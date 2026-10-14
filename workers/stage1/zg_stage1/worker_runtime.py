"""워커 실행 환경: 소켓 디렉터리, 단일 인스턴스 잠금, 추론 전용 스레드와 감시자.

왜 필요한가(docs/superpowers/plans/2026-10-14-stage2-ai-workers.md R1·R2):
- 소켓은 이 사용자만 들어갈 수 있는 0700 디렉터리에 둔다. 다른 사용자 프로세스가 채팅을 받거나 가짜 판정을 돌려주지 못하게 한다.
- 잠금으로 워커를 하나만 띄운다. 겹쳐 띄운 워커가 살아 있는 워커의 소켓을 지우고 빼앗지 못하게 한다.
- 모델은 추론 전용 스레드 하나가 만들고 혼자 쓴다(mlx·PyTorch 모델을 여러 스레드가 만지지 않게). 처리 스레드는 작업을 넘기고
  기다리기만 해서, 상태 확인은 추론과 상관없이 바로 답한다.
- 추론이 멈추면 클라이언트 시간 초과로는 멈춘 계산을 끝낼 수 없다. 감시자가 프로세스를 끝내 launchd가 다시 띄우게 한다.
2차 워커(workers/stage2)는 이 파일을 그대로 복사해 쓴다(패키지 이름만 다르다).
"""

from __future__ import annotations

import fcntl
import logging
import os
import queue
import stat
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO

# 소켓 디렉터리 이름(데이터 디렉터리 아래).
RUN_DIRECTORY_NAME = "run"

# 소켓 디렉터리 권한. 이 사용자만 들어갈 수 있다.
RUN_DIRECTORY_MODE = 0o700

# 소켓·잠금 파일 권한.
SOCKET_FILE_MODE = 0o600

# macOS의 유닉스 소켓 경로 상한(sun_path 104바이트, 끝의 NUL 포함).
MAX_SOCKET_PATH_BYTES = 103

# 잠금 파일을 여는 방식. 심볼릭 링크를 따라가지 않고(O_NOFOLLOW), FIFO에서 멈추지 않으며(O_NONBLOCK), 자식 프로세스에 넘기지 않는다.
LOCK_OPEN_FLAGS = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC

# 처리 스레드가 추론 결과를 기다리는 최대 시간(초). 넘으면 503이다. 서버는 2초에 포기하므로 그보다 길게 둔다.
DEFAULT_RESULT_WAIT_SECONDS = 5.0

# 추론 하나가 이 시간(초)을 넘으면 멈춘 것으로 보고 프로세스를 끝낸다.
DEFAULT_WATCHDOG_SECONDS = 10.0

# 감시자가 확인하는 간격(초).
WATCHDOG_INTERVAL_SECONDS = 0.5

# 감시자가 프로세스를 끝낼 때의 종료 코드(EX_SOFTWARE). launchd KeepAlive가 다시 띄운다.
WATCHDOG_EXIT_CODE = 70

# 추론 대기열 길이. 동시 처리 연결 한도(4)보다 조금 크게 둔다. 꽉 차면 넣기 전에 503이다.
INFERENCE_QUEUE_SIZE = 8

# 멈출 때 추론 스레드·감시자를 기다리는 최대 시간(초).
DEFAULT_STOP_JOIN_SECONDS = 10.0

# 작업 상태. 기다림(pending) → 계산 중(running) → 끝(done), 또는 기다리다 포기(abandoned).
JOB_PENDING = "pending"
JOB_RUNNING = "running"
JOB_ABANDONED = "abandoned"
JOB_DONE = "done"

LOGGER = logging.getLogger("zg_worker")


class WorkerSetupError(Exception):
    """워커를 시작할 수 없는 환경 문제(디렉터리·잠금 파일, 경로 길이, 다른 인스턴스). 메시지에 원인과 해결 방향을 쓴다."""


class InferenceBusyError(Exception):
    """추론 대기열이 꽉 찼거나, 결과가 제때 나오지 않았거나, 멈추는 중이다. 처리 스레드는 503을 준다."""


