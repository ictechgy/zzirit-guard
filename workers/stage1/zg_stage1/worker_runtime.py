"""워커 실행 환경: 소켓 디렉터리, 단일 인스턴스 잠금, 추론 전용 스레드와 감시자.

왜 필요한가(docs/superpowers/plans/2026-10-14-stage2-ai-workers.md R1·R2):
- 소켓은 이 사용자만 들어갈 수 있는 0700 디렉터리에 둔다. 다른 사용자 프로세스가 채팅을 받거나 가짜 판정을 돌려주지 못하게 한다.
- 잠금으로 워커를 하나만 띄운다. 겹쳐 띄운 워커가 살아 있는 워커의 소켓을 지우고 빼앗지 못하게 한다.
- 모델은 추론 전용 스레드 하나만 만진다. 처리 스레드는 작업을 넘기고 기다리기만 해서, 상태 확인은 추론과 상관없이 바로 답한다.
- 추론이 멈추면 클라이언트 시간 초과로는 멈춘 계산을 끝낼 수 없다. 감시자가 프로세스를 끝내 launchd가 다시 띄우게 한다.
2차 워커(workers/stage2)는 이 파일을 그대로 복사해 쓴다.
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

# 소켓 파일 권한.
SOCKET_FILE_MODE = 0o600

# macOS의 유닉스 소켓 경로 상한(sun_path 104바이트, 끝의 NUL 포함).
MAX_SOCKET_PATH_BYTES = 103

# 처리 스레드가 추론 결과를 기다리는 최대 시간(초). 넘으면 503이다. 서버는 2초에 포기하므로 그보다 길게 둔다.
DEFAULT_RESULT_WAIT_SECONDS = 5.0

# 추론 하나가 이 시간(초)을 넘으면 멈춘 것으로 보고 프로세스를 끝낸다.
DEFAULT_WATCHDOG_SECONDS = 10.0

# 감시자가 확인하는 간격(초).
WATCHDOG_INTERVAL_SECONDS = 0.5

# 감시자가 프로세스를 끝낼 때의 종료 코드(EX_SOFTWARE). launchd KeepAlive가 다시 띄운다.
WATCHDOG_EXIT_CODE = 70

# 추론 대기열 길이. 동시 처리 연결 한도(4)보다 조금 크게 둔다.
INFERENCE_QUEUE_SIZE = 8

LOGGER = logging.getLogger("zg_worker")


class WorkerSetupError(Exception):
    """워커를 시작할 수 없는 환경 문제(디렉터리 권한·소유자, 경로 길이, 다른 인스턴스). 메시지에 원인과 해결 방향을 쓴다."""


class InferenceBusyError(Exception):
    """추론 대기열이 꽉 찼거나 결과가 제때 나오지 않았다. 처리 스레드는 503을 준다."""


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
    """워커 소켓 경로. macOS 경로 길이 상한을 넘으면 오류다(바인딩 때 알기 어려운 오류가 나는 대신)."""
    path = run_directory / f"{worker_name}.sock"
    if len(os.fsencode(path)) > MAX_SOCKET_PATH_BYTES:
        raise WorkerSetupError(f"소켓 경로가 {MAX_SOCKET_PATH_BYTES}바이트를 넘습니다. ZG_DATA_DIR을 더 짧은 경로로 두세요.")
    return path


def acquire_instance_lock(run_directory: Path, worker_name: str) -> IO[bytes]:
    """`<워커 이름>.lock`에 배타 잠금을 잡는다. 이미 잡혀 있으면 다른 인스턴스가 살아 있으므로 오류다.

    반환한 파일을 프로세스가 끝날 때까지 열어 두어야 잠금이 유지된다(닫히면 풀린다).
    """
    lock_file = open(run_directory / f"{worker_name}.lock", "ab")  # noqa: SIM115 - 프로세스 수명 동안 열어 둔다
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        lock_file.close()
        raise WorkerSetupError(f"{worker_name} 워커가 이미 실행 중입니다. 같은 워커를 두 번 띄우지 마세요.") from error
    return lock_file


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
    """추론 작업 하나. 처리 스레드는 done을 기다리고, 추론 스레드가 결과나 오류를 채운다."""

    texts: Sequence[str]
    done: threading.Event = field(default_factory=threading.Event)
    results: list | None = None
    error: BaseException | None = None
    # 처리 스레드가 기다리다 포기한 작업. 추론 스레드는 이런 작업을 계산하지 않고 건너뛴다(늦은 작업이 쌓여 뒤 작업까지 늦추지 않게).
    abandoned: threading.Event = field(default_factory=threading.Event)


class InferenceRunner:
    """모델을 가진 추론 전용 스레드와 감시자.

    infer: 문장 목록 → 판정 목록(입력 순서). 이 스레드에서만 부른다.
    on_hang: 추론이 watchdog_seconds를 넘을 때 부르는 함수(기본은 프로세스 종료). 테스트에서 바꾼다.
    """

    def __init__(
        self,
        infer: Callable[[Sequence[str]], list],
        on_hang: Callable[[], None] | None = None,
        watchdog_seconds: float = DEFAULT_WATCHDOG_SECONDS,
        result_wait_seconds: float = DEFAULT_RESULT_WAIT_SECONDS,
    ) -> None:
        self._infer = infer
        self._on_hang = on_hang or exit_for_hang
        self._watchdog_seconds = watchdog_seconds
        self._result_wait_seconds = result_wait_seconds
        self._jobs: queue.Queue[InferenceJob | None] = queue.Queue(maxsize=INFERENCE_QUEUE_SIZE)
        self._running_since: float | None = None
        self._stopping = threading.Event()
        self._threads = [
            threading.Thread(target=self._run_jobs, name="inference", daemon=True),
            threading.Thread(target=self._watch, name="watchdog", daemon=True),
        ]

    def start(self) -> None:
        """추론 스레드와 감시자를 시작한다."""
        for thread in self._threads:
            thread.start()

    def stop(self) -> None:
        """새 작업을 받지 않고 추론 스레드를 끝낸다(진행 중인 추론은 끝까지 한다)."""
        self._stopping.set()
        try:
            self._jobs.put_nowait(None)
        except queue.Full:
            LOGGER.warning("추론 대기열이 꽉 차 종료 신호를 넣지 못했습니다. 데몬 스레드라 프로세스와 함께 끝납니다.")

    def classify(self, texts: Sequence[str]) -> list:
        """작업을 넘기고 결과를 기다린다. 대기열이 꽉 찼거나 제때 끝나지 않으면 InferenceBusyError다."""
        job = InferenceJob(texts)
        try:
            self._jobs.put_nowait(job)
        except queue.Full as error:
            raise InferenceBusyError("inference queue full") from error
        if not job.done.wait(self._result_wait_seconds):
            job.abandoned.set()
            raise InferenceBusyError("inference timed out")
        if job.error is not None:
            raise job.error
        return job.results or []

    def _run_jobs(self) -> None:
        """추론 스레드 본체: 작업을 하나씩 꺼내 계산한다. 오류는 작업에 담아 처리 스레드가 올리게 한다."""
        while (job := self._jobs.get()) is not None:
            if job.abandoned.is_set():
                continue
            self._running_since = time.monotonic()
            try:
                job.results = self._infer(job.texts)
            except Exception as error:  # 처리 스레드에서 500으로 바꾸고 로그를 남긴다
                job.error = error
            finally:
                self._running_since = None
                job.done.set()

    def _watch(self) -> None:
        """감시자 본체: 추론 하나가 너무 오래 걸리면 on_hang을 한 번 부른다."""
        while not self._stopping.wait(WATCHDOG_INTERVAL_SECONDS):
            started = self._running_since
            if started is not None and time.monotonic() - started > self._watchdog_seconds:
                LOGGER.error("추론이 %.0f초를 넘겨 멈춘 것으로 봅니다. 프로세스를 끝내 launchd가 다시 띄우게 합니다.", self._watchdog_seconds)
                self._on_hang()
                return


def exit_for_hang() -> None:
    """멈춘 추론을 끝낼 방법이 없어 프로세스를 즉시 끝낸다. 파이썬 정리 과정도 멈춘 스레드에 걸릴 수 있어 os._exit를 쓴다."""
    os._exit(WATCHDOG_EXIT_CODE)
