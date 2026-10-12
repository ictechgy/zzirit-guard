"""최고 epoch 저장의 원자성 테스트(가짜 모델): 저장이 중간에 끊겨도 반쯤 쓴 model.safetensors가 남지 않는다."""

from __future__ import annotations

from pathlib import Path

import pytest

from zg_stage1 import modeling


class FakeModel:
    """save_pretrained만 흉내 내는 가짜 모델. should_fail이면 가중치를 반쯤 쓴 뒤 예외를 낸다."""

    def __init__(self, payload: bytes, should_fail: bool = False) -> None:
        """payload: model.safetensors에 쓸 내용. should_fail: 쓰는 도중 실패를 흉내 낼지."""
        self.payload = payload
        self.should_fail = should_fail

    def save_pretrained(self, directory: str, state_dict: dict) -> None:
        """config.json과 model.safetensors를 쓴다. 실패 모드면 절반만 쓰고 예외를 낸다."""
        (Path(directory) / "config.json").write_text("{}", encoding="utf-8")
        weights = self.payload[: len(self.payload) // 2] if self.should_fail else self.payload
        (Path(directory) / "model.safetensors").write_bytes(weights)
        if self.should_fail:
            raise OSError("디스크가 가득 찼습니다(흉내)")


class FakeTokenizer:
    """save_pretrained만 흉내 내는 가짜 토크나이저."""

    def save_pretrained(self, directory: str) -> None:
        """tokenizer.json을 쓴다."""
        (Path(directory) / "tokenizer.json").write_text("{}", encoding="utf-8")


def test_atomic_save_moves_all_files_and_cleans_staging(tmp_path: Path) -> None:
    """저장이 성공하면 파일이 출력 디렉터리로 옮겨지고 임시 하위 디렉터리는 남지 않는다."""
    (tmp_path / "model-card.json").write_text("{}", encoding="utf-8")
    modeling.save_classifier_atomically(FakeModel(b"new-weights"), FakeTokenizer(), {}, tmp_path)
    assert (tmp_path / "model.safetensors").read_bytes() == b"new-weights"
    assert sorted(path.name for path in tmp_path.iterdir()) == ["config.json", "model-card.json", "model.safetensors", "tokenizer.json"]


def test_interrupted_save_keeps_previous_weights(tmp_path: Path) -> None:
    """저장이 중간에 끊기면 앞서 저장한 가중치가 그대로 남고, 반쯤 쓴 파일과 임시 디렉터리는 남지 않는다."""
    (tmp_path / "model.safetensors").write_bytes(b"previous-best")
    with pytest.raises(OSError, match="흉내"):
        modeling.save_classifier_atomically(FakeModel(b"new-weights-that-fail", should_fail=True), FakeTokenizer(), {}, tmp_path)
    assert (tmp_path / "model.safetensors").read_bytes() == b"previous-best"
    assert [path.name for path in tmp_path.iterdir()] == ["model.safetensors"]


def test_interrupted_first_save_leaves_no_weights(tmp_path: Path) -> None:
    """첫 저장이 끊기면 model.safetensors가 아예 없다(반쯤 쓴 파일이 '정상 가중치'로 보이지 않게)."""
    with pytest.raises(OSError):
        modeling.save_classifier_atomically(FakeModel(b"weights", should_fail=True), FakeTokenizer(), {}, tmp_path)
    assert list(tmp_path.iterdir()) == []
