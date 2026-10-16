"""M2 3차 판정 테스트: 경계, 자격, 결정적 선택, 짝지은 부트스트랩, 보류셋 봉인 검사."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from zg_stage1 import round3_decision
from zg_stage1.chat_eval_data import ChatEvalItem
from zg_stage1.errors import DatasetFormatError, ModelFormatError
from zg_stage1.data import compute_file_sha256
from zg_stage1.evaluate_chat import ShortRule
from zg_stage1.round3_decision import (
    H1T2_TRAINING_DATA_SHA256,
    assess_evaluation_unit,
    bootstrap_critical_difference,
    build_auc_evidence,
    choose_winner,
    ensemble_qualifies,
    evaluate_holdout_reports,
    load_model_reports,
    main,
    model_card_auc,
    require_equal,
    select_deployment_seed,
    single_qualifies,
    validate_dev_report,
)


OTHER_ALLOW = ("game_combat", "short_normal", "long_normal", "number_url_like")


def at_threshold(
    *,
    critical: float = 0.90,
    abuse: float = 0.90,
    friendly: float = 0.30,
    other_allow: float = 0.40,
    quote_endpoint: float = 0.40,
    weighted: float = 0.304,
) -> dict:
    """표의 경계값에 정확히 놓인 평가 단위 요약."""
    by_category = {
        "abuse": abuse,
        "sexual": critical,
        "minors": critical,
        "threat": critical,
        "doxxing": critical,
        "self_harm": critical,
        "spam": 1.0,
        "friendly_profanity": friendly,
        "quote_report": 1.0,
        **{category: other_allow for category in OTHER_ALLOW},
    }
    endpoint = {category: 0.0 for category in by_category}
    endpoint["quote_report"] = quote_endpoint
    return {
        "threshold": 0.42,
        "weighted_forward_rate": weighted,
        "weighted_forward_rate_exact": weighted,
        "within_budget": weighted <= 0.304,
        "critical_recall_min": critical,
        "critical_recall_mean": critical,
        "allow_forward_max": max(friendly, other_allow, 1.0),
        "by_category": by_category,
        "endpoint_candidate_by_category": endpoint,
    }


def test_pass_and_near_boundaries_are_inclusive() -> None:
    """표의 ≥·≤ 경계값은 통과/근접에 포함되고 한 항목이라도 바깥이면 해당 등급이 아니다."""
    passed = assess_evaluation_unit(at_threshold())
    near = assess_evaluation_unit(at_threshold(critical=0.85, abuse=0.85, friendly=0.35, other_allow=0.45, quote_endpoint=0.45))
    failed = assess_evaluation_unit(at_threshold(critical=0.849999))
    assert passed["pass"] is True and passed["near"] is True and passed["status"] == "pass"
    assert near["pass"] is False and near["near"] is True and near["status"] == "near"
    assert failed["pass"] is False and failed["near"] is False and failed["status"] == "fail"
    assert any("critical_recall_min" in reason for reason in failed["near_failures"])
    assert passed["allowed_max"] == 0.40  # quote_report 경로 전달 1.0은 허용 최대에 넣지 않는다.


def test_single_and_ensemble_qualification_combinations() -> None:
    """단일은 2통과+나머지 근접, 앙상블은 세 시드 통과+모든 두 시드 근접이며 둘 다 AUC가 필요하다."""
    passed = assess_evaluation_unit(at_threshold())
    near = assess_evaluation_unit(at_threshold(critical=0.85, abuse=0.85, friendly=0.35, other_allow=0.45, quote_endpoint=0.45))
    failed = assess_evaluation_unit(at_threshold(critical=0.84))
    assert single_qualifies([passed, passed, near], auc_pass=True)
    assert not single_qualifies([passed, near, near], auc_pass=True)
    assert not single_qualifies([passed, passed, failed], auc_pass=True)
    assert not single_qualifies([passed, passed, near], auc_pass=False)
    assert ensemble_qualifies(passed, [near, near, near], auc_pass=True)
    assert not ensemble_qualifies(near, [near, near, near], auc_pass=True)
    assert not ensemble_qualifies(passed, [near, failed, near], auc_pass=True)


def setting(key: str, model: str, form: str, critical: float, qualified: bool = True) -> dict:
    """선택 규칙 테스트용 설정."""
    return {"key": key, "model": model, "form": form, "critical_recall": critical, "qualified": qualified}


def test_choice_uses_m_minus_point_zero_two_and_simplicity_order() -> None:
    """M-0.02 경계를 포함하고, 형태 단순성이 모델 단순성보다 먼저다."""
    settings = [
        setting("h-single", "H1T2", "single", 0.91),
        setting("x-single", "D", "single", 0.915),
        setting("h-ensemble", "H1T2", "ensemble", 0.92),
        setting("x-ensemble", "D", "ensemble", 0.93),
    ]
    assert choose_winner(settings)["key"] == "h-single"  # 0.91 == 0.93 - 0.02
    settings[0]["critical_recall"] = 0.909999
    assert choose_winner(settings)["key"] == "x-single"  # 단일 형태가 앙상블보다 먼저


def test_choice_ties_and_no_qualification() -> None:
    """같은 형태·값이면 H1T2가 X보다 먼저고, 자격 설정이 없으면 승자가 없다."""
    assert choose_winner([setting("x", "W", "single", 0.9), setting("h", "H1T2", "single", 0.9)])["key"] == "h"
    assert choose_winner([setting("h", "H1T2", "single", 1.0, qualified=False)]) is None


def critical_item(identifier: str, category: str) -> ChatEvalItem:
    """부트스트랩용 핵심 유해 문장."""
    return ChatEvalItem(identifier, "dev", "harmful", category, identifier, "author", "reviewer", f"자리표시자 {identifier}")


def test_bootstrap_is_deterministic_and_pairs_the_same_resample() -> None:
    """같은 입력은 같은 구간을 내고, 두 설정의 같은 flags는 짝지음 덕분에 모든 차이가 정확히 0이다."""
    categories = ("sexual", "minors", "threat", "doxxing", "self_harm")
    items = [critical_item(f"{category}-{index}", category) for category in categories for index in range(2)]
    flags = [{item.item_id: index % 2 == 0 for index, item in enumerate(items)}]
    first = bootstrap_critical_difference(flags, flags, items)
    second = bootstrap_critical_difference(flags, flags, items)
    assert first == second == {"low": 0.0, "high": 0.0, "rounds": 2000}


def test_deployment_seed_tie_breaking() -> None:
    """허용 최대는 계획표 항목만 쓰고, 나머지 동률은 CONFIG 순서가 아닌 작은 시드가 이긴다."""
    rows = [
        {"seed": 51, "pass": True, "critical_recall_min": 0.92, "allowed_max": 0.39, "friendly_profanity": 0.29},
        {"seed": 41, "pass": True, "critical_recall_min": 0.92, "allowed_max": 0.39, "friendly_profanity": 0.29},
        {"seed": 31, "pass": True, "critical_recall_min": 0.92, "allowed_max": 0.39, "friendly_profanity": 0.3},
        {"seed": 21, "pass": True, "critical_recall_min": 0.92, "allowed_max": 0.4, "friendly_profanity": 0.3},
        {"seed": 11, "pass": True, "critical_recall_min": 0.91, "allowed_max": 0.4, "friendly_profanity": 0.3},
        {"seed": 1, "pass": False, "critical_recall_min": 1.0, "allowed_max": 0.0, "friendly_profanity": 0.0},
    ]
    assert select_deployment_seed(rows)["seed"] == 41


def holdout_manifest() -> dict:
    """단일 승자의 보류셋 manifest."""
    return {
        "selected": {"model": "H1T2", "form": "single"},
        "stage1": {
            "deployment_seed": 11,
            "units": [
                {"seed": 11, "weights_sha256": "w11", "threshold": 0.41},
                {"seed": 21, "weights_sha256": "w21", "threshold": 0.42},
                {"seed": 31, "weights_sha256": "w31", "threshold": 0.43},
            ],
        },
        "short_rule": {"max_length": 5, "multiplier": 4.0},
        "traffic_mix": {"short_normal": 1.0},
        "rule_policy_sha256": "rules",
        "stage2_model": {"identifier": "kanana@model"},
        "holdout_sha256": "holdout-hash",
        "forward_budget": 0.304,
    }


def holdout_report(weight: str, threshold: float, summary: dict | None = None) -> dict:
    """manifest 불변식을 모두 담은 보류셋 보고서."""
    return {
        "split": "holdout",
        "model_weights_sha256": weight,
        "eval_file": {"sha256": "holdout-hash"},
        "short_rule": {"max_length": 5, "multiplier": 4.0},
        "traffic_mix": {"short_normal": 1.0},
        "rule_routes": {"policy_sha256": "rules"},
        "stage2_scores": {"model_identifier": "kanana@model"},
        "decision": {"mode": "fixed", "threshold": threshold, "at_threshold": summary or at_threshold()},
    }


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("short_rule", {"max_length": 4, "multiplier": 4.0}, "짧은 문장"),
        ("traffic_mix", {"long_normal": 1.0}, "구성비"),
        ("rule_routes", {"policy_sha256": "other"}, "규칙"),
        ("stage2_scores", {"model_identifier": "kanana@other"}, "2차"),
        ("eval_file", {"sha256": "other"}, "보류셋"),
    ],
)
def test_holdout_manifest_mismatch_is_error(field: str, value: object, message: str) -> None:
    """가중치 외 manifest 고정값이 하나라도 다르면 합격/불합격을 계산하지 않는다."""
    report = holdout_report("w11", 0.41)
    report[field] = value
    with pytest.raises(DatasetFormatError, match=message):
        evaluate_holdout_reports(holdout_manifest(), [report])


def test_holdout_rejects_non_manifest_single_candidate_and_threshold() -> None:
    """보류셋에는 manifest의 선택 설정만 허용하고, 각 시드에 고정한 임계값도 정확히 맞아야 한다."""
    with pytest.raises(DatasetFormatError, match="가중치"):
        evaluate_holdout_reports(holdout_manifest(), [holdout_report("alternative", 0.41)])
    with pytest.raises(DatasetFormatError, match="임계값"):
        evaluate_holdout_reports(holdout_manifest(), [holdout_report("w11", 0.42)])


def test_single_holdout_uses_deployment_seed_and_marks_others_diagnostic() -> None:
    """배포 시드만 전체 합격을 정하고 다른 두 시드는 진단으로 남긴다."""
    failing = at_threshold(critical=0.8)
    reports = [holdout_report("w11", 0.41), holdout_report("w21", 0.42, failing), holdout_report("w31", 0.43, failing)]
    verdict = evaluate_holdout_reports(holdout_manifest(), reports)
    assert verdict["passed"] is True
    assert [unit["role"] for unit in verdict["units"]] == ["deployment", "diagnostic", "diagnostic"]
    assert [unit["passed"] for unit in verdict["units"]] == [True, False, False]


def test_holdout_weighted_forward_rate_over_budget_fails() -> None:
    """표의 항목이 모두 좋아도 가중 전달률이 0.304를 넘으면 배포 시드는 불합격이다."""
    summary = at_threshold(weighted=0.304001)
    verdict = evaluate_holdout_reports(holdout_manifest(), [holdout_report("w11", 0.41, summary)])
    assert verdict["passed"] is False
    assert any("weighted_forward_rate_exact" in reason for reason in verdict["units"][0]["failures"])


def test_manifest_input_is_not_mutated_by_holdout_evaluation() -> None:
    """판정은 manifest를 읽기만 하며 진단 역할 같은 런타임 값을 섞어 쓰지 않는다."""
    manifest = holdout_manifest()
    before = copy.deepcopy(manifest)
    evaluate_holdout_reports(manifest, [holdout_report("w11", 0.41)])
    assert manifest == before


def dev_validation_fixture() -> tuple[list[ChatEvalItem], dict]:
    """validate_dev_report의 고정 계약을 모두 만족하는 최소 보고서."""
    harmful = ("abuse", "sexual", "minors", "threat", "doxxing", "self_harm", "spam")
    allow = ("friendly_profanity", "game_combat", "quote_report", "number_url_like", "short_normal", "long_normal")
    items = [critical_item(f"id-{category}", category) for category in harmful]
    items += [ChatEvalItem(f"id-{category}", "dev", "allow", category, category, "a", "b", category) for category in allow]
    summary = at_threshold(critical=1.0, abuse=1.0, friendly=0.0, other_allow=0.0, quote_endpoint=0.0, weighted=0.0)
    flags = {
        item.item_id: {
            "routed": item.label == "harmful" or item.category == "quote_report",
            "goes_to_stage2": False,
            "endpoint": False,
        }
        for item in items
    }
    mix = {item.category: 1 / len(items) for item in items}
    report = {
        "split": "dev",
        "decision": {"mode": "budget", "budget": 0.304, "threshold": 0.42, "at_threshold": summary},
        "short_rule": {"max_length": 5, "multiplier": 4.0},
        "rule_routes": {"policy_sha256": "rules"},
        "stage2_scores": {"model_identifier": "stage2", "sha256": "stage2-sha"},
        "eval_file": {"sha256": "dev-sha"},
        "traffic_mix": mix,
        "item_flags": flags,
    }
    return items, report


def validate_fixture(report: dict, items: list[ChatEvalItem]) -> None:
    """테스트 보고서에 고정 출처를 적용한다."""
    validate_dev_report(
        report,
        "report.json",
        "dev-sha",
        "rules",
        "stage2",
        "stage2-sha",
        {"max_length": 5, "multiplier": 4.0},
        items,
    )


def test_dev_report_requires_fixed_budget_exact_load_and_flag_aggregates() -> None:
    """dev 판정은 0.304·5:4·exact 예산·item_flags 집계를 모두 교차 확인한다."""
    items, report = dev_validation_fixture()
    validate_fixture(report, items)

    wrong_budget = copy.deepcopy(report)
    wrong_budget["decision"]["budget"] = 0.303999
    with pytest.raises(DatasetFormatError, match="예산"):
        validate_fixture(wrong_budget, items)

    over_budget = copy.deepcopy(report)
    over_budget["decision"]["at_threshold"]["weighted_forward_rate_exact"] = 0.304001
    over_budget["decision"]["at_threshold"]["within_budget"] = True
    with pytest.raises(DatasetFormatError, match="예산"):
        validate_fixture(over_budget, items)

    mismatched_rates = copy.deepcopy(report)
    mismatched_rates["decision"]["at_threshold"]["by_category"]["abuse"] = 0.5
    with pytest.raises(DatasetFormatError, match="item_flags"):
        validate_fixture(mismatched_rates, items)


def test_dev_report_accepts_only_default_fixed_stage2_policy_when_present() -> None:
    """3차 개발 보고서의 선택 필드가 있으면 fixed 0.5/0.2/S3·S4·S5와 정확히 같아야 한다."""
    items, report = dev_validation_fixture()
    report["stage2_policy"] = {
        "policy": "fixed",
        "base": 0.5,
        "relaxed": 0.2,
        "categories": ["S3", "S4", "S5"],
    }
    validate_fixture(report, items)

    for key, value in [("policy", "category"), ("base", 0.4), ("relaxed", 0.1), ("categories", ["S3", "S4"])]:
        invalid = copy.deepcopy(report)
        invalid["stage2_policy"][key] = value
        with pytest.raises(DatasetFormatError, match="2차 후보 기준 정책"):
            validate_fixture(invalid, items)


def test_required_equal_rejects_two_missing_values_and_holdout_constants_are_fixed() -> None:
    """필수 키가 양쪽에 다 없어도 일치로 취급하지 않고, manifest 상수도 바꾸지 못한다."""
    with pytest.raises(DatasetFormatError):
        require_equal(None, None, "필수 키")
    manifest = holdout_manifest()
    report = holdout_report("w11", 0.41)
    manifest["forward_budget"] = 0.3
    with pytest.raises(DatasetFormatError, match="예산"):
        evaluate_holdout_reports(manifest, [report])
    manifest = holdout_manifest()
    manifest["short_rule"] = {"max_length": 4, "multiplier": 4.0}
    report["short_rule"] = {"max_length": 4, "multiplier": 4.0}
    with pytest.raises(DatasetFormatError, match="manifest"):
        evaluate_holdout_reports(manifest, [report])


def test_model_card_auc_never_falls_back_to_auc() -> None:
    """원래 검증 근거는 best_validation_auc 키가 없으면 auc 값이 있어도 거절한다."""
    with pytest.raises(DatasetFormatError, match="best_validation_auc"):
        model_card_auc({"auc": 0.99}, "card.json")


def test_auc_constants_and_d_evidence_are_verified(tmp_path: Path) -> None:
    """D는 여섯 정렬 파일·H1T2 카드 출처를 확인하고 부동소수점 경계에 1e-12를 허용한다."""
    seeds = (20261011, 20261021, 20261031)
    model_reports = {model: {"single": [{"report": {"model_weights_sha256": f"{model}-w-{seed}"}} for seed in seeds]} for model in ("H1T2", "D")}

    d_references: dict[str, list[str]] = {"H1T2": [], "D": []}
    for model in ("H1T2", "D"):
        for seed in seeds:
            path = write_json(
                tmp_path / f"aligned-{model}-{seed}.json",
                {
                    "auc": 0.91 if model == "H1T2" else 0.905,
                    "rows_excluded": 10,
                    "excluded_ids_sha256": "same-excluded",
                    "val_file": {"sha256": "same-val"},
                    "model_weights_sha256": f"{model}-w-{seed}",
                },
            )
            d_references[model].append(path.name)
    d_references["original_h1t2"] = [
        write_json(
            tmp_path / f"original-{seed}.json",
            {
                "best_validation_auc": 0.91,
                "status": "completed",
                "hyperparameters": {"seed": seed},
                "training_data": {"train": {"sha256": H1T2_TRAINING_DATA_SHA256}},
            },
        ).name
        for seed in seeds
    ]
    d_config = {
        "training_data_sha256": {"H1T2": H1T2_TRAINING_DATA_SHA256, "D": "d" * 64},
        "validation_auc": d_references,
    }
    evidence = build_auc_evidence(d_config, tmp_path / "config.json", "D", model_reports)
    assert evidence["H1T2"]["pass"] is True
    assert evidence["D"]["mean"] == evidence["D"]["threshold"] == 0.905
    assert evidence["D"]["pass"] is True
    assert evidence["H1T2"]["original_validation"]["threshold"] == 0.902

    changed = json.loads((tmp_path / d_references["D"][2]).read_text(encoding="utf-8"))
    changed["excluded_ids_sha256"] = "different"
    write_json(tmp_path / d_references["D"][2], changed)
    with pytest.raises(DatasetFormatError, match="excluded_ids_sha256"):
        build_auc_evidence(d_config, tmp_path / "config.json", "D", model_reports)

    changed["excluded_ids_sha256"] = "same-excluded"
    changed["rows_excluded"] = 0
    write_json(tmp_path / d_references["D"][2], changed)
    with pytest.raises(DatasetFormatError, match="rows_excluded"):
        build_auc_evidence(d_config, tmp_path / "config.json", "D", model_reports)

    changed["rows_excluded"] = 10
    changed["model_weights_sha256"] = "wrong-weight"
    write_json(tmp_path / d_references["D"][2], changed)
    with pytest.raises(DatasetFormatError, match="가중치"):
        build_auc_evidence(d_config, tmp_path / "config.json", "D", model_reports)

    w_references: dict[str, object] = {"control_mean": 0.0}
    for model in ("H1T2", "W"):
        w_references[model] = [
            write_json(
                tmp_path / f"card-{model}-{seed}.json",
                {
                    "best_validation_auc": 0.901,
                    "status": "completed",
                    "hyperparameters": {"seed": seed},
                    "training_data": {"train": {"sha256": H1T2_TRAINING_DATA_SHA256 if model == "H1T2" else "a" * 64}},
                },
            ).name
            for seed in seeds
        ]
    w_evidence = build_auc_evidence(
        {
            "training_data_sha256": {"H1T2": H1T2_TRAINING_DATA_SHA256, "W": "a" * 64},
            "validation_auc": w_references,
        },
        tmp_path / "config.json",
        "W",
        {},
    )
    assert w_evidence["H1T2"]["threshold"] == 0.902
    assert w_evidence["H1T2"]["pass"] is False

    changed_card = json.loads((tmp_path / w_references["W"][0]).read_text(encoding="utf-8"))
    changed_card["training_data"]["train"]["sha256"] = "x" * 64
    write_json(tmp_path / w_references["W"][0], changed_card)
    with pytest.raises(DatasetFormatError, match="학습 데이터"):
        build_auc_evidence(
            {
                "training_data_sha256": {"H1T2": H1T2_TRAINING_DATA_SHA256, "W": "a" * 64},
                "validation_auc": w_references,
            },
            tmp_path / "config.json",
            "W",
            {},
        )


def test_load_model_reports_enforces_seed_and_weight_composition(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """단일 고정 시드, 앙상블 오름차순, 세 두-시드 조합을 보고서 메타데이터로 검증한다."""
    seeds = (20261011, 20261021, 20261031)
    weights = {seed: f"w-{seed}" for seed in seeds}
    training_sha256 = H1T2_TRAINING_DATA_SHA256
    reports: dict[str, dict] = {
        **{
            f"single-{seed}.json": {
                "model_seed": seed,
                "model_weights_sha256": weights[seed],
                "model_training_data_sha256": training_sha256,
            }
            for seed in seeds
        },
        "ensemble.json": {
            "model_seeds": list(seeds),
            "model_weights_sha256": [weights[seed] for seed in seeds],
            "model_training_data_sha256s": [training_sha256] * 3,
        },
        "pair-1.json": {
            "model_seeds": [seeds[0], seeds[1]],
            "model_weights_sha256": [weights[seeds[0]], weights[seeds[1]]],
            "model_training_data_sha256s": [training_sha256] * 2,
        },
        "pair-2.json": {
            "model_seeds": [seeds[0], seeds[2]],
            "model_weights_sha256": [weights[seeds[0]], weights[seeds[2]]],
            "model_training_data_sha256s": [training_sha256] * 2,
        },
        "pair-3.json": {
            "model_seeds": [seeds[1], seeds[2]],
            "model_weights_sha256": [weights[seeds[1]], weights[seeds[2]]],
            "model_training_data_sha256s": [training_sha256] * 2,
        },
    }

    def fake_load(path: Path, *_args: object) -> dict:
        return {"report": reports[path.name]}

    monkeypatch.setattr("zg_stage1.round3_decision.load_evaluation_report", fake_load)

    def config(single_seeds: tuple[int, int, int] = seeds) -> dict:
        return {
            "reports": {
                "H1T2": {
                    "single": [{"seed": seed, "path": f"single-{seed}.json"} for seed in single_seeds],
                    "ensemble": "ensemble.json",
                    "pair_ensembles": ["pair-1.json", "pair-2.json", "pair-3.json"],
                }
            }
        }

    arguments = (
        "H1T2",
        config(),
        tmp_path / "config.json",
        [],
        {},
        ShortRule(5, 4.0),
        "dev",
        "rules",
        "stage2",
        "stage2-sha",
        training_sha256,
    )
    loaded = load_model_reports(*arguments)
    assert [entry["seed"] for entry in loaded["single"]] == list(seeds)

    reports["ensemble.json"]["model_weights_sha256"] = [weights[seeds[1]], weights[seeds[0]], weights[seeds[2]]]
    with pytest.raises(DatasetFormatError, match="가중치"):
        load_model_reports(*arguments)
    reports["ensemble.json"]["model_weights_sha256"] = [weights[seed] for seed in seeds]

    reports[f"single-{seeds[0]}.json"]["model_training_data_sha256"] = "wrong-training-data"
    with pytest.raises(DatasetFormatError, match="학습 데이터"):
        load_model_reports(*arguments)
    reports[f"single-{seeds[0]}.json"]["model_training_data_sha256"] = training_sha256

    reports["pair-3.json"] = reports["pair-2.json"]
    with pytest.raises(DatasetFormatError, match="조합"):
        load_model_reports(*arguments)

    bad_config = config((20261011, 20261021, 20261041))
    reports["single-20261041.json"] = {
        "model_seed": 20261041,
        "model_weights_sha256": "w-20261041",
        "model_training_data_sha256": training_sha256,
    }
    with pytest.raises(DatasetFormatError, match="20261031"):
        load_model_reports(*((arguments[0], bad_config) + arguments[2:]))


def write_json(path: Path, document: object) -> Path:
    """통합 테스트 입력 JSON을 쓴다."""
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def write_jsonl(path: Path, records: list[dict]) -> Path:
    """통합 테스트 입력 JSONL을 쓴다."""
    path.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records), encoding="utf-8")
    return path


def test_precheck_reports_r0_stop_stage2_rates_and_input_hashes(tmp_path: Path) -> None:
    """학습 전 precheck는 R0 인용·신고 적중과 범주별 2차 단독 후보율, 입력 지문을 고정한다."""
    harmful = ("abuse", "sexual", "minors", "threat", "doxxing", "self_harm", "spam")
    allow = ("friendly_profanity", "game_combat", "quote_report", "number_url_like", "short_normal", "long_normal")
    records = [
        {
            "id": f"id-{category}",
            "split": "dev",
            "label": "harmful" if category in harmful else "allow",
            "category": category,
            "family": category,
            "author": "a",
            "reviewer": "b",
            "text": f"사전 검사 자리표시자 {category}",
        }
        for category in harmful + allow
    ]
    eval_file = write_jsonl(tmp_path / "dev.jsonl", records)
    eval_sha = compute_file_sha256(eval_file)
    routes = write_jsonl(
        tmp_path / "routes.jsonl",
        [
            {
                "id": row["id"],
                "decision": "candidate" if row["category"] == "quote_report" else "pass",
                "keyword": 7 if row["category"] == "minors" else None,  # R0에도 기본 키워드 경로 적중이 있다
                "skipAi": False,
                "evalSha256": eval_sha,
                "policySha256": round3_decision.R0_POLICY_SHA256,
            }
            for row in records
        ],
    )
    stage2 = write_json(
        tmp_path / "stage2.json",
        {
            "model": {"directory_name": "kanana", "identifier": "kanana@fixed"},
            "eval_file": {"name": eval_file.name, "sha256": eval_sha},
            "candidate_threshold": 0.5,
            "scores": {row["id"]: {"unsafe_probability": 0.6, "category": "S1"} for row in records},
        },
    )
    output = tmp_path / "precheck.json"
    main(
        [
            "precheck",
            "--eval-file",
            str(eval_file),
            "--rule-routes",
            str(routes),
            "--stage2-scores",
            str(stage2),
            "--output",
            str(output),
        ]
    )
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["rule_quote_report_rate"] == 1.0 and report["stop"] is True
    assert set(report["stage2_standalone_candidate_by_category"].values()) == {1.0}
    assert report["inputs"]["eval_file"]["sha256"] == eval_sha
    assert report["inputs"]["rule_routes"]["sha256"] == compute_file_sha256(routes)
    assert report["inputs"]["stage2_scores"]["sha256"] == compute_file_sha256(stage2)

    broken = json.loads(stage2.read_text(encoding="utf-8"))
    broken["scores"].pop(records[0]["id"])
    broken_path = write_json(tmp_path / "broken-stage2.json", broken)
    with pytest.raises(DatasetFormatError, match="id"):
        main(
            [
                "precheck",
                "--eval-file",
                str(eval_file),
                "--rule-routes",
                str(routes),
                "--stage2-scores",
                str(broken_path),
                "--output",
                str(tmp_path / "broken-output.json"),
            ]
        )


def test_dev_command_writes_decision_markdown_and_manifest_from_relative_config(tmp_path: Path) -> None:
    """dev 명령은 14개 평가 단위를 묶어 단순한 승자·배포 시드와 원문 없는 세 산출물을 쓴다."""
    harmful = ("abuse", "sexual", "minors", "threat", "doxxing", "self_harm", "spam")
    allow = ("friendly_profanity", "game_combat", "quote_report", "number_url_like", "short_normal", "long_normal")
    records = []
    for category in harmful + allow:
        records.append(
            {
                "id": f"id-{category}",
                "split": "dev",
                "label": "harmful" if category in harmful else "allow",
                "category": category,
                "family": f"family-{category}",
                "author": "model-a",
                "reviewer": "model-b",
                "text": f"통합 자리표시자 {category}",
            }
        )
    dev_file = write_jsonl(tmp_path / "dev.jsonl", records)
    dev_sha = compute_file_sha256(dev_file)
    route_records = [
        {"id": row["id"], "decision": "pass", "keyword": None, "skipAi": False, "evalSha256": dev_sha, "policySha256": round3_decision.R0_POLICY_SHA256}
        for row in records
    ]
    routes = write_jsonl(tmp_path / "routes.jsonl", route_records)
    stage2 = write_json(
        tmp_path / "stage2.json",
        {
            "model": {"directory_name": "kanana", "identifier": "kanana@fixed"},
            "eval_file": {"name": dev_file.name, "sha256": dev_sha},
            "candidate_threshold": 0.5,
            "scores": {row["id"]: {"unsafe_probability": 0.1, "category": "S1"} for row in records},
            "prefix_fallbacks": 0,
            "created_at": "2026-10-15T00:00:00+00:00",
        },
    )
    summary = at_threshold(critical=1.0, abuse=1.0, friendly=0.0, other_allow=0.0, quote_endpoint=0.0, weighted=0.0)
    mix = {category: 1 / len(records) for category in harmful + allow}
    scores = {row["id"]: 0.9 if row["label"] == "harmful" else 0.1 for row in records}
    item_flags = {
        row["id"]: {
            "routed": row["label"] == "harmful" or row["category"] == "quote_report",
            "goes_to_stage2": False,
            "endpoint": False,
        }
        for row in records
    }

    def evaluation_report(name: str, seeds: int | list[int], weights: str | list[str]) -> str:
        path = tmp_path / f"{name}.json"
        model_names = [f"model-{weight}" for weight in weights] if isinstance(weights, list) else None
        training_sha256 = H1T2_TRAINING_DATA_SHA256 if name.startswith("H1T2-") else "d" * 64
        write_json(
            path,
            {
                "split": "dev",
                "model_weights_sha256": weights,
                **(
                    {
                        "model_dirs": model_names,
                        "model_seeds": seeds,
                        "model_training_data_sha256s": [training_sha256] * len(model_names),
                    }
                    if model_names is not None
                    else {
                        "model_dir": f"model-{weights}",
                        "model_seed": seeds,
                        "model_training_data_sha256": training_sha256,
                    }
                ),
                "eval_file": {"sha256": dev_sha},
                "short_rule": {"max_length": 5, "multiplier": 4.0},
                "traffic_mix": mix,
                "rule_routes": {"policy_sha256": round3_decision.R0_POLICY_SHA256},
                "stage2_scores": {"model_identifier": "kanana@fixed", "sha256": compute_file_sha256(stage2)},
                "decision": {"mode": "budget", "budget": 0.304, "threshold": 0.42, "at_threshold": summary},
                "scores": scores,
                "item_flags": item_flags,
            },
        )
        return path.name

    reports: dict[str, dict] = {}
    seeds = (20261011, 20261021, 20261031)
    for model in ("H1T2", "D"):
        singles = [evaluation_report(f"{model}-s{seed}", seed, f"{model}-w{seed}") for seed in seeds]
        ensemble = evaluation_report(f"{model}-ensemble", list(seeds), [f"{model}-w{seed}" for seed in seeds])
        pairs = [
            evaluation_report(f"{model}-pair-{index}", list(pair), [f"{model}-w{seed}" for seed in pair])
            for index, pair in enumerate(((seeds[0], seeds[1]), (seeds[0], seeds[2]), (seeds[1], seeds[2])), start=1)
        ]
        reports[model] = {
            "single": [{"seed": seed, "path": path} for seed, path in zip(seeds, singles, strict=True)],
            "ensemble": ensemble,
            "pair_ensembles": pairs,
        }
    validation_auc: dict[str, list[str]] = {}
    for model in ("H1T2", "D"):
        validation_auc[model] = []
        for seed in seeds:
            path = write_json(
                tmp_path / f"auc-{model}-{seed}.json",
                {
                    "auc": 0.91,
                    "rows_excluded": 2,
                    "excluded_ids_sha256": "excluded-ids",
                    "val_file": {"sha256": "validation-file"},
                    "model_weights_sha256": f"{model}-w{seed}",
                },
            )
            validation_auc[model].append(path.name)
    validation_auc["original_h1t2"] = [
        write_json(
            tmp_path / f"card-{seed}.json",
            {
                "best_validation_auc": 0.91,
                "status": "completed",
                "hyperparameters": {"seed": seed},
                "training_data": {"train": {"sha256": H1T2_TRAINING_DATA_SHA256}},
            },
        ).name
        for seed in seeds
    ]
    config = write_json(
        tmp_path / "config.json",
        {
            "variant": "D",
            "dev_file": dev_file.name,
            "rule_routes": routes.name,
            "stage2_scores": stage2.name,
            "short_rule": {"max_length": 5, "multiplier": 4.0},
            "training_data_sha256": {"H1T2": H1T2_TRAINING_DATA_SHA256, "D": "d" * 64},
            "reports": reports,
            "validation_auc": validation_auc,
            "manifest": {
                "stage2_model": {
                    "directory_name": "kanana",
                    "identifier": "kanana@fixed",
                    "weights_sha256": "stage2-weights",
                    "tokenizer_sha256": "stage2-tokenizer",
                    "chat_template_sha256": "stage2-template",
                    "original_revision": "revision",
                    "conversion": {"bits": 4},
                    "classification_tokens": ["SAFE", "S1-S7"],
                    "files": [{"name": "model.safetensors", "sha256": "stage2-weights"}],
                },
                "holdout_sha256": "holdout-sha",
                "evaluation_code_commit": "commit-sha",
                "evaluate_rules_sha256": "rule-tool-sha",
            },
        },
    )
    output = tmp_path / "decision.json"
    main(["dev", "--config", str(config), "--output", str(output)])
    decision = json.loads(output.read_text(encoding="utf-8"))
    manifest = json.loads((tmp_path / "decision.manifest.json").read_text(encoding="utf-8"))
    assert decision["winner"]["key"] == "H1T2/single" and decision["deployment_seed"] == 20261011
    assert manifest["selected"] == {"model": "H1T2", "form": "single"}
    assert manifest["stage1"]["deployment_seed"] == 20261011 and len(manifest["stage1"]["units"]) == 3
    assert manifest["evaluate_rules_sha256"] == "rule-tool-sha"
    assert (tmp_path / "decision.md").is_file()
    combined = output.read_text(encoding="utf-8") + (tmp_path / "decision.md").read_text(encoding="utf-8")
    assert all(row["text"] not in combined for row in records)


def test_require_r0_policy_accepts_r0_and_rejects_other_fingerprints() -> None:
    """R0인지는 키워드 적중 유무가 아니라 규칙 지문으로 가린다(R0에도 기본 키워드 경로 적중이 있다)."""
    round3_decision.require_r0_policy(round3_decision.R0_POLICY_SHA256, "규칙 경로")
    with pytest.raises(DatasetFormatError, match="R0와 다릅니다"):
        round3_decision.require_r0_policy("da3b4400f4b8617c535f2d90bf3833121602a915eabfd6b0a302e473f4385739", "규칙 경로")


def test_model_card_auc_refuses_unfinished_training(tmp_path: Path) -> None:
    """검증 AUC 근거 카드가 학습 중(status running)이면 중간 체크포인트의 AUC라서 거절한다."""
    references = [
        write_json(
            tmp_path / f"card-{seed}.json",
            {
                "best_validation_auc": 0.91,
                "status": "running" if seed == 20261031 else "completed",
                "hyperparameters": {"seed": seed},
                "training_data": {"train": {"sha256": H1T2_TRAINING_DATA_SHA256}},
            },
        ).name
        for seed in (20261011, 20261021, 20261031)
    ]
    config = {"validation_auc": {"H1T2": references}}
    with pytest.raises(ModelFormatError, match="학습이 끝나지 않았습니다"):
        round3_decision.load_model_card_auc_values(config, tmp_path / "config.json", "H1T2", H1T2_TRAINING_DATA_SHA256)
