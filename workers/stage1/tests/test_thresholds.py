"""thresholds 모듈 테스트: 재현율 목표를 지키는 가장 큰 임계값 선택과 CLI 인자 검사."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from zg_stage1.errors import DatasetFormatError, MetricError
from zg_stage1.thresholds import SPEC_STAGE1_THRESHOLD, build_argument_parser, main, select_threshold_for_recall

# 유해 5건(0.9·0.8·0.7·0.6·0.1)과 정상 3건(0.65·0.3·0.02)으로 만든 작은 예제.
EXAMPLE_SCORES = [0.9, 0.8, 0.7, 0.6, 0.1, 0.65, 0.3, 0.02]
EXAMPLE_LABELS = [1, 1, 1, 1, 1, 0, 0, 0]


def test_selects_largest_threshold_meeting_target() -> None:
    """목표 0.8이면 유해 4건이 필요하므로 4번째로 큰 유해 점수 0.6을 고른다."""
    selection = select_threshold_for_recall(EXAMPLE_SCORES, EXAMPLE_LABELS, target_recall=0.8)
    assert selection.threshold == pytest.approx(0.6)
    assert selection.achieved_recall == pytest.approx(0.8)
    assert selection.forward_rate == pytest.approx(5 / 8)
    assert selection.precision == pytest.approx(0.8)


def test_any_larger_threshold_misses_target() -> None:
    """고른 값보다 조금이라도 크면 목표를 못 지킨다(가장 큰 값인지 확인)."""
    selection = select_threshold_for_recall(EXAMPLE_SCORES, EXAMPLE_LABELS, target_recall=0.8)
    toxic_scores = [score for score, label in zip(EXAMPLE_SCORES, EXAMPLE_LABELS, strict=True) if label == 1]
    recall_above = sum(score >= selection.threshold + 1e-9 for score in toxic_scores) / len(toxic_scores)
    assert recall_above < 0.8


def test_full_recall_uses_smallest_toxic_score() -> None:
    """목표 1.0이면 가장 작은 유해 점수를 고른다."""
    assert select_threshold_for_recall(EXAMPLE_SCORES, EXAMPLE_LABELS, target_recall=1.0).threshold == pytest.approx(0.1)


def test_float_rounding_does_not_demand_extra_item() -> None:
    """0.07 × 100 = 7.000000000000001이어도 8건이 아니라 7건을 요구한다(부동소수 오차 여유값 확인)."""
    scores = [index / 100 for index in range(100, 0, -1)]
    selection = select_threshold_for_recall(scores, [1] * 100, target_recall=0.07)
    assert selection.threshold == pytest.approx(0.94)
    assert selection.achieved_recall == pytest.approx(0.07)


def test_ties_keep_target() -> None:
    """동점이 있어도 재현율은 목표 이상이다."""
    selection = select_threshold_for_recall([0.5, 0.5, 0.5, 0.2], [1, 1, 1, 1], target_recall=0.5)
    assert selection.threshold == pytest.approx(0.5)
    assert selection.achieved_recall == pytest.approx(0.75)


def test_reports_spec_default_alongside() -> None:
    """스펙 기본값 0.05일 때의 재현율·통과율을 함께 보고하고, 결과는 참고용으로 표시한다."""
    selection = select_threshold_for_recall(EXAMPLE_SCORES, EXAMPLE_LABELS, target_recall=0.8)
    assert selection.spec_default_threshold == SPEC_STAGE1_THRESHOLD
    assert selection.spec_default_recall == pytest.approx(1.0)
    assert selection.spec_default_forward_rate == pytest.approx(7 / 8)
    assert selection.is_advisory is True


@pytest.mark.parametrize("target", [0.0, -0.1, 1.01])
def test_invalid_target_is_rejected(target: float) -> None:
    """목표는 (0, 1] 안이어야 한다."""
    with pytest.raises(MetricError):
        select_threshold_for_recall(EXAMPLE_SCORES, EXAMPLE_LABELS, target_recall=target)


def test_no_toxic_scores_is_rejected() -> None:
    """유해 문장이 없으면 재현율을 정의할 수 없어 오류를 낸다."""
    with pytest.raises(MetricError, match="유해"):
        select_threshold_for_recall([0.1, 0.2], [0, 0])


@pytest.mark.parametrize("value", ["0", "1.5", "abc"])
def test_cli_rejects_bad_target_recall(value: str) -> None:
    """CLI는 잘못된 --target-recall을 사용법 오류(종료 코드 2)로 거부한다."""
    with pytest.raises(SystemExit) as exit_info:
        build_argument_parser().parse_args(["--scores-file", "x.json", "--target-recall", value])
    assert exit_info.value.code == 2


def test_cli_prints_selection(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """검증 점수 파일을 읽어 선택 결과를 Markdown으로 출력한다."""
    path = tmp_path / "validation-scores.json"
    path.write_text(json.dumps({"scores": EXAMPLE_SCORES, "binary_labels": EXAMPLE_LABELS}), encoding="utf-8")
    main(["--scores-file", str(path), "--target-recall", "0.8"])
    assert "0.6000" in capsys.readouterr().out


def test_cli_rejects_malformed_scores_file(tmp_path: Path) -> None:
    """형식이 다른 점수 파일은 고치는 방향을 담은 오류를 낸다."""
    path = tmp_path / "validation-scores.json"
    path.write_text(json.dumps({"scores": [0.1]}), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match="evaluate로 다시"):
        main(["--scores-file", str(path)])
