"""worker 테스트: 작은 ELECTRA 모델로 불러오기·식별자·추론 계약과, 실제 시작 순서(잠금 → 남은 소켓 정리 → 모델 → 소켓)."""

from __future__ import annotations

import argparse
import re
import socket
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from transformers import ElectraConfig, ElectraForSequenceClassification, PreTrainedTokenizerBase

from tests.worker_cases import send_json, short_temporary_directory
from zg_stage1 import modeling
from zg_stage1.errors import ModelFormatError, PathResolutionError
from zg_stage1.inference_contract import build_inference_contract, write_inference_contract_file
from zg_stage1.worker import compute_model_identifier, load_scorer, main, resolve_data_directory, start_worker
from zg_stage1.worker_runtime import WorkerSetupError, acquire_instance_lock
from zg_stage1.worker_server import WorkerHTTPServer

# 작은 모델의 max_length(추론 계약).
TINY_MAX_LENGTH = 16


@pytest.fixture
def tiny_model_directory(tmp_path: Path, tiny_tokenizer: PreTrainedTokenizerBase) -> Path:
    """학습 결과처럼 가중치(safetensors)·토크나이저·추론 계약이 있는 작은 모델 디렉터리."""
    directory = tmp_path / "kcelectra-tiny"
    modeling.install_special_token_template(tiny_tokenizer)
    config = ElectraConfig(
        vocab_size=16,
        embedding_size=8,
        hidden_size=8,
        num_hidden_layers=1,
        num_attention_heads=1,
        intermediate_size=16,
        num_labels=2,
        id2label=modeling.ID_TO_LABEL,
        label2id=modeling.LABEL_TO_ID,
    )
    ElectraForSequenceClassification(config).save_pretrained(str(directory), safe_serialization=True)
    tiny_tokenizer.save_pretrained(str(directory))
    write_inference_contract_file(directory, build_inference_contract(tiny_tokenizer, TINY_MAX_LENGTH))
    return directory


def test_model_identifier_covers_weights_and_tokenizer(tiny_model_directory: Path) -> None:
    """식별자는 `<디렉터리 이름>@<12자>`이고, 토크나이저 파일만 바뀌어도 달라진다."""
    before = compute_model_identifier(tiny_model_directory)
    assert re.fullmatch(r"kcelectra-tiny@[0-9a-f]{12}", before)
    tokenizer_path = tiny_model_directory / "tokenizer.json"
    tokenizer_path.write_text(tokenizer_path.read_text(encoding="utf-8") + " ", encoding="utf-8")
    assert compute_model_identifier(tiny_model_directory) != before


def test_scorer_matches_score_texts(tiny_model_directory: Path) -> None:
    """워커 점수 함수는 평가 코드(score_texts)와 같은 점수를 입력 순서대로 내고, 1차라 범주가 없다."""
    scorer = load_scorer(tiny_model_directory, threads=1)
    verdicts = scorer(["가 나", "다", "라 가 나"])
    model = modeling.load_trained_classifier(tiny_model_directory)
    tokenizer = modeling.load_trained_tokenizer(tiny_model_directory)
    expected = modeling.score_texts(model, tokenizer, ["가 나", "다", "라 가 나"], "cpu", TINY_MAX_LENGTH, 16)
    assert [verdict.unsafe_probability for verdict in verdicts] == pytest.approx(expected)
    assert all(verdict.category is None for verdict in verdicts)


def test_scorer_requires_inference_contract(tiny_model_directory: Path) -> None:
    """추론 계약이 없으면 학습 때와 다른 길이로 채점할 수 있어 시작하지 않는다."""
    (tiny_model_directory / "inference.json").unlink()
    with pytest.raises(ModelFormatError, match="inference.json"):
        load_scorer(tiny_model_directory, threads=1)


def test_data_directory_comes_from_argument_or_environment(tmp_path: Path) -> None:
    """데이터 디렉터리는 인자 → ZG_DATA_DIR 순서이고, 둘 다 없으면 오류다."""
    assert resolve_data_directory(tmp_path, {}) == tmp_path
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
    """워커를 다른 스레드에서 실제 순서대로 띄우고, 소켓이 생기면 경로를 준다. 끝나면 멈춘다."""
    servers: list[WorkerHTTPServer] = []
    arguments = argparse.Namespace(model_dir=model_directory, threads=1, data_dir=data_directory)
    thread = threading.Thread(target=start_worker, args=(arguments, {}, servers.append), daemon=True)
    thread.start()
    deadline = time.monotonic() + 30
    while not servers:
        assert time.monotonic() < deadline and thread.is_alive()
        time.sleep(0.05)
    try:
        yield data_directory / "run" / "stage1.sock"
    finally:
        servers[0].shutdown()
        thread.join(10)


def test_worker_serves_classify_end_to_end(tiny_model_directory: Path) -> None:
    """시작하면 소켓으로 계약대로 답하고, 멈추면 소켓을 지운다."""
    with short_temporary_directory() as data_directory:
        with running_worker(tiny_model_directory, data_directory) as socket_path:
            response = send_json(socket_path, "POST", "/classify", {"items": [{"id": "a", "text": "가 나"}, {"id": "b", "text": "다"}]})
            health = send_json(socket_path, "GET", "/health")
        assert response.status == 200 and [item["id"] for item in response.body["items"]] == ["a", "b"]
        assert health.body["model"] == response.body["model"] == compute_model_identifier(tiny_model_directory)
        assert not socket_path.exists()


def test_leftover_socket_from_crash_is_replaced(tiny_model_directory: Path) -> None:
    """앞선 인스턴스가 비정상 종료하며 남긴 소켓 파일이 있어도, 잠금을 잡은 뒤 지우고 새로 만든다."""
    with short_temporary_directory() as data_directory:
        run_directory = data_directory / "run"
        run_directory.mkdir(mode=0o700)
        leftover = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        leftover.bind(str(run_directory / "stage1.sock"))
        leftover.close()
        with running_worker(tiny_model_directory, data_directory) as socket_path:
            assert send_json(socket_path, "GET", "/health").status == 200


def test_second_instance_is_refused_without_touching_socket(tiny_model_directory: Path) -> None:
    """같은 워커가 이미 잠금을 잡고 있으면 두 번째는 소켓을 건드리지 않고 오류로 끝난다."""
    with short_temporary_directory() as data_directory:
        run_directory = data_directory / "run"
        run_directory.mkdir(mode=0o700)
        lock_file = acquire_instance_lock(run_directory, "stage1")
        marker = run_directory / "stage1.sock"
        marker.write_text("살아 있는 워커의 소켓 자리", encoding="utf-8")
        arguments = argparse.Namespace(model_dir=tiny_model_directory, threads=1, data_dir=data_directory)
        with pytest.raises(WorkerSetupError, match="이미 실행 중"):
            start_worker(arguments, {}, lambda server: None)
        assert marker.read_text(encoding="utf-8") == "살아 있는 워커의 소켓 자리"
        lock_file.close()
