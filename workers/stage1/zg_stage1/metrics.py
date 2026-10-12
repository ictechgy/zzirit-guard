"""이진 분류 지표: ROC AUC, 임계값별 재현율·통과율·정밀도·F1, 임계값 표.

scikit-learn을 쓰지 않는 이유: 필요한 지표가 몇 개뿐이라 직접 쓰는 편이 운영자 설치를 가볍게 한다.
대신 알려진 예제로 단위 테스트한다(tests/test_metrics.py).
점수(score)는 '유해일 확률'이고, 점수가 임계값 이상이면 '표시(2차로 보냄)'로 본다(스펙 §5.2 ④의 '0.05 이상').
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from zg_stage1.errors import MetricError

# 평가 보고서의 임계값 표에 넣는 값. 1차 분류기는 거름망이라 재현율을 지키는 낮은 쪽을 촘촘히 본다.
REPORT_THRESHOLDS: tuple[float, ...] = (0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5)

# 일반적인 분류 성능(F1 등)을 볼 때 쓰는 기준 임계값.
STANDARD_THRESHOLD = 0.5

# 지표를 결과 파일에 쓸 때의 소수점 자릿수. 비교하기 쉬운 정도로만 자른다.
METRIC_DECIMALS = 4


@dataclass(frozen=True)
class ConfusionCounts:
    """한 임계값에서의 혼동 행렬 칸 수. 양성(positive)은 유해(라벨 1)다."""

    true_positive: int
    false_positive: int
    true_negative: int
    false_negative: int


def ensure_same_length(scores: Sequence[float], labels: Sequence[int]) -> None:
    """점수와 라벨 개수가 같은지 확인한다. 다르면 짝이 어긋난 것이라 지표가 무의미하므로 오류를 낸다."""
    if len(scores) != len(labels):
        raise MetricError(f"점수 {len(scores)}개와 라벨 {len(labels)}개의 개수가 다릅니다. 입력 순서를 맞췄는지 확인하세요.")


def safe_divide(numerator: float, denominator: float) -> float:
    """분모가 0이면 0.0을 돌려주는 나눗셈.

    왜: 표시한 것이 하나도 없을 때의 정밀도처럼 정의되지 않는 값을 0으로 보는 관례(scikit-learn zero_division=0)를 따른다.
    """
    return numerator / denominator if denominator else 0.0


def count_confusion(scores: Sequence[float], labels: Sequence[int], threshold: float) -> ConfusionCounts:
    """점수 ≥ threshold를 '유해로 표시'로 보고 혼동 행렬 칸 수를 센다."""
    ensure_same_length(scores, labels)
    true_positive = false_positive = true_negative = false_negative = 0
    for score, label in zip(scores, labels, strict=True):
        is_flagged = score >= threshold
        true_positive += is_flagged and label == 1
        false_positive += is_flagged and label == 0
        false_negative += (not is_flagged) and label == 1
        true_negative += (not is_flagged) and label == 0
    return ConfusionCounts(true_positive, false_positive, true_negative, false_negative)


def summarize_at_threshold(scores: Sequence[float], labels: Sequence[int], threshold: float) -> dict:
    """한 임계값에서의 유해 재현율·통과율(2차로 보내는 비율)·정밀도·F1을 계산한다.

    반환 키: threshold, toxic_recall, forward_rate, precision, f1, flagged_count, toxic_count, total_count.
    """
    counts = count_confusion(scores, labels, threshold)
    flagged_count = counts.true_positive + counts.false_positive
    toxic_count = counts.true_positive + counts.false_negative
    recall = safe_divide(counts.true_positive, toxic_count)
    precision = safe_divide(counts.true_positive, flagged_count)
    return {
        "threshold": threshold,
        "toxic_recall": round(recall, METRIC_DECIMALS),
        "forward_rate": round(safe_divide(flagged_count, len(scores)), METRIC_DECIMALS),
        "precision": round(precision, METRIC_DECIMALS),
        "f1": round(safe_divide(2 * precision * recall, precision + recall), METRIC_DECIMALS),
        "flagged_count": flagged_count,
        "toxic_count": toxic_count,
        "total_count": len(scores),
    }


def build_threshold_table(scores: Sequence[float], labels: Sequence[int], thresholds: Sequence[float] = REPORT_THRESHOLDS) -> list[dict]:
    """여러 임계값의 summarize_at_threshold 결과를 임계값 순서대로 모은다."""
    return [summarize_at_threshold(scores, labels, threshold) for threshold in thresholds]


def compute_average_ranks(scores: Sequence[float]) -> list[float]:
    """점수의 순위(1부터)를 매기되, 같은 점수끼리는 평균 순위를 준다.

    왜 평균 순위인가: 동점을 라벨 순서로 정렬하면 AUC가 한쪽으로 치우친다. 평균 순위가 표준 정의(Mann-Whitney U)다.
    """
    order = sorted(range(len(scores)), key=scores.__getitem__)
    ranks = [0.0] * len(scores)
    start = 0
    while start < len(order):
        end = start
        while end + 1 < len(order) and scores[order[end + 1]] == scores[order[start]]:
            end += 1
        for position in range(start, end + 1):
            ranks[order[position]] = (start + end) / 2 + 1
        start = end + 1
    return ranks


def compute_roc_auc(scores: Sequence[float], labels: Sequence[int]) -> float:
    """ROC AUC를 순위 합(Mann-Whitney U)으로 계산한다. 임계값과 무관한 분리 능력 지표다.

    반환: 0~1. 무작위 점수면 약 0.5다.
    주의: 정상·유해가 모두 있어야 정의된다. 한쪽만 있으면 오류를 낸다(--limit를 너무 작게 줬을 때 생길 수 있다).
    """
    ensure_same_length(scores, labels)
    positive_count = sum(1 for label in labels if label == 1)
    negative_count = len(labels) - positive_count
    if positive_count == 0 or negative_count == 0:
        raise MetricError("AUC는 정상(0)과 유해(1)가 모두 있어야 계산할 수 있습니다. --limit를 늘리거나 데이터 파일을 확인하세요.")
    ranks = compute_average_ranks(scores)
    positive_rank_sum = sum(rank for rank, label in zip(ranks, labels, strict=True) if label == 1)
    return (positive_rank_sum - positive_count * (positive_count + 1) / 2) / (positive_count * negative_count)
