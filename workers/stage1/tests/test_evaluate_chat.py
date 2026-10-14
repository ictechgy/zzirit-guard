"""evaluate_chat 모듈 테스트: 범주별 전달률, 구성비 가중, 예산 임계값, 보류셋 보호. 모델 없이 점수를 직접 넣는다."""

from __future__ import annotations

import argparse
from pathlib import Path

import pytest

from zg_stage1.chat_eval_data import ChatEvalItem
from zg_stage1.errors import DatasetFormatError, MetricError, OutputExistsError
from zg_stage1.evaluate_chat import (
    DEFAULT_TRAFFIC_MIX,
    build_chat_report,
    forward_rates_by_category,
    format_chat_report_markdown,
    load_traffic_mix,
    missing_mix_categories,
    resolve_decision,
    resolve_output_path,
    scored_pairs,
    select_budget_threshold,
    summarize_at_chat_threshold,
    validate_traffic_mix,
    weighted_forward_rate,
)


def item(identifier: str, label: str, category: str, split: str = "dev") -> ChatEvalItem:
    """테스트용 평가 문장(원문은 자리표시자)."""
    return ChatEvalItem(identifier, split, label, category, f"{category}-x", "model-a", "model-b", f"문장{identifier}")


# 유해 2범주(threat 핵심, abuse 비핵심)와 허용 2유형. 점수는 손으로 정한 값이다.
ITEMS = [
    item("t1", "harmful", "threat"),
    item("t2", "harmful", "threat"),
    item("a1", "harmful", "abuse"),
    item("f1", "allow", "friendly_profanity"),
    item("f2", "allow", "friendly_profanity"),
    item("s1", "allow", "short_normal"),
    item("x1", "ambiguous", "abuse"),
]
SCORES = [0.9, 0.3, 0.95, 0.8, 0.2, 0.1, 0.99]

# 계산하기 쉬운 구성비: 허용 두 유형이 절반씩.
HALF_HALF_MIX = {"friendly_profanity": 0.5, "short_normal": 0.5}


def test_scored_pairs_drop_ambiguous_and_check_length() -> None:
    """ambiguous는 빼고, 문장과 점수 개수가 다르면 오류를 낸다."""
    assert [pair[0].item_id for pair in scored_pairs(ITEMS, SCORES)] == ["t1", "t2", "a1", "f1", "f2", "s1"]
    with pytest.raises(MetricError, match="개수"):
        scored_pairs(ITEMS, SCORES[:-1])


def test_forward_rates_by_category() -> None:
    """임계값 0.5에서 threat 1/2, abuse 1/1, 칭찬 비속어 1/2, 짧은 일반 0/1을 넘긴다."""
    rates = forward_rates_by_category(scored_pairs(ITEMS, SCORES), 0.5)
    assert rates == {"abuse": 1.0, "friendly_profanity": 0.5, "short_normal": 0.0, "threat": 0.5}


def test_weighted_forward_rate_renormalizes_missing_categories() -> None:
    """평가셋에 없는 범주는 빼고 남은 구성비로 다시 나눈다."""
    rates = {"friendly_profanity": 0.5, "short_normal": 0.0}
    assert weighted_forward_rate(rates, {"friendly_profanity": 0.25, "short_normal": 0.25, "spam": 0.5}) == pytest.approx(0.25)
    assert missing_mix_categories(rates, {"friendly_profanity": 0.5, "spam": 0.5}) == ["spam"]
    with pytest.raises(MetricError, match="하나도 없습니다"):
        weighted_forward_rate(rates, {"spam": 1.0})


def test_summary_reports_critical_and_allow_extremes() -> None:
    """핵심 범주(threat)의 최소·평균 재현율과 허용 유형 최대 전달률을 낸다."""
    summary = summarize_at_chat_threshold(scored_pairs(ITEMS, SCORES), 0.5, HALF_HALF_MIX)
    assert summary["critical_recall_min"] == 0.5 and summary["critical_recall_mean"] == 0.5
    assert summary["allow_forward_max"] == 0.5
    assert summary["weighted_forward_rate"] == 0.25


