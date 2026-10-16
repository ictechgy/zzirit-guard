"""채팅 형식 평가셋으로 1차 분류기를 '2차 처리 용량 안의 거름망'으로 평가한다.

무엇을 보나(docs/ml/2026-10-14-model-strengthening-plan.md M1):
- 범주별 전달률: 유해 범주에서는 재현율(2차로 넘긴 비율), 허용 유형에서는 잘못 넘긴 비율이다.
- 가중 전달률: 가정한 실제 트래픽 구성(DEFAULT_TRAFFIC_MIX)으로 범주별 전달률을 가중 평균한 값이다. 평가셋은 유해가
  절반쯤이라 그대로 평균하면 실제 2차 부하를 크게 부풀린다. 그래서 구성비로 다시 가중한다.
- 개발셋: 기본은 F_max(zg_stage1.capacity) 예산을 지키는 가장 작은 임계값을 고른다. --fixed-threshold면 주어진 값을 그대로 쓴다.
  어느 쪽이든 임계값 표와 문장별 점수를 남긴다.
- 보류셋: 개발셋 결과 파일(--dev-report)의 임계값만 쓴다. 모델 가중치가 같은지 확인하고, 그 임계값 하나의 집계만 남긴다.
  임계값 표나 문장별 점수를 남기면 보류셋을 보고 임계값을 다시 고를 수 있기 때문이다.
- 규칙 경로(--rule-routes, 선택): 서버의 규칙 평가 도구(apps/server/src/tools/evaluateRules.ts)가 낸 문장별 규칙 판정과
  키워드 경로 일치를 합친다. 실제 경로는 "규칙 → 키워드 경로 → 1차"라서,
  - 재현율(범주별 전달률)은 규칙·키워드·1차 중 하나라도 잡으면 잡은 것으로 센다.
  - 2차 부하(가중 전달률)는 규칙이 먼저 판정한 문장을 빼고(스펙 §5: 앞 단계에서 결정되면 멈춘다), 키워드나 1차로 2차에 가는 문장만 센다.
  주지 않으면 규칙·키워드가 아무것도 잡지 않은 것으로 본다(1차만 평가).
- 짧은 문장 규칙(--short-rule N:k, 선택): 공백을 뺀 N자 이하 문장은 기준 임계값의 k배를 넘어야 2차로 간다(M2 2차 계획 0).
  결과 파일에 규칙을 남기고, 보류셋은 개발셋과 같은 규칙일 때만 임계값을 읽는다.
원문은 출력·결과 파일에 넣지 않는다. 문장은 id로만 가리킨다.

CLI 사용 예:
  uv run python -m zg_stage1.evaluate_chat --model-dir <모델> --eval-file eval_data/chat-dev-v2.jsonl --forward-budget 0.304
  uv run python -m zg_stage1.evaluate_chat --model-dir <모델> --eval-file eval_data/chat-holdout-v2.jsonl --dev-report <모델>/chat-eval-dev.json
"""

from __future__ import annotations

import argparse
import json
import math
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Literal, NamedTuple

from zg_stage1 import modeling
from zg_stage1.arguments import positive_integer, probability_argument
from zg_stage1.chat_eval_data import ALLOW_CATEGORIES, CRITICAL_CATEGORIES, HARMFUL_CATEGORIES, ChatEvalItem, load_validated_eval_set
from zg_stage1.data import compute_file_sha256, describe_file_provenance
from zg_stage1.errors import DatasetFormatError, MetricError, OutputExistsError, run_command_line
from zg_stage1.evaluate import resolve_max_length
from zg_stage1.metrics import METRIC_DECIMALS, compute_roc_auc, ensure_valid_scores_and_labels
from zg_stage1.model_card import read_model_card, require_completed_training, utc_timestamp, write_json_atomically

# 실제 채팅의 범주 구성 가정(합 1.0). 실측 전까지의 가정이다(Grok 상담안: 짧은 일반·게임 80%, 칭찬 비속어 12%, 광고 모양 5%, 유해 3%).
# 섀도 운영으로 실제 비율을 재면 --mix-file로 바꾼다.
DEFAULT_TRAFFIC_MIX: dict[str, float] = {
    "short_normal": 0.35,
    "long_normal": 0.25,
    "game_combat": 0.12,
    "number_url_like": 0.05,
    "quote_report": 0.03,
    "friendly_profanity": 0.12,
    "spam": 0.05,
    "abuse": 0.02,
    "sexual": 0.003,
    "threat": 0.003,
    "doxxing": 0.002,
    "self_harm": 0.001,
    "minors": 0.001,
}

# 결과 표에 넣는 임계값. 거름망은 0.2~0.6 근처에서 결정될 가능성이 높아 그 구간을 촘촘히 본다.
CHAT_REPORT_THRESHOLDS: tuple[float, ...] = (0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)

# 고르는 임계값의 소수 자릿수. 운영 설정에 그대로 옮겨 적을 수 있는 정밀도다.
THRESHOLD_DECIMALS = 6

# 임계값이 가질 수 있는 가장 큰 값(probability_argument와 같은 (0, 1] 범위). 점수가 정확히 1.0인 문장은 이 값에서도 넘어간다.
MAX_THRESHOLD = 1.0

# 구성비 합이 1에서 이만큼 넘게 벗어나면 잘못 쓴 파일로 본다.
MIX_SUM_TOLERANCE = 1e-6

# 규칙 경로 결과의 판정 값(evaluateRules.ts). pass가 아니면 규칙이 먼저 잡은 것이다.
RULE_DECISIONS: frozenset[str] = frozenset({"auto_hide", "candidate", "pass"})

# 2차 워커가 후보로 올리는 고정 확률. 점수 파일도 이 기준으로 만들었는지 확인한다.
STAGE2_CANDIDATE_THRESHOLD = 0.5

# 완화 정책은 계획에서 한 번만 고른 값과 범주를 기본으로 쓴다. 서버도 contract 벡터로 같은 정의를 확인한다.
DEFAULT_RELAXED_STAGE2_THRESHOLD = 0.2
DEFAULT_RELAXED_STAGE2_CATEGORIES: frozenset[str] = frozenset({"S3", "S4", "S5"})
STAGE2_POLICIES: tuple[str, ...] = ("fixed", "keyword_route", "category")
STAGE2_CATEGORIES: frozenset[str] = frozenset(f"S{index}" for index in range(1, 8))
EndpointDecision = Literal["candidate", "needs_care", "pass"]


class Stage2Score(NamedTuple):
    """문장 하나의 2차 유해 확률과 가장 높은 안전 범주."""

    probability: float
    category: str


class Stage2Policy(NamedTuple):
    """경로 끝 후보를 정하는 2차 기준. 범주는 정렬해 보고서와 실행마다 같은 모양으로 남긴다."""

    policy: str = "fixed"
    base: float = STAGE2_CANDIDATE_THRESHOLD
    relaxed: float = DEFAULT_RELAXED_STAGE2_THRESHOLD
    categories: frozenset[str] = DEFAULT_RELAXED_STAGE2_CATEGORIES

    def to_dict(self) -> dict[str, object]:
        """서버 설정과 비교하기 쉬운 보고서 모양."""
        return {"policy": self.policy, "base": self.base, "relaxed": self.relaxed, "categories": sorted(self.categories)}


DEFAULT_STAGE2_POLICY = Stage2Policy()


