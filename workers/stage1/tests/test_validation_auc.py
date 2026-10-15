"""정책 정렬 검증 AUC 도구 테스트: 조건부 제외, 같은 추론 경로, 출처와 덮어쓰기 보호."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from tests.conftest import write_jsonl
from zg_stage1.data import compute_identifier_list_sha256
from zg_stage1.errors import DatasetFormatError, ModelFormatError, OutputExistsError
from zg_stage1.validation_auc import load_validation_records, main


def validation_row(identifier: str, label: str, target_label: object | None = None) -> dict:
    """작은 K-HATERS 검증 한 줄."""
    row = {"id": identifier, "text": f"검증 자리표시자 {identifier}", "label": label}
    if target_label is not None:
        row["target_label"] = target_label
    return row


def test_target_filter_is_only_required_when_selected(tmp_path: Path) -> None:
    """기본 평가는 target_label 없는 기존 파일을 읽고, 정책 정렬 선택 때만 그 필드를 요구한다."""
    path = write_jsonl(tmp_path / "val.jsonl", [validation_row("1", "normal")])
    records, excluded = load_validation_records(path, exclude_untargeted=False)
    assert [record.record_id for record in records] == ["1"] and excluded == []
    with pytest.raises(DatasetFormatError, match=r"val\.jsonl:1.*target_label"):
        load_validation_records(path, exclude_untargeted=True)


def test_identifier_hash_uses_numeric_order_and_rejects_non_integer() -> None:
    """D manifest와 AUC의 id 지문은 문자열이 아닌 정수 오름차순·마지막 줄바꿈 정의를 쓴다."""
    assert compute_identifier_list_sha256(["10", "2"]) == hashlib.sha256(b"2\n10\n").hexdigest()
    with pytest.raises(DatasetFormatError, match="정수"):
        compute_identifier_list_sha256(["not-an-id"])


def test_main_scores_policy_aligned_rows_and_writes_provenance(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """제외 뒤 남은 문장만 기존 modeling.score_texts로 채점하고, id 해시와 파일·가중치 해시를 남긴다."""
    model_dir = tmp_path / "model-a"
    model_dir.mkdir()
    (model_dir / "model.safetensors").write_bytes(b"stage1 weights")
    val_file = write_jsonl(
        tmp_path / "val.jsonl",
        [
            validation_row("20", "offensive", []),
            validation_row("3", "normal", []),
            validation_row("10", "L1_hate", ["group"]),
        ],
    )
    captured: dict[str, object] = {}

    monkeypatch.setattr("zg_stage1.validation_auc.modeling.resolve_device", lambda requested: requested)
    monkeypatch.setattr("zg_stage1.validation_auc.modeling.load_trained_tokenizer", lambda directory: "tokenizer")
    monkeypatch.setattr("zg_stage1.validation_auc.modeling.load_trained_classifier", lambda directory: "model")
    monkeypatch.setattr("zg_stage1.validation_auc.modeling.move_model_to_device", lambda model, device: model)
    monkeypatch.setattr("zg_stage1.validation_auc.resolve_max_length", lambda directory, card: 77)
    monkeypatch.setattr("zg_stage1.validation_auc.read_model_card", lambda directory: {"status": "completed", "hyperparameters": {"max_length": 77}})

    def fake_scores(model: object, tokenizer: object, texts: list[str], device: str, max_length: int, batch_size: int) -> list[float]:
        captured.update(texts=texts, device=device, max_length=max_length, batch_size=batch_size)
        return [0.1, 0.9]

    monkeypatch.setattr("zg_stage1.validation_auc.modeling.score_texts", fake_scores)
    output = tmp_path / "auc.json"
    main(
        [
            "--model-dir",
            str(model_dir),
            "--val-file",
            str(val_file),
            "--exclude-untargeted-offensive",
            "--output",
            str(output),
            "--device",
            "cpu",
            "--batch-size",
            "2",
        ]
    )
    report = json.loads(output.read_text(encoding="utf-8"))
    assert captured == {"texts": ["검증 자리표시자 3", "검증 자리표시자 10"], "device": "cpu", "max_length": 77, "batch_size": 2}
    assert report["auc"] == 1.0 and report["rows_scored"] == 2 and report["rows_excluded"] == 1
    assert report["excluded_ids_sha256"] == hashlib.sha256(b"20\n").hexdigest()
    assert report["val_file"] == {"name": "val.jsonl", "sha256": hashlib.sha256(val_file.read_bytes()).hexdigest()}
    assert report["model_weights_sha256"] == hashlib.sha256(b"stage1 weights").hexdigest()
    assert isinstance(report["created_at"], str) and "검증 자리표시자" not in output.read_text(encoding="utf-8")


def test_existing_output_is_refused_before_model_loading(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """기존 근거 파일은 덮어쓰지 않고, 무거운 모델도 불러오기 전에 멈춘다."""
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    val_file = write_jsonl(tmp_path / "val.jsonl", [validation_row("1", "normal")])
    output = tmp_path / "auc.json"
    output.write_text("앞선 결과\n", encoding="utf-8")
    monkeypatch.setattr("zg_stage1.validation_auc.modeling.load_trained_classifier", lambda directory: pytest.fail("모델을 불러오면 안 됨"))
    with pytest.raises(OutputExistsError, match="덮어쓰지"):
        main(["--model-dir", str(model_dir), "--val-file", str(val_file), "--output", str(output)])
    assert output.read_text(encoding="utf-8") == "앞선 결과\n"


def test_unfinished_training_is_refused_before_model_loading(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """학습 중(status running) 카드의 모델은 불러오기 전에 거부한다. 중간 체크포인트의 AUC를 근거로 쓰지 않게 하기 위해서다."""
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    (model_dir / "model-card.json").write_text(json.dumps({"status": "running"}), encoding="utf-8")
    val_file = write_jsonl(tmp_path / "val.jsonl", [validation_row("1", "normal")])
    monkeypatch.setattr("zg_stage1.validation_auc.modeling.resolve_device", lambda requested: requested)
    monkeypatch.setattr("zg_stage1.validation_auc.modeling.load_trained_classifier", lambda directory: pytest.fail("모델을 불러오면 안 됨"))
    with pytest.raises(ModelFormatError, match="학습이 끝나지 않았습니다"):
        main(["--model-dir", str(model_dir), "--val-file", str(val_file), "--output", str(tmp_path / "auc.json"), "--device", "cpu"])
