"""CLI 인자 검사 테스트: 잘못된 값은 모델을 불러오기 전에 거부되는지(모델·네트워크 없이)."""

from __future__ import annotations

from pathlib import Path

import pytest

from zg_stage1 import evaluate, train
from zg_stage1.errors import OutputExistsError, PathResolutionError, UnsafeWeightsError


def expect_usage_error(parse, argv: list[str]) -> None:
    """argv를 읽으면 argparse 사용법 오류(종료 코드 2)가 나는지 확인한다."""
    with pytest.raises(SystemExit) as exit_info:
        parse(argv)
    assert exit_info.value.code == 2


@pytest.mark.parametrize(
    "argv",
    [
        ["--epochs", "0"],
        ["--epochs", "two"],
        ["--batch-size", "0"],
        ["--learning-rate", "0"],
        ["--learning-rate", "-1e-5"],
        ["--max-steps", "-1"],
        ["--warmup-ratio", "1"],
        ["--weight-decay", "-0.1"],
        ["--max-length", "2"],
        ["--max-length", "513"],
        ["--device", "cuda"],
        ["--early-stop-patience", "0"],
    ],
)
def test_train_rejects_invalid_arguments(argv: list[str]) -> None:
    """train은 범위를 벗어난 값을 사용법 오류로 거부한다."""
    expect_usage_error(train.parse_arguments, argv)


def test_train_defaults() -> None:
    """기본값: 3 epoch, 배치 32, max_length 128, 제한 없는 스텝, 조기 종료 2회, 장치 auto."""
    arguments = train.parse_arguments([])
    assert (arguments.epochs, arguments.batch_size, arguments.max_length) == (3, 32, 128)
    assert (arguments.max_steps, arguments.early_stop_patience, arguments.device) == (0, 2, "auto")


def make_base_model_directory(root: Path, weight_names: list[str]) -> Path:
    """가짜 기반 모델 디렉터리(빈 파일들)를 만든다. 경로 검사만 하므로 내용은 필요 없다."""
    directory = root / "base" / "kcelectra-base"
    directory.mkdir(parents=True)
    for name in weight_names:
        (directory / name).write_bytes(b"")
    return directory


def make_data_files(root: Path) -> None:
    """가짜 K-HATERS train·val·test 파일과 채팅 회귀 파일을 만든다(저장소 파일에 기대지 않게 한다)."""
    data_directory = root / "data" / "k-haters"
    data_directory.mkdir(parents=True)
    for name in ("train_v2.jsonl", "val_v2.jsonl", "test_v2.jsonl"):
        (data_directory / name).write_text('{"id": 1, "text": "가", "label": "normal"}\n', encoding="utf-8")
    (root / "chat.jsonl").write_text('{"id": 1, "group": "normal", "expected": "allow", "text": "가"}\n', encoding="utf-8")


def parse_evaluate_arguments(model_directory: Path, root: Path):
    """가짜 자료 위치(root)를 쓰는 evaluate 인자를 만든다."""
    return evaluate.build_argument_parser().parse_args(["--model-dir", str(model_directory), "--ml-dir", str(root), "--chat-file", str(root / "chat.jsonl")])


def resolve_and_validate(argv: list[str], environment: dict[str, str]) -> train.TrainingPaths:
    """train의 경로 결정·검사만 실행한다(모델은 불러오지 않는다)."""
    from datetime import datetime

    paths = train.resolve_training_paths(train.parse_arguments(argv), environment, datetime(2026, 10, 12, 9, 0, 0))
    train.validate_training_paths(paths)
    return paths


def test_train_paths_default_from_data_directory(tmp_path: Path) -> None:
    """ZG_DATA_DIR만 있으면 그 아래 ml/의 기본 위치를 쓰고, 출력은 시각이 붙은 새 디렉터리다."""
    ml_directory = tmp_path / "ml"
    make_base_model_directory(ml_directory, ["model.safetensors"])
    make_data_files(ml_directory)
    paths = resolve_and_validate([], {"ZG_DATA_DIR": str(tmp_path)})
    assert paths.train_file == ml_directory / "data" / "k-haters" / "train_v2.jsonl"
    assert paths.output_directory == ml_directory / "stage1" / "kcelectra-20261012-090000"


