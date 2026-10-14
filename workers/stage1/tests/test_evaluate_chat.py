"""evaluate_chat 모듈 테스트: 범주별 전달률, 구성비 가중, 예산 임계값, 보류셋 보호. 모델 없이 점수를 직접 넣는다."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pytest

from zg_stage1.chat_eval_data import ALLOW_CATEGORIES, HARMFUL_CATEGORIES, ChatEvalItem
from zg_stage1.data import compute_file_sha256
from zg_stage1.errors import DatasetFormatError, MetricError, OutputExistsError
from zg_stage1.evaluate_chat import (
    DEFAULT_TRAFFIC_MIX,
    build_dev_report,
    build_holdout_report,
    candidate_thresholds,
    forward_rates_by_category,
    format_chat_report_markdown,
    load_traffic_mix,
    RuleRoute,
    load_rule_routes,
    read_dev_threshold,
    require_matching_decision,
    resolve_output_path,
    scored_pairs,
    select_budget_threshold,
    stage2_rates_by_category,
    summarize_at_chat_threshold,
    validate_traffic_mix,
    weighted_forward_rate,
)


def item(identifier: str, label: str, category: str, split: str = "dev") -> ChatEvalItem:
    """테스트용 평가 문장(원문은 자리표시자)."""
    return ChatEvalItem(identifier, split, label, category, f"{category}-x", "model-a", "model-b", f"문장{identifier}")


def full_coverage(harmful_score: float, allow_score: float, split: str = "dev") -> tuple[list[ChatEvalItem], list[float]]:
    """모든 범주에 한 문장씩. 유해는 harmful_score, 허용은 allow_score를 받는다."""
    items = [item(f"h-{category}", "harmful", category, split) for category in HARMFUL_CATEGORIES]
    items += [item(f"a-{category}", "allow", category, split) for category in ALLOW_CATEGORIES]
    return items, [harmful_score] * len(HARMFUL_CATEGORIES) + [allow_score] * len(ALLOW_CATEGORIES)


# 계산하기 쉬운 구성비: 허용 두 유형이 절반씩.
HALF_HALF_MIX = {"friendly_profanity": 0.5, "short_normal": 0.5}


def test_scored_pairs_drop_ambiguous_and_check_length() -> None:
    """ambiguous는 빼고, 문장과 점수 개수가 다르면 오류를 낸다."""
    items = [item("t1", "harmful", "threat"), item("x1", "ambiguous", "abuse")]
    assert [pair.item.item_id for pair in scored_pairs(items, [0.9, 0.9])] == ["t1"]
    with pytest.raises(MetricError, match="개수"):
        scored_pairs(items, [0.9])


def test_forward_rates_by_category() -> None:
    """임계값 이상인 비율을 범주별로 센다(경계값은 넘긴다)."""
    items = [item("t1", "harmful", "threat"), item("t2", "harmful", "threat"), item("f1", "allow", "friendly_profanity")]
    rates = forward_rates_by_category(scored_pairs(items, [0.5, 0.3, 0.8]), 0.5)
    assert rates == {"friendly_profanity": 1.0, "threat": 0.5}


def test_weighted_forward_rate_rejects_missing_categories() -> None:
    """구성비가 있는 범주가 평가셋에 없으면 빼고 나누지 않고 오류를 낸다(부하를 작게 보이게 하지 않으려고)."""
    rates = {"friendly_profanity": 0.5, "short_normal": 0.0}
    assert weighted_forward_rate(rates, HALF_HALF_MIX) == pytest.approx(0.25)
    assert weighted_forward_rate(rates, {"friendly_profanity": 1.0, "spam": 0.0}) == pytest.approx(0.5)
    with pytest.raises(MetricError, match="spam"):
        weighted_forward_rate(rates, {"friendly_profanity": 0.5, "spam": 0.5})


def test_summary_reports_critical_and_allow_extremes() -> None:
    """핵심 범주 재현율 최소·평균과 허용 유형 최대 전달률을 낸다."""
    items, scores = full_coverage(0.9, 0.1)
    scores[HARMFUL_CATEGORIES.index("minors")] = 0.2
    summary = summarize_at_chat_threshold(scored_pairs(items, scores), 0.5, DEFAULT_TRAFFIC_MIX)
    assert summary["critical_recall_min"] == 0.0
    assert summary["critical_recall_mean"] == pytest.approx(0.8)
    assert summary["allow_forward_max"] == 0.0


def test_candidates_are_floored_scores_and_next_grid_values() -> None:
    """후보는 점수를 여섯째 자리에서 내림한 값, 그 바로 위 격자값, 1.0이다. 0은 후보가 아니다(임계값은 0보다 커야 한다)."""
    items = [item("a", "allow", "short_normal"), item("b", "allow", "short_normal"), item("c", "allow", "short_normal")]
    assert candidate_thresholds(scored_pairs(items, [0.3000001, 0.25, 0.0])) == [0.000001, 0.25, 0.250001, 0.3, 0.300001, 1.0]


def test_budget_threshold_is_smallest_grid_value_meeting_budget() -> None:
    """예산 0.75를 지키는 가장 작은 격자값은 점수 0.1인 문장만 빼는 0.100001이다. 고른 값 그대로 예산을 지킨다."""
    items = [item("f1", "allow", "friendly_profanity"), item("s1", "allow", "short_normal"), item("s2", "allow", "short_normal")]
    pairs = scored_pairs(items, [0.3000001, 0.1, 0.9])
    threshold = select_budget_threshold(pairs, HALF_HALF_MIX, 0.75)
    assert threshold == pytest.approx(0.100001)
    assert weighted_forward_rate(forward_rates_by_category(pairs, threshold), HALF_HALF_MIX) <= 0.75


def test_budget_threshold_keeps_boundary_items() -> None:
    """점수 0.3000001인 문장은 내림한 후보(0.3)에서 넘어간다. 올림하면 빠지는 문제를 막는다."""
    items = [item("f1", "allow", "friendly_profanity"), item("s1", "allow", "short_normal")]
    pairs = scored_pairs(items, [0.3000001, 0.2])
    threshold = select_budget_threshold(pairs, HALF_HALF_MIX, 0.5)
    assert threshold == pytest.approx(0.200001)
    assert forward_rates_by_category(pairs, 0.3)["friendly_profanity"] == 1.0


def test_budget_zero_picks_value_just_above_max_score() -> None:
    """예산 0이면 가장 큰 점수 바로 위 격자값을 고른다(아무것도 넘기지 않음)."""
    pairs = scored_pairs([item("f1", "allow", "friendly_profanity")], [0.8])
    assert select_budget_threshold(pairs, {"friendly_profanity": 1.0}, 0.0) == pytest.approx(0.800001)


def test_no_threshold_when_scores_reach_one() -> None:
    """점수가 정확히 1.0이면 임계값 1.0에서도 넘어가므로, 예산 0은 지킬 수 없어 None이다."""
    pairs = scored_pairs([item("f1", "allow", "friendly_profanity")], [1.0])
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


def test_decision_must_match_split() -> None:
    """보류셋에는 개발셋 결과가, 개발셋에는 예산이 있어야 한다."""
    with pytest.raises(DatasetFormatError, match="보류셋"):
        require_matching_decision(argparse.Namespace(forward_budget=0.3, dev_report=None), "holdout")
    with pytest.raises(DatasetFormatError, match="forward-budget"):
        require_matching_decision(argparse.Namespace(forward_budget=None, dev_report=Path("x.json")), "dev")
    require_matching_decision(argparse.Namespace(forward_budget=None, dev_report=Path("x.json")), "holdout")


def write_dev_report(path: Path, model_sha: str, split: str = "dev", rule_routes: dict | None = None) -> Path:
    """개발셋 결과 파일(필요한 필드만)."""
    report = {"split": split, "model_weights_sha256": model_sha, "decision": {"mode": "budget", "threshold": 0.42}, "rule_routes": rule_routes}
    path.write_text(json.dumps(report), encoding="utf-8")
    return path


@pytest.mark.parametrize("bad_threshold", [None, -1, 0, 2, "0.4", True, float("nan")])
def test_dev_threshold_must_be_in_range(tmp_path: Path, bad_threshold: object) -> None:
    """개발셋 결과의 임계값이 (0, 1] 범위의 수가 아니면 오류다(NaN·문자열·불리언 포함)."""
    path = tmp_path / "dev.json"
    path.write_text(json.dumps({"split": "dev", "model_weights_sha256": "abc", "decision": {"mode": "budget", "threshold": bad_threshold}}), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match="범위의 수가 아닙니다"):
        read_dev_threshold(path, "abc", policy_sha256=None)


def test_dev_threshold_requires_same_model(tmp_path: Path) -> None:
    """같은 모델의 개발셋 결과에서만 임계값을 읽는다."""
    assert read_dev_threshold(write_dev_report(tmp_path / "dev.json", "abc"), "abc", policy_sha256=None) == 0.42
    with pytest.raises(DatasetFormatError, match="다른 모델"):
        read_dev_threshold(write_dev_report(tmp_path / "other.json", "abc"), "xyz", policy_sha256=None)
    with pytest.raises(DatasetFormatError, match="개발셋 예산 결과가 아닙니다"):
        read_dev_threshold(write_dev_report(tmp_path / "holdout.json", "abc", split="holdout"), "abc", policy_sha256=None)


def test_dev_threshold_requires_same_rule_policy(tmp_path: Path) -> None:
    """보류셋은 개발셋과 같은 규칙 목록(지문)으로 만든 규칙 경로를 써야 한다. 쓰지 않은 쪽과도 섞지 않는다."""
    with_routes = write_dev_report(tmp_path / "with.json", "abc", rule_routes={"file_name": "rules-dev.jsonl", "policy_sha256": "p1"})
    assert read_dev_threshold(with_routes, "abc", policy_sha256="p1") == 0.42
    for policy in (None, "p2"):
        with pytest.raises(DatasetFormatError, match="규칙 경로"):
            read_dev_threshold(with_routes, "abc", policy_sha256=policy)
    with pytest.raises(DatasetFormatError, match="규칙 경로"):
        read_dev_threshold(write_dev_report(tmp_path / "without.json", "abc"), "abc", policy_sha256="p1")


def test_rule_routes_count_toward_recall_but_not_stage2_load() -> None:
    """규칙이 잡은 문장은 재현율에는 들어가지만 2차 부하에서는 빠진다. 키워드 경로 문장은 둘 다에 들어간다.
    가벼운 반응(AI 건너뜀)은 점수가 높아도 2차 부하에 넣지 않는다."""
    items = [item("d1", "harmful", "doxxing"), item("s1", "harmful", "self_harm"), item("n1", "allow", "short_normal"), item("n2", "allow", "long_normal")]
    routes = {
        "d1": RuleRoute(rule_flagged=True, keyword=False), "s1": RuleRoute(rule_flagged=False, keyword=True),
        "n1": RuleRoute(False, False, skip_ai=True), "n2": RuleRoute(False, False),
    }
    pairs = scored_pairs(items, [0.1, 0.1, 0.9, 0.1], routes)
    assert forward_rates_by_category(pairs, 0.5) == {"doxxing": 1.0, "long_normal": 0.0, "self_harm": 1.0, "short_normal": 1.0}
    assert stage2_rates_by_category(pairs, 0.5) == {"doxxing": 0.0, "long_normal": 0.0, "self_harm": 1.0, "short_normal": 0.0}
    assert stage2_rates_by_category(pairs, 0.05) == {"doxxing": 0.0, "long_normal": 1.0, "self_harm": 1.0, "short_normal": 0.0}


def route_line(identifier: str, decision: str, keyword: int | None, eval_sha: str, policy: str = "p1", skip_ai: bool = False) -> str:
    """규칙 평가 도구가 쓰는 결과 한 줄."""
    record = {"id": identifier, "decision": decision, "reason": "x", "keyword": keyword, "skipAi": skip_ai, "evalSha256": eval_sha, "policySha256": policy}
    return json.dumps(record) + "\n"


def test_load_rule_routes_validates_ids_hashes_and_policy(tmp_path: Path) -> None:
    """규칙 결과의 id가 평가셋과 같고, 평가셋 파일 해시가 맞고, 규칙 목록 지문이 하나여야 한다."""
    items = [item("a", "allow", "short_normal"), item("b", "harmful", "spam")]
    eval_path = tmp_path / "dev.jsonl"
    eval_path.write_text("평가셋 내용", encoding="utf-8")
    sha = compute_file_sha256(eval_path)
    good = tmp_path / "good.jsonl"
    good.write_text(route_line("a", "pass", None, sha, skip_ai=True) + route_line("b", "candidate", 3, sha))
    assert load_rule_routes(good, items, eval_path) == ({"a": RuleRoute(False, False, True), "b": RuleRoute(True, True)}, "p1")
    cases = [
        (route_line("a", "pass", None, sha), "id가 평가셋과 다릅니다"),
        (route_line("a", "block", None, sha) + route_line("b", "pass", None, sha), "규칙 경로 결과 형식"),
        (route_line("a", "pass", None, "old") + route_line("b", "pass", None, "old"), "평가셋 파일과 한 규칙 목록"),
        (route_line("a", "pass", None, sha, "p1") + route_line("b", "pass", None, sha, "p2"), "평가셋 파일과 한 규칙 목록"),
    ]
    for content, message in cases:
        bad = tmp_path / "bad.jsonl"
        bad.write_text(content)
        with pytest.raises(DatasetFormatError, match=message):
            load_rule_routes(bad, items, eval_path)


def test_output_path_protects_holdout_results(tmp_path: Path) -> None:
    """개발셋 결과는 --overwrite로만 바꾸고, 보류셋 결과는 --overwrite가 있어도 바꾸지 않는다."""
    for split in ("dev", "holdout"):
        (tmp_path / f"chat-eval-{split}.json").write_text("{}", encoding="utf-8")
    assert resolve_output_path(argparse.Namespace(output=None, model_dir=tmp_path, overwrite=True), "dev").name == "chat-eval-dev.json"
    with pytest.raises(OutputExistsError):
        resolve_output_path(argparse.Namespace(output=None, model_dir=tmp_path, overwrite=False), "dev")
    with pytest.raises(OutputExistsError):
        resolve_output_path(argparse.Namespace(output=None, model_dir=tmp_path, overwrite=True), "holdout")
    with pytest.raises(DatasetFormatError, match="--output"):
        resolve_output_path(argparse.Namespace(output=tmp_path / "elsewhere.json", model_dir=tmp_path, overwrite=False), "holdout")


def test_dev_report_has_table_scores_and_no_text() -> None:
    """개발셋 결과는 임계값 표와 id별 점수를 담고 원문은 담지 않는다."""
    items, scores = full_coverage(0.9, 0.1)
    report = build_dev_report(items, scores, DEFAULT_TRAFFIC_MIX, 0.5)
    assert report["scores"]["h-threat"] == 0.9 and len(report["threshold_table"]) == 10
    assert report["decision"]["at_threshold"]["critical_recall_min"] == 1.0
    assert "문장h-threat" not in json.dumps(report, ensure_ascii=False)
    assert "가중 전달률" in format_chat_report_markdown(report)


def test_holdout_report_hides_table_and_scores() -> None:
    """보류셋 결과에는 임계값 표와 문장별 점수가 없다(보류셋으로 임계값을 다시 고르지 못하게)."""
    items, scores = full_coverage(0.9, 0.1, split="holdout")
    report = build_holdout_report(items, scores, DEFAULT_TRAFFIC_MIX, 0.42)
    assert "threshold_table" not in report and "scores" not in report
    expected_summary = summarize_at_chat_threshold(scored_pairs(items, scores), 0.42, DEFAULT_TRAFFIC_MIX)
    assert report["decision"] == {"mode": "fixed", "threshold": 0.42, "at_threshold": expected_summary}
    assert format_chat_report_markdown(report).count("| 0.42 |") == 1
