"""modeling 모듈 테스트(모델 다운로드 없음): 배치 패딩, 장치 선택, 학습 단계 계산, 로딩 전 .bin 거부."""

from __future__ import annotations

from pathlib import Path

import pytest
import torch

from zg_stage1 import modeling, train
from zg_stage1.errors import ModelFormatError, UnsafeWeightsError


def test_collate_pads_right_and_masks() -> None:
    """가장 긴 문장에 맞춰 오른쪽을 패딩하고, 패딩 위치의 마스크는 0이다."""
    batch = modeling.collate_batch([[1, 5, 2], [1, 2], [1, 7, 8, 9, 2]], [0, 1], pad_token_id=3)
    assert batch["input_ids"].tolist() == [[1, 5, 2], [1, 2, 3]]
    assert batch["attention_mask"].tolist() == [[1, 1, 1], [1, 1, 0]]
    assert batch["input_ids"].dtype == torch.long


def test_toxic_probability_is_second_column() -> None:
    """유해 확률은 softmax의 두 번째 칸이다."""
    probabilities = modeling.compute_toxic_probabilities(torch.tensor([[0.0, 0.0], [0.0, 100.0]]))
    assert probabilities == pytest.approx([0.5, 1.0])


def test_resolve_device_keeps_cpu() -> None:
    """cpu를 고르면 그대로 cpu다."""
    assert modeling.resolve_device("cpu") == "cpu"


def test_resolve_device_auto_picks_available() -> None:
    """auto는 MPS가 되면 mps, 아니면 cpu다."""
    expected = "mps" if torch.backends.mps.is_available() else "cpu"
    assert modeling.resolve_device("auto") == expected


@pytest.mark.parametrize(
    ("example_count", "batch_size", "epochs", "max_steps", "expected"),
    [(100, 32, 3, 0, 12), (100, 32, 3, 5, 5), (64, 32, 1, 0, 2), (10, 32, 2, 100, 2)],
)
def test_compute_total_steps(example_count: int, batch_size: int, epochs: int, max_steps: int, expected: int) -> None:
    """전체 스텝 = ceil(건수/배치) × epoch, --max-steps가 있으면 상한."""
    assert train.compute_total_steps(example_count, batch_size, epochs, max_steps) == expected


def test_progress_tracks_best_and_patience() -> None:
    """AUC가 최고치를 못 넘으면(같은 값 포함) 개선 없는 epoch로 센다."""
    progress = train.TrainingProgress(total_steps=10)
    assert progress.record_validation(1, 0.80) is True
    assert progress.record_validation(2, 0.79) is False
    assert progress.record_validation(3, 0.80) is False
    assert (progress.best_epoch, progress.best_auc, progress.epochs_without_improvement) == (1, 0.80, 2)
    assert progress.record_validation(4, 0.81) is True
    assert progress.epochs_without_improvement == 0


def test_load_classifier_refuses_bin_before_loading(tmp_path: Path) -> None:
    """.bin이 있는 디렉터리는 transformers로 넘기기 전에 거부한다."""
    (tmp_path / "config.json").write_text("{}", encoding="utf-8")
    (tmp_path / "pytorch_model.bin").write_bytes(b"")
    with pytest.raises(UnsafeWeightsError):
        modeling.load_trained_classifier(tmp_path)


def build_tiny_classifier(**config_overrides: object):
    """네트워크 없이 만드는 아주 작은 ELECTRA 분류 모델."""
    from transformers import ElectraConfig, ElectraForSequenceClassification

    config = ElectraConfig(
        vocab_size=16, embedding_size=8, hidden_size=8, num_hidden_layers=1, num_attention_heads=1, intermediate_size=16, **config_overrides
    )
    return ElectraForSequenceClassification(config)


def test_label_mapping_accepts_saved_and_generic_names() -> None:
    """train이 저장하는 매핑과 이름 없는(LABEL_0·LABEL_1) 기본값은 통과한다."""
    modeling.ensure_binary_classifier(build_tiny_classifier(num_labels=2, id2label=modeling.ID_TO_LABEL, label2id=modeling.LABEL_TO_ID))
    modeling.ensure_binary_classifier(build_tiny_classifier(num_labels=2))


def test_label_mapping_accepts_after_save_and_reload(tmp_path: Path) -> None:
    """JSON 저장 뒤 다시 읽어 키가 문자열이 되어도 통과한다."""
    from transformers import ElectraConfig

    build_tiny_classifier(num_labels=2, id2label=modeling.ID_TO_LABEL, label2id=modeling.LABEL_TO_ID).config.save_pretrained(str(tmp_path))
    reloaded = build_tiny_classifier()
    reloaded.config = ElectraConfig.from_pretrained(str(tmp_path))
    modeling.ensure_binary_classifier(reloaded)


@pytest.mark.parametrize(
    "mapping",
    [{0: "toxic", 1: "normal"}, {0: "normal", 1: "hate"}, {0: "LABEL_0", 1: "toxic"}, {0: "LABEL_1", 1: "LABEL_0"}],
)
def test_label_mapping_rejects_reversed_or_unknown_names(mapping: dict[int, str]) -> None:
    """0번이 toxic이거나 이름이 다르면 점수가 뒤집히므로 거부한다."""
    model = build_tiny_classifier(num_labels=2, id2label=mapping, label2id={name: index for index, name in mapping.items()})
    with pytest.raises(ModelFormatError):
        modeling.ensure_binary_classifier(model)
