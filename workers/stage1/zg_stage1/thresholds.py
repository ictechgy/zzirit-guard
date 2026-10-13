"""검증셋 점수로 '유해 재현율 목표를 지키는 가장 큰 임계값'을 고른다(참고용).

왜 '가장 큰' 임계값인가: 1차 분류기는 거름망이다. 임계값이 클수록 2차(kanana)로 보내는 양이 줄어 부하가 낮아진다.
그러니 재현율 목표를 지키는 범위에서 가장 큰 값을 찾으면 부하와 놓침 사이의 경계를 알 수 있다.
주의: 결과는 **참고용**이다. 운영 기본값은 스펙 §5.2 ④의 0.05로 둔다. 바꾸는 결정은 사람이 섀도 데이터를 보고 한다.

CLI 사용 예: uv run python -m zg_stage1.thresholds --scores-file <모델 디렉터리>/validation-scores.json --target-recall 0.97
"""

from __future__ import annotations

import argparse
import json
import math
from collections.abc import Sequence
from decimal import ROUND_FLOOR, Decimal
from dataclasses import asdict, dataclass
from pathlib import Path

from zg_stage1.arguments import probability_argument
from zg_stage1.errors import DatasetFormatError, MetricError, PathResolutionError, run_command_line
from zg_stage1.metrics import METRIC_DECIMALS, REPORT_THRESHOLDS, build_threshold_table, ensure_valid_scores_and_labels, summarize_at_threshold

# 재현율 목표 기본값. 유해 댓글 100건 중 97건 이상은 2차로 보내야 한다는 뜻이다.
DEFAULT_TARGET_RECALL = 0.97

# 스펙 §5.2 ④가 정한 1차 통과 임계값. 고른 값과 나란히 보여 줘 비교하게 한다.
SPEC_STAGE1_THRESHOLD = 0.05

# 보고하는 임계값의 소수 자릿수. 이 자릿수로 '내림'해서, 보고한 값을 그대로 써도 재현율 목표를 지키게 한다.
THRESHOLD_DECIMALS = 6


@dataclass(frozen=True)
class ThresholdSelection:
    """임계값 선택 결과. is_advisory는 항상 True로, 운영 설정을 자동으로 바꾸지 않는다는 표시다."""

    target_recall: float
    threshold: float
    achieved_recall: float
    forward_rate: float
    precision: float
    toxic_count: int
    total_count: int
    spec_default_threshold: float
    spec_default_recall: float
    spec_default_forward_rate: float
    is_advisory: bool = True


def validate_target_recall(target_recall: float) -> None:
    """재현율 목표가 (0, 1] 안인지 확인한다. 0 이하면 아무 임계값이나 통과하고, 1 초과는 이룰 수 없다."""
    if not 0 < target_recall <= 1:
        raise MetricError(f"재현율 목표 {target_recall}는 0보다 크고 1 이하여야 합니다. 예: 0.97")


def round_down_threshold(score: float) -> float:
    """점수를 소수 THRESHOLD_DECIMALS자리로 내림한다. 결과는 항상 원래 점수 이하인, 그런 6자리 값 중 가장 큰 값이다.

    가장 가까운 6자리 값이 점수 이하면 그대로 쓴다(예: 0.6은 0.6). 점수보다 크면 내림한다(예: 0.1234568 → 0.123456).
    왜 Decimal인가: float에 10^6을 곱해 floor하면 이진 표현 오차로 원래 점수보다 큰 값이 나올 수 있다.
    float의 정확한 값을 Decimal로 내림하면 결과가 원래 점수를 넘지 않는다.
    """
    nearest = round(score, THRESHOLD_DECIMALS)
    if nearest <= score:
        return nearest
    return float(Decimal(score).quantize(Decimal(1).scaleb(-THRESHOLD_DECIMALS), rounding=ROUND_FLOOR))


def collect_toxic_scores_descending(scores: Sequence[float], labels: Sequence[int]) -> list[float]:
    """유해(라벨 1) 문장의 점수만 내림차순으로 모은다. 유해 문장이 없으면 재현율을 정의할 수 없어 오류를 낸다."""
    ensure_valid_scores_and_labels(scores, labels)
    toxic_scores = sorted((score for score, label in zip(scores, labels, strict=True) if label == 1), reverse=True)
    if not toxic_scores:
        raise MetricError("검증 점수에 유해(라벨 1) 문장이 없습니다. --limit를 늘리거나 검증 파일을 확인하세요.")
    return toxic_scores


def compute_required_toxic_count(target_recall: float, toxic_count: int) -> int:
    """재현율 목표를 채우는 데 필요한 유해 건수 ceil(목표 × 유해 수)를 정확한 십진 계산으로 구한다. 최소 1이다.

    왜 Decimal인가: float 곱(0.97 × 100 = 97.00000000000001)은 필요 건수를 1 늘리고, 여유값을 빼 보정하면 반대로
    목표를 못 채우는 값(0.970000000001 → 97건)이 나온다. 사용자가 입력한 십진 표기 그대로 계산하면 둘 다 없다.
    최소 1로 묶는 이유는 아주 작은 목표에서 인덱스 -1(가장 낮은 점수)을 고르지 않기 위해서다.
    """
    return max(1, math.ceil(Decimal(str(target_recall)) * toxic_count))


