"""M2 4차의 고정 18개 개발셋 보고서에서 R1·T 채택을 결정한다.

보고서의 반올림 집계는 쓰지 않고 id별 경로 끝 판정과 2차 전달 플래그를 평가셋 범주에 다시 붙여 센다.
평가 원문은 입력 검증에만 머물고 JSON·Markdown에는 id와 집계만 남긴다.
"""

from __future__ import annotations

import argparse
import json
import math
import random
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from zg_stage1.chat_eval_data import ALLOW_CATEGORIES, HARMFUL_CATEGORIES, LABELS, ChatEvalItem
from zg_stage1.data import compute_file_sha256
from zg_stage1.errors import DatasetFormatError, OutputExistsError, run_command_line
from zg_stage1.evaluate_chat import (
    EndpointDecision,
    RuleRoute,
    Stage2Policy,
    Stage2Score,
    load_rule_routes,
    load_stage2_scores,
    stage2_endpoint_decision,
    validate_traffic_mix,
)
from zg_stage1.model_card import utc_timestamp

REQUIRED_POLICIES: tuple[str, ...] = ("L0", "L1", "L0+T1", "L0+T2", "L1+T1", "L1+T2")
CORE_CATEGORIES: tuple[str, ...] = ("self_harm", "sexual", "minors", "threat", "doxxing")
REQUIRED_SHORT_RULE = {"max_length": 5, "multiplier": 4.0}
POLICY_KIND = {
    "L0": "fixed",
    "L1": "fixed",
    "L0+T1": "keyword_route",
    "L1+T1": "keyword_route",
    "L0+T2": "category",
    "L1+T2": "category",
}
STEP1_IMPROVEMENT = 0.10
STEP2_IMPROVEMENT = 0.05
ALLOW_CATEGORY_INCREASE_LIMIT = 0.05
WEIGHTED_ALLOW_INCREASE_LIMIT = 0.005
T1_PREFERENCE_MARGIN = 0.02
HIGH_SCORE_THRESHOLD = 0.9
STAGE2_MISS_THRESHOLD = 0.05
BOOTSTRAP_SEED = 20261016
BOOTSTRAP_ROUNDS = 2000
COMPARISON_EPSILON = 1e-12
ENDPOINT_DECISIONS: frozenset[str] = frozenset({"candidate", "needs_care", "pass"})
REPORT_CATEGORIES: tuple[str, ...] = HARMFUL_CATEGORIES + ALLOW_CATEGORIES


def read_json_object(path: Path, context: str) -> dict[str, Any]:
    """JSON 객체만 읽고 파일 위치와 해결 방향을 담은 오류로 바꾼다."""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        detail = error.msg if isinstance(error, json.JSONDecodeError) else str(error)
        raise DatasetFormatError(f"{path.name}: {context} JSON을 읽지 못했습니다({detail}). 경로와 JSON 형식을 확인하세요.") from error
    if not isinstance(value, dict):
        raise DatasetFormatError(f"{path.name}: {context}는 JSON 객체여야 합니다. 설정 형식을 확인하세요.")
    return value


def resolve_path(config_path: Path, value: object, field: str) -> Path:
    """CONFIG 기준 상대 경로를 푼다. 저장소 밖 고정 경로를 코드에 넣지 않기 위해 설정만 따른다."""
    if not isinstance(value, str) or not value:
        raise DatasetFormatError(f"CONFIG {field}에 비어 있지 않은 경로 문자열을 넣으세요.")
    path = Path(value)
    resolved = path if path.is_absolute() else config_path.parent / path
    if not resolved.is_file():
        raise DatasetFormatError(f"CONFIG {field} 파일 {resolved.name}을 찾을 수 없습니다. 경로를 확인하세요.")
    return resolved


