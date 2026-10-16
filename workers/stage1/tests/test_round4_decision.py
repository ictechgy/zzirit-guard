"""M2 4차 판정 테스트: 18개 고정 정책, 경계 부등호, 불변식, 부트스트랩과 출력 보호."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from zg_stage1 import round4_decision
from zg_stage1.data import compute_file_sha256
from zg_stage1.errors import DatasetFormatError, OutputExistsError
from zg_stage1.round4_decision import (
    REQUIRED_POLICIES,
    assess_policy_change,
    bootstrap_minimum_differences,
    build_round4_decision,
    choose_final_policy,
    comparison_allow_failures,
    decision_markdown,
    diagnostics_markdown,
    format_round4_markdown,
    high_score_flags,
    unit_markdown_table,
    write_round4_decision,
)
from zg_stage1.evaluate_chat import RuleRoute

SEEDS = (20261011, 20261021, 20261031)
CORE = ("self_harm", "sexual", "minors", "threat", "doxxing")
ALLOW = ("friendly_profanity", "game_combat", "quote_report", "number_url_like", "short_normal", "long_normal")
CATEGORIES = (*CORE, "abuse", "spam", *ALLOW)
AMBIGUOUS_ID = "ambiguous"


def write_eval(path: Path) -> list[str]:
    """범주마다 한 채점 문장과 애매 문장 하나인 작은 개발셋."""
    identifiers: list[str] = []
    lines = []
    for index, category in enumerate(CATEGORIES):
        identifier = f"i{index}"
        identifiers.append(identifier)
        label = "harmful" if category in (*CORE, "abuse", "spam") else "allow"
        lines.append(
            json.dumps(
                {
                    "id": identifier,
                    "split": "dev",
                    "label": label,
                    "category": category,
                    "family": "fixed",
                    "author": "a",
                    "reviewer": "b",
                    "text": f"SECRET-ROUND4-{index}",
                }
            )
        )
    identifiers.append(AMBIGUOUS_ID)
    lines.append(
        json.dumps(
            {
                "id": AMBIGUOUS_ID,
                "split": "dev",
                "label": "ambiguous",
                "category": "abuse",
                "family": "fixed",
                "author": "a",
                "reviewer": "b",
                "text": "SECRET-ROUND4-AMBIGUOUS",
            }
        )
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return identifiers


def policy_document(policy: str) -> dict[str, object]:
    """정책 이름에 맞는 evaluate_chat stage2_policy 값."""
    kind = "keyword_route" if policy.endswith("T1") else "category" if policy.endswith("T2") else "fixed"
    return {"policy": kind, "base": 0.5, "relaxed": 0.2, "categories": ["S3", "S4", "S5"]}


def endpoint_for(policy: str, category: str) -> str:
    """L1만 R1 효과가 있는 기본 가짜 결과."""
    if category == "self_harm":
        return "needs_care"
    if category == "sexual" or policy.startswith("L1"):
        return "candidate"
    return "pass"


def write_report(path: Path, eval_sha: str, stage2_sha: str, identifiers: list[str], policy: str, seed: int) -> None:
    """판정기가 읽는 최소 evaluate_chat 보고서."""
    categories = CATEGORIES
    flags = {}
    for identifier, category in zip(identifiers[: len(categories)], categories, strict=True):
        decision = endpoint_for(policy, category)
        goes_to_stage2 = decision == "needs_care"
        routed = decision != "pass"
        if identifier == "i2" and policy.startswith("L0"):
            goes_to_stage2 = True
            routed = True
            decision = "candidate" if policy.endswith("T2") else "pass"
        flags[identifier] = {
            "routed": routed,
            "goes_to_stage2": goes_to_stage2,
            "endpoint": decision != "pass",
            "endpoint_decision": decision,
        }
    report = {
        "split": "dev",
        "model_seed": seed,
        "model_weights_sha256": f"weights-{seed}",
        "eval_file": {"sha256": eval_sha},
        "stage2_scores": {"sha256": stage2_sha, "model_identifier": "stage2"},
        "rule_routes": {"policy_sha256": "r1" if policy.startswith("L1") else "r0"},
        "short_rule": {"max_length": 5, "multiplier": 4.0},
        "traffic_mix": {category: 1 / len(categories) for category in categories},
        "stage2_policy": policy_document(policy),
        "decision": {"mode": "fixed", "threshold": 0.25},
        "scores": {identifier: 0.95 for identifier in identifiers},
        "item_flags": flags,
    }
    path.write_text(json.dumps(report), encoding="utf-8")


def build_fixture(tmp_path: Path) -> Path:
    """정책 6 × 시드 3 보고서와 CONFIG를 만든다."""
    eval_file = tmp_path / "eval.jsonl"
    identifiers = write_eval(eval_file)
    stage2_file = tmp_path / "stage2.json"
    stage2 = {
        "model": {"identifier": "stage2"},
        "eval_file": {"sha256": compute_file_sha256(eval_file)},
        "candidate_threshold": 0.5,
        "scores": {
            identifier: {
                "unsafe_probability": 0.3 if identifier == "i2" else 0.5,
                "category": "S6" if index == 0 else "S4",
            }
            for index, identifier in enumerate(identifiers)
        },
    }
    stage2_file.write_text(json.dumps(stage2), encoding="utf-8")
    units: dict[str, dict[str, str]] = {}
    for policy in REQUIRED_POLICIES:
        units[policy] = {}
        for seed in SEEDS:
            path = tmp_path / f"{policy.replace('+', '-')}-{seed}.json"
            write_report(path, compute_file_sha256(eval_file), compute_file_sha256(stage2_file), identifiers, policy, seed)
            units[policy][str(seed)] = path.name
    config = {
        "eval_file": eval_file.name,
        "traffic_mix": {category: 1 / len(CATEGORIES) for category in CATEGORIES},
        "stage2_scores": stage2_file.name,
        "seeds": list(SEEDS),
        "units": units,
        "expected_rule_fingerprints": {"R0": "r0", "R1": "r1"},
        "expected_seed_inputs": {str(seed): {"threshold": 0.25, "model_weights_sha256": f"weights-{seed}"} for seed in SEEDS},
    }
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps(config), encoding="utf-8")
    return config_path


def write_routes(path: Path, eval_sha: str, identifiers: list[str], fingerprint: str) -> None:
    """진단용 규칙 경로 JSONL."""
    records = [
        {
            "id": identifier,
            "decision": "pass",
            "keyword": 1 if index % 2 else None,
            "skipAi": False,
            "evalSha256": eval_sha,
            "policySha256": fingerprint,
        }
        for index, identifier in enumerate(identifiers)
    ]
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n", encoding="utf-8")


def metric(minimum: float, *, allow: float = 0.1, weighted: float = 0.01, loss: int = 0) -> dict[str, object]:
    """판정 경계만 바꾸기 쉬운 시드 지표."""
    return {
        "critical_minimum": minimum,
        "endpoint_rate_by_category": {category: allow for category in ALLOW},
        "weighted_allow_false_positive_rate": weighted,
        "needs_care_loss": loss,
    }


def test_requires_exact_six_by_three_units(tmp_path: Path) -> None:
    """6×3이 모두 있어야 하고 하나라도 빠지면 어떤 칸인지 알리는 오류다."""
    config_path = build_fixture(tmp_path)
    decision = build_round4_decision(config_path)
    assert len(decision["units"]) == 18
    config = json.loads(config_path.read_text(encoding="utf-8"))
    del config["units"]["L1+T2"][str(SEEDS[-1])]
    config_path.write_text(json.dumps(config), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match=r"L1\+T2.*20261031"):
        build_round4_decision(config_path)


def test_scores_cover_all_eval_ids_but_flags_cover_only_scored_ids(tmp_path: Path) -> None:
    """애매 문장은 scores에는 남고 판정·item_flags에서는 빠진다."""
    config_path = build_fixture(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    report = json.loads((tmp_path / config["units"]["L0"][str(SEEDS[0])]).read_text(encoding="utf-8"))
    assert AMBIGUOUS_ID in report["scores"]
    assert AMBIGUOUS_ID not in report["item_flags"]
    assert len(build_round4_decision(config_path)["units"]) == 18


def test_requires_exact_distinct_rule_fingerprints_from_config(tmp_path: Path) -> None:
    """R0·R1 지문은 CONFIG에 필수이며 서로 다르고 각 규칙 계열과 정확히 같아야 한다."""
    config_path = build_fixture(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    del config["expected_rule_fingerprints"]
    config_path.write_text(json.dumps(config), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match="expected_rule_fingerprints"):
        build_round4_decision(config_path)

    config_path = build_fixture(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["expected_rule_fingerprints"]["R0"] = "wrong"
    config_path.write_text(json.dumps(config), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match="R0.*지문"):
        build_round4_decision(config_path)

    config["expected_rule_fingerprints"] = {"R0": "same", "R1": "same"}
    config_path.write_text(json.dumps(config), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match="서로 달라야"):
        build_round4_decision(config_path)


def test_requires_exact_seed_thresholds_and_weights_from_config(tmp_path: Path) -> None:
    """CONFIG의 시드별 입력은 필수이고 18개 보고서의 임계값·가중치와 정확히 맞아야 한다."""
    config_path = build_fixture(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    del config["expected_seed_inputs"]
    config_path.write_text(json.dumps(config), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match="expected_seed_inputs"):
        build_round4_decision(config_path)

    config_path = build_fixture(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["expected_seed_inputs"][str(SEEDS[1])]["threshold"] = 0.26
    config_path.write_text(json.dumps(config), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match=r"20261021.*임계값"):
        build_round4_decision(config_path)

    config["expected_seed_inputs"][str(SEEDS[1])] = {
        "threshold": 0.25,
        "model_weights_sha256": "wrong",
    }
    config_path.write_text(json.dumps(config), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match=r"20261021.*가중치"):
        build_round4_decision(config_path)


@pytest.mark.parametrize(
    ("policy", "identifier", "changes", "reason"),
    [
        ("L0", "i0", {"endpoint_decision": "candidate"}, "2차 판정"),
        ("L0+T1", "i0", {"endpoint_decision": "pass", "endpoint": False}, "2차 판정"),
        ("L0", "i1", {"endpoint_decision": "needs_care"}, "규칙 후보"),
        ("L0", "i3", {"endpoint_decision": "candidate", "endpoint": True}, "통과"),
    ],
)
def test_cross_checks_each_item_flag_against_stage2_and_route_state(
    tmp_path: Path,
    policy: str,
    identifier: str,
    changes: dict[str, object],
    reason: str,
) -> None:
    """문장별 경로 상태와 2차 정책 결과가 어긋나면 id와 이유를 보고한다."""
    config_path = build_fixture(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    report_path = tmp_path / config["units"][policy][str(SEEDS[0])]
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["item_flags"][identifier] |= changes
    report_path.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match=rf"{identifier!r}.*{reason}"):
        build_round4_decision(config_path)


def test_same_seed_and_rule_family_requires_same_route_flags(tmp_path: Path) -> None:
    """같은 규칙 계열에서는 T 정책이 문장별 routed·goes_to_stage2를 바꾸지 못한다."""
    config_path = build_fixture(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    report_path = tmp_path / config["units"]["L0+T2"][str(SEEDS[0])]
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["item_flags"]["i3"] = {
        "routed": True,
        "goes_to_stage2": False,
        "endpoint": True,
        "endpoint_decision": "candidate",
    }
    report_path.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match=r"i3.*같은 규칙 계열"):
        build_round4_decision(config_path)


def test_flag_cross_check_distinguishes_fixed_category_and_both_keyword_routes(tmp_path: Path) -> None:
    """0.3/S4 점수는 fixed 통과·category 후보이며 keyword_route는 키워드 여부에 따라 둘 다 가능하다."""
    config_path = build_fixture(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))

    fixed_path = tmp_path / config["units"]["L0"][str(SEEDS[0])]
    fixed = json.loads(fixed_path.read_text(encoding="utf-8"))
    fixed["item_flags"]["i2"] |= {"endpoint": True, "endpoint_decision": "candidate"}
    fixed_path.write_text(json.dumps(fixed), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match=r"i2.*2차 판정"):
        build_round4_decision(config_path)

    config_path = build_fixture(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    category_path = tmp_path / config["units"]["L0+T2"][str(SEEDS[0])]
    category = json.loads(category_path.read_text(encoding="utf-8"))
    category["item_flags"]["i2"] |= {"endpoint": False, "endpoint_decision": "pass"}
    category_path.write_text(json.dumps(category), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match=r"i2.*2차 판정"):
        build_round4_decision(config_path)

    config_path = build_fixture(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    keyword_path = tmp_path / config["units"]["L0+T1"][str(SEEDS[0])]
    keyword = json.loads(keyword_path.read_text(encoding="utf-8"))
    keyword["item_flags"]["i2"] |= {"endpoint": True, "endpoint_decision": "candidate"}
    keyword_path.write_text(json.dumps(keyword), encoding="utf-8")
    assert len(build_round4_decision(config_path)["units"]) == 18
    keyword["item_flags"]["i2"]["endpoint_decision"] = "needs_care"
    keyword_path.write_text(json.dumps(keyword), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match=r"i2.*2차 판정"):
        build_round4_decision(config_path)


@pytest.mark.parametrize(
    ("mutation", "message"),
    [("threshold", "임계값"), ("policy", "2차 후보 기준"), ("mode", "decision.mode")],
)
def test_rejects_threshold_and_policy_mismatch(tmp_path: Path, mutation: str, message: str) -> None:
    """같은 시드 임계값과 이름별 T 정책이 다르면 판정을 멈춘다."""
    config_path = build_fixture(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    report_path = tmp_path / config["units"]["L0+T1"][str(SEEDS[0])]
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if mutation == "threshold":
        report["decision"]["threshold"] = 0.26
    elif mutation == "policy":
        report["stage2_policy"]["policy"] = "category"
    else:
        report["decision"]["mode"] = "budget"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match=message):
        build_round4_decision(config_path)


def test_rejects_l0_endpoint_invariant_loss(tmp_path: Path) -> None:
    """L0 경로 끝 문장을 어느 비교 정책이든 잃으면 고정 임계값 실험이 아니다."""
    config_path = build_fixture(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    for policy in ("L1", "L1+T1", "L1+T2"):
        path = tmp_path / config["units"][policy][str(SEEDS[0])]
        report = json.loads(path.read_text(encoding="utf-8"))
        report["item_flags"]["i1"] = {
            "routed": False,
            "goes_to_stage2": False,
            "endpoint": False,
            "endpoint_decision": "pass",
        }
        path.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match="불변식"):
        build_round4_decision(config_path)


def test_step_one_boundaries_are_inclusive_and_fail_only_above() -> None:
    """개선 0.10, 유형 0.05, 가중 0.005는 포함하고 손실 1이나 초과값은 제외한다."""
    baseline = [metric(0.2) for _ in SEEDS]
    exact = [metric(0.3, allow=0.15, weighted=0.015) for _ in SEEDS]
    assert assess_policy_change(baseline, exact, 0.10)["qualified"] is True
    assert assess_policy_change(baseline, [metric(0.299999) for _ in SEEDS], 0.10)["qualified"] is False
    assert assess_policy_change(baseline, [metric(0.25) for _ in SEEDS], 0.05)["qualified"] is True
    assert assess_policy_change(baseline, [metric(0.3, allow=0.150001) for _ in SEEDS], 0.10)["qualified"] is False
    assert assess_policy_change(baseline, [metric(0.3, weighted=0.015001) for _ in SEEDS], 0.10)["qualified"] is False
    assert assess_policy_change(baseline, [metric(0.3, loss=1) for _ in SEEDS], 0.10)["qualified"] is False


def test_step_two_uses_selected_base_and_prefers_t1_inside_margin() -> None:
    """R1 채택 여부가 T 비교 기준을 바꾸고 개선 차이가 0.02 미만이면 T1을 고른다."""
    values = {
        "L0": [metric(0.2) for _ in SEEDS],
        "L1": [metric(0.3) for _ in SEEDS],
        "L0+T1": [metric(0.26) for _ in SEEDS],
        "L0+T2": [metric(0.27) for _ in SEEDS],
        "L1+T1": [metric(0.36) for _ in SEEDS],
        "L1+T2": [metric(0.379) for _ in SEEDS],
    }
    chosen = choose_final_policy(values)
    assert chosen["step1"]["adopted"] is True
    assert chosen["step2"]["baseline"] == "L1"
    assert chosen["final_policy"] == "L1+T1"
    values["L1+T2"] = [metric(0.38) for _ in SEEDS]
    assert choose_final_policy(values)["final_policy"] == "L1+T2"
    values["L1"] = [metric(0.29999) for _ in SEEDS]
    chosen = choose_final_policy(values)
    assert chosen["step1"]["adopted"] is False
    assert chosen["step2"]["baseline"] == "L0"


def test_bootstrap_is_deterministic_and_recomputes_each_minimum() -> None:
    """재표본 id를 공유하면서 매 반복 범주별 비율에서 최소를 다시 고른다."""
    category_ids = {category: (f"{category}-0", f"{category}-1", f"{category}-2") for category in CORE}
    baseline = [{identifier: index != 2 for identifiers in category_ids.values() for index, identifier in enumerate(identifiers)} for _ in SEEDS]
    selected = [{identifier: True for identifiers in category_ids.values() for identifier in identifiers} for _ in SEEDS]
    first = bootstrap_minimum_differences(selected, baseline, category_ids, rounds=80, seed=17)
    second = bootstrap_minimum_differences(selected, baseline, category_ids, rounds=80, seed=17)
    assert first == second
    assert len(set(first)) > 1


def test_bootstrap_reselects_minimum_and_shares_one_resample(monkeypatch: pytest.MonkeyPatch) -> None:
    """관측 최소와 다른 범주가 재표본 최소가 되며 그 id 하나를 두 정책·세 시드가 공유한다."""
    category_ids = {category: tuple(f"{category}-{index}" for index in range(4)) for category in CORE}
    baseline_one = {identifier: True for identifiers in category_ids.values() for identifier in identifiers}
    baseline_one |= {category_ids[CORE[0]][0]: False, category_ids[CORE[0]][1]: False, category_ids[CORE[1]][0]: False}
    selected_one = {identifier: True for identifiers in category_ids.values() for identifier in identifiers}

    class FixedRandom:
        calls = 0

        def __init__(self, _seed: int) -> None:
            pass

        def randrange(self, _stop: int) -> int:
            position = self.calls // 4
            type(self).calls += 1
            return 2 if position == 0 else 0

    monkeypatch.setattr(round4_decision.random, "Random", FixedRandom)
    differences = bootstrap_minimum_differences([selected_one] * 3, [baseline_one] * 3, category_ids, rounds=1, seed=17)
    assert differences == [1.0]
    assert FixedRandom.calls == len(CORE) * 4


def test_optional_diagnostics_include_report_routes_and_mechanisms(tmp_path: Path) -> None:
    """선택 진단 칸과 정책 규칙 경로가 있으면 2차 단독·고득점·놓침을 함께 낸다."""
    config_path = build_fixture(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    eval_path = tmp_path / config["eval_file"]
    identifiers = [f"i{index}" for index in range(len(CATEGORIES))] + [AMBIGUOUS_ID]
    r0, r1 = tmp_path / "r0.jsonl", tmp_path / "r1.jsonl"
    write_routes(r0, compute_file_sha256(eval_path), identifiers, "r0")
    write_routes(r1, compute_file_sha256(eval_path), identifiers, "r1")
    config["diagnostics"] = {
        "L0+R1public": config["units"]["L0"],
        "routes": {"L0": r0.name, "L1": r1.name},
    }
    config_path.write_text(json.dumps(config), encoding="utf-8")
    diagnostics = build_round4_decision(config_path)["diagnostics"]
    assert len(diagnostics["report_slots"]["L0+R1public"]) == 3
    assert set(diagnostics["stage2_standalone"]) == set(REQUIRED_POLICIES)
    assert set(diagnostics["stage1_high_score"]) == {"L0", "L1"}
    assert set(diagnostics["stage2_misses"]) == {str(seed) for seed in SEEDS}


def test_diagnostic_reports_accept_budget_mode_and_legacy_missing_stage2_policy(tmp_path: Path) -> None:
    """임계값 재선택 진단은 budget이고, 3차 호환 보고서는 stage2_policy가 없어도 기본 fixed로 읽는다."""
    config_path = build_fixture(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    diagnostic_paths: dict[str, str] = {}
    for seed in SEEDS:
        source = tmp_path / config["units"]["L0"][str(seed)]
        report = json.loads(source.read_text(encoding="utf-8"))
        report.pop("stage2_policy")
        report["decision"] = {"mode": "budget", "budget": 0.304, "threshold": 0.25}
        target = tmp_path / f"diagnostic-{seed}.json"
        target.write_text(json.dumps(report), encoding="utf-8")
        diagnostic_paths[str(seed)] = target.name
    config["diagnostics"] = {"reselected": diagnostic_paths}
    config_path.write_text(json.dumps(config), encoding="utf-8")

    diagnostics = build_round4_decision(config_path)["diagnostics"]["report_slots"]["reselected"]
    assert [unit["threshold"] for unit in diagnostics] == [0.25, 0.25, 0.25]


@pytest.mark.parametrize(
    "diagnostics",
    [
        {"slot": "report.json"},
        {"slot": {str(SEEDS[0]): "report.json"}},
        {"slot": {}},
        {str(seed): "report.json" for seed in SEEDS},
    ],
)
def test_diagnostic_slots_reject_malformed_shapes(tmp_path: Path, diagnostics: object) -> None:
    """문자열 잎·시드 누락 객체·빈 객체를 조용히 버리지 않는다."""
    config_path = build_fixture(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["diagnostics"] = diagnostics
    config_path.write_text(json.dumps(config), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match="diagnostics"):
        build_round4_decision(config_path)


def test_high_score_diagnostic_preserves_needs_care() -> None:
    """0.9 이상이어도 이미 도움 필요인 문장을 일반 후보로 덮어쓰지 않는다."""
    unit = {
        "scores": {"care": 0.99},
        "flags": {
            "care": {
                "routed": True,
                "goes_to_stage2": True,
                "endpoint": True,
                "endpoint_decision": "needs_care",
            }
        },
    }
    result = high_score_flags(unit, {"care": RuleRoute(False, False)})
    assert result["care"] == unit["flags"]["care"]


def test_runtime_shape_validation_raises_explicit_errors() -> None:
    """최적화 모드에서도 사라지는 assert 대신 입력 형식 오류를 낸다."""
    with pytest.raises(DatasetFormatError):
        comparison_allow_failures([{"endpoint_rate_by_category": []}], [{"endpoint_rate_by_category": []}])
    with pytest.raises(DatasetFormatError):
        unit_markdown_table({})
    with pytest.raises(DatasetFormatError):
        decision_markdown([])
    with pytest.raises(DatasetFormatError):
        diagnostics_markdown([])


def test_diagnostic_markdown_documents_rounded_stage1_scores(tmp_path: Path) -> None:
    """진단 설명은 1차 점수가 보고서의 네 자리 값임을 명시한다."""
    report = build_round4_decision(build_fixture(tmp_path))
    assert "1차 점수는 보고서의 4자리 값" in format_round4_markdown(report)


def test_outputs_do_not_overwrite_or_leak_text(tmp_path: Path) -> None:
    """JSON·Markdown을 새로 만들고 평가 원문은 어디에도 쓰지 않으며 기존 파일은 보호한다."""
    config_path = build_fixture(tmp_path)
    output = tmp_path / "out"
    write_round4_decision(config_path, output)
    combined = (output / "decision.json").read_text(encoding="utf-8") + (output / "decision.md").read_text(encoding="utf-8")
    assert "SECRET-ROUND4" not in combined
    with pytest.raises(OutputExistsError):
        write_round4_decision(config_path, output)