def applied_stage2_threshold(
    policy: str,
    base_threshold: float,
    relaxed_threshold: float,
    relaxed_categories: frozenset[str],
    keyword_route: bool,
    category: str,
) -> float:
    """S6 우선 뒤 정책이 실제로 쓰는 기준. 완화값이 기본값보다 높아도 문턱을 올리지 않는다."""
    if category == "S6":
        return base_threshold
    relaxes_keyword = policy == "keyword_route" and keyword_route
    relaxes_category = policy == "category" and category in relaxed_categories
    return min(base_threshold, relaxed_threshold) if relaxes_keyword or relaxes_category else base_threshold


def stage2_endpoint_decision(
    policy: str,
    base_threshold: float,
    relaxed_threshold: float,
    relaxed_categories: frozenset[str],
    keyword_route: bool,
    probability: float,
    category: str,
) -> EndpointDecision:
    """2차 결과 하나를 후보·도움 필요·통과로 나누는 서버 공유 순수 정책."""
    threshold = applied_stage2_threshold(policy, base_threshold, relaxed_threshold, relaxed_categories, keyword_route, category)
    if probability < threshold:
        return "pass"
    return "needs_care" if category == "S6" else "candidate"


class RuleRoute(NamedTuple):
    """문장 하나의 규칙 경로 결과: 규칙이 잡았는지(pass가 아님), 키워드 경로에 걸렸는지, AI 단계를 건너뛰는 가벼운 반응인지."""

    rule_flagged: bool
    keyword: bool
    skip_ai: bool = False


class ShortRule(NamedTuple):
    """짧은 문장 임계값 규칙: 공백을 뺀 길이가 max_length 이하인 문장은 기준 임계값의 multiplier배를 넘어야 2차로 간다.

    왜: 짧은 일반 문장(인사·리액션)이 채팅의 대부분이라 2차 부하를 크게 차지한다. 짧은 문장만 문턱을 높이면
    그만큼 기준 임계값을 낮출 수 있어, 긴 유해 문장의 재현율을 지키면서 부하 예산을 맞출 수 있는지 잰다(M2 2차 계획 0).
    """

    max_length: int
    multiplier: float

    def to_dict(self) -> dict:
        """보고서에 남기는 모양."""
        return {"max_length": self.max_length, "multiplier": self.multiplier}


# 짧은 문장 규칙으로 임계값에 배수를 곱할 때 쓰는 허용 오차.
# 왜: 0.1 × 3 = 0.30000000000000004처럼 이진 소수 오차가 생겨, 점수/배수로 만든 격자 후보가 그 점수의 문장을 넣지 못한다.
# 배수가 1이면 쓰지 않아 기존 결과는 그대로다.
SCALED_THRESHOLD_TOLERANCE = 1e-12


def message_length(text: str) -> int:
    """짧은 문장 규칙이 보는 길이: 공백을 뺀 코드 포인트 수. 띄어쓰기 습관에 따라 길이가 달라지지 않게 한다."""
    return len("".join(text.split()))


class ScoredItem(NamedTuple):
    """평가 문장 하나의 1차 점수와 규칙 경로 결과. 규칙 결과를 주지 않으면 규칙·키워드 모두 걸리지 않은 것으로 본다.

    threshold_multiplier는 이 문장에 쓰는 임계값 배수다(짧은 문장 규칙에 걸리면 그 배수, 아니면 1).
    """

    item: ChatEvalItem
    score: float
    route: RuleRoute = RuleRoute(rule_flagged=False, keyword=False)
    threshold_multiplier: float = 1.0
    stage2_score: Stage2Score | None = None

    def is_routed(self, threshold: float) -> bool:
        """매니저나 2차 중 어디로든 올라가는지: 규칙이 잡거나, 2차로 가거나(goes_to_stage2).

        가벼운 반응(AI 건너뜀)은 규칙이 잡지 않으면 어디로도 가지 않는다. 2차 부하와 같은 기준이어야 숫자가 맞기 때문이다.
        """
        return self.route.rule_flagged or self.goes_to_stage2(threshold)

    def goes_to_stage2(self, threshold: float) -> bool:
        """2차(kanana)로 가는지. 규칙이 먼저 판정하거나 가벼운 반응이면 멈추므로(스펙 §5.2 ②·③) 2차 부하에서 뺀다."""
        if self.route.rule_flagged or self.route.skip_ai:
            return False
        if self.threshold_multiplier == 1.0:
            return self.route.keyword or self.score >= threshold
        return self.route.keyword or self.score >= threshold * self.threshold_multiplier - SCALED_THRESHOLD_TOLERANCE

    def endpoint_decision(self, threshold: float, policy: Stage2Policy = DEFAULT_STAGE2_POLICY) -> EndpointDecision:
        """규칙을 우선하고 실제 2차 경로의 결과만 후보·도움 필요로 쓴다."""
        if self.stage2_score is None:
            raise MetricError("경로 끝 후보율을 계산하려면 모든 문장의 2차 점수가 필요합니다. --stage2-scores를 확인하세요.")
        if self.route.rule_flagged:
            return "candidate"
        if not self.goes_to_stage2(threshold):
            return "pass"
        return stage2_endpoint_decision(
            policy.policy,
            policy.base,
            policy.relaxed,
            policy.categories,
            self.route.keyword,
            self.stage2_score.probability,
            self.stage2_score.category,
        )

    def is_endpoint_candidate(self, threshold: float, policy: Stage2Policy = DEFAULT_STAGE2_POLICY) -> bool:
        """경로 끝 후보 또는 도움 필요인지. 기존 endpoint 불리언은 두 상태를 함께 뜻한다."""
        return self.endpoint_decision(threshold, policy) != "pass"


def validate_traffic_mix(mix: Mapping[str, float]) -> None:
    """구성비가 알려진 범주만 담고, 모두 0 이상이고, 합이 1인지 확인한다."""
    unknown = sorted(set(mix) - set(HARMFUL_CATEGORIES) - set(ALLOW_CATEGORIES))
    if unknown:
        raise DatasetFormatError(f"구성비에 모르는 범주가 있습니다: {', '.join(unknown)}. docs/ml/chat-eval-policy.md의 범주 이름을 쓰세요.")
    if any(not (math.isfinite(weight) and weight >= 0) for weight in mix.values()):
        raise DatasetFormatError("구성비는 0 이상의 유한한 값이어야 합니다.")
    if abs(sum(mix.values()) - 1.0) > MIX_SUM_TOLERANCE:
        raise DatasetFormatError(f"구성비의 합이 {sum(mix.values()):.6f}입니다. 합이 1이 되게 고치세요.")


def scored_pairs(
    items: Sequence[ChatEvalItem],
    scores: Sequence[float],
    routes: Mapping[str, RuleRoute] | None = None,
    short_rule: ShortRule | None = None,
    stage2_scores: Mapping[str, Stage2Score] | None = None,
) -> list[ScoredItem]:
    """지표에 들어가는(ambiguous가 아닌) 문장과 점수·규칙 경로·임계값 배수의 묶음. routes가 없으면 규칙·키워드 없음으로 본다."""
    if len(items) != len(scores):
        raise MetricError(f"문장 {len(items)}개와 점수 {len(scores)}개의 개수가 다릅니다.")
    no_route = RuleRoute(rule_flagged=False, keyword=False)
    pairs = zip(items, scores, strict=True)
    return [
        ScoredItem(
            item,
            score,
            no_route if routes is None else routes[item.item_id],
            threshold_multiplier_for(item.text, short_rule),
            None if stage2_scores is None else stage2_scores[item.item_id],
        )
        for item, score in pairs
        if item.is_scored
    ]


def threshold_multiplier_for(text: str, short_rule: ShortRule | None) -> float:
    """문장에 쓸 임계값 배수. 짧은 문장 규칙이 없거나 문장이 길면 1이다."""
    if short_rule is None or message_length(text) > short_rule.max_length:
        return 1.0
    return short_rule.multiplier