def ensure_private_directory(path: Path) -> Path:
    """path가 이 사용자 소유의 진짜 디렉터리(심볼릭 링크 아님)이고 권한이 0700인지 확인한다. 없으면 0700으로 만든다.

    권한이 더 넓으면 0700으로 좁힌다(우리 소유라 고칠 수 있다). 소유자가 다르거나 링크면 오류다.
    """
    path.mkdir(mode=RUN_DIRECTORY_MODE, parents=True, exist_ok=True)
    status = os.lstat(path)
    if stat.S_ISLNK(status.st_mode) or not stat.S_ISDIR(status.st_mode):
        raise WorkerSetupError(f"{path.name}이 디렉터리가 아니거나 심볼릭 링크입니다. 지우고 다시 시작하세요.")
    if status.st_uid != os.getuid():
        raise WorkerSetupError(f"{path.name} 디렉터리의 소유자가 이 사용자가 아닙니다. 데이터 디렉터리 위치를 확인하세요.")
    if stat.S_IMODE(status.st_mode) != RUN_DIRECTORY_MODE:
        os.chmod(path, RUN_DIRECTORY_MODE)
    return path


def resolve_run_directory(data_directory: Path) -> Path:
    """데이터 디렉터리 아래의 소켓 디렉터리를 확인해 돌려준다."""
    return ensure_private_directory(data_directory / RUN_DIRECTORY_NAME)


def socket_path_for(run_directory: Path, worker_name: str) -> Path:
    """워커 소켓 경로. macOS 경로 길이 상한을 넘으면 오류다(바인딩 때 알기 어려운 오류가 나는 대신, 모델을 불러오기 전에)."""
    path = run_directory / f"{worker_name}.sock"
    if len(os.fsencode(path)) > MAX_SOCKET_PATH_BYTES:
        raise WorkerSetupError(f"소켓 경로가 {MAX_SOCKET_PATH_BYTES}바이트를 넘습니다. ZG_DATA_DIR을 더 짧은 경로로 두세요.")
    return path


def open_lock_file(path: Path) -> int:
    """잠금 파일을 열어 파일 번호를 돌려준다. 심볼릭 링크·FIFO·남의 파일이면 오류다.

    왜: 디렉터리가 예전에 다른 사용자에게 열려 있었다면, 그 사용자가 잠금 파일 자리에 링크나 FIFO를 심어
    워커가 영영 시작하지 못하게 할 수 있다.
    """
    try:
        descriptor = os.open(path, LOCK_OPEN_FLAGS, SOCKET_FILE_MODE)
    except OSError as error:
        raise WorkerSetupError(f"{path.name}을 열 수 없습니다(심볼릭 링크일 수 있음). 지우고 다시 시작하세요.") from error
    status = os.fstat(descriptor)
    if not stat.S_ISREG(status.st_mode) or status.st_uid != os.getuid():
        os.close(descriptor)
        raise WorkerSetupError(f"{path.name}이 이 사용자의 일반 파일이 아닙니다. 지우고 다시 시작하세요.")
    if stat.S_IMODE(status.st_mode) != SOCKET_FILE_MODE:
        os.fchmod(descriptor, SOCKET_FILE_MODE)
    return descriptor


def acquire_instance_lock(run_directory: Path, worker_name: str) -> IO[bytes]:
    """`<워커 이름>.lock`에 배타 잠금을 잡는다. 이미 잡혀 있으면 다른 인스턴스가 살아 있으므로 오류다.

    반환한 파일을 프로세스가 끝날 때까지 열어 두어야 잠금이 유지된다(닫히면 풀린다).
    """
    descriptor = open_lock_file(run_directory / f"{worker_name}.lock")
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        os.close(descriptor)
        raise WorkerSetupError(f"{worker_name} 워커가 이미 실행 중입니다. 같은 워커를 두 번 띄우지 마세요.") from error
    return os.fdopen(descriptor, "r+b")


def remove_stale_socket(socket_path: Path) -> None:
    """잠금을 잡은 뒤에 남아 있는 소켓 파일(앞선 인스턴스가 비정상 종료하며 남김)을 지운다. 소켓이 아닌 파일이면 지우지 않고 오류다."""
    try:
        status = os.lstat(socket_path)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(status.st_mode) or status.st_uid != os.getuid():
        raise WorkerSetupError(f"{socket_path.name}이 이 사용자의 소켓이 아닙니다. 지운 뒤 다시 시작하세요.")
    socket_path.unlink()