def select_threshold_for_recall(scores: Sequence[float], labels: Sequence[int], target_recall: float = DEFAULT_TARGET_RECALL) -> ThresholdSelection:
    """유해 재현율이 target_recall 이상인 임계값 중 가장 큰 값을 고른다(순수 함수).

    원리: 유해 점수를 내림차순으로 놓고, 필요한 건수 k = ceil(목표 × 유해 수)번째 점수를 임계값으로 쓰면
    점수 ≥ 임계값인 유해가 k개 이상이 된다. 이보다 큰 값은 k개를 채우지 못한다.
    보고하는 임계값은 소수 THRESHOLD_DECIMALS자리로 내림하고, 재현율·2차 전달율·정밀도는 그 내림한 값에서 계산한다.
    그래서 보고한 숫자를 그대로 설정에 넣어도 같은 결과가 나온다(반올림해 올리면 유해를 놓칠 수 있다).
    반환: ThresholdSelection(고른 값과 그때의 재현율·2차 전달율·정밀도, 스펙 기본값 0.05일 때의 값).
    """
    validate_target_recall(target_recall)
    toxic_scores = collect_toxic_scores_descending(scores, labels)
    required_count = compute_required_toxic_count(target_recall, len(toxic_scores))
    threshold = round_down_threshold(toxic_scores[required_count - 1])
    selected = summarize_at_threshold(scores, labels, threshold)
    spec_default = summarize_at_threshold(scores, labels, SPEC_STAGE1_THRESHOLD)
    return ThresholdSelection(
        target_recall=target_recall,
        threshold=threshold,
        achieved_recall=selected["toxic_recall"],
        forward_rate=selected["forward_rate"],
        precision=selected["precision"],
        toxic_count=selected["toxic_count"],
        total_count=selected["total_count"],
        spec_default_threshold=SPEC_STAGE1_THRESHOLD,
        spec_default_recall=spec_default["toxic_recall"],
        spec_default_forward_rate=spec_default["forward_rate"],
    )


def selection_to_dict(selection: ThresholdSelection) -> dict:
    """선택 결과를 evaluation.json에 넣을 dict로 바꾼다."""
    return asdict(selection)


def format_selection_markdown(selection: ThresholdSelection) -> str:
    """선택 결과를 사람이 읽을 Markdown 몇 줄로 만든다."""
    return "\n".join(
        [
            f"- 재현율 목표 {selection.target_recall:.2f} → 임계값 **{selection.threshold:.{THRESHOLD_DECIMALS}f}**(내림) "
            f"(재현율 {selection.achieved_recall:.4f}, 2차 전달율 {selection.forward_rate:.4f}, 정밀도 {selection.precision:.4f})",
            f"- 스펙 기본값 {selection.spec_default_threshold} → 재현율 {selection.spec_default_recall:.4f}, "
            f"2차 전달율 {selection.spec_default_forward_rate:.4f}",
            "- 참고용이다. 운영 임계값은 스펙 §5.2 ④의 0.05를 기본으로 두고, 바꾸는 결정은 사람이 한다.",
        ]
    )


def format_threshold_table_markdown(table: list[dict]) -> str:
    """임계값 표(build_threshold_table 결과)를 Markdown 표로 만든다."""
    lines = ["| 임계값 | 유해 재현율 | 2차 전달율 | 정밀도 |", "|---|---|---|---|"]
    for row in table:
        lines.append(f"| {row['threshold']} | {row['toxic_recall']:.4f} | {row['forward_rate']:.4f} | {row['precision']:.4f} |")
    return "\n".join(lines)


def build_argument_parser() -> argparse.ArgumentParser:
    """thresholds CLI의 인자 정의를 만든다."""
    parser = argparse.ArgumentParser(
        prog="python -m zg_stage1.thresholds",
        description="검증 점수(validation-scores.json)로 재현율 목표를 지키는 가장 큰 1차 임계값을 고른다(참고용).",
    )
    parser.add_argument("--scores-file", required=True, help="evaluate가 모델 디렉터리에 쓴 validation-scores.json")
    parser.add_argument("--target-recall", type=probability_argument, default=DEFAULT_TARGET_RECALL, help="유해 재현율 목표(기본 0.97)")
    return parser


def load_validation_scores(path: Path) -> tuple[list[float], list[int]]:
    """validation-scores.json에서 점수와 이진 라벨을 읽는다. 형식이 다르면 고치는 방향을 담은 오류를 낸다."""
    if not path.is_file():
        raise PathResolutionError(f"검증 점수 파일이 없습니다: {path.name}. 먼저 zg_stage1.evaluate를 실행하세요.")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise DatasetFormatError(f"{path.name}: JSON으로 읽을 수 없습니다({error.msg}). evaluate로 다시 만드세요.") from error
    scores = payload.get("scores") if isinstance(payload, dict) else None
    labels = payload.get("binary_labels") if isinstance(payload, dict) else None
    if not isinstance(scores, list) or not isinstance(labels, list):
        raise DatasetFormatError(f"{path.name}: 'scores'와 'binary_labels' 목록이 없습니다. evaluate로 다시 만드세요.")
    return [float(score) for score in scores], [int(label) for label in labels]


def main(argv: Sequence[str] | None = None) -> None:
    """검증 점수를 읽어 임계값 선택 결과와 임계값 표를 Markdown으로 출력한다."""
    arguments = build_argument_parser().parse_args(argv)
    scores, labels = load_validation_scores(Path(arguments.scores_file))
    selection = select_threshold_for_recall(scores, labels, arguments.target_recall)
    print(f"## 1차 임계값 선택(검증 {len(scores)}건, 참고용)\n")
    print(format_selection_markdown(selection))
    print()
    print(format_threshold_table_markdown(build_threshold_table(scores, labels, REPORT_THRESHOLDS)))
    print(f"\n(소수점 {METRIC_DECIMALS}자리 반올림)")


if __name__ == "__main__":
    run_command_line(main)
