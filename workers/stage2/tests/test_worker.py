"""2차 worker 테스트: 모델 디렉터리 확인, 식별자, 데이터 디렉터리, 시작 순서(가짜 판정 함수로)."""

from __future__ import annotations

import argparse
import re
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

import pytest

from tests.worker_cases import send_json, short_temporary_directory
from zg_stage2.errors import PathResolutionError
from zg_stage2.worker import compute_model_identifier, ensure_model_directory, main, resolve_data_directory, start_worker
from zg_stage2.worker_contract import ItemVerdict
from zg_stage2.worker_runtime import WorkerSetupError, acquire_instance_lock
from zg_stage2.worker_server import WorkerHTTPServer


@pytest.fixture
def fake_model_directory(tmp_path: Path) -> Path:
    """가중치·토크나이저·템플릿 파일이 있는 가짜 모델 디렉터리(내용은 임의)."""
    directory = tmp_path / "kanana-fake"
    directory.mkdir()
    (directory / "model.safetensors").write_bytes(b"weights")
    (directory / "config.json").write_text('{"model_type": "llama"}', encoding="utf-8")
    (directory / "chat_template.jinja").write_text("{{ messages }}", encoding="utf-8")
    return directory


def fake_build(model_directory: Path) -> Callable[[Sequence[str]], list[ItemVerdict]]:
    """mlx 없이 쓰는 가짜 판정 함수 만들기."""
    return lambda texts: [ItemVerdict(0.97, "S6") for _ in texts]


def test_model_directory_needs_model_weights_and_config(tmp_path: Path, fake_model_directory: Path) -> None:
    """model*.safetensors와 config.json이 없으면 시작 전에 거절한다(없는 경로를 허브 저장소 이름으로 오해하지 않게)."""
    assert ensure_model_directory(fake_model_directory) == fake_model_directory
    with pytest.raises(PathResolutionError):
        ensure_model_directory(tmp_path / "kakaocorp/kanana-safeguard-8b")
    adapter_only = tmp_path / "adapter-only"
    adapter_only.mkdir()
    (adapter_only / "adapters.safetensors").write_bytes(b"x")
    (adapter_only / "config.json").write_text("{}", encoding="utf-8")
    with pytest.raises(PathResolutionError):
        ensure_model_directory(adapter_only)


def test_model_identifier_covers_every_model_file(fake_model_directory: Path) -> None:
    """식별자는 `<디렉터리 이름>@<12자>`이고, 템플릿·토크나이저 자산이 바뀌면 달라진다. 숨김 파일과 README는 영향이 없다."""
    before = compute_model_identifier(fake_model_directory)
    assert re.fullmatch(r"kanana-fake@[0-9a-f]{12}", before)
    (fake_model_directory / ".DS_Store").write_bytes(b"x")
    (fake_model_directory / "README.md").write_text("설명", encoding="utf-8")
    assert compute_model_identifier(fake_model_directory) == before
    (fake_model_directory / "merges.txt").write_text("a b", encoding="utf-8")
    after_merges = compute_model_identifier(fake_model_directory)
    (fake_model_directory / "chat_template.jinja").write_text("{{ other }}", encoding="utf-8")
    assert len({before, after_merges, compute_model_identifier(fake_model_directory)}) == 3


def test_data_directory_comes_from_argument_or_environment(tmp_path: Path) -> None:
    """데이터 디렉터리는 인자 → ZG_DATA_DIR 순서이고, 둘 다 없으면 오류다."""
    assert resolve_data_directory(None, {"ZG_DATA_DIR": str(tmp_path)}) == tmp_path
    with pytest.raises(PathResolutionError):
        resolve_data_directory(None, {})


def test_main_reports_setup_error_with_exit_code_2(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """환경 문제는 traceback 없이 원인만 보이고 종료 코드 2로 끝낸다."""
    with pytest.raises(SystemExit) as raised:
        main(["--model-dir", str(tmp_path / "없음")], environment={"ZG_DATA_DIR": str(tmp_path)})
    assert raised.value.code == 2 and "오류:" in capsys.readouterr().err


@contextmanager
def running_worker(model_directory: Path, data_directory: Path) -> Iterator[Path]:
    """가짜 판정 함수로 워커를 실제 순서대로 띄우고 소켓 경로를 준다."""
    servers: list[WorkerHTTPServer] = []
    arguments = argparse.Namespace(model_dir=model_directory, data_dir=data_directory)
    thread = threading.Thread(target=start_worker, args=(arguments, {}, servers.append, fake_build), daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not servers:
        assert time.monotonic() < deadline and thread.is_alive()
        time.sleep(0.02)
    try:
        yield data_directory / "run" / "stage2.sock"
    finally:
        servers[0].shutdown()
        thread.join(10)


def test_worker_serves_classify_end_to_end(fake_model_directory: Path) -> None:
    """시작하면 stage2.sock에서 범주와 함께 답하고, 멈추면 소켓을 지운다."""
    with short_temporary_directory() as data_directory:
        with running_worker(fake_model_directory, data_directory) as socket_path:
            response = send_json(socket_path, "POST", "/classify", {"items": [{"id": "a", "text": "가"}]})
        assert response.status == 200 and response.body["items"] == [{"id": "a", "unsafe_probability": 0.97, "category": "S6"}]
        assert response.body["model"] == compute_model_identifier(fake_model_directory)
        assert not socket_path.exists()


def test_second_instance_is_refused(fake_model_directory: Path) -> None:
    """같은 워커가 이미 잠금을 잡고 있으면 두 번째는 오류로 끝난다."""
    with short_temporary_directory() as data_directory:
        run_directory = data_directory / "run"
        run_directory.mkdir(mode=0o700)
        lock_file = acquire_instance_lock(run_directory, "stage2")
        arguments = argparse.Namespace(model_dir=fake_model_directory, data_dir=data_directory)
        with pytest.raises(WorkerSetupError, match="이미 실행 중"):
            start_worker(arguments, {}, lambda server: None, fake_build)
        lock_file.close()
