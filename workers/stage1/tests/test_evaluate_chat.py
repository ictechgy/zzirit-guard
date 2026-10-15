"""evaluate_chat 모듈 테스트: 범주별 전달률, 구성비 가중, 예산 임계값, 보류셋 보호. 모델 없이 점수를 직접 넣는다."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pytest

from zg_stage1.chat_eval_data import ALLOW_CATEGORIES, HARMFUL_CATEGORIES, ChatEvalItem
from zg_stage1.data import compute_file_sha256
from zg_stage1.errors import DatasetFormatError, MetricError, ModelFormatError, OutputExistsError
from zg_stage1.evaluate_chat import (
    DEFAULT_TRAFFIC_MIX,
    average_model_scores,
    build_dev_report,
    build_holdout_report,
    candidate_thresholds,
    endpoint_candidate_rates_by_category,
    forward_rates_by_category,
    format_chat_report_markdown,
    load_traffic_mix,
    load_stage2_scores,
    RuleRoute,
    ShortRule,
    load_rule_routes,
    message_length,
    model_training_data_sha256,
    model_training_seed,
    short_rule_argument,
    read_dev_threshold,
    require_matching_decision,
    resolve_output_path,
    score_items,
    score_model_items,
    scored_pairs,
    select_budget_threshold,
    stage2_rates_by_category,
    summarize_at_chat_threshold,
    validate_traffic_mix,
    weighted_forward_rate,
    write_raw_score_artifacts,
)
from zg_stage1.model_card import require_completed_training


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


def write_dev_report(path: Path, model_sha: str, split: str = "dev", rule_routes: dict | None = None, short_rule: dict | None = None) -> Path:
    """개발셋 결과 파일(필요한 필드만)."""
    report = {"split": split, "model_weights_sha256": model_sha, "decision": {"mode": "budget", "threshold": 0.42}, "rule_routes": rule_routes}
    report["short_rule"] = short_rule
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
    legacy = write_dev_report(tmp_path / "legacy.json", "abc", rule_routes={"file_name": "rules-dev.jsonl"})
    with pytest.raises(DatasetFormatError, match="지문이 없는 옛 결과"):
        read_dev_threshold(legacy, "abc", policy_sha256=None)


def test_rule_routes_count_toward_recall_but_not_stage2_load() -> None:
    """규칙이 잡은 문장은 재현율에는 들어가지만 2차 부하에서는 빠진다. 키워드 경로 문장은 둘 다에 들어간다.
    가벼운 반응(AI 건너뜀)은 점수가 높아도 2차 부하에 넣지 않는다."""
    items = [item("d1", "harmful", "doxxing"), item("s1", "harmful", "self_harm"), item("n1", "allow", "short_normal"), item("n2", "allow", "long_normal")]
    routes = {
        "d1": RuleRoute(rule_flagged=True, keyword=False),
        "s1": RuleRoute(rule_flagged=False, keyword=True),
        "n1": RuleRoute(False, False, skip_ai=True),
        "n2": RuleRoute(False, False),
    }
    pairs = scored_pairs(items, [0.1, 0.1, 0.9, 0.1], routes)
    assert forward_rates_by_category(pairs, 0.5) == {"doxxing": 1.0, "long_normal": 0.0, "self_harm": 1.0, "short_normal": 0.0}
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
        (route_line("a", "pass", None, sha).replace('"skipAi": false', '"skipAi": "no"') + route_line("b", "pass", None, sha), "규칙 경로 결과 형식"),
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


def text_item(identifier: str, label: str, category: str, text: str) -> ChatEvalItem:
    """원문 길이가 필요한 테스트용 평가 문장."""
    return ChatEvalItem(identifier, "dev", label, category, f"{category}-x", "model-a", "model-b", text)


def test_message_length_ignores_whitespace() -> None:
    """짧은 문장 규칙의 길이는 공백을 뺀 코드 포인트 수다."""
    assert message_length(" ㅎ ㅇ  ") == 2
    assert message_length("안녕 하세요") == 5


def test_short_rule_raises_threshold_only_for_short_messages() -> None:
    """짧은 문장은 기준 임계값의 k배를 넘어야 2차로 가고, 긴 문장은 기준 임계값 그대로다."""
    items = [text_item("s", "allow", "short_normal", "ㅎㅇ"), text_item("l", "harmful", "threat", "퇴근길에 따라가서 기다릴게")]
    pairs = scored_pairs(items, [0.2, 0.2], short_rule=ShortRule(max_length=4, multiplier=3.0))
    assert [pair.threshold_multiplier for pair in pairs] == [3.0, 1.0]
    assert [pair.goes_to_stage2(0.1) for pair in pairs] == [False, True]
    assert [pair.goes_to_stage2(0.06) for pair in pairs] == [True, True]


def test_candidates_include_score_over_multiplier_for_short_messages() -> None:
    """짧은 문장은 점수/배수에서 넘어가기 시작하므로, 그 값이 임계값 후보에 들어간다."""
    pairs = scored_pairs([text_item("s", "allow", "short_normal", "ㅋ")], [0.3], short_rule=ShortRule(max_length=2, multiplier=3.0))
    candidates = candidate_thresholds(pairs)
    assert 0.1 in candidates and 0.100001 in candidates
    assert pairs[0].goes_to_stage2(0.1) and not pairs[0].goes_to_stage2(0.100001)


def test_short_rule_argument_validates_values() -> None:
    """N:k에서 N은 1 이상 정수, k는 1보다 커야 한다."""
    assert short_rule_argument("6:2.5") == ShortRule(6, 2.5)
    for bad in ("6", "0:2", "6:1", "6:nan", "x:2"):
        with pytest.raises(argparse.ArgumentTypeError):
            short_rule_argument(bad)


def test_reports_record_short_rule_and_holdout_must_match(tmp_path: Path) -> None:
    """개발셋 결과에 짧은 문장 규칙이 남고, 보류셋은 같은 규칙일 때만 임계값을 읽는다."""
    items, scores = full_coverage(0.9, 0.1)
    rule = ShortRule(6, 3.0)
    report = build_dev_report(items, scores, HALF_HALF_MIX, budget=0.5, short_rule=rule)
    assert report["short_rule"] == {"max_length": 6, "multiplier": 3.0}
    path = write_dev_report(tmp_path / "dev.json", "abc", short_rule=rule.to_dict())
    assert read_dev_threshold(path, "abc", policy_sha256=None, short_rule=rule) == 0.42
    for other in (None, ShortRule(6, 2.0)):
        with pytest.raises(DatasetFormatError, match="짧은 문장 규칙"):
            read_dev_threshold(path, "abc", policy_sha256=None, short_rule=other)
    holdout_items, holdout_scores = full_coverage(0.9, 0.1, split="holdout")
    assert build_holdout_report(holdout_items, holdout_scores, HALF_HALF_MIX, 0.5, short_rule=rule)["short_rule"] == rule.to_dict()


def test_candidates_cover_scaled_boundary_despite_rounding() -> None:
    """배수가 3처럼 이진수로 딱 떨어지지 않아도, 짧은 문장을 빼는 가장 작은 격자값이 후보에 들어간다(Codex 리뷰)."""
    pairs = scored_pairs([text_item("s", "allow", "short_normal", "ㅋ")], [0.000159], short_rule=ShortRule(max_length=2, multiplier=3.0))
    excluding = [value for value in candidate_thresholds(pairs) if not pairs[0].goes_to_stage2(value)]
    assert min(excluding) == 0.000054
    assert pairs[0].goes_to_stage2(0.000053)


def test_holdout_requires_same_traffic_mix(tmp_path: Path) -> None:
    """보류셋은 개발셋과 같은 트래픽 구성비일 때만 임계값을 읽는다."""
    path = tmp_path / "dev.json"
    report = {
        "split": "dev",
        "model_weights_sha256": "abc",
        "decision": {"mode": "budget", "threshold": 0.42},
        "rule_routes": None,
        "traffic_mix": HALF_HALF_MIX,
    }
    path.write_text(json.dumps(report), encoding="utf-8")
    assert read_dev_threshold(path, "abc", policy_sha256=None, traffic_mix=HALF_HALF_MIX) == 0.42
    with pytest.raises(DatasetFormatError, match="트래픽 구성비"):
        read_dev_threshold(path, "abc", policy_sha256=None, traffic_mix={"short_normal": 1.0})


def test_endpoint_candidate_uses_only_the_actual_stage2_path() -> None:
    """규칙은 바로 후보이고, 2차 확률은 실제 2차로 간 문장에만 적용하며 가벼운 반응은 AI를 건너뛴다."""
    items = [
        item("rule", "allow", "quote_report"),
        item("below", "allow", "long_normal"),
        item("keyword", "allow", "friendly_profanity"),
        item("skip", "allow", "short_normal"),
        item("stage1", "allow", "game_combat"),
    ]
    routes = {
        "rule": RuleRoute(True, False),
        "below": RuleRoute(False, False),
        "keyword": RuleRoute(False, True),
        "skip": RuleRoute(False, False, True),
        "stage1": RuleRoute(False, False),
    }
    stage2 = {"rule": 0.1, "below": 0.9, "keyword": 0.6, "skip": 0.9, "stage1": 0.49}
    pairs = scored_pairs(items, [0.1, 0.1, 0.1, 0.9, 0.9], routes=routes, stage2_scores=stage2)
    assert [pair.is_endpoint_candidate(0.5) for pair in pairs] == [True, False, True, False, False]
    assert endpoint_candidate_rates_by_category(pairs, 0.5) == {
        "friendly_profanity": 1.0,
        "game_combat": 0.0,
        "long_normal": 0.0,
        "quote_report": 1.0,
        "short_normal": 0.0,
    }


def stage2_score_payload(items: list[ChatEvalItem], *, model: str = "kanana@abc") -> dict:
    """C 모듈의 출력과 같은 작은 2차 점수 문서."""
    return {
        "model": {"directory_name": "kanana", "identifier": model},
        "eval_file": {"name": "eval.jsonl", "sha256": "a" * 64},
        "candidate_threshold": 0.5,
        "scores": {item.item_id: {"unsafe_probability": 0.25, "category": "S1"} for item in items},
        "prefix_fallbacks": 0,
        "created_at": "2026-10-15T00:00:00+00:00",
    }


def test_stage2_scores_require_exact_eval_id_set(tmp_path: Path) -> None:
    """2차 점수의 id는 평가셋과 한 개도 빠지거나 더하지 않고 정확히 같아야 한다."""
    items = [item("a", "allow", "long_normal"), item("b", "harmful", "threat")]
    path = tmp_path / "stage2.json"
    payload = stage2_score_payload(items)
    path.write_text(json.dumps(payload), encoding="utf-8")
    scores, provenance = load_stage2_scores(path, items)
    assert scores == {"a": 0.25, "b": 0.25}
    assert provenance["name"] == "stage2.json" and provenance["model_identifier"] == "kanana@abc"
    for bad_scores in ({"a": payload["scores"]["a"]}, payload["scores"] | {"extra": payload["scores"]["a"]}):
        payload["scores"] = bad_scores
        path.write_text(json.dumps(payload), encoding="utf-8")
        with pytest.raises(DatasetFormatError, match="id가 평가셋과 다릅니다"):
            load_stage2_scores(path, items)


def test_dev_report_adds_endpoint_rates_only_with_stage2_scores() -> None:
    """2차 점수를 주면 결정점과 임계값 표에 경로 끝 비율을 더하고, 주지 않은 기존 출력에는 키가 생기지 않는다."""
    items, scores = full_coverage(0.9, 0.1)
    stage2 = {item.item_id: (0.6 if item.category == "quote_report" else 0.1) for item in items}
    routes = {item.item_id: RuleRoute(False, item.category == "quote_report") for item in items}
    old_report = build_dev_report(items, scores, DEFAULT_TRAFFIC_MIX, 0.5)
    report = build_dev_report(items, scores, DEFAULT_TRAFFIC_MIX, 0.5, routes=routes, stage2_scores=stage2)
    assert "endpoint_candidate_by_category" not in old_report["decision"]["at_threshold"]
    assert "endpoint_candidate_by_category" not in old_report["threshold_table"][0]
    assert report["decision"]["at_threshold"]["endpoint_candidate_by_category"]["quote_report"] == 1.0
    assert all("endpoint_candidate_by_category" in row for row in report["threshold_table"])


def test_stage2_dev_report_records_exact_decision_flags_and_budget() -> None:
    """2차 선택을 쓴 dev 보고서는 반올림 점수가 아닌 원 점수의 경로 플래그와 예산 판정을 남긴다."""
    items, scores = full_coverage(0.9, 0.1)
    short_index = len(HARMFUL_CATEGORIES) + ALLOW_CATEGORIES.index("short_normal")
    friendly_index = len(HARMFUL_CATEGORIES) + ALLOW_CATEGORIES.index("friendly_profanity")
    scores[short_index] = 0.5
    scores[friendly_index] = 0.50004
    items.append(item("ambiguous", "ambiguous", "abuse"))
    scores.append(0.99)
    routes = {entry.item_id: RuleRoute(False, False) for entry in items}
    stage2 = {entry.item_id: 0.6 for entry in items}

    report = build_dev_report(items, scores, HALF_HALF_MIX, 0.75, routes=routes, stage2_scores=stage2)

    assert report["decision"]["threshold"] == 0.500001
    assert report["scores"][items[friendly_index].item_id] == 0.5
    assert report["item_flags"][items[friendly_index].item_id] == {
        "routed": True,
        "goes_to_stage2": True,
        "endpoint": True,
    }
    assert "ambiguous" not in report["item_flags"]
    at_threshold = report["decision"]["at_threshold"]
    assert at_threshold["weighted_forward_rate_exact"] == 0.5
    assert at_threshold["within_budget"] is True


def test_exact_budget_fields_are_opt_in_and_holdout_uses_dev_budget() -> None:
    """2차 점수·예산을 준 새 경로만 exact 필드를 추가하고 기존 출력은 바꾸지 않는다."""
    dev_items, scores = full_coverage(0.9, 0.1)
    old = build_dev_report(dev_items, scores, DEFAULT_TRAFFIC_MIX, 0.5)
    assert "item_flags" not in old
    assert "weighted_forward_rate_exact" not in old["decision"]["at_threshold"]
    assert "within_budget" not in old["decision"]["at_threshold"]

    holdout_items, holdout_scores = full_coverage(0.9, 0.1, split="holdout")
    stage2 = {entry.item_id: 0.1 for entry in holdout_items}
    report = build_holdout_report(
        holdout_items,
        holdout_scores,
        DEFAULT_TRAFFIC_MIX,
        0.42,
        stage2_scores=stage2,
        budget=0.304,
    )
    at_threshold = report["decision"]["at_threshold"]
    assert at_threshold["weighted_forward_rate_exact"] == pytest.approx(0.08)
    assert at_threshold["within_budget"] is True
    assert "item_flags" not in report


def test_ensemble_scores_are_arithmetic_mean_and_validate_shape() -> None:
    """앙상블 점수는 모델 순서와 무관한 문장별 산술 평균이며 길이·확률 오류를 숨기지 않는다."""
    assert average_model_scores([[0.2, 0.6], [0.4, 0.8], [0.9, 0.1]]) == pytest.approx([0.5, 0.5])
    with pytest.raises(MetricError, match="개수"):
        average_model_scores([[0.2], [0.3, 0.4]])
    with pytest.raises(MetricError, match="0~1"):
        average_model_scores([[0.2], [float("nan")]])


def test_holdout_requires_same_ensemble_weights_in_order(tmp_path: Path) -> None:
    """보류셋은 개발셋 앙상블과 가중치 목록 및 순서가 모두 같아야 한다."""
    path = tmp_path / "dev.json"
    report = {
        "split": "dev",
        "model_weights_sha256": ["first", "second", "third"],
        "decision": {"mode": "budget", "threshold": 0.42},
        "rule_routes": None,
        "short_rule": None,
    }
    path.write_text(json.dumps(report), encoding="utf-8")
    assert read_dev_threshold(path, ["first", "second", "third"], policy_sha256=None) == 0.42
    for current in (["second", "first", "third"], ["first", "second"]):
        with pytest.raises(DatasetFormatError, match="다른 모델"):
            read_dev_threshold(path, current, policy_sha256=None)


def test_holdout_requires_same_stage2_model_identifier(tmp_path: Path) -> None:
    """2차 점수를 쓰는 보류셋은 개발셋과 같은 kanana 식별자여야 한다."""
    path = tmp_path / "dev.json"
    report = {
        "split": "dev",
        "model_weights_sha256": "weights",
        "decision": {"mode": "budget", "threshold": 0.42},
        "rule_routes": None,
        "short_rule": None,
        "stage2_scores": {"name": "scores.json", "sha256": "x", "model_identifier": "kanana@old"},
    }
    path.write_text(json.dumps(report), encoding="utf-8")
    assert read_dev_threshold(path, "weights", policy_sha256=None, stage2_model_identifier="kanana@old") == 0.42
    with pytest.raises(DatasetFormatError, match="2차 모델"):
        read_dev_threshold(path, "weights", policy_sha256=None, stage2_model_identifier="kanana@new")


def test_ensemble_holdout_requires_explicit_new_output(tmp_path: Path) -> None:
    """앙상블 보류셋은 첫 모델 디렉터리에 암묵적으로 쓰지 않고 명시한 새 경로만 허용한다."""
    model_dirs = [tmp_path / "m1", tmp_path / "m2"]
    with pytest.raises(DatasetFormatError, match="--output"):
        resolve_output_path(argparse.Namespace(output=None, model_dir=model_dirs, overwrite=False), "holdout")
    output = tmp_path / "ensemble-holdout.json"
    namespace = argparse.Namespace(output=output, model_dir=model_dirs, overwrite=False)
    assert resolve_output_path(namespace, "holdout") == output
    output.write_text("{}", encoding="utf-8")
    with pytest.raises(OutputExistsError):
        resolve_output_path(namespace, "holdout")


def test_raw_score_artifacts_include_components_and_ensemble_average(tmp_path: Path) -> None:
    """보류셋 원시 점수는 구성 모델별 값과 앙상블 평균·시드·입력 지문을 원문 없이 남긴다."""
    items = [item("a", "allow", "short_normal", split="holdout"), item("b", "harmful", "threat", split="holdout")]
    eval_file = tmp_path / "holdout.jsonl"
    eval_file.write_text("sealed-placeholder\n", encoding="utf-8")
    output = tmp_path / "raw"
    write_raw_score_artifacts(
        output,
        eval_file,
        items,
        [Path("model-a"), Path("model-b")],
        ["wa", "wb"],
        [20261011, 20261021],
        [[0.1, 0.8], [0.3, 0.6]],
    )
    first = json.loads((output / "component-1.json").read_text(encoding="utf-8"))
    averaged = json.loads((output / "average.json").read_text(encoding="utf-8"))
    assert first["model_seed"] == 20261011 and first["scores"] == {"a": 0.1, "b": 0.8}
    assert averaged["model_seeds"] == [20261011, 20261021]
    assert averaged["scores"] == pytest.approx({"a": 0.2, "b": 0.7})
    assert first["eval_file"]["sha256"] == compute_file_sha256(eval_file)
    assert "문장" not in json.dumps(first, ensure_ascii=False)
    with pytest.raises(OutputExistsError):
        write_raw_score_artifacts(output, eval_file, items, [Path("model-a")], ["wa"], [20261011], [[0.1, 0.8]])


def test_model_training_identity_comes_from_model_card(tmp_path: Path) -> None:
    """보고서 모델 출처는 model-card의 시드와 실제 학습 파일 sha256에서 읽는다."""
    model = tmp_path / "arbitrary-name"
    model.mkdir()
    (model / "model-card.json").write_text(
        '{"hyperparameters":{"seed":20261011},"training_data":{"train":{"sha256":"train-sha"}}}',
        encoding="utf-8",
    )
    assert model_training_seed(model) == 20261011
    assert model_training_data_sha256(model) == "train-sha"
    (model / "model-card.json").write_text('{"hyperparameters":{}}', encoding="utf-8")
    with pytest.raises(DatasetFormatError, match="seed"):
        model_training_seed(model)
    with pytest.raises(DatasetFormatError, match="학습 데이터"):
        model_training_data_sha256(model)


def test_scoring_refuses_unfinished_training(tmp_path: Path) -> None:
    """학습 중이거나 중단된 카드의 모델은 점수를 내기 전에 거부한다. 학습 도구가 epoch마다 중간 체크포인트를 쓰기 때문이다."""
    model = tmp_path / "model"
    model.mkdir()
    arguments = argparse.Namespace(device="cpu", batch_size=8)
    for status in ("running", "interrupted", None):
        (model / "model-card.json").write_text(json.dumps({"status": status}), encoding="utf-8")
        with pytest.raises(ModelFormatError, match="학습이 끝나지 않았습니다"):
            score_model_items(arguments, model, [])


def test_completed_or_cardless_models_pass_training_check() -> None:
    """학습이 끝난 카드와 카드 없는 디렉터리(기존 허용)는 통과한다."""
    require_completed_training({"status": "completed"}, "model")
    require_completed_training(None, "model")


def test_ensemble_checks_every_card_before_scoring(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """앙상블은 채점을 시작하기 전에 모든 모델의 학습 완료를 확인한다(마지막 모델에서 멈춰 앞 채점을 버리지 않게)."""
    finished, unfinished = tmp_path / "finished", tmp_path / "unfinished"
    for directory, status in ((finished, "completed"), (unfinished, "running")):
        directory.mkdir()
        (directory / "model-card.json").write_text(json.dumps({"status": status}), encoding="utf-8")
    monkeypatch.setattr("zg_stage1.evaluate_chat.score_model_items", lambda *arguments: pytest.fail("채점을 시작하면 안 됨"))
    arguments = argparse.Namespace(model_dir=[finished, unfinished], device="cpu", batch_size=8)
    with pytest.raises(ModelFormatError, match="unfinished"):
        score_items(arguments, [])