def rates_by_category(pairs: Sequence[ScoredItem], is_counted: Callable[[ScoredItem], bool]) -> dict[str, float]:
    """범주별로 is_counted가 참인 문장의 비율."""
    totals: dict[str, int] = {}
    counted: dict[str, int] = {}
    for pair in pairs:
        totals[pair.item.category] = totals.get(pair.item.category, 0) + 1
        counted[pair.item.category] = counted.get(pair.item.category, 0) + is_counted(pair)
    return {category: counted[category] / totals[category] for category in sorted(totals)}


def forward_rates_by_category(pairs: Sequence[ScoredItem], threshold: float) -> dict[str, float]:
    """범주별로 경로 어디선가 잡힌(규칙·키워드·1차) 비율. 유해 범주에서는 재현율, 허용 유형에서는 잘못 올린 비율이다."""
    return rates_by_category(pairs, lambda pair: pair.is_routed(threshold))


def stage2_rates_by_category(pairs: Sequence[ScoredItem], threshold: float) -> dict[str, float]:
    """범주별로 2차로 가는 비율. 2차 부하(가중 전달률)를 계산하는 데 쓴다."""
    return rates_by_category(pairs, lambda pair: pair.goes_to_stage2(threshold))


def endpoint_candidate_rates_by_category(pairs: Sequence[ScoredItem], threshold: float, policy: Stage2Policy = DEFAULT_STAGE2_POLICY) -> dict[str, float]:
    """범주별 경로 끝 후보율. 2차에 가지 않은 문장의 kanana 점수는 쓰지 않는다."""
    return rates_by_category(pairs, lambda pair: pair.is_endpoint_candidate(threshold, policy))


def weighted_forward_rate(rates: Mapping[str, float], mix: Mapping[str, float]) -> float:
    """구성비로 가중한 전달률. 구성비가 있는 범주가 평가셋에 없으면 오류다.

    왜 빼고 다시 나누지 않나: 빠진 범주가 실제로는 많이 넘어갈 수 있는데, 빼고 나누면 부하가 작게 보여 잘못된 임계값을 고른다.
    """
    missing = sorted(category for category, weight in mix.items() if weight > 0 and category not in rates)
    if missing:
        raise MetricError(f"구성비가 있는 범주가 평가셋에 없습니다: {', '.join(missing)}. 평가셋에 그 범주를 넣거나 구성비를 고치세요.")
    return sum(weight * rates[category] for category, weight in mix.items() if weight > 0)


def rates_for(rates: Mapping[str, float], categories: Sequence[str] | frozenset[str]) -> list[float]:
    """주어진 범주의 전달률 목록. 평가셋이 범주를 모두 담는지는 load_validated_eval_set이 확인한다."""
    return [rates[category] for category in sorted(categories)]


def summarize_at_chat_threshold(
    pairs: Sequence[ScoredItem], threshold: float, mix: Mapping[str, float], stage2_policy: Stage2Policy = DEFAULT_STAGE2_POLICY
) -> dict:
    """한 임계값에서의 요약: 2차 부하(가중 전달률), 핵심 범주 재현율(최소·평균), 허용 유형 최대 전달률, 범주별 전달률."""
    rates = forward_rates_by_category(pairs, threshold)
    critical = rates_for(rates, CRITICAL_CATEGORIES)
    allow = rates_for(rates, ALLOW_CATEGORIES)
    summary = {
        "threshold": threshold,
        "weighted_forward_rate": round(weighted_forward_rate(stage2_rates_by_category(pairs, threshold), mix), METRIC_DECIMALS),
        "critical_recall_min": round(min(critical), METRIC_DECIMALS),
        "critical_recall_mean": round(sum(critical) / len(critical), METRIC_DECIMALS),
        "allow_forward_max": round(max(allow), METRIC_DECIMALS),
        "by_category": {category: round(rate, METRIC_DECIMALS) for category, rate in rates.items()},
    }
    if pairs and all(pair.stage2_score is not None for pair in pairs):
        endpoint = endpoint_candidate_rates_by_category(pairs, threshold, stage2_policy)
        summary["endpoint_candidate_by_category"] = {category: round(rate, METRIC_DECIMALS) for category, rate in endpoint.items()}
    return summary


def add_exact_budget_result(
    summary: dict,
    pairs: Sequence[ScoredItem],
    threshold: float,
    mix: Mapping[str, float],
    budget: float,
) -> None:
    """2차 점수를 쓰는 새 보고서의 결정점에만 반올림 전 부하와 예산 판정을 더한다."""
    exact = weighted_forward_rate(stage2_rates_by_category(pairs, threshold), mix)
    summary["weighted_forward_rate_exact"] = exact
    summary["within_budget"] = exact <= budget


def item_flags_at_threshold(
    pairs: Sequence[ScoredItem], threshold: float, stage2_policy: Stage2Policy = DEFAULT_STAGE2_POLICY
) -> dict[str, dict[str, bool | str]]:
    """dev 결정점의 문장별 경로 결과. pairs에서 빠진 ambiguous는 자연스럽게 제외된다."""
    flags: dict[str, dict[str, bool | str]] = {}
    for pair in pairs:
        decision = pair.endpoint_decision(threshold, stage2_policy)
        flags[pair.item.item_id] = {
            "routed": pair.is_routed(threshold),
            "goes_to_stage2": pair.goes_to_stage2(threshold),
            "endpoint": decision != "pass",
            "endpoint_decision": decision,
        }
    return flags


def candidate_thresholds(pairs: Sequence[ScoredItem]) -> list[float]:
    """고를 수 있는 임계값 후보(소수 여섯째 자리 격자): 점수마다 내림한 값과 그 바로 위 격자값, 그리고 최댓값 1.0.

    왜 둘 다인가: 내림한 값은 그 점수의 문장을 넣고, 바로 위 값은 빼는 가장 작은 임계값이다. 이 둘이면 격자 위의
    모든 전달 경우를 덮어, 예산을 지키는 가장 작은 격자값을 놓치지 않는다. 범위 (0, 1] 밖의 값은 뺀다.
    짧은 문장 규칙에 걸린 문장은 기준 임계값이 점수/배수일 때 넘어가므로, 점수 대신 점수/배수 둘레에 격자 후보를 만든다.
    배수를 곱할 때는 나눗셈의 이진 소수 오차와 허용 오차 때문에 넘어가는 경계가 격자 한 칸쯤 어긋날 수 있어,
    내림값 앞뒤 두 칸까지 넣는다. 후보는 모두 실제 전달률로 다시 확인하므로 남는 후보는 결과를 바꾸지 않는다.
    """
    step = 10**-THRESHOLD_DECIMALS
    values: set[float] = {MAX_THRESHOLD}
    for pair in pairs:
        floored = math.floor(pair.score / pair.threshold_multiplier / step)
        offsets = (0, 1) if pair.threshold_multiplier == 1.0 else (-1, 0, 1, 2)
        values |= {round((floored + offset) * step, THRESHOLD_DECIMALS) for offset in offsets}
    return sorted(value for value in values if 0 < value <= MAX_THRESHOLD)


def select_budget_threshold(pairs: Sequence[ScoredItem], mix: Mapping[str, float], budget: float) -> float | None:
    """2차 부하(가중 전달률)가 예산 이하가 되는 가장 작은 임계값. 돌려주는 값 그대로 계산해 확인한다. 없으면 None이다.

    왜 가장 작은 값인가: 임계값이 작을수록 재현율이 높다. 예산을 지키는 범위에서 재현율을 최대로 하는 값이다.
    None은 임계값 1.0에서도 예산을 넘는다는 뜻이다(점수가 1.0인 문장이나 키워드 경로가 많을 때).
    """
    for candidate in candidate_thresholds(pairs):
        if weighted_forward_rate(stage2_rates_by_category(pairs, candidate), mix) <= budget:
            return candidate
    return None