@dataclass
class InferenceJob:
    """추론 작업 하나. 처리 스레드는 done을 기다리고, 추론 스레드가 결과나 오류를 채운다.

    상태 바꾸기는 잠금 안에서 한다. 추론 스레드의 '꺼내기'와 처리 스레드의 '포기'가 겹쳐도 둘 중 하나만 이긴다.
    """

    texts: Sequence[str]
    done: threading.Event = field(default_factory=threading.Event)
    results: list | None = None
    error: Exception | None = None
    state: str = JOB_PENDING
    lock: threading.Lock = field(default_factory=threading.Lock)

    def claim(self) -> bool:
        """추론 스레드가 계산을 시작한다. 이미 포기한 작업이면 False(계산하지 않고 건너뛴다)."""
        with self.lock:
            if self.state != JOB_PENDING:
                return False
            self.state = JOB_RUNNING
            return True

    def abandon(self) -> None:
        """처리 스레드가 기다리다 포기한다. 아직 시작하지 않은 작업만 포기 상태가 된다(계산 중이면 결과만 버려진다)."""
        with self.lock:
            if self.state == JOB_PENDING:
                self.state = JOB_ABANDONED

    def finish(self, results: list | None, error: Exception | None) -> None:
        """결과나 오류를 채우고 기다리는 쪽을 깨운다."""
        with self.lock:
            self.results, self.error, self.state = results, error, JOB_DONE
        self.done.set()