def require_number(value: object, context: str, *, lower: float = 0.0, upper: float = 1.0) -> float:
    """불리언·NaN을 확률로 받아 조용히 판정이 바뀌는 일을 막는다."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise DatasetFormatError(f"{context}가 유한한 {lower}~{upper} 값이 아닙니다. 보고서를 다시 만드세요.")
    numeric = float(value)
    if not (math.isfinite(numeric) and lower <= numeric <= upper):
        raise DatasetFormatError(f"{context}가 유한한 {lower}~{upper} 값이 아닙니다. 보고서를 다시 만드세요.")
    return numeric


def require_seed_list(value: object) -> tuple[int, ...]:
    """판정은 서로 다른 세 정수 시드에만 정의돼 있으므로 CONFIG에서 먼저 고정한다."""
    if not isinstance(value, list) or len(value) != 3 or any(isinstance(seed, bool) or not isinstance(seed, int) for seed in value):
        raise DatasetFormatError("CONFIG seeds에는 서로 다른 정수 시드 세 개를 넣으세요.")
    seeds = tuple(value)
    if len(set(seeds)) != len(seeds):
        raise DatasetFormatError("CONFIG seeds가 겹칩니다. 서로 다른 시드 세 개를 넣으세요.")
    return seeds


def require_expected_rule_fingerprints(value: object) -> dict[str, str]:
    """CONFIG가 고정한 R0·R1 지문을 정확히 읽고 두 규칙층이 섞이는 일을 막는다."""
    if not isinstance(value, dict) or set(value) != {"R0", "R1"}:
        raise DatasetFormatError("CONFIG expected_rule_fingerprints에는 R0·R1 규칙 지문을 정확히 넣으세요.")
    fingerprints = {name: value[name] for name in ("R0", "R1")}
    if any(not isinstance(fingerprint, str) or not fingerprint for fingerprint in fingerprints.values()):
        raise DatasetFormatError("CONFIG expected_rule_fingerprints의 R0·R1은 비어 있지 않은 문자열이어야 합니다.")
    if fingerprints["R0"] == fingerprints["R1"]:
        raise DatasetFormatError("CONFIG expected_rule_fingerprints의 R0와 R1 규칙 지문은 서로 달라야 합니다.")
    return fingerprints


def require_expected_seed_inputs(value: object, seeds: Sequence[int]) -> dict[int, dict[str, float | str]]:
    """시드별 1차 임계값과 단일 가중치 지문을 CONFIG에서 고정한다."""
    if not isinstance(value, dict) or set(map(str, value)) != {str(seed) for seed in seeds}:
        raise DatasetFormatError("CONFIG expected_seed_inputs에는 CONFIG seeds와 같은 시드별 입력을 정확히 넣으세요.")
    result: dict[int, dict[str, float | str]] = {}
    for seed in seeds:
        raw = value.get(str(seed), value.get(seed))
        if not isinstance(raw, dict) or set(raw) != {"threshold", "model_weights_sha256"}:
            raise DatasetFormatError(f"CONFIG expected_seed_inputs.{seed}에는 threshold와 model_weights_sha256만 넣으세요.")
        weight = raw.get("model_weights_sha256")
        if not isinstance(weight, str) or not weight:
            raise DatasetFormatError(f"CONFIG expected_seed_inputs.{seed}.model_weights_sha256는 비어 있지 않은 문자열이어야 합니다.")
        result[seed] = {
            "threshold": require_number(raw.get("threshold"), f"CONFIG expected_seed_inputs.{seed}.threshold"),
            "model_weights_sha256": weight,
        }
    return result


def load_traffic_mix_config(config_path: Path, value: object) -> dict[str, float]:
    """구성비는 CONFIG 안 값 또는 별도 JSON을 허용하되 evaluate_chat과 같은 검증을 쓴다."""
    raw = read_json_object(resolve_path(config_path, value, "traffic_mix"), "traffic_mix") if isinstance(value, str) else value
    if not isinstance(raw, dict):
        raise DatasetFormatError("CONFIG traffic_mix는 범주→비율 객체 또는 그 JSON 경로여야 합니다.")
    mix = {str(category): require_number(weight, f"traffic_mix {category}") for category, weight in raw.items()}
    validate_traffic_mix(mix)
    return mix


def scored_items(items: Sequence[ChatEvalItem]) -> list[ChatEvalItem]:
    """ambiguous는 계획대로 모든 판정·분모에서 제외한다."""
    return [item for item in items if item.is_scored]


def load_decision_items(path: Path) -> list[ChatEvalItem]:
    """판정에는 id 결합과 split·label·category만 필요하므로 원문·작성자 필드에 의존하지 않는다."""
    items = [parse_decision_item(line, f"{path.name}:{number}") for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1) if line.strip()]
    if not items:
        raise DatasetFormatError(f"{path.name}: 평가 문장이 없습니다. 개발셋 경로를 확인하세요.")
    identifiers = [item.item_id for item in items]
    if len(set(identifiers)) != len(identifiers):
        raise DatasetFormatError(f"{path.name}: 평가 id가 겹칩니다. score·item_flags를 정확히 결합하도록 id를 고치세요.")
    return items


def parse_decision_item(line: str, location: str) -> ChatEvalItem:
    """원문을 오류에 되돌려 쓰지 않고 판정에 필요한 네 필드만 읽는다."""
    try:
        raw = json.loads(line)
    except json.JSONDecodeError as error:
        raise DatasetFormatError(f"{location}: JSON 객체로 읽을 수 없습니다({error.msg}). 평가셋 형식을 확인하세요.") from error
    if not isinstance(raw, dict):
        raise DatasetFormatError(f"{location}: JSON 객체가 아닙니다. 평가셋 형식을 확인하세요.")
    identifier, split, label, category = (raw.get(key) for key in ("id", "split", "label", "category"))
    if not all(isinstance(value, str) and value for value in (identifier, split, label, category)):
        raise DatasetFormatError(f"{location}: 문자열 id·split·label·category가 필요합니다. 평가셋 형식을 확인하세요.")
    if label not in LABELS:
        raise DatasetFormatError(f"{location}: label이 harmful·allow·ambiguous가 아닙니다. 라벨 정책을 확인하세요.")
    allowed = HARMFUL_CATEGORIES if label == "harmful" else ALLOW_CATEGORIES if label == "allow" else REPORT_CATEGORIES
    if category not in allowed:
        raise DatasetFormatError(f"{location}: label과 category가 맞지 않습니다. 라벨 정책을 확인하세요.")
    return ChatEvalItem(str(identifier), str(split), str(label), str(category), "", "", "", "")


def require_development_set(items: Sequence[ChatEvalItem]) -> None:
    """보류셋을 이 라운드에서 열지 않는다는 계획을 실행 경계에서 지킨다."""
    if not items or any(item.split != "dev" for item in items):
        raise DatasetFormatError("CONFIG eval_file은 개발셋(dev)이어야 합니다. 이 라운드에서는 보류셋을 열지 마세요.")
    categories = {item.category for item in scored_items(items)}
    missing = sorted(set(REPORT_CATEGORIES) - categories)
    if missing:
        raise DatasetFormatError(f"개발셋에 판정에 필요한 범주가 없습니다: {', '.join(missing)}. 올바른 개발셋을 쓰세요.")


def reference_path(config_path: Path, value: object, context: str) -> Path:
    """보고서 참조는 경로 문자열 또는 {path: ...}를 받는다."""
    reference = value.get("path") if isinstance(value, dict) else value
    return resolve_path(config_path, reference, context)


def seed_report_paths(config_path: Path, value: object, seeds: Sequence[int], context: str) -> dict[int, Path]:
    """시드별 보고서를 JSON 객체나 seeds 순서 목록에서 정확히 세 개 읽는다."""
    if isinstance(value, list):
        if len(value) != len(seeds):
            raise DatasetFormatError(f"CONFIG {context}에는 시드별 보고서 {len(seeds)}개가 필요합니다.")
        if all(isinstance(reference, dict) and "seed" in reference for reference in value):
            indexed = {reference["seed"]: reference for reference in value if isinstance(reference, dict)}
            if set(indexed) != set(seeds) or len(indexed) != len(value):
                raise DatasetFormatError(f"CONFIG {context} 목록의 seed가 CONFIG seeds와 다릅니다. 시드별 보고서를 확인하세요.")
            return {seed: reference_path(config_path, indexed[seed], f"{context}/{seed}") for seed in seeds}
        return {seed: reference_path(config_path, reference, f"{context}/{seed}") for seed, reference in zip(seeds, value, strict=True)}
    if not isinstance(value, dict):
        raise DatasetFormatError(f"CONFIG {context}는 시드→보고서 객체 또는 보고서 목록이어야 합니다.")
    missing = [seed for seed in seeds if str(seed) not in value and seed not in value]
    extras = [key for key in value if str(key) not in {str(seed) for seed in seeds}]
    if missing or extras:
        details = ([f"누락 {', '.join(map(str, missing))}"] if missing else []) + ([f"추가 {', '.join(map(str, extras))}"] if extras else [])
        raise DatasetFormatError(f"CONFIG {context}의 시드 보고서가 맞지 않습니다({'; '.join(details)}). 6×3 칸을 정확히 채우세요.")
    return {seed: reference_path(config_path, value.get(str(seed), value.get(seed)), f"{context}/{seed}") for seed in seeds}


def required_unit_paths(config_path: Path, value: object, seeds: Sequence[int]) -> dict[str, dict[int, Path]]:
    """정책 여섯 이름을 바꾸거나 빠뜨리면 비교 의미가 달라지므로 정확한 집합만 받는다."""
    if isinstance(value, list):
        grouped: dict[str, list[object]] = {policy: [] for policy in REQUIRED_POLICIES}
        for reference in value:
            policy = reference.get("policy") if isinstance(reference, dict) else None
            if policy not in grouped:
                raise DatasetFormatError("CONFIG units 목록에는 policy·seed·path를 가진 18개 객체를 넣으세요.")
            grouped[str(policy)].append(reference)
        value = grouped
    if not isinstance(value, dict):
        raise DatasetFormatError("CONFIG units는 정책→시드별 보고서 객체여야 합니다.")
    missing = [policy for policy in REQUIRED_POLICIES if policy not in value]
    extras = sorted(set(value) - set(REQUIRED_POLICIES))
    if missing or extras:
        detail = ([f"누락 {', '.join(missing)}"] if missing else []) + ([f"추가 {', '.join(extras)}"] if extras else [])
        raise DatasetFormatError(f"CONFIG units가 정책 6개와 다릅니다({'; '.join(detail)}). 계획의 이름을 그대로 쓰세요.")
    return {policy: seed_report_paths(config_path, value[policy], seeds, f"units/{policy}") for policy in REQUIRED_POLICIES}


def stage2_policy_from_report(value: object, context: str) -> Stage2Policy:
    """보고서 정책을 의미 기준으로 읽어 범주 순서 차이가 판정을 막지 않게 한다."""
    if not isinstance(value, dict):
        raise DatasetFormatError(f"{context}: stage2_policy 객체가 없습니다. 현재 evaluate_chat으로 다시 평가하세요.")
    policy = value.get("policy")
    categories = value.get("categories")
    if policy not in {"fixed", "keyword_route", "category"} or not isinstance(categories, list) or any(not isinstance(item, str) for item in categories):
        raise DatasetFormatError(f"{context}: 2차 후보 기준 정책 형식이 잘못됐습니다. 현재 evaluate_chat으로 다시 평가하세요.")
    base = require_number(value.get("base"), f"{context}의 기본 2차 기준")
    relaxed = require_number(value.get("relaxed"), f"{context}의 완화 2차 기준")
    return Stage2Policy(str(policy), base, relaxed, frozenset(categories))


def require_round4_policy(policy: Stage2Policy, expected_kind: str | None, context: str) -> None:
    """T 이름뿐 아니라 이 라운드에서 고정한 0.5/0.2/S3·S4·S5도 함께 검사한다."""
    if expected_kind is not None and policy.policy != expected_kind:
        raise DatasetFormatError(f"{context}: 정책 이름과 2차 후보 기준({policy.policy})이 맞지 않습니다. {expected_kind}로 다시 평가하세요.")
    expected = Stage2Policy(expected_kind or policy.policy)
    if policy.base != expected.base or policy.relaxed != expected.relaxed or policy.categories != expected.categories:
        raise DatasetFormatError(f"{context}: 2차 후보 기준은 기본 0.5, 완화 0.2, 범주 S3·S4·S5여야 합니다. 계획값으로 다시 평가하세요.")


def require_provenance(report: Mapping[str, Any], key: str, expected_sha256: str, context: str) -> None:
    """평가셋과 2차 점수는 파일 이름이 아니라 전체 sha256으로 고정한다."""
    value = report.get(key)
    actual = value.get("sha256") if isinstance(value, dict) else None
    if actual != expected_sha256:
        raise DatasetFormatError(f"{context}: {key} sha256이 CONFIG 입력과 다릅니다. 같은 입력으로 보고서를 다시 만드세요.")


def require_report_mix(report: Mapping[str, Any], expected: Mapping[str, float], context: str) -> None:
    """구성비가 하나라도 다르면 가중 오후보와 2차 부하를 비교할 수 없다."""
    if report.get("traffic_mix") != dict(expected):
        raise DatasetFormatError(f"{context}: 트래픽 구성비가 CONFIG와 다릅니다. 같은 --mix-file로 다시 평가하세요.")


def require_report_seed(report: Mapping[str, Any], seed: int, context: str) -> None:
    """파일 이름 대신 모델 카드에서 남긴 시드가 칸 이름과 같은지 확인한다."""
    if report.get("model_seed") != seed:
        raise DatasetFormatError(f"{context}: model_seed가 CONFIG 시드 {seed}와 다릅니다. 올바른 모델 보고서를 연결하세요.")


def require_fixed_decision(report: Mapping[str, Any], context: str, *, allow_budget: bool = False) -> float:
    """판정 칸은 fixed만, 진단 칸은 fixed 또는 budget의 유효한 임계값만 받는다."""
    decision = report.get("decision")
    allowed_modes = {"fixed", "budget"} if allow_budget else {"fixed"}
    if not isinstance(decision, dict) or decision.get("mode") not in allowed_modes:
        expected = "fixed 또는 budget" if allow_budget else "fixed"
        raise DatasetFormatError(f"{context}: decision.mode가 {expected}가 아닙니다. 올바른 임계값 방식으로 다시 평가하세요.")
    return require_number(decision.get("threshold"), f"{context}의 고정 임계값")


def require_weights(report: Mapping[str, Any], context: str) -> str | list[str]:
    """단일·앙상블 어느 쪽이든 비어 있지 않은 1차 가중치 지문만 받는다."""
    value = report.get("model_weights_sha256")
    if isinstance(value, str) and value:
        return value
    if isinstance(value, list) and value and all(isinstance(item, str) and item for item in value):
        return value
    raise DatasetFormatError(f"{context}: model_weights_sha256이 없습니다. 현재 evaluate_chat으로 다시 평가하세요.")


def require_rule_fingerprint(report: Mapping[str, Any], context: str) -> str:
    """R0/R1 비교는 규칙 목록 전체 지문이 있는 보고서만 쓴다."""
    routes = report.get("rule_routes")
    fingerprint = routes.get("policy_sha256") if isinstance(routes, dict) else None
    if not isinstance(fingerprint, str) or not fingerprint:
        raise DatasetFormatError(f"{context}: 규칙 목록 지문이 없습니다. --rule-routes로 다시 평가하세요.")
    return fingerprint


def require_scores(report: Mapping[str, Any], expected_ids: set[str], context: str) -> dict[str, float]:
    """진단용 1차 점수는 ambiguous를 포함한 평가셋 전체 id와 정확히 맞아야 한다."""
    raw = report.get("scores")
    if not isinstance(raw, dict) or set(raw) != expected_ids:
        raise DatasetFormatError(f"{context}: scores id가 전체 개발셋과 다릅니다. 같은 평가셋으로 다시 평가하세요.")
    return {str(identifier): require_number(value, f"{context} id {identifier!r}의 1차 점수") for identifier, value in raw.items()}


def require_item_flags(report: Mapping[str, Any], expected_ids: set[str], context: str) -> dict[str, dict[str, bool | str]]:
    """경로 관계와 새 3상태 판정이 모순 없는 문장별 표시만 받는다."""
    raw = report.get("item_flags")
    if not isinstance(raw, dict) or set(raw) != expected_ids:
        raise DatasetFormatError(f"{context}: item_flags id가 채점 개발셋과 다릅니다. --stage2-scores로 다시 평가하세요.")
    return {str(identifier): require_flag_value(value, str(identifier), context) for identifier, value in raw.items()}


def require_flag_value(value: object, identifier: str, context: str) -> dict[str, bool | str]:
    """endpoint는 endpoint_decision != pass라는 이전 키 호환 계약을 고정한다."""
    keys = ("routed", "goes_to_stage2", "endpoint")
    if not isinstance(value, dict) or any(not isinstance(value.get(key), bool) for key in keys):
        raise DatasetFormatError(f"{context}: id {identifier!r}의 경로 플래그가 불리언이 아닙니다. 보고서를 다시 만드세요.")
    decision = value.get("endpoint_decision")
    if decision not in ENDPOINT_DECISIONS or value["endpoint"] != (decision != "pass"):
        raise DatasetFormatError(f"{context}: id {identifier!r}의 endpoint와 endpoint_decision이 모순됩니다. 보고서를 다시 만드세요.")
    if value["goes_to_stage2"] and not value["routed"]:
        raise DatasetFormatError(f"{context}: id {identifier!r}의 goes_to_stage2는 참인데 routed가 거짓입니다. 보고서를 다시 만드세요.")
    return {"routed": value["routed"], "goes_to_stage2": value["goes_to_stage2"], "endpoint": value["endpoint"], "endpoint_decision": decision}


def require_flag_decisions(
    flags: Mapping[str, Mapping[str, bool | str]],
    stage2_scores: Mapping[str, Stage2Score],
    stage2_policy: Stage2Policy,
    context: str,
) -> None:
    """각 문장 경로 상태와 실제 2차 점수로 가능한 경로 끝 판정을 교차 검사한다."""
    for identifier, flag in flags.items():
        routed = bool(flag["routed"])
        goes_to_stage2 = bool(flag["goes_to_stage2"])
        decision = flag["endpoint_decision"]
        if goes_to_stage2:
            score = stage2_scores[identifier]
            keyword_values = (False, True) if stage2_policy.policy == "keyword_route" else (False,)
            expected = {
                stage2_endpoint_decision(
                    stage2_policy.policy,
                    stage2_policy.base,
                    stage2_policy.relaxed,
                    stage2_policy.categories,
                    keyword,
                    score.probability,
                    score.category,
                )
                for keyword in keyword_values
            }
            if decision not in expected:
                choices = "·".join(sorted(expected))
                raise DatasetFormatError(f"{context}: id {identifier!r}의 2차 판정이 {decision!r}이지만 실제 점수·정책으로 가능한 값은 {choices}입니다.")
        elif routed:
            if decision != "candidate":
                raise DatasetFormatError(f"{context}: id {identifier!r}는 2차에 가지 않고 routed가 참이므로 규칙 후보(candidate)여야 합니다.")
        elif decision != "pass":
            raise DatasetFormatError(f"{context}: id {identifier!r}는 routed와 goes_to_stage2가 모두 거짓이므로 통과(pass)여야 합니다.")


def load_report(
    path: Path,
    policy_name: str,
    seed: int,
    items: Sequence[ChatEvalItem],
    eval_sha256: str,
    stage2_sha256: str,
    stage2_scores: Mapping[str, Stage2Score],
    traffic_mix: Mapping[str, float],
    *,
    expected_policy_kind: str | None,
    allow_budget_decision: bool = False,
    allow_missing_stage2_policy: bool = False,
) -> dict[str, Any]:
    """보고서 하나의 공통 입력·정책·문장별 증거를 판정 가능한 모양으로 검증한다."""
    context = f"{policy_name}/{seed} ({path.name})"
    report = read_json_object(path, "evaluate_chat 보고서")
    if report.get("split") != "dev" or report.get("short_rule") != REQUIRED_SHORT_RULE:
        raise DatasetFormatError(f"{context}: dev 보고서 또는 짧은 문장 규칙 5:4가 아닙니다. 고정 설정으로 다시 평가하세요.")
    require_provenance(report, "eval_file", eval_sha256, context)
    require_provenance(report, "stage2_scores", stage2_sha256, context)
    require_report_mix(report, traffic_mix, context)
    require_report_seed(report, seed, context)
    if allow_missing_stage2_policy and "stage2_policy" not in report:
        stage2_policy = Stage2Policy()
    else:
        stage2_policy = stage2_policy_from_report(report.get("stage2_policy"), context)
    require_round4_policy(stage2_policy, expected_policy_kind, context)
    score_ids = {item.item_id for item in items}
    flag_ids = {item.item_id for item in scored_items(items)}
    flags = require_item_flags(report, flag_ids, context)
    require_flag_decisions(flags, stage2_scores, stage2_policy, context)
    return {
        "policy": policy_name,
        "seed": seed,
        "threshold": require_fixed_decision(report, context, allow_budget=allow_budget_decision),
        "weights": require_weights(report, context),
        "rule_fingerprint": require_rule_fingerprint(report, context),
        "stage2_policy": stage2_policy,
        "scores": require_scores(report, score_ids, context),
        "flags": flags,
        "source": {"name": path.name, "sha256": compute_file_sha256(path)},
    }


def require_same_seed_experiment(
    units: Mapping[str, Mapping[int, Mapping[str, Any]]],
    seeds: Sequence[int],
    expected_inputs: Mapping[int, Mapping[str, float | str]],
) -> None:
    """여섯 칸의 1차 입력을 같은 시드끼리뿐 아니라 CONFIG 고정값과도 맞춘다."""
    for seed in seeds:
        expected = expected_inputs[seed]
        for policy in REQUIRED_POLICIES:
            if units[policy][seed]["threshold"] != expected["threshold"]:
                raise DatasetFormatError(f"시드 {seed}의 {policy} 임계값이 CONFIG expected_seed_inputs와 다릅니다. 고정 임계값으로 다시 평가하세요.")
            if units[policy][seed]["weights"] != expected["model_weights_sha256"]:
                raise DatasetFormatError(f"시드 {seed}의 {policy} 1차 가중치가 CONFIG expected_seed_inputs와 다릅니다. 같은 모델로 다시 평가하세요.")


def require_rule_groups(units: Mapping[str, Mapping[int, Mapping[str, Any]]], seeds: Sequence[int], expected_fingerprints: Mapping[str, str]) -> None:
    """R0·R1 계열의 모든 지문과 문장별 라우팅을 CONFIG 고정값에 맞춘다."""
    groups = {
        "R0": ("L0", "L0+T1", "L0+T2"),
        "R1": ("L1", "L1+T1", "L1+T2"),
    }
    for rule_name, group in groups.items():
        expected_fingerprint = expected_fingerprints[rule_name]
        for seed in seeds:
            baseline_flags = units[group[0]][seed]["flags"]
            for policy in group:
                if units[policy][seed]["rule_fingerprint"] != expected_fingerprint:
                    raise DatasetFormatError(
                        f"{rule_name} 규칙 지문이 CONFIG expected_rule_fingerprints와 다릅니다({policy}/{seed}). 같은 규칙 경로로 다시 평가하세요."
                    )
                for identifier, baseline in baseline_flags.items():
                    current = units[policy][seed]["flags"][identifier]
                    for key in ("goes_to_stage2", "routed"):
                        if current[key] != baseline[key]:
                            raise DatasetFormatError(
                                f"시드 {seed} id {identifier!r}의 {key}가 같은 규칙 계열 {rule_name} 안에서 다릅니다({group[0]}·{policy})."
                            )


def group_items(items: Sequence[ChatEvalItem]) -> dict[str, list[ChatEvalItem]]:
    """범주별 분모와 부트스트랩 순서를 평가 파일 순서로 고정한다."""
    grouped: dict[str, list[ChatEvalItem]] = {}
    for item in scored_items(items):
        grouped.setdefault(item.category, []).append(item)
    return grouped


def rates_and_counts(items: Sequence[ChatEvalItem], counted: Mapping[str, bool]) -> tuple[dict[str, float], dict[str, dict[str, int]]]:
    """문장별 불리언에서 반올림 없는 범주 비율과 분자·분모를 함께 만든다."""
    grouped = group_items(items)
    counts = {category: {"count": sum(counted[item.item_id] for item in members), "total": len(members)} for category, members in grouped.items()}
    rates = {category: value["count"] / value["total"] for category, value in counts.items()}
    return rates, counts


def minimum_core_rate(rates: Mapping[str, float]) -> tuple[float, str]:
    """동률이면 계획에 적힌 핵심 범주 순서로 이름을 고정해 출력 흔들림을 막는다."""
    category = min(CORE_CATEGORIES, key=lambda name: (rates[name], CORE_CATEGORIES.index(name)))
    return rates[category], category


def weighted_rate(rates: Mapping[str, float], mix: Mapping[str, float], categories: Sequence[str]) -> float:
    """구성비 합으로 다시 나누지 않는다. 채팅 전체에서 차지하는 부하/오후보 비율이기 때문이다."""
    return sum(mix.get(category, 0.0) * rates[category] for category in categories)


def metrics_from_flags(
    items: Sequence[ChatEvalItem],
    flags: Mapping[str, Mapping[str, bool | str]],
    traffic_mix: Mapping[str, float],
    l0_flags: Mapping[str, Mapping[str, bool | str]],
) -> dict[str, Any]:
    """보고서 집계를 믿지 않고 endpoint_decision·goes_to_stage2에서 모든 판정 지표를 다시 센다."""
    endpoint = {identifier: value["endpoint_decision"] != "pass" for identifier, value in flags.items()}
    stage2 = {identifier: bool(value["goes_to_stage2"]) for identifier, value in flags.items()}
    rates, counts = rates_and_counts(items, endpoint)
    stage2_rates, _ = rates_and_counts(items, stage2)
    minimum, category = minimum_core_rate(rates)
    self_harm_ids = [item.item_id for item in scored_items(items) if item.category == "self_harm"]
    loss = sum(l0_flags[item_id]["endpoint_decision"] == "needs_care" and flags[item_id]["endpoint_decision"] != "needs_care" for item_id in self_harm_ids)
    return {
        "endpoint_rate_by_category": rates,
        "endpoint_count_by_category": counts,
        "critical_minimum": minimum,
        "critical_minimum_category": category,
        "weighted_allow_false_positive_rate": weighted_rate(rates, traffic_mix, ALLOW_CATEGORIES),
        "stage2_load": weighted_rate(stage2_rates, traffic_mix, tuple(traffic_mix)),
        "needs_care_count": sum(value["endpoint_decision"] == "needs_care" for value in flags.values()),
        "needs_care_loss": loss,
    }


def require_l0_invariant(units: Mapping[str, Mapping[int, Mapping[str, Any]]], seeds: Sequence[int]) -> None:
    """고정 1차 뒤의 정책은 L0 경로 끝을 빼지 않고 더하기만 해야 한다."""
    for seed in seeds:
        baseline = units["L0"][seed]["flags"]
        for policy in REQUIRED_POLICIES[1:]:
            missing = [identifier for identifier, value in baseline.items() if value["endpoint"] and not units[policy][seed]["flags"][identifier]["endpoint"]]
            if missing:
                raise DatasetFormatError(
                    f"시드 {seed}의 {policy}가 L0 경로 끝 {len(missing)}개를 잃어 불변식을 어겼습니다. 고정 임계값·정책 구현을 확인하세요."
                )


def attach_metrics(
    units: Mapping[str, Mapping[int, dict[str, Any]]], items: Sequence[ChatEvalItem], traffic_mix: Mapping[str, float], seeds: Sequence[int]
) -> None:
    """모든 정책의 도움 필요 손실은 같은 시드 L0를 기준으로 붙인다."""
    for policy in REQUIRED_POLICIES:
        for seed in seeds:
            units[policy][seed]["metrics"] = metrics_from_flags(items, units[policy][seed]["flags"], traffic_mix, units["L0"][seed]["flags"])


def mean_minimum(units: Sequence[Mapping[str, object]]) -> float:
    """세 시드 핵심 최소의 산술 평균."""
    total = 0.0
    for unit in units:
        total += metric_float(unit["critical_minimum"], "critical_minimum")
    return total / len(units)


def metric_float(value: object, name: str) -> float:
    """내부 지표 객체도 불리언이나 NaN이면 자격을 계산하지 않는다."""
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(float(value)):
        raise DatasetFormatError(f"정책 지표 {name}이 유한한 숫자가 아닙니다. 문장별 표시를 다시 확인하세요.")
    return float(value)


def assess_policy_change(baseline: Sequence[Mapping[str, object]], candidate: Sequence[Mapping[str, object]], required_improvement: float) -> dict[str, Any]:
    """계획의 개선·유형별 오후보·가중 오후보·도움 필요 경계를 반올림 전에 적용한다."""
    if len(baseline) != 3 or len(candidate) != 3:
        raise DatasetFormatError("정책 자격 판정에는 기준과 비교 정책의 시드 지표가 각각 세 개 필요합니다.")
    improvement = mean_minimum(candidate) - mean_minimum(baseline)
    improvement_ok = improvement + COMPARISON_EPSILON >= required_improvement
    allow_failures = comparison_allow_failures(baseline, candidate)
    weighted_failures = comparison_weighted_failures(baseline, candidate)
    loss_failures = [index for index, unit in enumerate(candidate) if metric_float(unit["needs_care_loss"], "needs_care_loss") != 0]
    reasons = qualification_reasons(improvement, required_improvement, allow_failures, weighted_failures, loss_failures)
    return {
        "qualified": improvement_ok and not allow_failures and not weighted_failures and not loss_failures,
        "improvement": improvement,
        "required_improvement": required_improvement,
        "allow_failures": allow_failures,
        "weighted_allow_failures": weighted_failures,
        "needs_care_loss_failures": loss_failures,
        "reasons": reasons,
    }


def comparison_allow_failures(baseline: Sequence[Mapping[str, object]], candidate: Sequence[Mapping[str, object]]) -> list[dict[str, object]]:
    """시드별 허용 유형 증가가 0.05를 넘은 칸만 모은다."""
    failures: list[dict[str, object]] = []
    for index, (base, current) in enumerate(zip(baseline, candidate, strict=True)):
        base_rates = base["endpoint_rate_by_category"]
        current_rates = current["endpoint_rate_by_category"]
        if not isinstance(base_rates, Mapping) or not isinstance(current_rates, Mapping):
            raise DatasetFormatError("endpoint_rate_by_category는 범주별 비율 객체여야 합니다.")
        for category in ALLOW_CATEGORIES:
            increase = metric_float(current_rates[category], category) - metric_float(base_rates[category], category)
            if increase > ALLOW_CATEGORY_INCREASE_LIMIT + COMPARISON_EPSILON:
                failures.append({"seed_index": index, "category": category, "increase": increase})
    return failures


def comparison_weighted_failures(baseline: Sequence[Mapping[str, object]], candidate: Sequence[Mapping[str, object]]) -> list[dict[str, object]]:
    """시드별 허용 가중 오후보 증가가 0.005를 넘은 칸만 모은다."""
    failures: list[dict[str, object]] = []
    for index, (base, current) in enumerate(zip(baseline, candidate, strict=True)):
        increase = metric_float(current["weighted_allow_false_positive_rate"], "weighted_allow_false_positive_rate") - metric_float(
            base["weighted_allow_false_positive_rate"], "weighted_allow_false_positive_rate"
        )
        if increase > WEIGHTED_ALLOW_INCREASE_LIMIT + COMPARISON_EPSILON:
            failures.append({"seed_index": index, "increase": increase})
    return failures


def qualification_reasons(
    improvement: float,
    required: float,
    allow_failures: Sequence[object],
    weighted_failures: Sequence[object],
    loss_failures: Sequence[object],
) -> list[str]:
    """기계 판정과 사람이 읽는 이유가 같은 조건에서 나오게 한다."""
    reasons = [f"핵심 최소 평균 개선 {improvement:.6f} (기준 {required:.2f})"]
    reasons.append("허용 유형별 증가 상한 통과" if not allow_failures else f"허용 유형별 증가 상한 초과 {len(allow_failures)}건")
    reasons.append("허용 가중 증가 상한 통과" if not weighted_failures else f"허용 가중 증가 상한 초과 {len(weighted_failures)}건")
    reasons.append("도움 필요 손실 0" if not loss_failures else f"도움 필요 손실 시드 {len(loss_failures)}개")
    return reasons


def choose_final_policy(metrics: Mapping[str, Sequence[Mapping[str, object]]]) -> dict[str, Any]:
    """R1을 먼저 고른 뒤 그 기준 위의 T1·T2만 비교하고 0.02 미만 동률은 T1로 깬다."""
    step1_assessment = assess_policy_change(metrics["L0"], metrics["L1"], STEP1_IMPROVEMENT)
    base = "L1" if step1_assessment["qualified"] else "L0"
    t1_name, t2_name = f"{base}+T1", f"{base}+T2"
    t1 = assess_policy_change(metrics[base], metrics[t1_name], STEP2_IMPROVEMENT)
    t2 = assess_policy_change(metrics[base], metrics[t2_name], STEP2_IMPROVEMENT)
    selected = choose_t_policy(t1_name, t1, t2_name, t2)
    return {
        "step1": {"comparison": "L1 - L0", "adopted": bool(step1_assessment["qualified"]), **step1_assessment},
        "step2": {"baseline": base, "T1": t1, "T2": t2, "selected": selected},
        "final_policy": selected or base,
    }


def choose_t_policy(first_name: str, first: Mapping[str, object], second_name: str, second: Mapping[str, object]) -> str | None:
    """자격 있는 T가 둘이면 개선 차이 0.02 미만에서 영향 범위가 좁은 T1을 택한다."""
    eligible = [(first_name, first), (second_name, second)]
    eligible = [(name, assessment) for name, assessment in eligible if assessment["qualified"]]
    if not eligible:
        return None
    if len(eligible) == 1:
        return eligible[0][0]
    first_improvement = metric_float(first["improvement"], "improvement")
    second_improvement = metric_float(second["improvement"], "improvement")
    difference = abs(first_improvement - second_improvement)
    if difference + COMPARISON_EPSILON < T1_PREFERENCE_MARGIN:
        return first_name
    return first_name if first_improvement > second_improvement else second_name


def bootstrap_minimum_differences(
    selected_flags: Sequence[Mapping[str, bool]],
    baseline_flags: Sequence[Mapping[str, bool]],
    category_ids: Mapping[str, Sequence[str]],
    *,
    rounds: int = BOOTSTRAP_ROUNDS,
    seed: int = BOOTSTRAP_SEED,
) -> list[float]:
    """두 정책·세 시드에 같은 범주별 재표본 id를 쓰고 매 반복 최소를 새로 고른다."""
    if len(selected_flags) != 3 or len(baseline_flags) != 3 or rounds < 1:
        raise DatasetFormatError("부트스트랩에는 두 정책의 시드 세 개와 1회 이상의 반복이 필요합니다.")
    generator = random.Random(seed)
    differences = []
    for _ in range(rounds):
        samples = {category: [generator.randrange(len(ids)) for _ in ids] for category, ids in category_ids.items()}
        selected = bootstrap_seed_mean(selected_flags, category_ids, samples)
        baseline = bootstrap_seed_mean(baseline_flags, category_ids, samples)
        differences.append(selected - baseline)
    return differences


def bootstrap_seed_mean(seed_flags: Sequence[Mapping[str, bool]], category_ids: Mapping[str, Sequence[str]], samples: Mapping[str, Sequence[int]]) -> float:
    """한 정책의 각 시드에서 다섯 범주율을 다시 만들고 그때의 최소를 평균한다."""
    minima = []
    for flags in seed_flags:
        rates = [sum(flags[category_ids[category][index]] for index in samples[category]) / len(samples[category]) for category in CORE_CATEGORIES]
        minima.append(min(rates))
    return sum(minima) / len(minima)


def bootstrap_report(selected: Sequence[Mapping[str, Any]], baseline: Sequence[Mapping[str, Any]], items: Sequence[ChatEvalItem]) -> dict[str, Any]:
    """정렬한 2,000개 차이에서 계획의 고정 인덱스로 95% 보고 구간을 꺼낸다."""
    category_ids = {category: [item.item_id for item in scored_items(items) if item.category == category] for category in CORE_CATEGORIES}
    selected_flags = [{identifier: bool(value["endpoint"]) for identifier, value in unit["flags"].items()} for unit in selected]
    baseline_flags = [{identifier: bool(value["endpoint"]) for identifier, value in unit["flags"].items()} for unit in baseline]
    differences = sorted(bootstrap_minimum_differences(selected_flags, baseline_flags, category_ids))
    lower = int(0.025 * len(differences))
    upper = int(0.975 * len(differences)) - 1
    observed = mean_minimum([unit["metrics"] for unit in selected]) - mean_minimum([unit["metrics"] for unit in baseline])
    return {
        "seed": BOOTSTRAP_SEED,
        "rounds": BOOTSTRAP_ROUNDS,
        "observed_difference": observed,
        "interval": [differences[lower], differences[upper]],
        "interval_indices": [lower, upper],
    }


def collect_diagnostic_slots(config_path: Path, value: object, seeds: Sequence[int], prefix: str = "") -> dict[str, dict[int, Path]]:
    """진단 이름은 자유롭게 두되 잎은 언제나 같은 세 시드 보고서로 정규화한다."""
    if isinstance(value, list):
        if not prefix:
            raise DatasetFormatError("CONFIG diagnostics 최상위는 이름→진단 칸 객체여야 합니다.")
        return {prefix: seed_report_paths(config_path, value, seeds, f"diagnostics/{prefix}")}
    if not isinstance(value, dict):
        location = f"diagnostics/{prefix}" if prefix else "diagnostics"
        raise DatasetFormatError(f"CONFIG {location}는 중첩 객체 또는 시드별 보고서 목록이어야 합니다.")
    seed_keys = {str(seed) for seed in seeds}
    actual_keys = set(map(str, value))
    if actual_keys & seed_keys:
        if not prefix:
            raise DatasetFormatError("CONFIG diagnostics 최상위에는 진단 칸 이름이 필요합니다.")
        if actual_keys != seed_keys:
            raise DatasetFormatError(f"CONFIG diagnostics/{prefix}의 시드가 CONFIG seeds와 다릅니다. 세 시드 보고서를 모두 넣으세요.")
        return {prefix: seed_report_paths(config_path, value, seeds, f"diagnostics/{prefix}")}
    result: dict[str, dict[int, Path]] = {}
    for name, child in value.items():
        if name == "routes":
            continue
        child_prefix = f"{prefix}/{name}" if prefix else str(name)
        result |= collect_diagnostic_slots(config_path, child, seeds, child_prefix)
    if prefix and not result:
        raise DatasetFormatError(f"CONFIG diagnostics/{prefix}에 시드별 보고서가 없습니다.")
    return result


def load_diagnostics(
    config_path: Path,
    value: object,
    seeds: Sequence[int],
    items: Sequence[ChatEvalItem],
    eval_sha256: str,
    stage2_sha256: str,
    stage2_scores: Mapping[str, Stage2Score],
    traffic_mix: Mapping[str, float],
    baseline_units: Mapping[int, Mapping[str, Any]],
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Path]]:
    """선택 진단 보고서도 공통 입력을 검사하지만 이름·임계값·가중치는 자유롭게 둔다."""
    if value is None:
        return {}, {}
    if not isinstance(value, dict):
        raise DatasetFormatError("CONFIG diagnostics는 객체여야 합니다.")
    slots = collect_diagnostic_slots(config_path, value, seeds)
    loaded: dict[str, list[dict[str, Any]]] = {}
    for name, paths in slots.items():
        loaded[name] = []
        for seed in seeds:
            report = load_report(
                paths[seed],
                name,
                seed,
                items,
                eval_sha256,
                stage2_sha256,
                stage2_scores,
                traffic_mix,
                expected_policy_kind=None,
                allow_budget_decision=True,
                allow_missing_stage2_policy=True,
            )
            report["metrics"] = metrics_from_flags(items, report["flags"], traffic_mix, baseline_units[seed]["flags"])
            loaded[name].append(report)
    routes = diagnostic_route_paths(config_path, value.get("routes"))
    return loaded, routes


def diagnostic_route_paths(config_path: Path, value: object) -> dict[str, Path]:
    """2차 단독·고득점 진단에 쓸 정책별 규칙 경로 JSONL을 읽는다."""
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise DatasetFormatError("CONFIG diagnostics.routes는 정책 이름→규칙 경로 JSONL 객체여야 합니다.")
    return {str(name): reference_path(config_path, path, f"diagnostics/routes/{name}") for name, path in value.items()}


def routes_for_policy(routes: Mapping[str, Mapping[str, RuleRoute]], policy: str) -> Mapping[str, RuleRoute] | None:
    """T 칸 전용 경로가 없으면 같은 규칙층 L0 또는 L1 경로를 재사용한다."""
    if policy in routes:
        return routes[policy]
    base = "L1" if policy.startswith("L1") else "L0"
    return routes.get(base)


def load_diagnostic_routes(
    paths: Mapping[str, Path],
    items: Sequence[ChatEvalItem],
    eval_path: Path,
    units: Mapping[str, Mapping[int, Mapping[str, Any]]],
    seeds: Sequence[int],
) -> dict[str, Mapping[str, RuleRoute]]:
    """각 JSONL의 평가셋·id와 해당 정책 보고서의 규칙 지문까지 맞춘다."""
    result: dict[str, Mapping[str, RuleRoute]] = {}
    for name, path in paths.items():
        if name not in REQUIRED_POLICIES:
            raise DatasetFormatError(f"diagnostics.routes의 {name!r}은 판정 정책 이름이 아닙니다. L0·L1 또는 T를 포함한 정책 이름을 쓰세요.")
        routes, fingerprint = load_rule_routes(path, items, eval_path)
        if fingerprint != units[name][seeds[0]]["rule_fingerprint"]:
            raise DatasetFormatError(f"diagnostics.routes/{name}의 규칙 지문이 해당 보고서와 다릅니다. 같은 규칙 결과를 쓰세요.")
        result[name] = routes
    return result


def standalone_flags(
    items: Sequence[ChatEvalItem], routes: Mapping[str, RuleRoute], scores: Mapping[str, Stage2Score], policy: Stage2Policy
) -> dict[str, dict[str, bool | str]]:
    """1차가 모두 넘긴다고 놓되 규칙과 가벼운 반응의 앞단 판정은 그대로 둔다."""
    result = {}
    for item in scored_items(items):
        route = routes[item.item_id]
        decision: EndpointDecision
        if route.rule_flagged:
            decision = "candidate"
        elif route.skip_ai:
            decision = "pass"
        else:
            stage2 = scores[item.item_id]
            decision = stage2_endpoint_decision(
                policy.policy, policy.base, policy.relaxed, policy.categories, route.keyword, stage2.probability, stage2.category
            )
        result[item.item_id] = flag_record(route, decision, not route.rule_flagged and not route.skip_ai)
    return result


def flag_record(route: RuleRoute, decision: EndpointDecision, goes_to_stage2: bool) -> dict[str, bool | str]:
    """진단도 evaluate_chat과 같은 네 키 관계를 쓴다."""
    endpoint = decision != "pass"
    return {"routed": route.rule_flagged or goes_to_stage2, "goes_to_stage2": goes_to_stage2, "endpoint": endpoint, "endpoint_decision": decision}


def high_score_flags(unit: Mapping[str, Any], routes: Mapping[str, RuleRoute]) -> dict[str, dict[str, bool | str]]:
    """규칙·가벼운 반응은 유지하고 1차 점수 0.9 이상만 2차와 무관한 후보로 더한다."""
    result = {}
    for identifier, original in unit["flags"].items():
        route = routes[identifier]
        decision = original["endpoint_decision"]
        promoted = False
        if decision == "pass" and not route.rule_flagged and not route.skip_ai and unit["scores"][identifier] >= HIGH_SCORE_THRESHOLD:
            decision = "candidate"
            promoted = True
        result[identifier] = {
            **original,
            "routed": True if promoted else original["routed"],
            "goes_to_stage2": False if promoted else original["goes_to_stage2"],
            "endpoint": decision != "pass",
            "endpoint_decision": decision,
        }
    return result


def build_mechanism_diagnostics(
    units: Mapping[str, Mapping[int, Mapping[str, Any]]],
    seeds: Sequence[int],
    items: Sequence[ChatEvalItem],
    traffic_mix: Mapping[str, float],
    stage2_scores: Mapping[str, Stage2Score],
    routes: Mapping[str, Mapping[str, RuleRoute]],
) -> dict[str, Any]:
    """규칙 경로가 있을 때만 2차 단독·1차 고득점 진단을 계산한다."""
    standalone: dict[str, list[dict[str, Any]]] = {}
    for policy in REQUIRED_POLICIES:
        route = routes_for_policy(routes, policy)
        if route is None:
            continue
        flags = standalone_flags(items, route, stage2_scores, units[policy][seeds[0]]["stage2_policy"])
        standalone[policy] = [metrics_from_flags(items, flags, traffic_mix, units["L0"][seed]["flags"]) for seed in seeds]
    high_score: dict[str, list[dict[str, Any]]] = {}
    for base in ("L0", "L1"):
        route = routes_for_policy(routes, base)
        if route is None:
            continue
        high_score[base] = [metrics_from_flags(items, high_score_flags(units[base][seed], route), traffic_mix, units["L0"][seed]["flags"]) for seed in seeds]
    return {"stage2_standalone": standalone, "stage1_high_score": high_score}


def stage2_miss_counts(
    units: Mapping[str, Mapping[int, Mapping[str, Any]]], seeds: Sequence[int], items: Sequence[ChatEvalItem], scores: Mapping[str, Stage2Score]
) -> dict[str, dict[str, int]]:
    """다음 2차 교체 판단을 위해 1차는 높지만 2차 확률이 0.05 미만인 핵심 문장 수를 센다."""
    result: dict[str, dict[str, int]] = {}
    for seed in seeds:
        stage1 = units["L0"][seed]["scores"]
        result[str(seed)] = {
            category: sum(
                stage1[item.item_id] >= HIGH_SCORE_THRESHOLD and scores[item.item_id].probability < STAGE2_MISS_THRESHOLD
                for item in scored_items(items)
                if item.category == category
            )
            for category in CORE_CATEGORIES
        }
    return result


def public_unit(unit: Mapping[str, Any]) -> dict[str, Any]:
    """원문과 내부 플래그를 빼고 판정 근거 집계·출처만 결과에 남긴다."""
    return {
        "policy": unit["policy"],
        "seed": unit["seed"],
        "threshold": unit["threshold"],
        "model_weights_sha256": unit["weights"],
        "rule_policy_sha256": unit["rule_fingerprint"],
        "stage2_policy": unit["stage2_policy"].to_dict(),
        "metrics": unit["metrics"],
        "source": unit["source"],
    }


def public_diagnostic(unit: Mapping[str, Any]) -> dict[str, Any]:
    """진단 보고서도 집계와 출처만 공개한다."""
    return {"seed": unit["seed"], "threshold": unit["threshold"], "metrics": unit["metrics"], "source": unit["source"]}


def build_round4_decision(config_path: Path) -> dict[str, Any]:
    """CONFIG 전체를 사전 검사하고 18개 칸의 정확 지표·단계 판정·진단·부트스트랩을 만든다."""
    config = read_json_object(config_path, "round4 CONFIG")
    seeds = require_seed_list(config.get("seeds"))
    expected_rule_fingerprints = require_expected_rule_fingerprints(config.get("expected_rule_fingerprints"))
    expected_seed_inputs = require_expected_seed_inputs(config.get("expected_seed_inputs"), seeds)
    eval_path = resolve_path(config_path, config.get("eval_file"), "eval_file")
    items = load_decision_items(eval_path)
    require_development_set(items)
    traffic_mix = load_traffic_mix_config(config_path, config.get("traffic_mix"))
    stage2_path = resolve_path(config_path, config.get("stage2_scores"), "stage2_scores")
    stage2_scores, stage2_provenance = load_stage2_scores(stage2_path, items, eval_path)
    paths = required_unit_paths(config_path, config.get("units"), seeds)
    units = load_required_units(
        paths,
        seeds,
        items,
        compute_file_sha256(eval_path),
        stage2_provenance["sha256"],
        stage2_scores,
        traffic_mix,
    )
    require_same_seed_experiment(units, seeds, expected_seed_inputs)
    require_rule_groups(units, seeds, expected_rule_fingerprints)
    require_l0_invariant(units, seeds)
    attach_metrics(units, items, traffic_mix, seeds)
    metrics = {policy: [units[policy][seed]["metrics"] for seed in seeds] for policy in REQUIRED_POLICIES}
    choice = choose_final_policy(metrics)
    diagnostic_reports, route_paths = load_diagnostics(
        config_path,
        config.get("diagnostics"),
        seeds,
        items,
        compute_file_sha256(eval_path),
        stage2_provenance["sha256"],
        stage2_scores,
        traffic_mix,
        units["L0"],
    )
    routes = load_diagnostic_routes(route_paths, items, eval_path, units, seeds)
    diagnostics = build_mechanism_diagnostics(units, seeds, items, traffic_mix, stage2_scores, routes)
    diagnostics["report_slots"] = {name: [public_diagnostic(unit) for unit in values] for name, values in diagnostic_reports.items()}
    diagnostics["route_sources"] = {name: {"name": path.name, "sha256": compute_file_sha256(path)} for name, path in route_paths.items()}
    diagnostics["stage2_misses"] = stage2_miss_counts(units, seeds, items, stage2_scores)
    result = build_public_result(config_path, eval_path, stage2_path, traffic_mix, seeds, units, choice, diagnostics)
    if choice["final_policy"] != "L0":
        selected = [units[choice["final_policy"]][seed] for seed in seeds]
        baseline = [units["L0"][seed] for seed in seeds]
        result["bootstrap"] = bootstrap_report(selected, baseline, items)
    return result


def load_required_units(
    paths: Mapping[str, Mapping[int, Path]],
    seeds: Sequence[int],
    items: Sequence[ChatEvalItem],
    eval_sha256: str,
    stage2_sha256: str,
    stage2_scores: Mapping[str, Stage2Score],
    traffic_mix: Mapping[str, float],
) -> dict[str, dict[int, dict[str, Any]]]:
    """정책 이름이 정한 stage2_policy까지 포함해 18개를 모두 읽는다."""
    return {
        policy: {
            seed: load_report(
                paths[policy][seed],
                policy,
                seed,
                items,
                eval_sha256,
                stage2_sha256,
                stage2_scores,
                traffic_mix,
                expected_policy_kind=POLICY_KIND[policy],
            )
            for seed in seeds
        }
        for policy in REQUIRED_POLICIES
    }


def build_public_result(
    config_path: Path,
    eval_path: Path,
    stage2_path: Path,
    traffic_mix: Mapping[str, float],
    seeds: Sequence[int],
    units: Mapping[str, Mapping[int, Mapping[str, Any]]],
    choice: Mapping[str, Any],
    diagnostics: Mapping[str, Any],
) -> dict[str, Any]:
    """재현 입력 지문과 판정 근거를 원문 없이 한 JSON 문서로 묶는다."""
    return {
        "schema_version": 1,
        "created_at": utc_timestamp(),
        "inputs": {
            "config": {"name": config_path.name, "sha256": compute_file_sha256(config_path)},
            "eval_file": {"name": eval_path.name, "sha256": compute_file_sha256(eval_path)},
            "stage2_scores": {"name": stage2_path.name, "sha256": compute_file_sha256(stage2_path)},
            "traffic_mix": dict(traffic_mix),
            "seeds": list(seeds),
        },
        "units": [public_unit(units[policy][seed]) for policy in REQUIRED_POLICIES for seed in seeds],
        "decision": dict(choice),
        "diagnostics": dict(diagnostics),
    }


def format_rate(value: float) -> str:
    """Markdown 표시만 네 자리로 반올림하고 JSON의 판정값은 그대로 둔다."""
    return f"{value:.4f}"


def format_round4_markdown(report: Mapping[str, Any]) -> str:
    """정책·시드별 분자/분모와 단계 이유·진단을 사람이 검토할 표로 만든다."""
    lines = ["# M2 4차 개발셋 판정", "", f"최종 정책: **{report['decision']['final_policy']}**", ""]
    lines += unit_markdown_table(report["units"])
    lines += decision_markdown(report["decision"])
    lines += diagnostics_markdown(report["diagnostics"])
    if "bootstrap" in report:
        bootstrap = report["bootstrap"]
        lines += [
            "## 짝지은 부트스트랩",
            "",
            f"L0 대비 핵심 최소 차이: 관측 {format_rate(bootstrap['observed_difference'])}, "
            f"95% 구간 [{format_rate(bootstrap['interval'][0])}, {format_rate(bootstrap['interval'][1])}] "
            f"(시드 {bootstrap['seed']}, {bootstrap['rounds']}회)",
            "",
        ]
    return "\n".join(lines).rstrip() + "\n"


def unit_markdown_table(units: object) -> list[str]:
    """모든 범주의 후보 수/전체와 운영 비용을 한 행에 모은다."""
    if not isinstance(units, list):
        raise DatasetFormatError("판정 결과 units는 정책·시드별 목록이어야 합니다.")
    headers = ["정책", "시드", *REPORT_CATEGORIES, "핵심 최소(범주)", "허용 가중 오후보", "도움 필요/손실", "2차 부하"]
    lines = ["## 정책별 지표", "", "| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    for unit in units:
        metrics = unit["metrics"]
        counts = metrics["endpoint_count_by_category"]
        category_cells = [f"{counts[category]['count']}/{counts[category]['total']}" for category in REPORT_CATEGORIES]
        cells = [
            unit["policy"],
            str(unit["seed"]),
            *category_cells,
            f"{format_rate(metrics['critical_minimum'])} ({metrics['critical_minimum_category']})",
            format_rate(metrics["weighted_allow_false_positive_rate"]),
            f"{metrics['needs_care_count']}/{metrics['needs_care_loss']}",
            format_rate(metrics["stage2_load"]),
        ]
        lines.append("| " + " | ".join(cells) + " |")
    return lines + [""]


def decision_markdown(decision: object) -> list[str]:
    """각 단계의 통과 여부와 실패 근거를 JSON과 같은 순서로 적는다."""
    if not isinstance(decision, Mapping):
        raise DatasetFormatError("판정 결과 decision은 객체여야 합니다.")
    step1 = decision["step1"]
    step2 = decision["step2"]
    lines = ["## 단계별 판정", "", f"- 1단계 R1: {'채택' if step1['adopted'] else '불채택'} — " + "; ".join(step1["reasons"])]
    for name in ("T1", "T2"):
        assessment = step2[name]
        lines.append(f"- 2단계 {name} (기준 {step2['baseline']}): {'자격' if assessment['qualified'] else '탈락'} — " + "; ".join(assessment["reasons"]))
    lines += [f"- 2단계 선택: {step2['selected'] or '없음'}", ""]
    return lines


def diagnostics_markdown(diagnostics: object) -> list[str]:
    """선택 진단 칸과 2차 단독·고득점·놓침을 원문 없는 요약으로 표시한다."""
    if not isinstance(diagnostics, Mapping):
        raise DatasetFormatError("판정 결과 diagnostics는 객체여야 합니다.")
    lines = ["## 진단", "", "1차 점수는 보고서의 4자리 값을 사용한다.", ""]
    report_slots = diagnostics.get("report_slots", {})
    if report_slots:
        lines += ["| 진단 칸 | 시드 | 핵심 최소 | 허용 가중 오후보 | 도움 필요/손실 | 2차 부하 |", "|---|---|---|---|---|---|"]
        for name, units in report_slots.items():
            for unit in units:
                metric = unit["metrics"]
                lines.append(
                    f"| {name} | {unit['seed']} | {format_rate(metric['critical_minimum'])} ({metric['critical_minimum_category']}) | "
                    f"{format_rate(metric['weighted_allow_false_positive_rate'])} | "
                    f"{metric['needs_care_count']}/{metric['needs_care_loss']} | {format_rate(metric['stage2_load'])} |"
                )
        lines.append("")
    lines += mechanism_markdown("2차 단독", diagnostics.get("stage2_standalone", {}))
    lines += mechanism_markdown("1차 고득점 경로", diagnostics.get("stage1_high_score", {}))
    misses = diagnostics.get("stage2_misses", {})
    lines += ["### 2차 놓침", "", "| 시드 | " + " | ".join(CORE_CATEGORIES) + " |", "|---|" + "---|" * len(CORE_CATEGORIES)]
    for seed, values in misses.items():
        lines.append("| " + " | ".join([seed, *(str(values[category]) for category in CORE_CATEGORIES)]) + " |")
    return lines + [""]


def mechanism_markdown(title: str, values: object) -> list[str]:
    """정책별 진단의 세 시드 핵심 최소를 짧은 표로 보인다."""
    if not isinstance(values, Mapping) or not values:
        return [f"### {title}", "", "규칙 경로 입력이 없어 계산하지 않음.", ""]
    lines = [f"### {title}", "", "| 정책 | 시드 순서 핵심 최소 |", "|---|---|"]
    for policy, metrics in values.items():
        lines.append(f"| {policy} | {', '.join(format_rate(metric['critical_minimum']) for metric in metrics)} |")
    return lines + [""]


def ensure_outputs_absent(output_dir: Path) -> tuple[Path, Path]:
    """둘 중 하나라도 있으면 먼저 멈춰 부분 덮어쓰기를 피한다."""
    if output_dir.exists() and not output_dir.is_dir():
        raise OutputExistsError(f"{output_dir.name}이 디렉터리가 아닙니다. 새 --output-dir 경로를 주세요.")
    json_path, markdown_path = output_dir / "decision.json", output_dir / "decision.md"
    existing = next((path for path in (json_path, markdown_path) if path.exists()), None)
    if existing is not None:
        raise OutputExistsError(f"{existing.name}이 이미 있습니다. 앞선 4차 판정을 지키려고 덮어쓰지 않습니다. 새 --output-dir을 주세요.")
    return json_path, markdown_path


def write_exclusive(path: Path, content: str) -> None:
    """사전 검사 뒤 경쟁으로 생긴 파일도 x 모드로 덮어쓰지 않는다."""
    try:
        with path.open("x", encoding="utf-8") as handle:
            handle.write(content)
    except FileExistsError as error:
        raise OutputExistsError(f"{path.name}이 쓰는 동안 생겼습니다. 앞선 파일을 지키려고 덮어쓰지 않았습니다.") from error


def write_round4_decision(config_path: Path, output_dir: Path) -> dict[str, Any]:
    """완전한 판정을 메모리에서 만든 뒤 새 JSON·Markdown만 공개한다."""
    json_path, markdown_path = ensure_outputs_absent(output_dir)
    report = build_round4_decision(config_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    write_exclusive(json_path, json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    try:
        write_exclusive(markdown_path, format_round4_markdown(report))
    except BaseException:
        json_path.unlink(missing_ok=True)
        raise
    return report


def build_argument_parser() -> argparse.ArgumentParser:
    """계획에 고정한 CONFIG와 새 출력 디렉터리만 받는다."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage1.round4_decision", description="M2 4차 개발셋 R1·T 판정")
    parser.add_argument("--config", type=Path, required=True, help="18개 보고서와 공통 입력을 적은 JSON")
    parser.add_argument("--output-dir", type=Path, required=True, help="새 decision.json·decision.md를 쓸 디렉터리")
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    """사전 검사를 모두 통과한 판정만 두 출력으로 쓴다."""
    arguments = build_argument_parser().parse_args(argv)
    write_round4_decision(arguments.config, arguments.output_dir)
    print(f"4차 판정 저장: {arguments.output_dir / 'decision.json'}, {arguments.output_dir / 'decision.md'}")


if __name__ == "__main__":
    run_command_line(main)
