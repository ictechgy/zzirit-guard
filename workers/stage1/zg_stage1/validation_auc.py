"""K-HATERS 검증 파일에서 M2 3차 정책 정렬 AUC를 계산한다.

기본 평가는 원래 라벨을 그대로 쓰고, --exclude-untargeted-offensive를 고르면 offensive이면서
target_label이 빈 목록인 줄을 제외한다. 원문이나 id 목록은 결과에 쓰지 않고 제외 id의 지문만 남긴다.
"""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path

from zg_stage1 import modeling
from zg_stage1.arguments import positive_integer
from zg_stage1.data import (
    LabeledText,
    compute_file_sha256,
    compute_identifier_list_sha256,
    load_labeled_texts,
    load_labeled_texts_excluding_untargeted_offensive,
)
from zg_stage1.errors import OutputExistsError, run_command_line
from zg_stage1.evaluate import resolve_max_length
from zg_stage1.metrics import METRIC_DECIMALS, compute_roc_auc
from zg_stage1.model_card import read_model_card, utc_timestamp, write_json_atomically


def build_argument_parser() -> argparse.ArgumentParser:
    """CLI 인자."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage1.validation_auc", description="정책 정렬 K-HATERS 검증 AUC 계산")
    parser.add_argument("--model-dir", type=Path, required=True, help="train이 만든 1차 모델 디렉터리")
    parser.add_argument("--val-file", type=Path, required=True, help="K-HATERS validation JSONL")
    parser.add_argument("--exclude-untargeted-offensive", action="store_true", help="offensive이고 target_label이 빈 줄을 제외한다")
    parser.add_argument("--output", type=Path, required=True, help="새 결과 JSON 경로(기존 파일은 덮어쓰지 않음)")
    parser.add_argument("--device", choices=("cpu", "mps"), default="cpu", help="점수 계산 장치(기본 cpu)")
    parser.add_argument("--batch-size", type=positive_integer, default=modeling.DEFAULT_INFERENCE_BATCH_SIZE, help="점수 계산 배치 크기")
    return parser


def load_validation_records(path: Path, exclude_untargeted: bool) -> tuple[list[LabeledText], list[str]]:
    """선택지가 있을 때만 target_label을 읽어 정책과 어긋난 offensive 줄을 제외한다."""
    if exclude_untargeted:
        return load_labeled_texts_excluding_untargeted_offensive(path)
    return load_labeled_texts(path), []


def ensure_output_absent(path: Path) -> None:
    """앞선 AUC 근거를 지키려고 결과를 덮어쓰지 않는다."""
    if path.exists():
        raise OutputExistsError(f"{path.name}이 이미 있습니다. 앞선 검증 AUC 근거를 지키려고 덮어쓰지 않습니다. 다른 --output을 주세요.")


def build_report(arguments: argparse.Namespace, records: Sequence[LabeledText], excluded_ids: Sequence[str], scores: Sequence[float]) -> dict:
    """원문 없이 AUC와 입력·가중치 지문을 만든다."""
    labels = [record.binary_label for record in records]
    return {
        "auc": round(compute_roc_auc(scores, labels), METRIC_DECIMALS),
        "rows_scored": len(records),
        "rows_excluded": len(excluded_ids),
        "excluded_ids_sha256": compute_identifier_list_sha256(excluded_ids),
        "val_file": {"name": arguments.val_file.name, "sha256": compute_file_sha256(arguments.val_file)},
        "model_weights_sha256": compute_file_sha256(arguments.model_dir / modeling.WEIGHTS_FILE_NAME),
        "created_at": utc_timestamp(),
    }


def main(argv: Sequence[str] | None = None) -> None:
    """입력을 검증하고 학습 검증과 같은 토큰화·최대 길이로 채점한 뒤 새 JSON을 쓴다."""
    arguments = build_argument_parser().parse_args(argv)
    ensure_output_absent(arguments.output)
    records, excluded_ids = load_validation_records(arguments.val_file, arguments.exclude_untargeted_offensive)
    device = modeling.resolve_device(arguments.device)
    model_card = read_model_card(arguments.model_dir)
    max_length = resolve_max_length(arguments.model_dir, model_card)
    tokenizer = modeling.load_trained_tokenizer(arguments.model_dir)
    model = modeling.move_model_to_device(modeling.load_trained_classifier(arguments.model_dir), device)
    scores = modeling.score_texts(model, tokenizer, [record.text for record in records], device, max_length, arguments.batch_size)
    report = build_report(arguments, records, excluded_ids, scores)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomically(arguments.output, report)
    print(f"검증 {len(records)}줄 AUC {report['auc']:.4f}, 제외 {len(excluded_ids)}줄 → {arguments.output.name}")


if __name__ == "__main__":
    run_command_line(main)