def test_budget_threshold_is_smallest_meeting_budget() -> None:
    """허용 문장 가중 전달률 25% 이하가 되는 가장 작은 임계값은 0.2를 넘고 0.8 이하인 첫 점수(0.3)다."""
    pairs = scored_pairs(ITEMS, SCORES)
    assert select_budget_threshold(pairs, HALF_HALF_MIX, 0.25) == pytest.approx(0.3)
    assert select_budget_threshold(pairs, HALF_HALF_MIX, 1.0) == pytest.approx(0.1)


def test_budget_threshold_none_when_impossible() -> None:
    """가장 큰 점수를 임계값으로 해도 예산을 넘으면 None이다(아무것도 넘기지 않는 임계값은 고르지 않는다)."""
    pairs = scored_pairs([item("f1", "allow", "friendly_profanity")], [0.8])
    assert select_budget_threshold(pairs, {"friendly_profanity": 1.0}, 0.0) is None


def test_traffic_mix_validation() -> None:
    """기본 구성비는 유효하고, 모르는 범주·음수·합이 1이 아닌 구성비는 오류다."""
    validate_traffic_mix(DEFAULT_TRAFFIC_MIX)
    for bad_mix, message in [({"unknown": 1.0}, "모르는 범주"), ({"spam": -0.5, "abuse": 1.5}, "0 이상"), ({"spam": 0.5}, "합이")]:
        with pytest.raises(DatasetFormatError, match=message):
            validate_traffic_mix(bad_mix)


def test_load_traffic_mix_from_file(tmp_path: Path) -> None:
    """--mix-file JSON을 읽어 검증한다."""
    path = tmp_path / "mix.json"
    path.write_text('{"spam": 0.4, "short_normal": 0.6}', encoding="utf-8")
    assert load_traffic_mix(path) == {"spam": 0.4, "short_normal": 0.6}
    assert load_traffic_mix(None) == DEFAULT_TRAFFIC_MIX


def test_holdout_cannot_choose_threshold() -> None:
    """보류셋에 --forward-budget을 주면 오류다. 고정 임계값은 받는다."""
    with pytest.raises(DatasetFormatError, match="보류셋"):
        resolve_decision(argparse.Namespace(forward_budget=0.3, threshold=None), "holdout")
    assert resolve_decision(argparse.Namespace(forward_budget=None, threshold=0.4), "holdout") == {"mode": "fixed", "threshold": 0.4}
    assert resolve_decision(argparse.Namespace(forward_budget=0.3, threshold=None), "dev") == {"mode": "budget", "budget": 0.3}


def test_output_path_does_not_overwrite(tmp_path: Path) -> None:
    """결과 파일이 이미 있으면 --overwrite 없이 오류다."""
    existing = tmp_path / "chat-eval-dev.json"
    existing.write_text("{}", encoding="utf-8")
    with pytest.raises(OutputExistsError):
        resolve_output_path(argparse.Namespace(output=None, model_dir=tmp_path, overwrite=False), "dev")
    assert resolve_output_path(argparse.Namespace(output=None, model_dir=tmp_path, overwrite=True), "dev") == existing


def test_report_has_scores_by_id_and_no_text() -> None:
    """보고서는 id별 점수를 담고 원문은 담지 않는다. 요약 표도 만들 수 있다."""
    report = build_chat_report(ITEMS, SCORES, HALF_HALF_MIX, {"mode": "budget", "budget": 0.25})
    assert report["scores"]["t1"] == 0.9 and report["counts"] == {"scored": 6, "ambiguous": 1}
    assert report["decision"]["threshold"] == pytest.approx(0.3)
    assert "문장t1" not in str(report)
    assert "가중 전달률" in format_chat_report_markdown(report)