def compute_chat_auc(pairs: Sequence[ScoredItem]) -> float:
    """1차 점수만으로 유해(1)와 허용(0)을 가르는 AUC. 규칙 경로는 넣지 않는다(1차 분류기 자체의 순위 품질)."""
    scores = [pair.score for pair in pairs]
    labels = [int(pair.item.label == "harmful") for pair in pairs]
    ensure_valid_scores_and_labels(scores, labels)
    return round(compute_roc_auc(scores, labels), METRIC_DECIMALS)


def describe_counts(items: Sequence[ChatEvalItem], pairs: Sequence[ScoredItem]) -> dict:
    """채점 문장과 애매 문장 수."""
    return {"scored": len(pairs), "ambiguous": len(items) - len(pairs)}


def build_dev_report(
    items: Sequence[ChatEvalItem],
    scores: Sequence[float],
    mix: Mapping[str, float],
    budget: float | None,
    routes: Mapping[str, RuleRoute] | None = None,
    short_rule: ShortRule | None = None,
    stage2_scores: Mapping[str, Stage2Score] | None = None,
    fixed_threshold: float | None = None,
    stage2_policy: Stage2Policy = DEFAULT_STAGE2_POLICY,
) -> dict:
    """개발셋 결과: 임계값 표, 예산 임계값과 그 요약, 문장별 점수(id만), 짧은 문장 규칙. 원문은 넣지 않는다."""
    if (budget is None) == (fixed_threshold is None):
        raise DatasetFormatError("개발셋에는 --forward-budget 또는 --fixed-threshold 중 하나만 주세요.")
    if fixed_threshold is not None and not (math.isfinite(fixed_threshold) and 0 <= fixed_threshold <= 1):
        raise DatasetFormatError("--fixed-threshold는 유한한 0~1 값이어야 합니다.")
    pairs = scored_pairs(items, scores, routes, short_rule, stage2_scores)
    threshold: float | None
    if fixed_threshold is not None:
        threshold = fixed_threshold
    else:
        assert budget is not None
        threshold = select_budget_threshold(pairs, mix, budget)
    at_threshold = None if threshold is None else summarize_at_chat_threshold(pairs, threshold, mix, stage2_policy)
    if threshold is not None and at_threshold is not None and stage2_scores is not None and budget is not None:
        add_exact_budget_result(at_threshold, pairs, threshold, mix, budget)
    decision = {"mode": "fixed", "threshold": threshold, "at_threshold": at_threshold}
    if fixed_threshold is None:
        decision |= {"mode": "budget", "budget": budget}
    report = {
        "split": "dev",
        "counts": describe_counts(items, pairs),
        "auc": compute_chat_auc(pairs),
        "traffic_mix": dict(mix),
        "threshold_table": [summarize_at_chat_threshold(pairs, value, mix, stage2_policy) for value in CHAT_REPORT_THRESHOLDS],
        "decision": decision,
        "short_rule": None if short_rule is None else short_rule.to_dict(),
        "stage2_policy": stage2_policy.to_dict(),
        "scores": {item.item_id: round(score, METRIC_DECIMALS) for item, score in zip(items, scores, strict=True)},
    }
    if threshold is not None and stage2_scores is not None:
        report["item_flags"] = item_flags_at_threshold(pairs, threshold, stage2_policy)
    return report


def build_holdout_report(
    items: Sequence[ChatEvalItem],
    scores: Sequence[float],
    mix: Mapping[str, float],
    threshold: float,
    routes: Mapping[str, RuleRoute] | None = None,
    short_rule: ShortRule | None = None,
    stage2_scores: Mapping[str, Stage2Score] | None = None,
    budget: float | None = None,
    stage2_policy: Stage2Policy = DEFAULT_STAGE2_POLICY,
) -> dict:
    """보류셋 결과: 개발셋에서 고른 임계값 하나의 집계와 AUC만. 임계값 표·문장별 점수는 넣지 않는다(보류셋 튜닝 방지)."""
    pairs = scored_pairs(items, scores, routes, short_rule, stage2_scores)
    summary = summarize_at_chat_threshold(pairs, threshold, mix, stage2_policy)
    if stage2_scores is not None and budget is not None:
        add_exact_budget_result(summary, pairs, threshold, mix, budget)
    return {
        "split": "holdout",
        "counts": describe_counts(items, pairs),
        "auc": compute_chat_auc(pairs),
        "traffic_mix": dict(mix),
        "decision": {"mode": "fixed", "threshold": threshold, "at_threshold": summary},
        "short_rule": None if short_rule is None else short_rule.to_dict(),
        "stage2_policy": stage2_policy.to_dict(),
    }


