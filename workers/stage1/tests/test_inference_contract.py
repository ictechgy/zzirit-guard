"""추론 계약(inference.json) 테스트: 내용, 쓰기·읽기, 학습 출력 준비 때 쓰기, 기존 학습 결과에 쓰는 CLI, 평가의 max_length 결정."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from transformers import PreTrainedTokenizerBase

from zg_stage1 import evaluate, modeling, train, write_inference_contract
from zg_stage1.errors import ModelFormatError, OutputExistsError, PathResolutionError
from zg_stage1.inference_contract import (
    INFERENCE_CONTRACT_FILE_NAME,
    build_inference_contract,
    read_inference_contract,
    write_inference_contract_file,
)


@pytest.fixture
def wrapped_tokenizer(tiny_tokenizer: PreTrainedTokenizerBase) -> PreTrainedTokenizerBase:
    """[CLS]·[SEP] 규칙을 넣은 작은 토크나이저."""
    modeling.install_special_token_template(tiny_tokenizer)
    return tiny_tokenizer


def make_trained_directory(root: Path, tokenizer: PreTrainedTokenizerBase, card: dict | None) -> Path:
    """학습 결과처럼 토크나이저(와 카드)만 있는 디렉터리를 만든다."""
    directory = root / "kcelectra-test"
    directory.mkdir()
    tokenizer.save_pretrained(str(directory))
    if card is not None:
        (directory / "model-card.json").write_text(json.dumps(card), encoding="utf-8")
    return directory


def test_contract_records_max_length_class_index_and_special_tokens(wrapped_tokenizer: PreTrainedTokenizerBase) -> None:
    """계약에는 max_length, 유해 칸 번호, [CLS]·[SEP] 요구와 토큰 번호가 들어 있다."""
    contract = build_inference_contract(wrapped_tokenizer, max_length=128)
    assert contract["max_length"] == 128
    assert contract["toxic_class_index"] == 1
    assert contract["labels"] == {"0": "normal", "1": "toxic"}
    assert contract["special_tokens"] == {
        "requires_cls_sep_wrapping": True,
        "cls_token": "[CLS]",
        "cls_token_id": 1,
        "sep_token": "[SEP]",
        "sep_token_id": 2,
        "pad_token_id": 3,
    }


def test_contract_refuses_tokenizer_without_template(tiny_tokenizer: PreTrainedTokenizerBase) -> None:
    """규칙이 없는 토크나이저로는 계약을 만들지 않는다(계약과 실제 동작이 어긋나므로)."""
    with pytest.raises(ModelFormatError):
        build_inference_contract(tiny_tokenizer, max_length=128)


def test_write_and_read_round_trip(wrapped_tokenizer: PreTrainedTokenizerBase, tmp_path: Path) -> None:
    """쓴 계약을 그대로 다시 읽는다."""
    contract = build_inference_contract(wrapped_tokenizer, max_length=96)
    write_inference_contract_file(tmp_path, contract)
    assert read_inference_contract(tmp_path) == contract


def test_read_returns_none_when_missing(tmp_path: Path) -> None:
    """계약 파일이 없으면 None이다(계약 이전에 만든 학습 결과)."""
    assert read_inference_contract(tmp_path) is None


@pytest.mark.parametrize("payload", ["{", "[]", '{"schema_version": 1}', '{"schema_version": 1, "max_length": "128", "toxic_class_index": 1}'])
def test_read_rejects_malformed_contract(tmp_path: Path, payload: str) -> None:
    """깨졌거나 필수 값이 없는 계약은 고치는 방향을 담은 오류를 낸다."""
    (tmp_path / INFERENCE_CONTRACT_FILE_NAME).write_text(payload, encoding="utf-8")
    with pytest.raises(ModelFormatError, match="write_inference_contract"):
        read_inference_contract(tmp_path)


def test_training_output_preparation_writes_contract(wrapped_tokenizer: PreTrainedTokenizerBase, tmp_path: Path) -> None:
    """학습이 출력 디렉터리를 만들 때 inference.json도 함께 쓴다."""
    output_directory = tmp_path / "run"
    train.prepare_output_directory(output_directory, wrapped_tokenizer, max_length=64)
    assert read_inference_contract(output_directory)["max_length"] == 64


def test_cli_writes_contract_for_existing_run(wrapped_tokenizer: PreTrainedTokenizerBase, tmp_path: Path) -> None:
    """이미 끝난 학습 결과에 카드의 max_length로 계약을 써 넣는다(다시 학습하지 않는다)."""
    directory = make_trained_directory(tmp_path, wrapped_tokenizer, {"hyperparameters": {"max_length": 128}})
    write_inference_contract.main(["--model-dir", str(directory)])
    assert read_inference_contract(directory)["max_length"] == 128


def test_cli_refuses_to_overwrite_without_flag(wrapped_tokenizer: PreTrainedTokenizerBase, tmp_path: Path) -> None:
    """계약이 이미 있으면 --overwrite 없이는 덮어쓰지 않는다."""
    directory = make_trained_directory(tmp_path, wrapped_tokenizer, {"hyperparameters": {"max_length": 128}})
    write_inference_contract.main(["--model-dir", str(directory)])
    with pytest.raises(OutputExistsError, match="--overwrite"):
        write_inference_contract.main(["--model-dir", str(directory)])
    write_inference_contract.main(["--model-dir", str(directory), "--overwrite", "--max-length", "64"])
    assert read_inference_contract(directory)["max_length"] == 64


def test_cli_requires_max_length_source(wrapped_tokenizer: PreTrainedTokenizerBase, tmp_path: Path) -> None:
    """카드도 --max-length도 없으면 추측하지 않고 오류를 낸다."""
    directory = make_trained_directory(tmp_path, wrapped_tokenizer, None)
    with pytest.raises(PathResolutionError, match="--max-length"):
        write_inference_contract.main(["--model-dir", str(directory)])


def test_evaluate_prefers_contract_max_length(wrapped_tokenizer: PreTrainedTokenizerBase, tmp_path: Path) -> None:
    """평가는 inference.json의 max_length를 카드보다 먼저 쓴다(워커와 같은 값을 쓰기 위해서다)."""
    write_inference_contract_file(tmp_path, build_inference_contract(wrapped_tokenizer, max_length=64))
    assert evaluate.resolve_max_length(tmp_path, {"hyperparameters": {"max_length": 128}}) == 64


def test_evaluate_falls_back_to_card_then_default(tmp_path: Path) -> None:
    """계약이 없으면 카드의 값을, 카드도 없으면 128을 쓴다."""
    assert evaluate.resolve_max_length(tmp_path, {"hyperparameters": {"max_length": 96}}) == 96
    assert evaluate.resolve_max_length(tmp_path, None) == 128


@pytest.mark.parametrize(
    "overrides",
    [{"schema_version": 2}, {"toxic_class_index": 0}, {"max_length": 1}, {"max_length": 7}, {"max_length": 513}],
)
def test_read_rejects_contract_with_invalid_semantics(wrapped_tokenizer: PreTrainedTokenizerBase, tmp_path: Path, overrides: dict) -> None:
    """정수이기만 한 계약(모르는 버전·뒤집힌 유해 칸·범위 밖 max_length)은 거부한다."""
    contract = {**build_inference_contract(wrapped_tokenizer, max_length=128), **overrides}
    (tmp_path / INFERENCE_CONTRACT_FILE_NAME).write_text(json.dumps(contract), encoding="utf-8")
    with pytest.raises(ModelFormatError, match="write_inference_contract"):
        read_inference_contract(tmp_path)


@pytest.mark.parametrize("max_length", [8, 512])
def test_read_accepts_boundary_max_length(wrapped_tokenizer: PreTrainedTokenizerBase, tmp_path: Path, max_length: int) -> None:
    """허용 범위의 양 끝값은 통과한다."""
    write_inference_contract_file(tmp_path, build_inference_contract(wrapped_tokenizer, max_length=max_length))
    assert read_inference_contract(tmp_path)["max_length"] == max_length


def test_build_refuses_out_of_range_max_length(wrapped_tokenizer: PreTrainedTokenizerBase) -> None:
    """범위 밖 max_length로는 계약을 만들지 않는다(쓴 뒤 읽을 수 없게 되므로)."""
    with pytest.raises(ModelFormatError):
        build_inference_contract(wrapped_tokenizer, max_length=4)
