"""worker_runtime 테스트: 소켓 디렉터리 권한, 단일 인스턴스 잠금, 남은 소켓 정리, 추론 스레드와 감시자."""

from __future__ import annotations

import os
import socket
import stat
import threading
import time
from collections.abc import Sequence
from pathlib import Path

import pytest

from tests.worker_cases import short_temporary_directory
from zg_stage1.worker_runtime import (
    InferenceBusyError,
    InferenceRunner,
    WorkerSetupError,
    acquire_instance_lock,
    ensure_private_directory,
    remove_stale_socket,
    resolve_run_directory,
    socket_path_for,
)


def mode_of(path: Path) -> int:
    """파일 권한 비트."""
    return stat.S_IMODE(os.lstat(path).st_mode)


def test_run_directory_is_created_private(tmp_path: Path) -> None:
    """소켓 디렉터리를 0700으로 만든다."""
    run_directory = resolve_run_directory(tmp_path)
    assert run_directory == tmp_path / "run" and mode_of(run_directory) == 0o700


def test_run_directory_permissions_are_narrowed(tmp_path: Path) -> None:
    """이미 있는 디렉터리가 0755면 0700으로 좁힌다."""
    (tmp_path / "run").mkdir(mode=0o755)
    os.chmod(tmp_path / "run", 0o755)
    assert mode_of(resolve_run_directory(tmp_path)) == 0o700


def test_run_directory_rejects_symlink(tmp_path: Path) -> None:
    """심볼릭 링크로 된 소켓 디렉터리는 받지 않는다(다른 곳으로 소켓을 빼돌리지 못하게)."""
    (tmp_path / "elsewhere").mkdir()
    (tmp_path / "run").symlink_to(tmp_path / "elsewhere")
    with pytest.raises(WorkerSetupError, match="심볼릭 링크"):
        resolve_run_directory(tmp_path)


def test_run_directory_rejects_regular_file(tmp_path: Path) -> None:
    """같은 이름의 파일이 있으면 오류다."""
    (tmp_path / "run").write_text("x", encoding="utf-8")
    with pytest.raises((WorkerSetupError, FileExistsError)):
        ensure_private_directory(tmp_path / "run")


def test_socket_path_length_limit(tmp_path: Path) -> None:
    """macOS 소켓 경로 상한을 넘으면 바인딩 전에 알기 쉬운 오류를 낸다."""
    with pytest.raises(WorkerSetupError, match="ZG_DATA_DIR"):
        socket_path_for(tmp_path / ("a" * 120), "stage1")
    assert socket_path_for(Path("/tmp/x"), "stage1") == Path("/tmp/x/stage1.sock")


def test_instance_lock_is_exclusive(tmp_path: Path) -> None:
    """같은 워커를 두 번 띄우면 두 번째는 오류다. 앞선 것이 끝나면 다시 잡을 수 있다."""
    first = acquire_instance_lock(tmp_path, "stage1")
    with pytest.raises(WorkerSetupError, match="이미 실행 중"):
        acquire_instance_lock(tmp_path, "stage1")
    first.close()
    acquire_instance_lock(tmp_path, "stage1").close()


def test_stale_socket_is_removed() -> None:
    """앞선 인스턴스가 남긴 소켓 파일은 지운다."""
    with short_temporary_directory() as directory:
        socket_path = directory / "stage1.sock"
        leftover = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        leftover.bind(str(socket_path))
        leftover.close()
        remove_stale_socket(socket_path)
        assert not socket_path.exists()
        remove_stale_socket(socket_path)


def test_stale_path_that_is_not_a_socket_is_kept(tmp_path: Path) -> None:
    """소켓이 아닌 파일은 지우지 않고 오류다(사용자 파일을 지우지 않게)."""
    regular = tmp_path / "stage1.sock"
    regular.write_text("x", encoding="utf-8")
    with pytest.raises(WorkerSetupError):
        remove_stale_socket(regular)
    assert regular.exists()


def double_lengths(texts: Sequence[str]) -> list:
    """가짜 추론: 문장 길이의 두 배."""
    return [len(text) * 2 for text in texts]


def test_runner_returns_results_in_order() -> None:
    """추론 스레드가 계산한 결과를 입력 순서대로 돌려준다."""
    runner = InferenceRunner(double_lengths)
    runner.start()
    try:
        assert runner.classify(["가", "가나다"]) == [2, 6]
    finally:
        runner.stop()


def test_runner_reraises_inference_error() -> None:
    """추론 오류는 처리 스레드로 그대로 올라온다."""

    def failing(texts: Sequence[str]) -> list:
        raise RuntimeError("모델 오류")

    runner = InferenceRunner(failing)
    runner.start()
    try:
        with pytest.raises(RuntimeError, match="모델 오류"):
            runner.classify(["가"])
    finally:
        runner.stop()


def test_runner_reports_busy_when_result_is_late() -> None:
    """결과가 기다리는 시간 안에 나오지 않으면 InferenceBusyError다."""
    release = threading.Event()

    def slow(texts: Sequence[str]) -> list:
        release.wait(5)
        return [0.0 for _ in texts]

    runner = InferenceRunner(slow, result_wait_seconds=0.2)
    runner.start()
    try:
        with pytest.raises(InferenceBusyError):
            runner.classify(["가"])
    finally:
        release.set()
        runner.stop()


def test_watchdog_calls_hang_handler_once() -> None:
    """추론 하나가 감시 시간을 넘기면 멈춘 것으로 보고 처리 함수를 한 번 부른다."""
    hang_calls: list[float] = []
    release = threading.Event()

    def stuck(texts: Sequence[str]) -> list:
        release.wait(5)
        return [0.0 for _ in texts]

    runner = InferenceRunner(stuck, on_hang=lambda: hang_calls.append(time.monotonic()), watchdog_seconds=0.3, result_wait_seconds=0.1)
    runner.start()
    try:
        with pytest.raises(InferenceBusyError):
            runner.classify(["가"])
        deadline = time.monotonic() + 3
        while not hang_calls and time.monotonic() < deadline:
            time.sleep(0.05)
        assert len(hang_calls) == 1
    finally:
        release.set()
        runner.stop()
