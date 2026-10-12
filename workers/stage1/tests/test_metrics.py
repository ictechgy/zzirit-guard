"""metrics 모듈 테스트: AUC(알려진 예제·동점·한 클래스), 임계값 표."""

from __future__ import annotations

import pytest

from zg_stage1.errors import MetricError
from zg_stage1.metrics import build_threshold_table, compute_average_ranks, compute_roc_auc, summarize_at_threshold


def test_auc_matches_known_example() -> None:
    """scikit-learn 문서의 roc_auc_score 예제(y=[0,0,1,1], s=[0.1,0.4,0.35,0.8])는 0.75다."""
    assert compute_roc_auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]) == pytest.approx(0.75)


def test_auc_perfect_and_inverted() -> None:
    """완전히 분리되면 1.0, 반대로 분리되면 0.0이다."""
    assert compute_roc_auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]) == pytest.approx(1.0)
    assert compute_roc_auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]) == pytest.approx(0.0)


def test_auc_counts_ties_as_half() -> None:
    """동점은 절반으로 센다: 모든 점수가 같으면 0.5다(라벨 순서와 무관)."""
    assert compute_roc_auc([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0]) == pytest.approx(0.5)
    assert compute_roc_auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]) == pytest.approx(0.5)


def test_average_ranks_with_ties() -> None:
    """같은 점수는 평균 순위를 받는다."""
    assert compute_average_ranks([0.3, 0.1, 0.3, 0.2]) == [3.5, 1.0, 3.5, 2.0]


def test_auc_requires_both_classes() -> None:
    """한 클래스만 있으면 AUC를 정의할 수 없어 오류를 낸다."""
    with pytest.raises(MetricError, match="모두 있어야"):
        compute_roc_auc([0.1, 0.9], [1, 1])


def test_auc_rejects_length_mismatch() -> None:
    """점수와 라벨 개수가 다르면 오류를 낸다."""
    with pytest.raises(MetricError, match="개수가 다릅니다"):
        compute_roc_auc([0.1, 0.9, 0.5], [0, 1])


def test_summarize_at_threshold_counts() -> None:
    """임계값 0.5: 유해 3건 중 2건 표시(재현율 2/3), 표시 3건 중 유해 2건(정밀도 2/3), 2차 전달율 3/5."""
    summary = summarize_at_threshold([0.9, 0.6, 0.1, 0.7, 0.2], [1, 1, 1, 0, 0], 0.5)
    assert summary["toxic_recall"] == pytest.approx(0.6667)
    assert summary["precision"] == pytest.approx(0.6667)
    assert summary["forward_rate"] == pytest.approx(0.6)
    assert summary["f1"] == pytest.approx(0.6667)
    assert (summary["flagged_count"], summary["toxic_count"], summary["total_count"]) == (3, 3, 5)


def test_threshold_is_inclusive() -> None:
    """점수가 임계값과 같으면 표시한다(스펙의 '0.05 이상')."""
    assert summarize_at_threshold([0.05], [1], 0.05)["toxic_recall"] == 1.0


def test_summarize_with_nothing_flagged_has_zero_precision() -> None:
    """아무것도 표시하지 않으면 정밀도·F1을 0으로 본다(0으로 나누지 않는다)."""
    summary = summarize_at_threshold([0.1, 0.2], [1, 0], 0.9)
    assert (summary["precision"], summary["f1"], summary["forward_rate"]) == (0.0, 0.0, 0.0)


def test_threshold_table_keeps_order_and_is_monotonic() -> None:
    """임계값 표는 주어진 순서를 지키고, 임계값이 커질수록 재현율·2차 전달율이 줄거나 같다."""
    scores = [0.005, 0.015, 0.04, 0.08, 0.15, 0.25, 0.4, 0.6, 0.03, 0.9]
    labels = [0, 1, 0, 1, 0, 1, 1, 1, 0, 1]
    table = build_threshold_table(scores, labels)
    assert [row["threshold"] for row in table] == [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5]
    recalls = [row["toxic_recall"] for row in table]
    forward_rates = [row["forward_rate"] for row in table]
    assert recalls == sorted(recalls, reverse=True)
    assert forward_rates == sorted(forward_rates, reverse=True)