def test_train_refuses_existing_out_dir(tmp_path: Path) -> None:
    """이미 있는 --out-dir는 무거운 작업 전에 거부한다."""
    make_base_model_directory(tmp_path, ["model.safetensors"])
    make_data_files(tmp_path)
    (tmp_path / "existing").mkdir()
    with pytest.raises(OutputExistsError):
        resolve_and_validate(["--ml-dir", str(tmp_path), "--out-dir", str(tmp_path / "existing")], {})


def test_train_refuses_bin_weights(tmp_path: Path) -> None:
    """기반 모델 디렉터리에 .bin이 있으면 거부한다."""
    make_base_model_directory(tmp_path, ["model.safetensors", "pytorch_model.bin"])
    make_data_files(tmp_path)
    with pytest.raises(UnsafeWeightsError, match="pytorch_model.bin"):
        resolve_and_validate(["--ml-dir", str(tmp_path), "--out-dir", str(tmp_path / "new")], {})


def test_train_reports_missing_data(tmp_path: Path) -> None:
    """학습 데이터가 없으면 받는 방법을 알려 준다."""
    make_base_model_directory(tmp_path, ["model.safetensors"])
    with pytest.raises(PathResolutionError, match="학습 데이터"):
        resolve_and_validate(["--ml-dir", str(tmp_path), "--out-dir", str(tmp_path / "new")], {})


def test_train_without_any_location_explains_fix() -> None:
    """경로 인자도 환경 변수도 없으면 설정 방법을 알려 준다."""
    with pytest.raises(PathResolutionError, match="ZG_ML_DIR"):
        resolve_and_validate([], {})


@pytest.mark.parametrize(
    "argv",
    [
        [],
        ["--model-dir", "m", "--limit", "0"],
        ["--model-dir", "m", "--batch-size", "0"],
        ["--model-dir", "m", "--stage1-threshold", "0"],
        ["--model-dir", "m", "--target-recall", "1.2"],
        ["--model-dir", "m", "--device", "gpu"],
    ],
)
def test_evaluate_rejects_invalid_arguments(argv: list[str]) -> None:
    """evaluate는 --model-dir 누락과 범위를 벗어난 값을 사용법 오류로 거부한다."""
    expect_usage_error(evaluate.build_argument_parser().parse_args, argv)


def test_evaluate_defaults_to_cpu_and_spec_threshold() -> None:
    """evaluate 기본값: CPU(워커와 같은 장치), 임계값 0.05, 재현율 목표 0.97."""
    arguments = evaluate.build_argument_parser().parse_args(["--model-dir", "m"])
    assert (arguments.device, arguments.stage1_threshold, arguments.target_recall) == ("cpu", 0.05, 0.97)


def test_evaluate_refuses_to_overwrite_previous_results(tmp_path: Path) -> None:
    """이미 evaluation.json이 있으면 --overwrite 없이는 거부한다."""
    model_directory = make_base_model_directory(tmp_path, ["model.safetensors"])
    make_data_files(tmp_path)
    (model_directory / "evaluation.json").write_text("{}", encoding="utf-8")
    arguments = parse_evaluate_arguments(model_directory, tmp_path)
    paths = evaluate.resolve_evaluation_paths(arguments, {})
    with pytest.raises(OutputExistsError, match="--overwrite"):
        evaluate.validate_evaluation_paths(paths, should_overwrite=False)
    evaluate.validate_evaluation_paths(paths, should_overwrite=True)


def test_evaluate_refuses_bin_weights(tmp_path: Path) -> None:
    """평가할 모델 디렉터리에 .bin이 있으면 거부한다."""
    model_directory = make_base_model_directory(tmp_path, ["model.safetensors", "pytorch_model.bin"])
    make_data_files(tmp_path)
    arguments = parse_evaluate_arguments(model_directory, tmp_path)
    with pytest.raises(UnsafeWeightsError):
        evaluate.validate_evaluation_paths(evaluate.resolve_evaluation_paths(arguments, {}), should_overwrite=False)


def test_train_refuses_out_dir_inside_repository(tmp_path: Path) -> None:
    """train은 저장소 안의 --out-dir를 무거운 작업 전에 거부한다."""
    from zg_stage1.errors import OutputLocationError
    from zg_stage1.paths import REPOSITORY_ROOT

    make_base_model_directory(tmp_path, ["model.safetensors"])
    make_data_files(tmp_path)
    inside = REPOSITORY_ROOT / "workers" / "stage1" / "outputs" / "run"
    with pytest.raises(OutputLocationError):
        resolve_and_validate(["--ml-dir", str(tmp_path), "--out-dir", str(inside)], {})
