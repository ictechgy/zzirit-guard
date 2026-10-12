"""paths 모듈 테스트: ML 디렉터리 우선순위, 출력 덮어쓰기 거부, safetensors만 허용."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest

from zg_stage1.errors import OutputExistsError, PathResolutionError, UnsafeWeightsError
from zg_stage1.paths import (
    create_new_output_directory,
    default_training_output_directory,
    ensure_safetensors_only,
    resolve_ml_directory,
)


def test_explicit_ml_directory_wins(tmp_path: Path) -> None:
    """--ml-dir가 환경 변수보다 앞선다."""
    environment = {"ZG_ML_DIR": "/from/ml", "ZG_DATA_DIR": "/from/data"}
    assert resolve_ml_directory(str(tmp_path), environment) == tmp_path


def test_ml_directory_variable_beats_data_directory() -> None:
    """ZG_ML_DIR가 ZG_DATA_DIR/ml보다 앞선다."""
    assert resolve_ml_directory(None, {"ZG_ML_DIR": "/from/ml", "ZG_DATA_DIR": "/from/data"}) == Path("/from/ml")


def test_data_directory_gets_ml_suffix() -> None:
    """ZG_DATA_DIR만 있으면 그 아래 ml/을 쓴다."""
    assert resolve_ml_directory(None, {"ZG_DATA_DIR": "/from/data"}) == Path("/from/data/ml")


def test_missing_ml_directory_explains_fix() -> None:
    """아무것도 없으면 추측하지 않고, 설정 방법을 담은 오류를 낸다."""
    with pytest.raises(PathResolutionError, match="ZG_DATA_DIR"):
        resolve_ml_directory(None, {})


def test_create_new_output_directory_refuses_existing(tmp_path: Path) -> None:
    """이미 있는 출력 디렉터리는 덮어쓰지 않는다(안의 파일도 그대로 둔다)."""
    existing = tmp_path / "run"
    existing.mkdir()
    (existing / "model.safetensors").write_bytes(b"keep")
    with pytest.raises(OutputExistsError, match="덮어쓰지 않습니다"):
        create_new_output_directory(existing)
    assert (existing / "model.safetensors").read_bytes() == b"keep"


def test_create_new_output_directory_refuses_existing_file(tmp_path: Path) -> None:
    """같은 이름의 파일이 있어도 거부한다."""
    existing = tmp_path / "run"
    existing.write_text("x", encoding="utf-8")
    with pytest.raises(OutputExistsError):
        create_new_output_directory(existing)


def test_create_new_output_directory_creates_parents(tmp_path: Path) -> None:
    """없는 부모 디렉터리까지 만든다."""
    target = tmp_path / "stage1" / "kcelectra-1"
    assert create_new_output_directory(target).is_dir()


def test_default_output_directory_uses_timestamp(tmp_path: Path) -> None:
    """기본 출력 위치는 <ML>/stage1/kcelectra-YYYYMMDD-HHMMSS다."""
    path = default_training_output_directory(tmp_path, datetime(2026, 10, 12, 9, 5, 7))
    assert path == tmp_path / "stage1" / "kcelectra-20261012-090507"


@pytest.mark.parametrize("pickle_name", ["pytorch_model.bin", "model.pt", "weights.pth", "model.ckpt"])
def test_pickle_weights_are_refused_even_with_safetensors(tmp_path: Path, pickle_name: str) -> None:
    """pickle 형식 가중치가 하나라도 있으면 safetensors가 함께 있어도 거부한다."""
    (tmp_path / "model.safetensors").write_bytes(b"")
    (tmp_path / pickle_name).write_bytes(b"")
    with pytest.raises(UnsafeWeightsError, match=pickle_name):
        ensure_safetensors_only(tmp_path)


def test_missing_safetensors_is_refused(tmp_path: Path) -> None:
    """safetensors 가중치가 없으면 거부한다."""
    (tmp_path / "config.json").write_text("{}", encoding="utf-8")
    with pytest.raises(UnsafeWeightsError, match="safetensors 가중치가 없습니다"):
        ensure_safetensors_only(tmp_path)


def test_safetensors_only_is_accepted(tmp_path: Path) -> None:
    """safetensors만 있으면 그 파일 목록을 돌려준다."""
    (tmp_path / "model.safetensors").write_bytes(b"")
    assert ensure_safetensors_only(tmp_path) == [tmp_path / "model.safetensors"]


def test_missing_model_directory_is_reported(tmp_path: Path) -> None:
    """모델 디렉터리가 없으면 받는 방법을 알려 준다."""
    with pytest.raises(PathResolutionError, match="hf download"):
        ensure_safetensors_only(tmp_path / "absent")
