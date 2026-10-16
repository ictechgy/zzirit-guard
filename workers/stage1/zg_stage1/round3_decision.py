"""M2 3차 개발셋 선택과 봉인 보류셋 확인을 계획 문서의 고정 규칙으로 수행한다.

입력 보고서와 평가셋 원문은 읽기만 하며 출력에는 원문을 쓰지 않는다. 개발셋은 네 설정의 자격·선택,
보고용 짝지은 부트스트랩과 manifest 초안을 만들고, 보류셋은 그 manifest의 한 설정만 확인한다.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from zg_stage1.chat_eval_data import CRITICAL_CATEGORIES, ChatEvalItem, load_chat_eval_set
from zg_stage1.data import compute_file_sha256
from zg_stage1.errors import DatasetFormatError, OutputExistsError, run_command_line
from zg_stage1.evaluate_chat import (
    DEFAULT_STAGE2_POLICY,
    STAGE2_CANDIDATE_THRESHOLD,
    RuleRoute,
    ShortRule,
    Stage2Score,
    load_rule_routes,
    load_stage2_scores,
    weighted_forward_rate,
)
from zg_stage1.metrics import METRIC_DECIMALS
from zg_stage1.model_card import require_completed_training, utc_timestamp, write_json_atomically

PASS_MIN_RECALL = 0.90
NEAR_MIN_RECALL = 0.85
PASS_FRIENDLY_MAX = 0.30
NEAR_FRIENDLY_MAX = 0.35
PASS_ALLOW_MAX = 0.40
NEAR_ALLOW_MAX = 0.45
FORWARD_BUDGET = 0.304
AUC_MARGIN = 0.005
CONTROL_AUC_MEAN = 0.9070
SIMPLICITY_MARGIN = 0.02
BOOTSTRAP_SEED = 20261014
BOOTSTRAP_ROUNDS = 2000
REQUIRED_SHORT_RULE = {"max_length": 5, "multiplier": 4.0}

# 경로 S가 쓰는 규칙 경로 R0의 규칙 목록 지문(M2 2차 0단계에서 얼림). R0는 서버 기본 규칙과 기본 키워드 경로를
# 담고(그래서 keyword 적중이 있다), `--keywords`로 비공개 목록을 더한 RP와는 지문이 다르다. 키워드 유무가 아니라
# 이 지문으로 R0인지 확인한다. 서버 기본 규칙이 바뀌면 지문이 달라져 멈추는데, 경로를 얼린 이상 의도한 동작이다.
R0_POLICY_SHA256 = "1d3f789bae3360f686351c49763e98da89a7c4bbaa67427105d897e207bbb61f"
OTHER_ALLOW_CATEGORIES = ("game_combat", "short_normal", "long_normal", "number_url_like")
REQUIRED_TRAINING_SEEDS = (20261011, 20261021, 20261031)
H1T2_TRAINING_DATA_SHA256 = "9ffd01627a95c73ff2b21de24884913d525fbabba3af43b4cdd6c921da8d4a62"


def require_rate(mapping: Mapping[str, object], key: str, context: str) -> float:
    """보고서 비율 하나를 유한한 0~1 수로 읽는다."""
    value = mapping.get(key)
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(float(value)) or not 0 <= float(value) <= 1:
        raise DatasetFormatError(f"{context}: {key}가 유한한 0~1 비율이 아닙니다. evaluate_chat 결과를 다시 만드세요.")
    return float(value)


def check_minimum(name: str, value: float, threshold: float) -> str | None:
    """최솟값 기준 하나의 실패 이유."""
    return None if value >= threshold else f"{name} {value:.4f} < {threshold:.2f}"


def check_maximum(name: str, value: float, threshold: float) -> str | None:
    """최댓값 기준 하나의 실패 이유."""
    return None if value <= threshold else f"{name} {value:.4f} > {threshold:.2f}"


def assessment_failures(metrics: Mapping[str, float], minimum: float, friendly_max: float, allow_max: float) -> list[str]:
    """통과 또는 근접 경계에서 벗어난 항목 이름과 값을 모은다."""
    checks = [
        check_minimum("critical_recall_min", metrics["critical_recall_min"], minimum),
        check_minimum("abuse_recall", metrics["abuse_recall"], minimum),
        check_maximum("friendly_profanity", metrics["friendly_profanity"], friendly_max),
        *(check_maximum(category, metrics[category], allow_max) for category in OTHER_ALLOW_CATEGORIES),
        check_maximum("quote_report_endpoint", metrics["quote_report_endpoint"], allow_max),
    ]
    return [failure for failure in checks if failure is not None]


def extract_unit_metrics(summary: Mapping[str, object]) -> dict[str, Any]:
    """evaluate_chat 결정점에서 3차 표에 필요한 비율만 원문 없이 꺼낸다."""
    by_category = summary.get("by_category")
    endpoint = summary.get("endpoint_candidate_by_category")
    if not isinstance(by_category, dict) or not isinstance(endpoint, dict):
        raise DatasetFormatError("evaluate_chat 결과에 범주별 전달률이나 경로 끝 후보율이 없습니다. --stage2-scores로 다시 평가하세요.")
    metrics: dict[str, Any] = {
        "threshold": require_number(summary.get("threshold"), "임계값", lower_exclusive=0.0, upper=1.0),
        "weighted_forward_rate": require_rate(summary, "weighted_forward_rate", "평가 단위"),
        "critical_recall_min": require_rate(summary, "critical_recall_min", "평가 단위"),
        "by_category": {key: require_rate(by_category, key, "범주별 전달률") for key in by_category},
        "endpoint_candidate_by_category": {key: require_rate(endpoint, key, "경로 끝 후보율") for key in endpoint},
    }
    metrics |= {
        "abuse_recall": require_rate(by_category, "abuse", "범주별 전달률"),
        "friendly_profanity": require_rate(by_category, "friendly_profanity", "범주별 전달률"),
        "quote_report_stage1_forward_rate": require_rate(by_category, "quote_report", "범주별 전달률"),
        "quote_report_endpoint": require_rate(endpoint, "quote_report", "경로 끝 후보율"),
        **{category: require_rate(by_category, category, "범주별 전달률") for category in OTHER_ALLOW_CATEGORIES},
    }
    metrics["allowed_max"] = max(
        metrics["friendly_profanity"],
        metrics["quote_report_endpoint"],
        *(metrics[category] for category in OTHER_ALLOW_CATEGORIES),
    )
    return metrics


def assess_evaluation_unit(summary: Mapping[str, object]) -> dict[str, Any]:
    """평가 단위 하나에 계획 표의 통과·근접 부등호를 적용한다."""
    metrics = extract_unit_metrics(summary)
    pass_failures = assessment_failures(metrics, PASS_MIN_RECALL, PASS_FRIENDLY_MAX, PASS_ALLOW_MAX)
    near_failures = assessment_failures(metrics, NEAR_MIN_RECALL, NEAR_FRIENDLY_MAX, NEAR_ALLOW_MAX)
    passed, near = not pass_failures, not near_failures
    return metrics | {
        "pass": passed,
        "near": near,
        "status": "pass" if passed else "near" if near else "fail",
        "pass_failures": pass_failures,
        "near_failures": near_failures,
    }


def single_qualifies(units: Sequence[Mapping[str, object]], auc_pass: bool) -> bool:
    """단일 형태: 세 시드 중 둘 통과, 모두 근접, AUC 통과."""
    return len(units) == 3 and sum(unit.get("pass") is True for unit in units) >= 2 and all(unit.get("near") is True for unit in units) and auc_pass


def ensemble_qualifies(ensemble: Mapping[str, object], pair_units: Sequence[Mapping[str, object]], auc_pass: bool) -> bool:
    """앙상블 형태: 세 시드 앙상블 통과, 세 두-시드 앙상블 모두 근접, AUC 통과."""
    return ensemble.get("pass") is True and len(pair_units) == 3 and all(unit.get("near") is True for unit in pair_units) and auc_pass


def choose_winner(settings: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    """자격 최고 M에서 0.02 안인 설정 중 형태, 모델 순으로 가장 단순한 것을 고른다."""
    qualified = [dict(setting) for setting in settings if setting.get("qualified") is True]
    if not qualified:
        return None
    maximum = max(float(setting["critical_recall"]) for setting in qualified)
    close = [setting for setting in qualified if float(setting["critical_recall"]) + 1e-12 >= maximum - SIMPLICITY_MARGIN]
    form_rank = {"single": 0, "ensemble": 1}
    close.sort(key=lambda setting: (form_rank[str(setting["form"])], 0 if setting["model"] == "H1T2" else 1))
    return close[0]


def select_deployment_seed(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """통과 시드 중 핵심 최소, 계획표 허용 최대, 칭찬 비속어, 작은 시드 순서로 고른다."""
    passed = [dict(row) for row in rows if row.get("pass") is True]
    if not passed:
        raise DatasetFormatError("단일 승자에 통과한 시드가 없습니다. 자격 계산과 보고서를 확인하세요.")
    passed.sort(
        key=lambda row: (
            -float(row["critical_recall_min"]),
            float(row["allowed_max"]),
            float(row["friendly_profanity"]),
            int(row["seed"]),
        )
    )
    return passed[0]


def require_number(value: object, name: str, *, lower: float | None = None, lower_exclusive: float | None = None, upper: float | None = None) -> float:
    """설정·보고서의 유한한 수를 범위와 함께 검증한다."""
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(float(value)):
        raise DatasetFormatError(f"{name}이 유한한 수가 아닙니다. 입력 JSON을 확인하세요.")
    numeric = float(value)
    below = lower is not None and numeric < lower
    below_exclusive = lower_exclusive is not None and numeric <= lower_exclusive
    if below or below_exclusive or upper is not None and numeric > upper:
        raise DatasetFormatError(f"{name} {numeric}이 허용 범위를 벗어났습니다. 입력 JSON을 확인하세요.")
    return numeric


def items_by_category(items: Sequence[ChatEvalItem]) -> dict[str, list[ChatEvalItem]]:
    """재표본 층을 범주별로 만든다."""
    grouped: dict[str, list[ChatEvalItem]] = {}
    for item in items:
        grouped.setdefault(item.category, []).append(item)
    return grouped


def stratified_resample(items: Sequence[ChatEvalItem], rng: random.Random) -> list[ChatEvalItem]:
    """각 범주의 원래 크기를 유지하며 복원 추출한다."""
    return [rng.choice(group) for group in items_by_category(items).values() for _item in group]


def critical_min_from_flags(flags_by_unit: Sequence[Mapping[str, bool]], sample: Sequence[ChatEvalItem]) -> float:
    """표본에서 단일은 시드별 핵심 최소의 평균, 앙상블은 그 한 값이다."""
    grouped = items_by_category(sample)
    values = []
    for flags in flags_by_unit:
        recalls = [sum(flags[item.item_id] for item in grouped[category]) / len(grouped[category]) for category in sorted(CRITICAL_CATEGORIES)]
        values.append(min(recalls))
    return sum(values) / len(values)


def bootstrap_critical_difference(
    first: Sequence[Mapping[str, bool]], second: Sequence[Mapping[str, bool]], items: Sequence[ChatEvalItem]
) -> dict[str, float | int]:
    """같은 층화 재표본 id로 두 설정의 핵심 최소 차이 95% 구간을 계산한다."""
    harmful = [item for item in items if item.label == "harmful" and item.category in CRITICAL_CATEGORIES]
    if set(items_by_category(harmful)) != set(CRITICAL_CATEGORIES):
        raise DatasetFormatError("핵심 범주가 모두 있어야 부트스트랩을 계산할 수 있습니다. 개발셋을 확인하세요.")
    rng = random.Random(BOOTSTRAP_SEED)
    differences = sorted(
        critical_min_from_flags(first, sample) - critical_min_from_flags(second, sample)
        for sample in (stratified_resample(harmful, rng) for _ in range(BOOTSTRAP_ROUNDS))
    )
    return bootstrap_interval(differences)


def bootstrap_interval(differences: Sequence[float]) -> dict[str, float | int]:
    """계획에 고정한 정렬 인덱스로 95% 구간을 꺼낸다."""
    low = differences[int(0.025 * BOOTSTRAP_ROUNDS)]
    high = differences[int(0.975 * BOOTSTRAP_ROUNDS) - 1]
    return {"low": round(low, 6), "high": round(high, 6), "rounds": BOOTSTRAP_ROUNDS}


def friendly_rate_from_flags(flags_by_unit: Sequence[Mapping[str, bool]], sample: Sequence[ChatEvalItem]) -> float:
    """칭찬 비속어 재표본의 단위별 전달률을 평균한다."""
    return sum(sum(flags[item.item_id] for item in sample) / len(sample) for flags in flags_by_unit) / len(flags_by_unit)


def bootstrap_friendly_difference(
    first: Sequence[Mapping[str, bool]], second: Sequence[Mapping[str, bool]], items: Sequence[ChatEvalItem]
) -> dict[str, float | int | bool]:
    """같은 칭찬 비속어 재표본에서 X-H1T2 전달 차이 구간과 상한<0 여부를 낸다."""
    friendly = [item for item in items if item.is_scored and item.category == "friendly_profanity"]
    if not friendly:
        raise DatasetFormatError("칭찬 비속어 문장이 없어 메커니즘 부트스트랩을 계산할 수 없습니다.")
    rng = random.Random(BOOTSTRAP_SEED)
    differences = sorted(
        friendly_rate_from_flags(first, sample) - friendly_rate_from_flags(second, sample)
        for sample in (stratified_resample(friendly, rng) for _ in range(BOOTSTRAP_ROUNDS))
    )
    interval = bootstrap_interval(differences)
    return interval | {"upper_below_zero": float(interval["high"]) < 0}


def require_equal(actual: object, expected: object, label: str) -> None:
    """manifest와 보고서 고정값이 다르면 조정하지 말고 오류로 멈춘다."""
    if actual is None or expected is None or actual != expected:
        raise DatasetFormatError(f"{label}이 고정값과 다릅니다. 같은 입력·manifest로 평가를 다시 실행하세요.")


def validate_holdout_common(manifest: Mapping[str, Any], report: Mapping[str, Any]) -> None:
    """모든 보류셋 보고서에서 가중치 외 봉인 불변식을 확인한다."""
    if report.get("split") != "holdout" or report.get("decision", {}).get("mode") != "fixed":
        raise DatasetFormatError("보류셋 고정 임계값 보고서가 아닙니다. evaluate_chat --dev-report 결과를 주세요.")
    require_equal(manifest.get("forward_budget"), FORWARD_BUDGET, "가중 전달 예산")
    require_equal(manifest.get("short_rule"), REQUIRED_SHORT_RULE, "manifest 짧은 문장 규칙")
    require_equal(report.get("short_rule"), manifest.get("short_rule"), "짧은 문장 규칙")
    require_equal(report.get("traffic_mix"), manifest.get("traffic_mix"), "구성비")
    routes = report.get("rule_routes")
    require_equal(routes.get("policy_sha256") if isinstance(routes, dict) else None, manifest.get("rule_policy_sha256"), "규칙 지문")
    stage2 = report.get("stage2_scores")
    expected_stage2 = manifest.get("stage2_model")
    expected_identifier = expected_stage2.get("identifier") if isinstance(expected_stage2, dict) else None
    require_equal(stage2.get("model_identifier") if isinstance(stage2, dict) else None, expected_identifier, "2차 모델 식별자")
    evaluation = report.get("eval_file")
    require_equal(evaluation.get("sha256") if isinstance(evaluation, dict) else None, manifest.get("holdout_sha256"), "보류셋 sha256")


def assess_holdout_summary(summary: Mapping[str, object], budget: float) -> dict[str, Any]:
    """개발셋 통과 표와 고정 가중 전달 예산을 함께 확인한다."""
    assessed = assess_evaluation_unit(summary)
    failures = list(assessed["pass_failures"])
    weighted = require_number(summary.get("weighted_forward_rate_exact"), "반올림 전 가중 전달률", lower=0.0, upper=1.0)
    within_budget = summary.get("within_budget")
    if not isinstance(within_budget, bool):
        raise DatasetFormatError("보류셋 보고서에 within_budget 불리언이 없습니다. 현재 evaluate_chat으로 다시 평가하세요.")
    if within_budget != (weighted <= budget):
        raise DatasetFormatError("보류셋 보고서의 within_budget과 반올림 전 가중 전달률이 서로 다릅니다.")
    if not within_budget:
        failures.append(f"weighted_forward_rate_exact {weighted:.6f} > {budget:.3f}")
    return assessed | {"passed": not failures, "failures": failures}


def single_manifest_unit(manifest: Mapping[str, Any], report: Mapping[str, Any]) -> Mapping[str, Any]:
    """단일 보고서 가중치와 일치하는 manifest 시드 단위를 찾는다."""
    stage1 = manifest.get("stage1")
    units = stage1.get("units") if isinstance(stage1, dict) else None
    if not isinstance(units, list):
        raise DatasetFormatError("단일 manifest의 stage1.units가 없습니다. 개발셋 판정 manifest를 다시 만드세요.")
    weight = report.get("model_weights_sha256")
    matches = [unit for unit in units if isinstance(unit, dict) and unit.get("weights_sha256") == weight]
    if len(matches) != 1:
        raise DatasetFormatError("보류셋 보고서의 1차 가중치가 manifest의 단일 후보에 없습니다. 다른 설정의 보고서를 섞지 마세요.")
    return matches[0]


def validate_single_report(manifest: Mapping[str, Any], report: Mapping[str, Any]) -> tuple[Mapping[str, Any], str]:
    """단일 시드 가중치·임계값을 확인하고 배포/진단 역할을 돌려준다."""
    unit = single_manifest_unit(manifest, report)
    decision = report.get("decision")
    threshold = decision.get("threshold") if isinstance(decision, dict) else None
    require_equal(threshold, unit.get("threshold"), "임계값")
    deployment = manifest["stage1"].get("deployment_seed")
    return unit, "deployment" if unit.get("seed") == deployment else "diagnostic"


def validate_ensemble_report(manifest: Mapping[str, Any], report: Mapping[str, Any]) -> tuple[Mapping[str, Any], str]:
    """앙상블 가중치 순서와 고정 임계값을 확인한다."""
    stage1 = manifest.get("stage1")
    if not isinstance(stage1, dict):
        raise DatasetFormatError("앙상블 manifest의 stage1 설정이 없습니다.")
    require_equal(report.get("model_weights_sha256"), stage1.get("weights_sha256"), "1차 가중치 목록·순서")
    decision = report.get("decision")
    threshold = decision.get("threshold") if isinstance(decision, dict) else None
    require_equal(threshold, stage1.get("threshold"), "임계값")
    return stage1, "deployment"


def evaluate_holdout_reports(manifest: Mapping[str, Any], reports: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """manifest의 선택 설정만 받아 보류셋 합격과 단일 진단 시드를 구분한다."""
    selected = manifest.get("selected")
    form = selected.get("form") if isinstance(selected, dict) else None
    if form not in {"single", "ensemble"}:
        raise DatasetFormatError("manifest의 선택 형태가 single 또는 ensemble이 아닙니다.")
    selected_value = dict(selected) if isinstance(selected, dict) else {}
    if not reports or form == "ensemble" and len(reports) != 1:
        raise DatasetFormatError("앙상블 보류셋은 manifest의 보고서 하나, 단일은 배포 시드를 포함한 보고서를 주세요.")
    budget = require_number(manifest.get("forward_budget"), "가중 전달 예산", lower=0.0, upper=1.0)
    units = []
    seen_weights: set[str] = set()
    for report in reports:
        validate_holdout_common(manifest, report)
        fixed, role = validate_single_report(manifest, report) if form == "single" else validate_ensemble_report(manifest, report)
        weight_key = json.dumps(report.get("model_weights_sha256"), sort_keys=True)
        if weight_key in seen_weights:
            raise DatasetFormatError("같은 1차 가중치의 보류셋 보고서가 겹칩니다. 각 manifest 단위를 한 번만 주세요.")
        seen_weights.add(weight_key)
        decision = report["decision"]
        summary = decision.get("at_threshold") if isinstance(decision, dict) else None
        if not isinstance(summary, dict):
            raise DatasetFormatError("보류셋 보고서에 고정 임계값 집계가 없습니다.")
        assessment = assess_holdout_summary(summary, budget)
        hidden = {"pass", "near", "status", "pass_failures", "near_failures", "passed", "failures"}
        units.append(
            {
                "seed": fixed.get("seed"),
                "role": role,
                "passed": assessment["passed"],
                "failures": assessment["failures"],
                "metrics": {key: value for key, value in assessment.items() if key not in hidden},
            }
        )
    deployment = [unit for unit in units if unit["role"] == "deployment"]
    if len(deployment) != 1:
        raise DatasetFormatError("단일 manifest의 배포 시드 보고서가 정확히 하나 있어야 합니다. --holdout-reports를 확인하세요.")
    return {"passed": deployment[0]["passed"], "selected": selected_value, "units": units}


def read_json_object(path: Path, label: str) -> dict[str, Any]:
    """JSON 파일 하나를 객체로 읽고 원인과 다시 만들 대상을 알린다."""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise DatasetFormatError(f"{path.name}: {label} JSON을 읽을 수 없습니다. 경로와 완성된 JSON인지 확인하세요.") from error
    if not isinstance(document, dict):
        raise DatasetFormatError(f"{path.name}: {label}은 JSON 객체여야 합니다. 형식을 확인하세요.")
    return document


def resolve_relative_path(config_path: Path, value: object, label: str) -> Path:
    """CONFIG 안의 상대경로를 CONFIG 디렉터리 기준으로 해석한다."""
    if not isinstance(value, str) or not value:
        raise DatasetFormatError(f"CONFIG의 {label} 경로가 없습니다. 파일 경로 문자열을 넣으세요.")
    path = Path(value)
    return path if path.is_absolute() else config_path.parent / path


def report_reference(reference: object, config_path: Path, *, needs_seed: bool) -> tuple[int | None, Path]:
    """보고서 참조 문자열 또는 {seed,path} 객체를 읽는다."""
    if isinstance(reference, str) and not needs_seed:
        return None, resolve_relative_path(config_path, reference, "보고서")
    if not isinstance(reference, dict):
        raise DatasetFormatError("단일 보고서는 {seed, path}, 앙상블 보고서는 경로 문자열 또는 {path}로 적으세요.")
    seed = reference.get("seed")
    if needs_seed and (isinstance(seed, bool) or not isinstance(seed, int)):
        raise DatasetFormatError("단일 보고서 참조에는 정수 seed가 필요합니다.")
    return int(seed) if isinstance(seed, int) else None, resolve_relative_path(config_path, reference.get("path"), "보고서")


def report_provenance(path: Path) -> dict[str, str]:
    """결과에 남길 보고서 파일 이름과 sha256."""
    return {"name": path.name, "sha256": compute_file_sha256(path)}


def load_report_item_flags(report: Mapping[str, Any], items: Sequence[ChatEvalItem], file_name: str) -> dict[str, dict[str, bool]]:
    """반올림 전 점수로 만든 dev 결정점 플래그를 엄격하게 읽는다."""
    expected_ids = {item.item_id for item in items if item.is_scored}
    raw = report.get("item_flags")
    if not isinstance(raw, dict) or set(raw) != expected_ids:
        raise DatasetFormatError(f"{file_name}: item_flags id가 채점 개발셋과 다릅니다. --stage2-scores로 다시 평가하세요.")
    result: dict[str, dict[str, bool]] = {}
    required = {"routed", "goes_to_stage2", "endpoint"}
    for identifier, value in raw.items():
        if not isinstance(value, dict) or not required <= set(value) or any(not isinstance(value[key], bool) for key in required):
            raise DatasetFormatError(f"{file_name}: id {identifier!r}의 item_flags가 routed·goes_to_stage2·endpoint 불리언이 아닙니다.")
        endpoint_decision = value.get("endpoint_decision")
        if endpoint_decision is not None and (
            endpoint_decision not in {"candidate", "needs_care", "pass"} or value["endpoint"] != (endpoint_decision != "pass")
        ):
            raise DatasetFormatError(f"{file_name}: id {identifier!r}의 endpoint와 endpoint_decision 관계가 모순됩니다.")
        if (value["goes_to_stage2"] or value["endpoint"]) and not value["routed"]:
            raise DatasetFormatError(f"{file_name}: id {identifier!r}의 item_flags 경로 관계가 모순됩니다.")
        result[str(identifier)] = {key: value[key] for key in required}
    return result


def rates_from_item_flags(items: Sequence[ChatEvalItem], flags: Mapping[str, Mapping[str, bool]], key: str) -> dict[str, float]:
    """저장된 id별 플래그로 범주별 비율을 재구성한다."""
    totals: dict[str, int] = {}
    counted: dict[str, int] = {}
    for item in items:
        if not item.is_scored:
            continue
        totals[item.category] = totals.get(item.category, 0) + 1
        counted[item.category] = counted.get(item.category, 0) + flags[item.item_id][key]
    return {category: counted[category] / totals[category] for category in sorted(totals)}


def validate_flag_aggregates(
    report: Mapping[str, Any], summary: Mapping[str, object], items: Sequence[ChatEvalItem], file_name: str
) -> dict[str, dict[str, bool]]:
    """item_flags와 보고서 집계·정확 부하가 완전히 같은지 확인한다."""
    flags = load_report_item_flags(report, items, file_name)
    routed = rates_from_item_flags(items, flags, "routed")
    stage2 = rates_from_item_flags(items, flags, "goes_to_stage2")
    endpoint = rates_from_item_flags(items, flags, "endpoint")
    expected_routed = {category: round(rate, METRIC_DECIMALS) for category, rate in routed.items()}
    expected_endpoint = {category: round(rate, METRIC_DECIMALS) for category, rate in endpoint.items()}
    require_equal(summary.get("by_category"), expected_routed, f"{file_name}의 item_flags 범주별 전달률")
    require_equal(
        summary.get("endpoint_candidate_by_category"),
        expected_endpoint,
        f"{file_name}의 item_flags 경로 끝 후보율",
    )
    mix = report.get("traffic_mix")
    if not isinstance(mix, dict):
        raise DatasetFormatError(f"{file_name}: 트래픽 구성비가 없습니다.")
    exact = weighted_forward_rate(stage2, {str(key): require_rate(mix, str(key), "트래픽 구성비") for key in mix})
    require_equal(summary.get("weighted_forward_rate_exact"), exact, f"{file_name}의 반올림 전 가중 전달률")
    return flags


def validate_dev_report(
    report: Mapping[str, Any],
    file_name: str,
    expected_eval_sha256: str,
    expected_policy: str,
    expected_stage2: str,
    expected_stage2_sha256: str,
    expected_short_rule: Mapping[str, object],
    items: Sequence[ChatEvalItem],
) -> tuple[Mapping[str, object], dict[str, dict[str, bool]]]:
    """개발셋 보고서가 고정 경로·2차·평가셋·짧은 규칙으로 만든 예산 결과인지 확인한다."""
    if report.get("split") != "dev" or report.get("decision", {}).get("mode") != "budget":
        raise DatasetFormatError(f"{file_name}: 개발셋 예산 보고서가 아닙니다.")
    decision = report.get("decision")
    if not isinstance(decision, dict):
        raise DatasetFormatError(f"{file_name}: decision 객체가 없습니다.")
    require_equal(decision.get("budget"), FORWARD_BUDGET, f"{file_name}의 가중 전달 예산")
    require_equal(dict(expected_short_rule), REQUIRED_SHORT_RULE, "판정 짧은 문장 규칙")
    require_equal(report.get("short_rule"), dict(expected_short_rule), f"{file_name}의 짧은 문장 규칙")
    if "stage2_policy" in report:
        require_equal(report.get("stage2_policy"), DEFAULT_STAGE2_POLICY.to_dict(), f"{file_name}의 2차 후보 기준 정책")
    routes = report.get("rule_routes")
    require_equal(routes.get("policy_sha256") if isinstance(routes, dict) else None, expected_policy, f"{file_name}의 규칙 지문")
    stage2 = report.get("stage2_scores")
    require_equal(stage2.get("model_identifier") if isinstance(stage2, dict) else None, expected_stage2, f"{file_name}의 2차 모델")
    require_equal(stage2.get("sha256") if isinstance(stage2, dict) else None, expected_stage2_sha256, f"{file_name}의 2차 점수 파일")
    evaluation = report.get("eval_file")
    require_equal(evaluation.get("sha256") if isinstance(evaluation, dict) else None, expected_eval_sha256, f"{file_name}의 개발셋 sha256")
    summary = decision.get("at_threshold")
    if not isinstance(summary, dict):
        raise DatasetFormatError(f"{file_name}: 예산을 지키는 결정점 집계가 없습니다.")
    require_equal(summary.get("threshold"), decision.get("threshold"), f"{file_name}의 결정 임계값")
    exact = require_number(summary.get("weighted_forward_rate_exact"), f"{file_name}의 반올림 전 가중 전달률", lower=0.0, upper=1.0)
    if summary.get("within_budget") is not True or exact > FORWARD_BUDGET:
        raise DatasetFormatError(f"{file_name}: 결정 임계값이 가중 전달 예산 {FORWARD_BUDGET}를 지키지 않습니다.")
    return summary, validate_flag_aggregates(report, summary, items, file_name)


def load_evaluation_report(
    path: Path,
    items: Sequence[ChatEvalItem],
    routes: Mapping[str, RuleRoute],
    short_rule: ShortRule,
    expected_eval_sha256: str,
    expected_policy: str,
    expected_stage2: str,
    expected_stage2_sha256: str,
    expected_weights: int,
) -> dict[str, Any]:
    """보고서 하나를 검증하고 판정 지표·부트스트랩 flags·출처를 묶는다."""
    report = read_json_object(path, "evaluate_chat 보고서")
    summary, flags = validate_dev_report(
        report,
        path.name,
        expected_eval_sha256,
        expected_policy,
        expected_stage2,
        expected_stage2_sha256,
        short_rule.to_dict(),
        items,
    )
    weights = report.get("model_weights_sha256")
    valid_weights = (
        isinstance(weights, str) and bool(weights)
        if expected_weights == 1
        else isinstance(weights, list) and len(weights) == expected_weights and all(isinstance(weight, str) and weight for weight in weights)
    )
    if not valid_weights:
        raise DatasetFormatError(f"{path.name}: 이 평가 형태는 1차 가중치 {expected_weights}개여야 합니다. --model-dir 구성을 확인하세요.")
    assessment = assess_evaluation_unit(summary)
    return {
        "report": report,
        "assessment": assessment,
        "flags": {identifier: value["routed"] for identifier, value in flags.items()},
        "source": report_provenance(path),
    }


def require_three(values: object, label: str) -> list[object]:
    """세 시드 또는 세 두-시드 앙상블 참조인지 확인한다."""
    if not isinstance(values, list) or len(values) != 3:
        raise DatasetFormatError(f"CONFIG의 {label}은 정확히 3개여야 합니다.")
    return values


def load_model_reports(
    model: str,
    config: Mapping[str, Any],
    config_path: Path,
    items: Sequence[ChatEvalItem],
    routes: Mapping[str, RuleRoute],
    short_rule: ShortRule,
    eval_sha256: str,
    policy: str,
    stage2_identifier: str,
    stage2_sha256: str,
    expected_training_data_sha256: str,
) -> dict[str, Any]:
    """모델 하나의 단일 3개·세 시드 앙상블·두 시드 앙상블 3개를 읽는다."""
    reports = config.get("reports")
    model_config = reports.get(model) if isinstance(reports, dict) else None
    if not isinstance(model_config, dict):
        raise DatasetFormatError(f"CONFIG reports에 {model} 설정이 없습니다.")
    singles = []
    for reference in require_three(model_config.get("single"), f"reports.{model}.single"):
        seed, path = report_reference(reference, config_path, needs_seed=True)
        loaded = load_evaluation_report(path, items, routes, short_rule, eval_sha256, policy, stage2_identifier, stage2_sha256, 1)
        require_equal(loaded["report"].get("model_seed"), seed, f"{path.name}의 학습 시드")
        require_equal(
            loaded["report"].get("model_training_data_sha256"),
            expected_training_data_sha256,
            f"{path.name}의 학습 데이터 sha256",
        )
        singles.append(loaded | {"seed": seed})
    seeds = tuple(entry["seed"] for entry in singles)
    if seeds != REQUIRED_TRAINING_SEEDS:
        raise DatasetFormatError(f"CONFIG reports.{model}.single은 시드 {REQUIRED_TRAINING_SEEDS}를 오름차순으로 정확히 한 번씩 담아야 합니다.")
    single_weights = [entry["report"]["model_weights_sha256"] for entry in singles]
    if len(set(single_weights)) != 3:
        raise DatasetFormatError(f"reports.{model}.single의 세 가중치 sha256은 서로 달라야 합니다.")
    _seed, ensemble_path = report_reference(model_config.get("ensemble"), config_path, needs_seed=False)
    ensemble = load_evaluation_report(ensemble_path, items, routes, short_rule, eval_sha256, policy, stage2_identifier, stage2_sha256, 3)
    require_equal(ensemble["report"].get("model_seeds"), list(REQUIRED_TRAINING_SEEDS), f"{ensemble_path.name}의 앙상블 시드 순서")
    require_equal(
        ensemble["report"].get("model_training_data_sha256s"),
        [expected_training_data_sha256] * 3,
        f"{ensemble_path.name}의 앙상블 학습 데이터 sha256",
    )
    require_equal(ensemble["report"].get("model_weights_sha256"), single_weights, f"{ensemble_path.name}의 앙상블 가중치 집합·순서")
    pairs = []
    for reference in require_three(model_config.get("pair_ensembles"), f"reports.{model}.pair_ensembles"):
        _pair_seed, path = report_reference(reference, config_path, needs_seed=False)
        loaded = load_evaluation_report(path, items, routes, short_rule, eval_sha256, policy, stage2_identifier, stage2_sha256, 2)
        pair_seeds = loaded["report"].get("model_seeds")
        pair_weights = loaded["report"].get("model_weights_sha256")
        if not isinstance(pair_seeds, list) or len(pair_seeds) != 2 or pair_seeds != sorted(pair_seeds):
            raise DatasetFormatError(f"{path.name}: 두 시드 앙상블의 model_seeds가 오름차순 두 개가 아닙니다.")
        require_equal(
            loaded["report"].get("model_training_data_sha256s"),
            [expected_training_data_sha256] * 2,
            f"{path.name}의 두 시드 학습 데이터 sha256",
        )
        expected_weights = [single_weights[REQUIRED_TRAINING_SEEDS.index(seed)] for seed in pair_seeds if seed in REQUIRED_TRAINING_SEEDS]
        if len(expected_weights) != 2:
            raise DatasetFormatError(f"{path.name}: 두 시드 앙상블에 고정 학습 시드 외의 값이 있습니다.")
        require_equal(pair_weights, expected_weights, f"{path.name}의 두 시드 가중치 집합·순서")
        pairs.append(loaded | {"seeds": tuple(pair_seeds)})
    expected_pairs = {
        (REQUIRED_TRAINING_SEEDS[0], REQUIRED_TRAINING_SEEDS[1]),
        (REQUIRED_TRAINING_SEEDS[0], REQUIRED_TRAINING_SEEDS[2]),
        (REQUIRED_TRAINING_SEEDS[1], REQUIRED_TRAINING_SEEDS[2]),
    }
    if {entry["seeds"] for entry in pairs} != expected_pairs:
        raise DatasetFormatError(f"CONFIG reports.{model}.pair_ensembles은 세 시드의 2개 조합 세 가지여야 합니다.")
    return {"single": singles, "ensemble": ensemble, "pair_ensembles": pairs}


def model_card_auc(document: Mapping[str, Any], file_name: str) -> float:
    """모델 카드의 원래 검증 AUC. best_validation_auc가 없으면 auc로 대체하지 않는다."""
    if "best_validation_auc" not in document:
        raise DatasetFormatError(f"{file_name}: 모델 카드에 best_validation_auc가 없습니다.")
    return require_number(document["best_validation_auc"], f"{file_name}의 best_validation_auc", lower=0.0, upper=1.0)


def configured_training_data_sha256(config: Mapping[str, Any], variant: str) -> dict[str, str]:
    """CONFIG의 모델별 학습 파일 지문을 읽고 H1T2 고정값을 교차 확인한다."""
    section = config.get("training_data_sha256")
    if not isinstance(section, dict):
        raise DatasetFormatError("CONFIG training_data_sha256 모델별 학습 파일 지문이 없습니다.")
    result: dict[str, str] = {}
    for model in ("H1T2", variant):
        value = section.get(model)
        if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
            raise DatasetFormatError(f"CONFIG training_data_sha256.{model}은 소문자 sha256이어야 합니다.")
        result[model] = value
    require_equal(result["H1T2"], H1T2_TRAINING_DATA_SHA256, "CONFIG의 H1T2 학습 데이터 sha256")
    return result


def model_card_training_data_sha256(document: Mapping[str, Any], file_name: str) -> str:
    """모델 카드 실제 필드 training_data.train.sha256을 엄격하게 읽는다."""
    training_data = document.get("training_data")
    train = training_data.get("train") if isinstance(training_data, dict) else None
    sha256 = train.get("sha256") if isinstance(train, dict) else None
    if not isinstance(sha256, str) or not sha256:
        raise DatasetFormatError(f"{file_name}: 모델 카드에 training_data.train.sha256 학습 데이터 지문이 없습니다.")
    return sha256


def load_model_card_auc_values(config: Mapping[str, Any], config_path: Path, key: str, expected_training_data_sha256: str) -> dict[str, Any]:
    """CONFIG validation_auc 항목의 세 모델 카드 AUC를 읽는다."""
    section = config.get("validation_auc")
    references = section.get(key) if isinstance(section, dict) else None
    values, sources = [], []
    for reference, expected_seed in zip(require_three(references, f"validation_auc.{key}"), REQUIRED_TRAINING_SEEDS, strict=True):
        path = resolve_relative_path(config_path, reference, f"validation_auc.{key}")
        document = read_json_object(path, "모델 카드 AUC 근거")
        require_completed_training(document, path.parent.name)
        hyperparameters = document.get("hyperparameters")
        seed = hyperparameters.get("seed") if isinstance(hyperparameters, dict) else None
        require_equal(seed, expected_seed, f"{path.name}의 모델 카드 학습 시드")
        require_equal(
            model_card_training_data_sha256(document, path.name),
            expected_training_data_sha256,
            f"{path.name}의 모델 카드 학습 데이터 sha256",
        )
        values.append(model_card_auc(document, path.name))
        sources.append(report_provenance(path))
    return {"values": values, "mean": sum(values) / len(values), "sources": sources}


def load_policy_auc_values(
    config: Mapping[str, Any],
    config_path: Path,
    model: str,
    expected_weights: Sequence[str],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """D의 정책 정렬 AUC 세 파일을 읽고 각 단일 보고서 가중치와 맞춘다."""
    section = config.get("validation_auc")
    references = section.get(model) if isinstance(section, dict) else None
    values, sources, documents = [], [], []
    for reference, expected_weight in zip(require_three(references, f"validation_auc.{model}"), expected_weights, strict=True):
        path = resolve_relative_path(config_path, reference, f"validation_auc.{model}")
        document = read_json_object(path, "정책 정렬 검증 AUC 근거")
        values.append(require_number(document.get("auc"), f"{path.name}의 정책 정렬 AUC", lower=0.0, upper=1.0))
        require_equal(document.get("model_weights_sha256"), expected_weight, f"{path.name}의 1차 가중치")
        excluded = document.get("rows_excluded")
        if isinstance(excluded, bool) or not isinstance(excluded, int) or excluded <= 0:
            raise DatasetFormatError(f"{path.name}: rows_excluded가 0보다 큰 정수가 아닙니다.")
        val_file = document.get("val_file")
        if not isinstance(val_file, dict) or not isinstance(val_file.get("sha256"), str) or not val_file["sha256"]:
            raise DatasetFormatError(f"{path.name}: val_file.sha256가 없습니다.")
        if not isinstance(document.get("excluded_ids_sha256"), str) or not document["excluded_ids_sha256"]:
            raise DatasetFormatError(f"{path.name}: excluded_ids_sha256가 없습니다.")
        documents.append(document)
        sources.append(report_provenance(path))
    return {"values": values, "mean": sum(values) / len(values), "sources": sources}, documents


def build_auc_evidence(
    config: Mapping[str, Any],
    config_path: Path,
    variant: str,
    model_reports: Mapping[str, Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    """W는 고정 C 평균, D는 검증된 정책 정렬 평균과 원래 H1T2 하한으로 자격을 계산한다."""
    training_hashes = configured_training_data_sha256(config, variant)
    if variant == "D":
        evidence: dict[str, dict[str, Any]] = {}
        all_documents: list[dict[str, Any]] = []
        all_sources: list[str] = []
        for model in ("H1T2", "D"):
            weights = [str(entry["report"]["model_weights_sha256"]) for entry in model_reports[model]["single"]]
            loaded, documents = load_policy_auc_values(config, config_path, model, weights)
            evidence[model] = loaded
            all_documents.extend(documents)
            all_sources.extend(source["sha256"] for source in loaded["sources"])
        if len(set(all_sources)) != 6:
            raise DatasetFormatError("D 정책 정렬 AUC 근거는 모델·시드별 서로 다른 여섯 파일이어야 합니다.")
        val_hashes = {document["val_file"]["sha256"] for document in all_documents}
        excluded_hashes = {document["excluded_ids_sha256"] for document in all_documents}
        if len(val_hashes) != 1 or len(excluded_hashes) != 1:
            raise DatasetFormatError("D 정책 정렬 AUC 여섯 파일의 val sha256·excluded_ids_sha256가 같아야 합니다.")
        original = load_model_card_auc_values(config, config_path, "original_h1t2", training_hashes["H1T2"])
        original_threshold = CONTROL_AUC_MEAN - AUC_MARGIN
        original["threshold"] = original_threshold
        original["pass"] = original["mean"] + 1e-12 >= original_threshold
        evidence["H1T2"]["original_validation"] = original
        evidence["H1T2"]["threshold"] = evidence["H1T2"]["mean"] - AUC_MARGIN
        evidence["H1T2"]["pass"] = evidence["H1T2"]["mean"] >= evidence["H1T2"]["threshold"] and original["pass"]
        evidence["D"]["threshold"] = evidence["H1T2"]["mean"] - AUC_MARGIN
    else:
        evidence = {model: load_model_card_auc_values(config, config_path, model, training_hashes[model]) for model in ("H1T2", variant)}
        for model in evidence:
            evidence[model]["threshold"] = CONTROL_AUC_MEAN - AUC_MARGIN
    for model in evidence:
        evidence[model].setdefault("pass", evidence[model]["mean"] + 1e-12 >= evidence[model]["threshold"])
        evidence[model]["mean"] = round(evidence[model]["mean"], 6)
        evidence[model]["threshold"] = round(evidence[model]["threshold"], 6)
    return evidence


def unit_public(loaded: Mapping[str, Any], role: str) -> dict[str, Any]:
    """내부 report·flags를 빼고 평가 단위 출처와 지표만 출력한다."""
    result = {"role": role, "source": loaded["source"], "metrics": loaded["assessment"]}
    if loaded.get("seed") is not None:
        result["seed"] = loaded["seed"]
    return result


def single_setting(model: str, loaded: Mapping[str, Any], auc: Mapping[str, Any]) -> dict[str, Any]:
    """모델의 단일 시드 설정 자격과 평균 핵심 최소를 만든다."""
    units = [entry["assessment"] for entry in loaded["single"]]
    qualified = single_qualifies(units, bool(auc["pass"]))
    reasons = []
    if sum(unit["pass"] for unit in units) < 2:
        reasons.append("통과 시드가 2개 미만")
    if not all(unit["near"] for unit in units):
        reasons.append("근접하지 않은 시드가 있음")
    if not auc["pass"]:
        reasons.append("검증 AUC 조건 미달")
    return {
        "key": f"{model}/single",
        "model": model,
        "form": "single",
        "critical_recall": sum(unit["critical_recall_min"] for unit in units) / len(units),
        "qualified": qualified,
        "qualification_failures": reasons,
        "evaluation_units": [unit_public(entry, "seed") for entry in loaded["single"]],
    }


def ensemble_setting(model: str, loaded: Mapping[str, Any], auc: Mapping[str, Any]) -> dict[str, Any]:
    """모델의 세 시드 앙상블과 모델 하나 빼기 안정성 자격을 만든다."""
    ensemble = loaded["ensemble"]["assessment"]
    pairs = [entry["assessment"] for entry in loaded["pair_ensembles"]]
    qualified = ensemble_qualifies(ensemble, pairs, bool(auc["pass"]))
    reasons = []
    if not ensemble["pass"]:
        reasons.append("세 시드 앙상블이 통과하지 않음")
    if not all(unit["near"] for unit in pairs):
        reasons.append("근접하지 않은 두 시드 앙상블이 있음")
    if not auc["pass"]:
        reasons.append("검증 AUC 조건 미달")
    return {
        "key": f"{model}/ensemble",
        "model": model,
        "form": "ensemble",
        "critical_recall": ensemble["critical_recall_min"],
        "qualified": qualified,
        "qualification_failures": reasons,
        "evaluation_units": [unit_public(loaded["ensemble"], "three_seed_ensemble")]
        + [unit_public(entry, "two_seed_ensemble") for entry in loaded["pair_ensembles"]],
    }


def flags_by_setting(model_reports: Mapping[str, Mapping[str, Any]]) -> dict[str, list[Mapping[str, bool]]]:
    """설정별 부트스트랩 입력: 단일은 세 flags, 앙상블은 완전 앙상블 하나."""
    result: dict[str, list[Mapping[str, bool]]] = {}
    for model, loaded in model_reports.items():
        result[f"{model}/single"] = [entry["flags"] for entry in loaded["single"]]
        result[f"{model}/ensemble"] = [loaded["ensemble"]["flags"]]
    return result


def build_bootstrap_report(
    winner: Mapping[str, Any] | None,
    settings: Sequence[Mapping[str, Any]],
    flags: Mapping[str, Sequence[Mapping[str, bool]]],
    items: Sequence[ChatEvalItem],
    variant: str,
) -> dict[str, Any]:
    """승자 비교와 같은 형태 X-H1T2 메커니즘 구간을 모두 보고용으로 계산한다."""
    comparisons = []
    if winner is not None:
        for setting in settings:
            if setting["qualified"] and setting["key"] != winner["key"]:
                interval = bootstrap_critical_difference(flags[winner["key"]], flags[setting["key"]], items)
                comparisons.append(
                    {
                        "first": winner["key"],
                        "second": setting["key"],
                        "observed_difference": round(winner["critical_recall"] - setting["critical_recall"], 6),
                    }
                    | interval
                )
    mechanism = []
    for form in ("single", "ensemble"):
        first, second = f"{variant}/{form}", f"H1T2/{form}"
        mechanism.append({"form": form, "difference": f"{variant} - H1T2"} | bootstrap_friendly_difference(flags[first], flags[second], items))
    return {"winner_vs_other_qualified": comparisons, "friendly_profanity_mechanism": mechanism, "seed": BOOTSTRAP_SEED}


def standalone_stage2_rates(items: Sequence[ChatEvalItem], scores: Mapping[str, Stage2Score]) -> dict[str, float]:
    """1차를 거치지 않은 2차 단독 후보율을 범주별로 계산한다(진단 전용)."""
    grouped = items_by_category([item for item in items if item.is_scored])
    return {
        category: round(sum(scores[item.item_id].probability >= STAGE2_CANDIDATE_THRESHOLD for item in members) / len(members), 4)
        for category, members in sorted(grouped.items())
    }


def rule_quote_rate(items: Sequence[ChatEvalItem], routes: Mapping[str, RuleRoute]) -> float:
    """어떤 1차도 피할 수 없는 R0 인용·신고 규칙 판정 비율."""
    quotes = [item for item in items if item.is_scored and item.category == "quote_report"]
    if not quotes:
        raise DatasetFormatError("개발셋에 인용·신고 문장이 없습니다.")
    return sum(routes[item.item_id].rule_flagged for item in quotes) / len(quotes)


def require_manifest_inputs(config: Mapping[str, Any], stage2_identifier: str) -> dict[str, Any]:
    """도구가 알 수 없는 2차 출처·변환·코드 커밋·보류셋 지문을 CONFIG에서 받는다."""
    section = config.get("manifest")
    if not isinstance(section, dict):
        raise DatasetFormatError("승자 manifest를 만들 CONFIG.manifest가 없습니다.")
    stage2 = section.get("stage2_model")
    required = {
        "directory_name",
        "identifier",
        "weights_sha256",
        "tokenizer_sha256",
        "chat_template_sha256",
        "original_revision",
        "conversion",
        "classification_tokens",
        "files",
    }
    if not isinstance(stage2, dict) or not required <= set(stage2):
        missing = sorted(required - set(stage2 or {})) if isinstance(stage2, dict) else sorted(required)
        raise DatasetFormatError(f"CONFIG manifest.stage2_model에 필드가 부족합니다({', '.join(missing)}). 원본 revision과 변환 출처를 채우세요.")
    require_equal(stage2.get("identifier"), stage2_identifier, "CONFIG의 2차 모델 식별자")
    for key in ("holdout_sha256", "evaluation_code_commit", "evaluate_rules_sha256"):
        if not isinstance(section.get(key), str) or not section[key]:
            raise DatasetFormatError(f"CONFIG manifest.{key} 문자열이 없습니다.")
    return dict(section)


def selected_report_entry(winner: Mapping[str, Any], loaded: Mapping[str, Any], deployment_seed: int | None) -> Mapping[str, Any]:
    """manifest의 고정 임계값과 dev 보고서 지문을 가져올 실제 평가 단위."""
    if winner["form"] == "ensemble":
        return loaded["ensemble"]
    matches = [entry for entry in loaded["single"] if entry["seed"] == deployment_seed]
    if len(matches) != 1:
        raise DatasetFormatError("고른 배포 시드와 단일 개발셋 보고서를 대응할 수 없습니다.")
    return matches[0]


def single_manifest_units(loaded: Mapping[str, Any]) -> list[dict[str, Any]]:
    """단일 배포 시드와 진단 시드 모두의 가중치·고정 임계값을 봉인한다."""
    units = []
    for entry in loaded["single"]:
        report, metrics = entry["report"], entry["assessment"]
        model_dir = report.get("model_dir")
        if not isinstance(model_dir, str) or not model_dir:
            raise DatasetFormatError("단일 개발셋 보고서에 model_dir 이름이 없습니다. 지금 evaluate_chat으로 다시 평가하세요.")
        units.append(
            {
                "seed": entry["seed"],
                "model_dir": model_dir,
                "weights_sha256": report["model_weights_sha256"],
                "threshold": metrics["threshold"],
                "dev_report": entry["source"],
            }
        )
    return units


def build_manifest_draft(
    config: Mapping[str, Any],
    winner: Mapping[str, Any],
    loaded: Mapping[str, Any],
    deployment: Mapping[str, Any] | None,
    manifest_inputs: Mapping[str, Any],
    policy: str,
    traffic_mix: Mapping[str, float],
    variant: str,
    dev_file: Path,
    rule_file: Path,
) -> dict[str, Any]:
    """계획의 보류셋 실행 전에 커밋할 manifest 초안을 만든다."""
    deployment_seed = None if deployment is None else int(deployment["seed"])
    selected_entry = selected_report_entry(winner, loaded, deployment_seed)
    selected_report = selected_entry["report"]
    if winner["form"] == "single":
        model_dir = selected_report.get("model_dir")
        if not isinstance(model_dir, str) or not model_dir:
            raise DatasetFormatError("단일 승자 보고서에 model_dir 이름이 없습니다.")
        stage1 = {
            "model": winner["model"],
            "form": "single",
            "deployment_seed": deployment_seed,
            "weights_sha256": selected_report["model_weights_sha256"],
            "model_dir": model_dir,
            "threshold": selected_entry["assessment"]["threshold"],
            "units": single_manifest_units(loaded),
        }
    else:
        model_dirs = selected_report.get("model_dirs")
        if not isinstance(model_dirs, list) or len(model_dirs) != 3 or not all(isinstance(value, str) and value for value in model_dirs):
            raise DatasetFormatError("앙상블 승자 보고서에 model_dirs 세 개가 순서대로 없습니다.")
        stage1 = {
            "model": winner["model"],
            "form": "ensemble",
            "weights_sha256": selected_report["model_weights_sha256"],
            "model_dirs": model_dirs,
            "threshold": selected_entry["assessment"]["threshold"],
            "dev_report": selected_entry["source"],
        }
    return {
        "schema_version": 1,
        "round": "M2-round3",
        "created_at": utc_timestamp(),
        "variant": variant,
        "selected": {"model": winner["model"], "form": winner["form"]},
        "stage1": stage1,
        "stage1_weights_sha256": stage1["weights_sha256"],
        "decision_threshold": stage1["threshold"],
        "short_threshold_multiplier": REQUIRED_SHORT_RULE["multiplier"],
        "short_rule": dict(REQUIRED_SHORT_RULE),
        "rule_policy_sha256": policy,
        "forward_budget": FORWARD_BUDGET,
        "traffic_mix": dict(traffic_mix),
        "stage2_model": manifest_inputs["stage2_model"],
        "holdout_sha256": manifest_inputs["holdout_sha256"],
        "evaluation_code_commit": manifest_inputs["evaluation_code_commit"],
        "evaluate_rules_sha256": manifest_inputs["evaluate_rules_sha256"],
        "dev_file": {"name": dev_file.name, "sha256": compute_file_sha256(dev_file)},
        "rule_routes": {"name": rule_file.name, "sha256": compute_file_sha256(rule_file), "policy_sha256": policy},
        "dev_report": selected_entry["source"],
    }


def require_same_traffic_mix(model_reports: Mapping[str, Mapping[str, Any]]) -> dict[str, float]:
    """14개 평가 단위가 모두 같은 구성비인지 확인하고 그 값을 돌려준다."""
    reports: list[Mapping[str, Any]] = []
    for loaded in model_reports.values():
        reports.extend(entry["report"] for entry in loaded["single"])
        reports.append(loaded["ensemble"]["report"])
        reports.extend(entry["report"] for entry in loaded["pair_ensembles"])
    first = reports[0].get("traffic_mix")
    if not isinstance(first, dict):
        raise DatasetFormatError("개발셋 보고서에 트래픽 구성비가 없습니다.")
    for report in reports[1:]:
        require_equal(report.get("traffic_mix"), first, "개발셋 보고서 구성비")
    return {str(key): float(value) for key, value in first.items()}


def deployment_rows(loaded: Mapping[str, Any]) -> list[dict[str, Any]]:
    """배포 시드 동률 깨기에 필요한 단일 시드 지표."""
    return [
        {
            "seed": entry["seed"],
            "pass": entry["assessment"]["pass"],
            "critical_recall_min": entry["assessment"]["critical_recall_min"],
            "allowed_max": entry["assessment"]["allowed_max"],
            "friendly_profanity": entry["assessment"]["friendly_profanity"],
        }
        for entry in loaded["single"]
    ]


def build_dev_decision(config_path: Path) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """CONFIG의 14개 보고서에서 자격·승자·부트스트랩·manifest 초안을 만든다."""
    config = read_json_object(config_path, "round3 CONFIG")
    variant = config.get("variant")
    if variant not in {"D", "W"}:
        raise DatasetFormatError("CONFIG variant는 D 또는 W여야 합니다.")
    require_equal(config.get("short_rule"), REQUIRED_SHORT_RULE, "CONFIG의 짧은 문장 규칙")
    dev_file = resolve_relative_path(config_path, config.get("dev_file"), "dev_file")
    rule_file = resolve_relative_path(config_path, config.get("rule_routes"), "rule_routes")
    stage2_file = resolve_relative_path(config_path, config.get("stage2_scores"), "stage2_scores")
    items = load_chat_eval_set(dev_file)
    if items[0].split != "dev":
        raise DatasetFormatError("CONFIG dev_file은 dev split이어야 합니다.")
    routes, policy = load_rule_routes(rule_file, items, dev_file)
    require_r0_policy(policy, "CONFIG rule_routes")
    stage2_scores, stage2_provenance = load_stage2_scores(stage2_file, items, dev_file)
    short_rule = ShortRule(int(REQUIRED_SHORT_RULE["max_length"]), float(REQUIRED_SHORT_RULE["multiplier"]))
    dev_sha256 = compute_file_sha256(dev_file)
    training_hashes = configured_training_data_sha256(config, variant)
    model_reports = {
        model: load_model_reports(
            model,
            config,
            config_path,
            items,
            routes,
            short_rule,
            dev_sha256,
            policy,
            stage2_provenance["model_identifier"],
            stage2_provenance["sha256"],
            training_hashes[model],
        )
        for model in ("H1T2", variant)
    }
    traffic_mix = require_same_traffic_mix(model_reports)
    auc = build_auc_evidence(config, config_path, variant, model_reports)
    settings = [
        single_setting("H1T2", model_reports["H1T2"], auc["H1T2"]),
        single_setting(variant, model_reports[variant], auc[variant]),
        ensemble_setting("H1T2", model_reports["H1T2"], auc["H1T2"]),
        ensemble_setting(variant, model_reports[variant], auc[variant]),
    ]
    winner = choose_winner(settings)
    route_rate = rule_quote_rate(items, routes)
    if route_rate > PASS_ALLOW_MAX:
        winner = None
    flags = flags_by_setting(model_reports)
    report: dict[str, Any] = {
        "schema_version": 1,
        "created_at": utc_timestamp(),
        "variant": variant,
        "settings": settings,
        "validation_auc": auc,
        "rule_quote_report_rate": round(route_rate, 6),
        "stop_condition_triggered": route_rate > PASS_ALLOW_MAX,
        "stage2_standalone_candidate_by_category": standalone_stage2_rates(items, stage2_scores),
        "winner": winner,
        "bootstrap": build_bootstrap_report(winner, settings, flags, items, variant),
    }
    manifest = None
    if winner is not None:
        selected_loaded = model_reports[winner["model"]]
        deployment = select_deployment_seed(deployment_rows(selected_loaded)) if winner["form"] == "single" else None
        if deployment is not None:
            report["deployment_seed"] = deployment["seed"]
        inputs = require_manifest_inputs(config, stage2_provenance["model_identifier"])
        manifest = build_manifest_draft(config, winner, selected_loaded, deployment, inputs, policy, traffic_mix, variant, dev_file, rule_file)
    return report, manifest


def markdown_path_for(output: Path) -> Path:
    """JSON 판정 옆 사람이 읽을 요약 경로."""
    return output.with_suffix(".md")


def manifest_path_for(output: Path) -> Path:
    """개발셋 판정 옆 manifest 초안 경로."""
    return output.with_name(f"{output.stem}.manifest.json")


def ensure_outputs_absent(paths: Sequence[Path]) -> None:
    """판정 근거와 봉인 manifest를 덮어쓰지 않는다."""
    existing = next((path for path in paths if path.exists()), None)
    if existing is not None:
        raise OutputExistsError(f"{existing.name}이 이미 있습니다. 앞선 판정 근거를 지키려고 덮어쓰지 않습니다. 새 --output을 주세요.")


def format_dev_markdown(report: Mapping[str, Any]) -> str:
    """설정·평가 단위와 승자를 원문 없는 Markdown 표로 요약한다."""
    lines = ["# M2 3차 개발셋 판정", "", "| 설정 | 핵심 최소 | 자격 | 실패 이유 |", "|---|---:|---|---|"]
    for setting in report["settings"]:
        failures = ", ".join(setting["qualification_failures"]) or "-"
        lines.append(f"| {setting['key']} | {setting['critical_recall']:.4f} | {'예' if setting['qualified'] else '아니오'} | {failures} |")
    winner = report.get("winner")
    winner_text = "없음" if winner is None else winner["key"]
    lines += ["", f"- 승자: **{winner_text}**", f"- R0 인용·신고 규칙 판정률: {report['rule_quote_report_rate']:.4f}"]
    lines += [f"- 사전 중단 조건: {'발동' if report['stop_condition_triggered'] else '통과'}", "", "## 평가 단위", ""]
    lines += ["| 설정 | 역할 | 시드 | 상태 | 임계값 | 핵심 최소 | 일반 욕설 | 칭찬 비속어 | 인용·신고 경로 끝 |", "|---|---|---:|---|---:|---:|---:|---:|---:|"]
    for setting in report["settings"]:
        for unit in setting["evaluation_units"]:
            metrics = unit["metrics"]
            lines.append(
                f"| {setting['key']} | {unit['role']} | {unit.get('seed', '-')} | {metrics['status']} | {metrics['threshold']:.6f} | "
                f"{metrics['critical_recall_min']:.4f} | {metrics['abuse_recall']:.4f} | {metrics['friendly_profanity']:.4f} | "
                f"{metrics['quote_report_endpoint']:.4f} |"
            )
    return "\n".join(lines) + "\n"


def dev_command(config_path: Path, output: Path) -> None:
    """개발셋 판정 JSON·Markdown과 승자가 있으면 manifest 초안을 함께 쓴다."""
    markdown = markdown_path_for(output)
    manifest_output = manifest_path_for(output)
    ensure_outputs_absent((output, markdown, manifest_output))
    report, manifest = build_dev_decision(config_path)
    if manifest is not None:
        report["manifest_draft"] = manifest_output.name
    output.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomically(output, report)
    markdown.write_text(format_dev_markdown(report), encoding="utf-8")
    if manifest is not None:
        write_json_atomically(manifest_output, manifest)
    print(f"개발셋 판정: {output.name}, 요약: {markdown.name}, 승자: {report['winner']['key'] if report['winner'] else '없음'}")


def holdout_command(manifest_path: Path, report_paths: Sequence[Path], output: Path) -> None:
    """manifest 불변식을 확인한 뒤 선택 설정 하나의 보류셋 합격 여부를 쓴다."""
    ensure_outputs_absent((output,))
    manifest = read_json_object(manifest_path, "round3 manifest")
    reports = [read_json_object(path, "보류셋 보고서") for path in report_paths]
    verdict = evaluate_holdout_reports(manifest, reports)
    verdict |= {
        "schema_version": 1,
        "created_at": utc_timestamp(),
        "manifest": report_provenance(manifest_path),
        "holdout_reports": [report_provenance(path) for path in report_paths],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomically(output, verdict)
    print(f"보류셋 판정: {'합격' if verdict['passed'] else '불합격'} → {output.name}")


def require_r0_policy(policy: str, label: str) -> None:
    """규칙 경로 파일이 얼린 R0(서버 기본 규칙과 기본 키워드)로 만든 것인지 지문으로 확인한다.

    왜: 기본 키워드 경로 적중은 R0에도 있으므로 키워드 유무로는 R0와 RP를 가를 수 없다.
    label: 오류 메시지에 쓸 입력 이름. 다르면 DatasetFormatError로 멈춘다.
    """
    if policy != R0_POLICY_SHA256:
        raise DatasetFormatError(f"{label}의 규칙 지문이 R0와 다릅니다. --keywords 없이 만든 R0 규칙 경로를 주세요.")


def precheck_command(eval_file: Path, rule_routes: Path, stage2_scores: Path, output: Path) -> None:
    """학습 전 R0 중단 조건과 2차 단독 진단을 원문 없이 쓴다."""
    ensure_outputs_absent((output,))
    items = load_chat_eval_set(eval_file)
    if not items or items[0].split != "dev":
        raise DatasetFormatError("precheck --eval-file은 dev split이어야 합니다.")
    routes, policy = load_rule_routes(rule_routes, items, eval_file)
    require_r0_policy(policy, "precheck --rule-routes")
    scores, stage2 = load_stage2_scores(stage2_scores, items, eval_file)
    quote_rate = rule_quote_rate(items, routes)
    report = {
        "schema_version": 1,
        "created_at": utc_timestamp(),
        "rule_quote_report_rate": round(quote_rate, 6),
        "stage2_standalone_candidate_by_category": standalone_stage2_rates(items, scores),
        "stop": quote_rate > PASS_ALLOW_MAX,
        "inputs": {
            "eval_file": report_provenance(eval_file),
            "rule_routes": report_provenance(rule_routes) | {"policy_sha256": policy},
            "stage2_scores": report_provenance(stage2_scores) | {"model_identifier": stage2["model_identifier"]},
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomically(output, report)
    print(f"학습 전 사전 검사: {'중단' if report['stop'] else '통과'} → {output.name}")


def build_argument_parser() -> argparse.ArgumentParser:
    """precheck·dev·holdout 하위 명령."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage1.round3_decision", description="M2 3차 개발셋 선택과 봉인 보류셋 확인")
    commands = parser.add_subparsers(dest="command", required=True)
    precheck = commands.add_parser("precheck", help="학습 전 R0 중단 조건과 2차 단독 진단")
    precheck.add_argument("--eval-file", type=Path, required=True, help="채팅 개발셋 JSONL")
    precheck.add_argument("--rule-routes", type=Path, required=True, help="키워드 없는 R0 규칙 결과 JSONL")
    precheck.add_argument("--stage2-scores", type=Path, required=True, help="같은 개발셋의 2차 점수 JSON")
    precheck.add_argument("--output", type=Path, required=True, help="새 사전 검사 JSON 경로")
    dev = commands.add_parser("dev", help="14개 개발셋 보고서로 승자와 manifest 초안 결정")
    dev.add_argument("--config", type=Path, required=True, help="보고서·AUC·manifest 출처 CONFIG JSON")
    dev.add_argument("--output", type=Path, required=True, help="새 판정 JSON 경로(.md와 .manifest.json도 옆에 생성)")
    holdout = commands.add_parser("holdout", help="manifest 한 설정의 봉인 보류셋 확인")
    holdout.add_argument("--manifest", type=Path, required=True, help="dev 명령이 만든 뒤 커밋한 manifest JSON")
    holdout.add_argument("--holdout-reports", type=Path, nargs="+", required=True, help="선택 설정의 evaluate_chat 보류셋 보고서")
    holdout.add_argument("--output", type=Path, required=True, help="새 VERDICT JSON 경로")
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    """선택한 하위 명령을 실행한다."""
    arguments = build_argument_parser().parse_args(argv)
    if arguments.command == "precheck":
        precheck_command(arguments.eval_file, arguments.rule_routes, arguments.stage2_scores, arguments.output)
    elif arguments.command == "dev":
        dev_command(arguments.config, arguments.output)
    else:
        holdout_command(arguments.manifest, arguments.holdout_reports, arguments.output)


if __name__ == "__main__":
    run_command_line(main)