def build_argument_parser() -> argparse.ArgumentParser:
    """CLI 인자. 개발셋에는 예산/고정 임계값, 보류셋에는 --dev-report를 준다."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage1.evaluate_chat", description="채팅 평가셋으로 1차 분류기 평가(기본 CPU)")
    parser.add_argument("--model-dir", type=Path, action="append", required=True, help="train이 만든 출력 디렉터리(앙상블은 순서대로 여러 번 지정)")
    parser.add_argument("--eval-file", type=Path, required=True, help="채팅 평가셋 JSONL(개발셋 또는 보류셋)")
    decision = parser.add_mutually_exclusive_group(required=True)
    decision.add_argument("--forward-budget", type=probability_argument, help="F_max(개발셋에서 임계값을 고를 때)")
    decision.add_argument("--fixed-threshold", type=closed_probability_argument, help="개발셋에서도 예산으로 고르지 않고 쓸 고정 1차 임계값")
    decision.add_argument("--dev-report", type=Path, help="같은 모델의 개발셋 결과 JSON(보류셋을 볼 때)")
    parser.add_argument("--mix-file", type=Path, help="트래픽 구성비 JSON(범주→비율, 합 1). 없으면 기본 가정")
    parser.add_argument("--rule-routes", type=Path, help="서버 규칙 평가 도구가 낸 문장별 규칙·키워드 결과 JSONL(없으면 1차만 평가)")
    parser.add_argument("--stage2-scores", type=Path, help="zg_stage2.score_eval_set이 만든 같은 평가셋의 id별 2차 점수 JSON")
    parser.add_argument("--stage2-policy", choices=STAGE2_POLICIES, default="fixed", help="2차 후보 기준 정책(기본 fixed)")
    parser.add_argument(
        "--relaxed-stage2-threshold", type=closed_probability_argument, default=DEFAULT_RELAXED_STAGE2_THRESHOLD, help="완화된 2차 후보 기준(기본 0.2)"
    )
    parser.add_argument(
        "--relaxed-stage2-categories",
        type=relaxed_stage2_categories_argument,
        default=DEFAULT_RELAXED_STAGE2_CATEGORIES,
        help="category 정책에서 완화할 S1~S7 CSV(기본 S3,S4,S5)",
    )
    parser.add_argument(
        "--short-rule", type=short_rule_argument, help="짧은 문장 임계값 N:k(공백 뺀 N자 이하 문장은 임계값의 k배, k>1). 보류셋은 개발셋과 같아야 한다"
    )
    parser.add_argument("--device", choices=modeling.DEVICE_CHOICES, default="cpu", help="점수 계산 장치(기본 cpu)")
    parser.add_argument("--batch-size", type=positive_integer, default=modeling.DEFAULT_INFERENCE_BATCH_SIZE, help="점수 계산 배치 크기")
    parser.add_argument("--output", type=Path, help="결과 JSON 경로(기본: <모델>/chat-eval-<셋>.json)")
    parser.add_argument("--raw-scores-dir", type=Path, help="보류셋 원시 1차 점수를 새 디렉터리에 저장(판정 스크립트 전용)")
    parser.add_argument("--overwrite", action="store_true", help="이미 있는 결과 파일을 덮어쓴다(개발셋만)")
    return parser


def compute_model_weights_sha256(model_directory: Path) -> str:
    """모델 가중치 파일의 sha256. 보류셋 평가가 개발셋에서 임계값을 고른 바로 그 모델인지 확인하는 데 쓴다."""
    return compute_file_sha256(model_directory / modeling.WEIGHTS_FILE_NAME)


def model_directories(arguments: argparse.Namespace) -> list[Path]:
    """argparse의 반복 목록과 기존 단위 테스트의 Path 값을 한 모양으로 정규화한다."""
    value = arguments.model_dir
    return [value] if isinstance(value, Path) else list(value)


def model_training_seed(model_directory: Path) -> int:
    """보고서 구성 검사에 쓸 학습 시드를 모델 카드에서 읽는다."""
    card = read_model_card(model_directory)
    hyperparameters = card.get("hyperparameters") if isinstance(card, dict) else None
    seed = hyperparameters.get("seed") if isinstance(hyperparameters, dict) else None
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise DatasetFormatError(f"{model_directory.name}의 model-card.json에 정수 hyperparameters.seed가 없습니다. 학습 출처를 확인하세요.")
    return seed


def model_training_data_sha256(model_directory: Path) -> str:
    """보고서 구성 검사에 쓸 실제 학습 파일 sha256을 모델 카드에서 읽는다."""
    card = read_model_card(model_directory)
    training_data = card.get("training_data") if isinstance(card, dict) else None
    train = training_data.get("train") if isinstance(training_data, dict) else None
    sha256 = train.get("sha256") if isinstance(train, dict) else None
    if not isinstance(sha256, str) or not sha256:
        raise DatasetFormatError(f"{model_directory.name}의 model-card.json에 training_data.train.sha256 학습 데이터 지문이 없습니다. 학습 출처를 확인하세요.")
    return sha256


def require_valid_threshold(value: object, file_name: str) -> float:
    """개발셋 결과의 임계값이 (0, 1] 범위의 유한한 수인지 확인한다. NaN이면 모든 비교가 거짓이 돼 '하나도 안 넘김'으로 보이기 때문이다."""
    if isinstance(value, bool) or not isinstance(value, int | float) or not (math.isfinite(value) and 0 < value <= MAX_THRESHOLD):
        raise DatasetFormatError(f"{file_name}의 임계값({value!r})이 (0, 1] 범위의 수가 아닙니다. 예산을 지키는 임계값이 없었거나 파일이 손상됐습니다.")
    return float(value)


def require_valid_fixed_threshold(value: object, file_name: str) -> float:
    """고정 임계값은 0도 허용하되 불리언·NaN·범위 밖 값은 거부한다."""
    if isinstance(value, bool) or not isinstance(value, int | float) or not (math.isfinite(value) and 0 <= value <= MAX_THRESHOLD):
        raise DatasetFormatError(f"{file_name}의 고정 임계값({value!r})이 유한한 0~1 값이 아닙니다. 개발셋 결과를 다시 만드세요.")
    return float(value)


def short_rule_argument(value: str) -> ShortRule:
    """--short-rule 값 N:k를 읽는다. N은 1 이상 정수, k는 1보다 큰 유한한 수다."""
    length_text, _, multiplier_text = value.partition(":")
    try:
        max_length, multiplier = int(length_text), float(multiplier_text)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"짧은 문장 규칙은 N:k 모양이어야 합니다(받은 값: {value!r}). 예: 6:3") from error
    if max_length < 1 or not (math.isfinite(multiplier) and multiplier > 1):
        raise argparse.ArgumentTypeError(f"짧은 문장 규칙의 N은 1 이상, k는 1보다 커야 합니다(받은 값: {value!r}).")
    return ShortRule(max_length, multiplier)


def closed_probability_argument(value: str) -> float:
    """고정·완화 기준은 0도 의미가 있으므로 유한한 [0, 1] 값만 받는다."""
    try:
        probability = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"{value!r}는 확률이 아닙니다.") from error
    if not (math.isfinite(probability) and 0 <= probability <= 1):
        raise argparse.ArgumentTypeError(f"{value!r}는 유한한 0~1 값이어야 합니다.")
    return probability


def relaxed_stage2_categories_argument(value: str) -> frozenset[str]:
    """쉼표 목록을 검증한다. 빈 값·중복은 설정 오타라 조용히 고치지 않는다."""
    categories = value.split(",")
    if any(not category for category in categories) or len(categories) != len(set(categories)):
        raise argparse.ArgumentTypeError("--relaxed-stage2-categories는 겹치지 않는 S1~S7 CSV여야 합니다.")
    unknown = sorted(set(categories) - STAGE2_CATEGORIES)
    if unknown:
        raise argparse.ArgumentTypeError(f"모르는 2차 범주가 있습니다: {', '.join(unknown)}. S1~S7만 쓰세요.")
    return frozenset(categories)


def require_same_short_rule(report: Mapping, short_rule: ShortRule | None, file_name: str) -> None:
    """보류셋은 개발셋과 같은 짧은 문장 규칙을 써야 한다. 규칙이 다르면 고른 임계값이 다른 부하를 뜻하기 때문이다."""
    expected = None if short_rule is None else short_rule.to_dict()
    if report.get("short_rule") != expected:
        raise DatasetFormatError(f"{file_name}과 짧은 문장 규칙이 다릅니다(개발셋 {report.get('short_rule')}, 지금 {expected}). 같은 --short-rule을 주세요.")


def require_same_traffic_mix(report: Mapping, traffic_mix: Mapping[str, float] | None, file_name: str) -> None:
    """보류셋은 개발셋과 같은 트래픽 구성비를 써야 한다. 구성비가 다르면 고른 임계값이 다른 부하 예산을 뜻하기 때문이다.

    traffic_mix가 None이면(옛 호출) 검사하지 않는다. 개발셋 결과에 구성비가 없으면(옛 결과) 오류다.
    """
    if traffic_mix is None:
        return
    if report.get("traffic_mix") != dict(traffic_mix):
        raise DatasetFormatError(f"{file_name}과 트래픽 구성비가 다릅니다. 개발셋을 평가할 때 쓴 --mix-file을 그대로 주세요.")


def require_same_stage2_policy(report: Mapping, stage2_policy: Stage2Policy | None, file_name: str) -> None:
    """보류셋은 개발셋에서 고정한 2차 후보 정책을 그대로 써야 한다."""
    if stage2_policy is None:
        return
    if report.get("stage2_policy") != stage2_policy.to_dict():
        raise DatasetFormatError(f"{file_name}과 2차 후보 기준 정책이 다릅니다. 개발셋의 --stage2-policy와 완화 기준·범주를 그대로 주세요.")


def read_dev_threshold(
    dev_report_path: Path,
    model_weights_sha256: str | Sequence[str],
    policy_sha256: str | None,
    short_rule: ShortRule | None = None,
    traffic_mix: Mapping[str, float] | None = None,
    stage2_model_identifier: str | None = None,
    stage2_policy: Stage2Policy | None = None,
) -> float:
    """개발셋 결과에서 임계값을 읽는다. 개발셋 결과가 아니거나, 다른 모델의 결과거나, 임계값이 잘못됐으면 오류다.

    policy_sha256: 이번 보류셋 평가에 쓴 규칙 목록 지문(규칙 경로를 쓰지 않으면 None). 개발셋과 다르면 오류다.
    1차만으로 고른 임계값을 규칙과 합친 경로에 쓰거나, 다른 키워드 목록으로 만든 규칙 결과와 섞으면 2차 부하가 예산과 맞지 않기 때문이다.
    """
    report = json.loads(dev_report_path.read_text(encoding="utf-8"))
    if report.get("split") != "dev" or report.get("decision", {}).get("mode") not in {"budget", "fixed"}:
        raise DatasetFormatError(f"{dev_report_path.name}은 개발셋 예산 결과가 아닙니다. --forward-budget으로 만든 개발셋 결과를 주세요.")
    if report.get("model_weights_sha256") != model_weights_sha256:
        raise DatasetFormatError(f"{dev_report_path.name}은 다른 모델의 결과입니다. 같은 --model-dir로 개발셋을 먼저 평가하세요.")
    dev_routes = report.get("rule_routes")
    if dev_routes is not None and not dev_routes.get("policy_sha256"):
        raise DatasetFormatError(f"{dev_report_path.name}은 규칙 목록 지문이 없는 옛 결과입니다. 지금 도구로 개발셋을 다시 평가하세요.")
    dev_policy = None if dev_routes is None else dev_routes["policy_sha256"]
    if dev_policy != policy_sha256:
        message = f"{dev_report_path.name}과 규칙 경로(사용 여부나 규칙 목록)가 다릅니다. 개발셋과 같은 규칙 목록으로 만든 --rule-routes를 주세요."
        raise DatasetFormatError(message)
    require_same_short_rule(report, short_rule, dev_report_path.name)
    require_same_traffic_mix(report, traffic_mix, dev_report_path.name)
    require_same_stage2_policy(report, stage2_policy, dev_report_path.name)
    if stage2_model_identifier is not None:
        stage2 = report.get("stage2_scores")
        if not isinstance(stage2, dict) or stage2.get("model_identifier") != stage2_model_identifier:
            raise DatasetFormatError(f"{dev_report_path.name}과 2차 모델 식별자가 다릅니다. 개발셋과 같은 --stage2-scores 모델을 쓰세요.")
    decision = report["decision"]
    if decision.get("mode") == "fixed":
        return require_valid_fixed_threshold(decision.get("threshold"), dev_report_path.name)
    return require_valid_threshold(decision.get("threshold"), dev_report_path.name)


def read_dev_budget(dev_report_path: Path) -> float | None:
    """보류셋 정확 예산 판정에 쓸 dev 보고서의 예산을 읽는다."""
    report = json.loads(dev_report_path.read_text(encoding="utf-8"))
    decision = report.get("decision")
    if isinstance(decision, dict) and decision.get("mode") == "fixed":
        return None
    value = decision.get("budget") if isinstance(decision, dict) else None
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(float(value)) or not 0 <= float(value) <= 1:
        raise DatasetFormatError(f"{dev_report_path.name}의 가중 전달 예산이 유한한 0~1 값이 아닙니다. 개발셋을 다시 평가하세요.")
    return float(value)


class RouteRecord(NamedTuple):
    """규칙 경로 결과 한 줄: id, 경로, 만든 평가셋 sha256, 규칙 목록 지문."""

    item_id: str
    route: RuleRoute
    eval_sha256: str
    policy_sha256: str


def parse_rule_route(line: str, location: str) -> RouteRecord:
    """규칙 경로 결과 한 줄을 읽는다. 판정 값이나 해시 필드가 이상하면 오류다."""
    record = json.loads(line)
    fields = record if isinstance(record, dict) else {}
    hashes = [fields.get("evalSha256"), fields.get("policySha256")]
    has_hashes = all(isinstance(value, str) and value for value in hashes)
    has_flags = isinstance(fields.get("skipAi"), bool)
    if fields.get("decision") not in RULE_DECISIONS or not isinstance(fields.get("id"), str) or not has_hashes or not has_flags:
        raise DatasetFormatError(f"{location}: 규칙 경로 결과 형식이 아닙니다(id, decision, skipAi, evalSha256, policySha256). 규칙 평가 도구를 다시 돌리세요.")
    route = RuleRoute(rule_flagged=fields["decision"] != "pass", keyword=fields.get("keyword") is not None, skip_ai=fields["skipAi"])
    return RouteRecord(fields["id"], route, fields["evalSha256"], fields["policySha256"])


def ensure_routes_match_eval_file(records: Sequence[RouteRecord], eval_path: Path, file_name: str) -> str:
    """모든 줄이 이 평가셋 파일(sha256)과 한 규칙 목록으로 만든 결과인지 확인하고, 규칙 목록 지문을 돌려준다.

    왜: 평가셋 문장을 고친 뒤 옛 규칙 결과를 쓰거나, 다른 목록으로 만든 결과를 섞으면 숫자가 조용히 틀린다.
    """
    eval_hashes = {record.eval_sha256 for record in records}
    policies = {record.policy_sha256 for record in records}
    if eval_hashes != {compute_file_sha256(eval_path)} or len(policies) != 1:
        raise DatasetFormatError(f"{file_name}이 이 평가셋 파일과 한 규칙 목록으로 만든 결과가 아닙니다. 지금 평가셋으로 규칙 평가 도구를 다시 돌리세요.")
    return policies.pop()


def load_rule_routes(path: Path, items: Sequence[ChatEvalItem], eval_path: Path) -> tuple[dict[str, RuleRoute], str]:
    """규칙 경로 결과를 읽고, 평가셋 id·파일 해시와 맞는지 확인한다. (id별 경로, 규칙 목록 지문)을 돌려준다."""
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    records = [parse_rule_route(line, f"{path.name}:{number}") for number, line in enumerate(lines, 1)]
    routes = {record.item_id: record.route for record in records}
    if len(routes) != len(records) or set(routes) != {item.item_id for item in items}:
        raise DatasetFormatError(f"{path.name}의 id가 평가셋과 다릅니다. 같은 평가셋 파일로 규칙 평가 도구를 다시 돌리세요.")
    return routes, ensure_routes_match_eval_file(records, eval_path, path.name)


def load_stage2_scores(path: Path, items: Sequence[ChatEvalItem], eval_path: Path | None = None) -> tuple[dict[str, Stage2Score], dict[str, str]]:
    """2차 점수 파일의 기준·모델·확률·범주와 평가셋 id 집합을 검증한다."""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise DatasetFormatError(f"{path.name}: 2차 점수 JSON을 읽을 수 없습니다({error.msg}). score_eval_set을 다시 실행하세요.") from error
    if not isinstance(document, dict) or document.get("candidate_threshold") != STAGE2_CANDIDATE_THRESHOLD:
        raise DatasetFormatError(f"{path.name}: 2차 후보 임계값이 0.5인 score_eval_set 결과가 아닙니다. 도구를 다시 실행하세요.")
    model = document.get("model")
    identifier = model.get("identifier") if isinstance(model, dict) else None
    if not isinstance(identifier, str) or not identifier:
        raise DatasetFormatError(f"{path.name}: 2차 모델 식별자가 없습니다. score_eval_set 결과를 다시 만드세요.")
    raw_scores = document.get("scores")
    if not isinstance(raw_scores, dict) or set(raw_scores) != {item.item_id for item in items}:
        raise DatasetFormatError(f"{path.name}의 id가 평가셋과 다릅니다. 같은 평가셋으로 score_eval_set을 다시 실행하세요.")
    if eval_path is not None:
        provenance = document.get("eval_file")
        expected_hash = compute_file_sha256(eval_path)
        if not isinstance(provenance, dict) or provenance.get("sha256") != expected_hash:
            raise DatasetFormatError(f"{path.name}은 이 평가셋 파일의 점수가 아닙니다. 같은 --eval-file로 score_eval_set을 다시 실행하세요.")
    scores: dict[str, Stage2Score] = {}
    for identifier_key, value in raw_scores.items():
        probability = value.get("unsafe_probability") if isinstance(value, dict) else None
        category = value.get("category") if isinstance(value, dict) else None
        if not isinstance(probability, int | float) or isinstance(probability, bool):
            raise DatasetFormatError(f"{path.name}: id {identifier_key!r}의 2차 확률이 유한한 0~1 값이 아닙니다. score_eval_set을 다시 실행하세요.")
        numeric_probability = float(probability)
        if not math.isfinite(numeric_probability) or not 0 <= numeric_probability <= 1:
            raise DatasetFormatError(f"{path.name}: id {identifier_key!r}의 2차 확률이 유한한 0~1 값이 아닙니다. score_eval_set을 다시 실행하세요.")
        if category not in STAGE2_CATEGORIES:
            raise DatasetFormatError(f"{path.name}: id {identifier_key!r}의 2차 범주가 S1~S7이 아닙니다. score_eval_set을 다시 실행하세요.")
        scores[str(identifier_key)] = Stage2Score(numeric_probability, category)
    metadata = {"name": path.name, "sha256": compute_file_sha256(path), "model_identifier": identifier}
    return scores, metadata


def require_matching_decision(arguments: argparse.Namespace, split: str) -> None:
    """개발셋에는 예산/고정값 하나, 보류셋에는 개발셋 결과만 요구한다."""
    budget = getattr(arguments, "forward_budget", None)
    fixed = getattr(arguments, "fixed_threshold", None)
    dev_report = getattr(arguments, "dev_report", None)
    if budget is not None and fixed is not None:
        raise DatasetFormatError("--forward-budget과 --fixed-threshold는 함께 쓸 수 없습니다. 하나만 고르세요.")
    if split == "holdout" and dev_report is None:
        raise DatasetFormatError("보류셋으로 임계값을 고르지 않습니다. 같은 모델의 개발셋 결과를 --dev-report로 주세요.")
    if split == "holdout" and (budget is not None or fixed is not None):
        raise DatasetFormatError("보류셋에는 --forward-budget이나 --fixed-threshold 대신 개발셋의 --dev-report를 주세요.")
    if split == "dev" and (budget is None) == (fixed is None):
        raise DatasetFormatError("개발셋에는 --forward-budget(F_max) 또는 --fixed-threshold 중 하나만 주세요.")
    if split == "dev" and dev_report is not None:
        raise DatasetFormatError("개발셋에는 --dev-report를 쓰지 않습니다. 예산이나 고정 임계값을 주세요.")


def load_traffic_mix(path: Path | None) -> dict[str, float]:
    """구성비를 읽는다. 경로가 없으면 기본 가정을 쓴다. 어느 쪽이든 검증한다."""
    mix = DEFAULT_TRAFFIC_MIX if path is None else json.loads(path.read_text(encoding="utf-8"))
    validate_traffic_mix(mix)
    return dict(mix)


def stage2_policy_from_arguments(arguments: argparse.Namespace) -> Stage2Policy:
    """CLI 기본값과 직접 만든 테스트 Namespace를 한 정책 값으로 모은다."""
    return Stage2Policy(
        getattr(arguments, "stage2_policy", "fixed"),
        STAGE2_CANDIDATE_THRESHOLD,
        getattr(arguments, "relaxed_stage2_threshold", DEFAULT_RELAXED_STAGE2_THRESHOLD),
        getattr(arguments, "relaxed_stage2_categories", DEFAULT_RELAXED_STAGE2_CATEGORIES),
    )


def resolve_output_path(arguments: argparse.Namespace, split: str) -> Path:
    """결과 파일 경로. 이미 있으면 덮어쓰지 않는다. 보류셋은 모델 디렉터리의 정해진 이름에만 쓰고, --overwrite로도 덮어쓰지 않는다.

    왜: 보류셋은 모델마다 한 번만 본다. 다른 경로로 몇 번이고 다시 돌릴 수 있으면 그 결과를 보고 설정을 바꾸게 된다.
    """
    directories = model_directories(arguments)
    is_ensemble = len(directories) > 1
    if split == "holdout" and is_ensemble and arguments.output is None:
        raise DatasetFormatError("앙상블 보류셋 결과는 모델 하나의 디렉터리에 둘 수 없습니다. 새 --output 경로를 주세요.")
    if split == "holdout" and not is_ensemble and arguments.output is not None:
        raise DatasetFormatError("단일 모델 보류셋 결과는 모델 디렉터리의 chat-eval-holdout.json에만 씁니다. --output을 빼세요.")
    output = arguments.output or directories[0] / f"chat-eval-{split}.json"
    if output.exists() and (split == "holdout" or not arguments.overwrite):
        raise OutputExistsError(f"{output.name}이 이미 있습니다. 개발셋 결과는 --overwrite로 바꿀 수 있고, 보류셋 결과는 바꾸지 않습니다.")
    return output


def score_model_items(arguments: argparse.Namespace, model_directory: Path, items: Sequence[ChatEvalItem]) -> list[float]:
    """학습된 모델 하나로 문장의 유해 확률을 계산한다."""
    model_card = read_model_card(model_directory)
    require_completed_training(model_card, model_directory.name)
    device = modeling.resolve_device(arguments.device)
    max_length = resolve_max_length(model_directory, model_card)
    tokenizer = modeling.load_trained_tokenizer(model_directory)
    model = modeling.move_model_to_device(modeling.load_trained_classifier(model_directory), device).eval()
    return modeling.score_texts(model, tokenizer, [item.text for item in items], device, max_length, arguments.batch_size)


def average_model_scores(scores_by_model: Sequence[Sequence[float]]) -> list[float]:
    """모델별 점수의 문장별 산술 평균. 한 모델이어도 값을 바꾸지 않는다."""
    if not scores_by_model:
        raise MetricError("앙상블에 모델 점수가 없습니다. --model-dir를 하나 이상 주세요.")
    expected = len(scores_by_model[0])
    if any(len(scores) != expected for scores in scores_by_model):
        raise MetricError("앙상블 모델별 점수 개수가 다릅니다. 모두 같은 평가셋을 채점했는지 확인하세요.")
    for scores in scores_by_model:
        ensure_valid_scores_and_labels(scores, [0] * len(scores))
    return [sum(scores[index] for scores in scores_by_model) / len(scores_by_model) for index in range(expected)]


def score_items(arguments: argparse.Namespace, items: Sequence[ChatEvalItem]) -> list[float]:
    """모든 --model-dir를 채점하고 둘 이상이면 문장별 평균을 낸다.

    채점 전에 모든 모델의 학습 완료를 먼저 확인한다. 앙상블의 마지막 모델에서 멈추면 앞 모델의 채점 시간을 버리기 때문이다.
    """
    directories = model_directories(arguments)
    for directory in directories:
        require_completed_training(read_model_card(directory), directory.name)
    components = [score_model_items(arguments, directory, items) for directory in directories]
    arguments.raw_score_components = components
    return average_model_scores(components)


def write_raw_score_artifacts(
    directory: Path,
    eval_file: Path,
    items: Sequence[ChatEvalItem],
    model_dirs: Sequence[Path],
    model_hashes: Sequence[str],
    model_seeds: Sequence[int],
    components: Sequence[Sequence[float]],
) -> None:
    """보류셋 판정 후 공개할 단일/앙상블 원시 점수를 원문 없이 묶어 쓴다."""
    if directory.exists():
        raise OutputExistsError(f"{directory.name}이 이미 있습니다. 원시 점수를 덮어쓰지 않도록 새 --raw-scores-dir을 주세요.")
    directory.mkdir(mode=0o700, parents=True)
    evaluation = describe_file_provenance(eval_file)
    for index, (model_dir, weight, seed, scores) in enumerate(zip(model_dirs, model_hashes, model_seeds, components, strict=True), start=1):
        write_json_atomically(
            directory / f"component-{index}.json",
            {
                "kind": "component",
                "model_dir": model_dir.name,
                "model_seed": seed,
                "model_weights_sha256": weight,
                "eval_file": evaluation,
                "scores": {item.item_id: score for item, score in zip(items, scores, strict=True)},
            },
        )
    if len(components) > 1:
        averaged = average_model_scores(components)
        write_json_atomically(
            directory / "average.json",
            {
                "kind": "average",
                "model_dirs": [path.name for path in model_dirs],
                "model_seeds": list(model_seeds),
                "model_weights_sha256": list(model_hashes),
                "eval_file": evaluation,
                "scores": {item.item_id: score for item, score in zip(items, averaged, strict=True)},
            },
        )


def format_summary_row(row: dict) -> str:
    """요약 표 한 줄."""
    cells = [row["threshold"], row["weighted_forward_rate"], row["critical_recall_min"], row["critical_recall_mean"], row["allow_forward_max"]]
    return "| " + " | ".join(str(cell) for cell in cells) + " |"


def format_chat_report_markdown(report: dict) -> str:
    """결과 요약 표(원문 없음). 보류셋은 고정 임계값 한 줄만 보여 준다."""
    counts = report["counts"]
    lines = [f"### 채팅 평가({report['split']}, {counts['scored']}문장, 애매 {counts['ambiguous']}): AUC {report['auc']:.4f}", ""]
    lines += ["| 임계값 | 가중 전달률 | 핵심 재현율 최소 | 핵심 재현율 평균 | 허용 전달 최대 |", "|---|---|---|---|---|"]
    at_threshold = report["decision"]["at_threshold"]
    lines += [format_summary_row(row) for row in report.get("threshold_table", []) + ([at_threshold] if at_threshold else [])]
    decision = {key: value for key, value in report["decision"].items() if key != "at_threshold"}
    lines += ["", f"결정: {json.dumps(decision, ensure_ascii=False)}", ""]
    if at_threshold is None:
        return "\n".join(lines + ["예산을 지키는 임계값이 없습니다. 1차 분류기만으로는 이 예산을 지킬 수 없습니다."])
    lines.append("범주별 전달률: " + ", ".join(f"{category} {rate}" for category, rate in at_threshold["by_category"].items()))
    return "\n".join(lines)


def build_report_for_split(arguments: argparse.Namespace, items: Sequence[ChatEvalItem], mix: Mapping[str, float], model_sha: str | Sequence[str]) -> dict:
    """셋에 맞는 보고서를 만든다. 보류셋은 채점 전에 개발셋 결과를 확인한다(다른 모델이면 채점하지 않는다)."""
    routes, policy = (None, None) if arguments.rule_routes is None else load_rule_routes(arguments.rule_routes, items, arguments.eval_file)
    route_provenance = None if arguments.rule_routes is None else describe_file_provenance(arguments.rule_routes) | {"policy_sha256": policy}
    provenance = {"rule_routes": route_provenance}
    stage2_path = getattr(arguments, "stage2_scores", None)
    stage2_scores, stage2_provenance = (None, None) if stage2_path is None else load_stage2_scores(stage2_path, items, arguments.eval_file)
    if stage2_provenance is not None:
        provenance["stage2_scores"] = stage2_provenance
    stage2_policy = stage2_policy_from_arguments(arguments)
    if items[0].split == "holdout":
        stage2_identifier = None if stage2_provenance is None else stage2_provenance["model_identifier"]
        threshold = read_dev_threshold(arguments.dev_report, model_sha, policy, arguments.short_rule, mix, stage2_identifier, stage2_policy)
        budget = read_dev_budget(arguments.dev_report) if stage2_scores is not None else None
        report = build_holdout_report(items, score_items(arguments, items), mix, threshold, routes, arguments.short_rule, stage2_scores, budget, stage2_policy)
        return report | provenance | {"dev_report": describe_file_provenance(arguments.dev_report)}
    return (
        build_dev_report(
            items,
            score_items(arguments, items),
            mix,
            arguments.forward_budget,
            routes,
            arguments.short_rule,
            stage2_scores,
            arguments.fixed_threshold,
            stage2_policy,
        )
        | provenance
    )


def main(argv: Sequence[str] | None = None) -> None:
    """평가셋 검증 → 결정 방식 확인 → 채점 → 보고서 저장·출력."""
    arguments = build_argument_parser().parse_args(argv)
    items = load_validated_eval_set(arguments.eval_file)
    require_matching_decision(arguments, items[0].split)
    if arguments.stage2_policy != "fixed" and arguments.stage2_scores is None:
        raise DatasetFormatError("완화된 --stage2-policy를 평가하려면 문장별 --stage2-scores를 함께 주세요.")
    if arguments.raw_scores_dir is not None and items[0].split != "holdout":
        raise DatasetFormatError("--raw-scores-dir은 봉인 보류셋 판정 스크립에서만 쓸 수 있습니다.")
    if arguments.raw_scores_dir is not None and arguments.raw_scores_dir.exists():
        raise OutputExistsError(f"{arguments.raw_scores_dir.name}이 이미 있습니다. 새 --raw-scores-dir을 주세요.")
    mix = load_traffic_mix(arguments.mix_file)
    output = resolve_output_path(arguments, items[0].split)
    directories = model_directories(arguments)
    model_hashes = [compute_model_weights_sha256(directory) for directory in directories]
    include_model_seeds = arguments.stage2_scores is not None or arguments.raw_scores_dir is not None
    model_seeds = [model_training_seed(directory) for directory in directories] if include_model_seeds else []
    model_training_hashes = [model_training_data_sha256(directory) for directory in directories] if include_model_seeds else []
    model_sha: str | list[str] = model_hashes[0] if len(model_hashes) == 1 else model_hashes
    report = build_report_for_split(arguments, items, mix, model_sha)
    if len(directories) == 1:
        report |= {
            "created_at": utc_timestamp(),
            "model_dir": directories[0].name,
            "model_weights_sha256": model_sha,
        }
        if include_model_seeds:
            report["model_seed"] = model_seeds[0]
            report["model_training_data_sha256"] = model_training_hashes[0]
    else:
        report |= {
            "created_at": utc_timestamp(),
            "model_dirs": [directory.name for directory in directories],
            "model_weights_sha256": model_sha,
        }
        if include_model_seeds:
            report["model_seeds"] = model_seeds
            report["model_training_data_sha256s"] = model_training_hashes
    report |= {"eval_file": describe_file_provenance(arguments.eval_file)}
    write_json_atomically(output, report)
    if arguments.raw_scores_dir is not None:
        write_raw_score_artifacts(
            arguments.raw_scores_dir,
            arguments.eval_file,
            items,
            directories,
            model_hashes,
            model_seeds,
            arguments.raw_score_components,
        )
    print(format_chat_report_markdown(report))
    print(f"\n저장: {output.name}")


if __name__ == "__main__":
    run_command_line(main)