class InferenceRunner:
    """모델을 가진 추론 전용 스레드와 감시자.

    build_infer: 추론 스레드 안에서 한 번 불러 '문장 목록 → 판정 목록' 함수를 만든다(모델 불러오기·데우기). 모델을 만든 스레드가 계속 쓰게 한다.
    on_hang: 추론이 watchdog_seconds를 넘을 때 부르는 함수(기본은 프로세스 종료). 테스트에서 바꾼다.
    """

    def __init__(
        self,
        build_infer: Callable[[], Callable[[Sequence[str]], list]],
        on_hang: Callable[[], None] | None = None,
        watchdog_seconds: float = DEFAULT_WATCHDOG_SECONDS,
        result_wait_seconds: float = DEFAULT_RESULT_WAIT_SECONDS,
    ) -> None:
        self._build_infer = build_infer
        self._on_hang = on_hang or exit_for_hang
        self._watchdog_seconds = watchdog_seconds
        self._result_wait_seconds = result_wait_seconds
        self._jobs: queue.Queue[InferenceJob | None] = queue.Queue(maxsize=INFERENCE_QUEUE_SIZE)
        self._active_lock = threading.Lock()
        self._active: tuple[InferenceJob, float] | None = None
        self._ready = threading.Event()
        self._startup_error: Exception | None = None
        self._stopping = threading.Event()
        # 작업 넣기와 멈추기를 한 잠금으로 묶는다. '멈추지 않았음'을 본 뒤 종료 신호 뒤에 작업을 넣는 일이 없게 한다.
        self._submit_lock = threading.Lock()
        self._threads = [
            threading.Thread(target=self._run_jobs, name="inference", daemon=True),
            threading.Thread(target=self._watch, name="watchdog", daemon=True),
        ]

    def start(self) -> None:
        """추론 스레드와 감시자를 시작하고, 모델 준비(build_infer)가 끝날 때까지 기다린다. 준비가 실패하면 그 오류를 올린다."""
        for thread in self._threads:
            thread.start()
        self._ready.wait()
        if self._startup_error is not None:
            self._stopping.set()
            raise self._startup_error

    def stop(self, join_seconds: float = DEFAULT_STOP_JOIN_SECONDS) -> None:
        """새 작업을 받지 않고, 대기열의 작업을 마친 뒤 추론 스레드와 감시자를 끝낸다. 각 스레드를 최대 join_seconds 기다린다."""
        with self._submit_lock:
            self._stopping.set()
            try:
                self._jobs.put(None, timeout=join_seconds)
            except queue.Full:
                LOGGER.warning("추론 대기열이 비지 않아 종료 신호를 넣지 못했습니다. 데몬 스레드라 프로세스와 함께 끝납니다.")
        for thread in self._threads:
            thread.join(join_seconds)
            if thread.is_alive():
                LOGGER.warning("%s 스레드가 %.0f초 안에 끝나지 않았습니다. 프로세스와 함께 끝납니다.", thread.name, join_seconds)

    def classify(self, texts: Sequence[str]) -> list:
        """작업을 넘기고 결과를 기다린다. 멈추는 중이거나, 대기열이 꽉 찼거나, 제때 끝나지 않으면 InferenceBusyError다."""
        job = InferenceJob(texts)
        self._submit(job)
        if not job.done.wait(self._result_wait_seconds):
            job.abandon()
            raise InferenceBusyError("inference timed out")
        if job.error is not None:
            raise job.error
        return job.results or []

    def _submit(self, job: InferenceJob) -> None:
        """멈추는 중이 아니면 작업을 넣는다. 확인과 넣기를 멈추기와 같은 잠금 안에서 한다."""
        with self._submit_lock:
            if self._stopping.is_set():
                raise InferenceBusyError("stopping")
            try:
                self._jobs.put_nowait(job)
            except queue.Full as error:
                raise InferenceBusyError("inference queue full") from error

    def _run_jobs(self) -> None:
        """추론 스레드 본체: 모델을 만들고, 작업을 하나씩 꺼내 계산한다. 포기한 작업은 건너뛴다."""
        infer = self._prepare()
        if infer is None:
            return
        while (job := self._jobs.get()) is not None:
            if job.claim():
                self._run_one(infer, job)

    def _prepare(self) -> Callable[[Sequence[str]], list] | None:
        """모델을 만든다. 실패하면 오류를 start()로 넘기고 None을 돌려준다."""
        try:
            return self._build_infer()
        except Exception as error:  # start()가 같은 오류를 올린다
            self._startup_error = error
            return None
        finally:
            self._ready.set()

    def _run_one(self, infer: Callable[[Sequence[str]], list], job: InferenceJob) -> None:
        """작업 하나를 계산한다. 계산하는 동안 감시자가 볼 수 있게 시작 시각을 남긴다. 오류는 작업에 담아 처리 스레드가 올리게 한다."""
        with self._active_lock:
            self._active = (job, time.monotonic())
        results: list | None = None
        error: Exception | None = None
        try:
            results = infer(job.texts)
        except Exception as caught:  # 처리 스레드에서 500으로 바꾸고 로그를 남긴다
            error = caught
        finally:
            with self._active_lock:
                self._active = None
            job.finish(results, error)

    def _watch(self) -> None:
        """감시자 본체: 추론 하나가 너무 오래 걸리면 on_hang을 한 번 부른다."""
        while not self._stopping.wait(WATCHDOG_INTERVAL_SECONDS):
            if self._handle_hang():
                return

    def _handle_hang(self) -> bool:
        """지금 계산 중인 작업이 감시 시간을 넘겼는지 잠금 안에서 다시 확인하고, 넘겼으면 on_hang을 부른다.

        왜 잠금 안에서 부르나: 확인한 뒤 부르기 전에 작업이 끝나면, 멀쩡한 프로세스를 끝낼 수 있다.
        """
        with self._active_lock:
            if self._active is None or self._stopping.is_set():
                return False
            if time.monotonic() - self._active[1] <= self._watchdog_seconds:
                return False
            LOGGER.error("추론이 %.0f초를 넘겨 멈춘 것으로 봅니다. 프로세스를 끝내 launchd가 다시 띄우게 합니다.", self._watchdog_seconds)
            self._on_hang()
            return True


def exit_for_hang() -> None:
    """멈춘 추론을 끝낼 방법이 없어 프로세스를 즉시 끝낸다. 파이썬 정리 과정도 멈춘 스레드에 걸릴 수 있어 os._exit를 쓴다."""
    os._exit(WATCHDOG_EXIT_CODE)
