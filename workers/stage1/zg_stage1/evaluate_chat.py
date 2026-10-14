"""채팅 형식 평가셋으로 1차 분류기를 '2차 처리 용량 안의 거름망'으로 평가한다.

무엇을 보나(docs/ml/2026-10-14-model-strengthening-plan.md M1):
- 범주별 전달률: 유해 범주에서는 재현율(2차로 넘긴 비율), 허용 유형에서는 잘못 넘긴 비율이다.
- 가중 전달률: 가정한 실제 트래픽 구성(DEFAULT_TRAFFIC_MIX)으로 범주별 전달률을 가중 평균한 값이다. 평가셋은 유해가
  절반쯤이라 그대로 평균하면 실제 2차 부하를 크게 부풀린다. 그래서 구성비로 다시 가중한다.
- 예산 임계값(개발셋에서만): 가중 전달률이 F_max(zg_stage1.capacity) 이하가 되는 가장 작은 임계값.
  보류셋에는 개발셋에서 고른 값을 --threshold로 그대로 넣어 한 번만 본다. 보류셋으로 임계값을 고르면 오류를 낸다.
원문은 출력·결과 파일에 넣지 않는다. 문장은 id로만 가리킨다.

CLI 사용 예:
  uv run python -m zg_stage1.evaluate_chat --model-dir <모델> --eval-file eval_data/chat-dev-v1.jsonl --forward-budget 0.30
  uv run python -m zg_stage1.evaluate_chat --model-dir <모델> --eval-file eval_data/chat-holdout-v1.jsonl --threshold 0.42
"""

from __future__ import annotations

import argparse
import json
import math
from collections.abc import Mapping, Sequence
from pathlib import Path

from zg_stage1 import modeling
from zg_stage1.arguments import positive_integer, probability_argument
from zg_stage1.chat_eval_data import ALLOW_CATEGORIES, CRITICAL_CATEGORIES, HARMFUL_CATEGORIES, ChatEvalItem, load_chat_eval_set
from zg_stage1.data import describe_file_provenance
from zg_stage1.errors import DatasetFormatError, MetricError, OutputExistsError, run_command_line
from zg_stage1.evaluate import resolve_max_length
from zg_stage1.metrics import METRIC_DECIMALS, compute_roc_auc, ensure_valid_scores_and_labels
from zg_stage1.model_card import read_model_card, utc_timestamp, write_json_atomically

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

# 고른 임계값의 소수 자릿수. 올림해서, 보고한 값을 그대로 써도 예산을 넘지 않게 한다.
THRESHOLD_DECIMALS = 6

# 구성비 합이 1에서 이만큼 넘게 벗어나면 잘못 쓴 파일로 본다.
MIX_SUM_TOLERANCE = 1e-6


def validate_traffic_mix(mix: Mapping[str, float]) -> None:
    """구성비가 알려진 범주만 담고, 모두 0 이상이고, 합이 1인지 확인한다."""
    unknown = sorted(set(mix) - set(HARMFUL_CATEGORIES) - set(ALLOW_CATEGORIES))
    if unknown:
        raise DatasetFormatError(f"구성비에 모르는 범주가 있습니다: {', '.join(unknown)}. docs/ml/chat-eval-policy.md의 범주 이름을 쓰세요.")
    if any(not (math.isfinite(weight) and weight >= 0) for weight in mix.values()):
        raise DatasetFormatError("구성비는 0 이상의 유한한 값이어야 합니다.")
    if abs(sum(mix.values()) - 1.0) > MIX_SUM_TOLERANCE:
        raise DatasetFormatError(f"구성비의 합이 {sum(mix.values()):.6f}입니다. 합이 1이 되게 고치세요.")


def scored_pairs(items: Sequence[ChatEvalItem], scores: Sequence[float]) -> list[tuple[ChatEvalItem, float]]:
    """지표에 들어가는(ambiguous가 아닌) 문장과 점수의 짝."""
    if len(items) != len(scores):
        raise MetricError(f"문장 {len(items)}개와 점수 {len(scores)}개의 개수가 다릅니다.")
    return [(item, score) for item, score in zip(items, scores, strict=True) if item.is_scored]


def forward_rates_by_category(pairs: Sequence[tuple[ChatEvalItem, float]], threshold: float) -> dict[str, float]:
    """범주별로 점수가 임계값 이상(2차로 넘김)인 비율."""
    totals: dict[str, int] = {}
    forwarded: dict[str, int] = {}
    for item, score in pairs:
        totals[item.category] = totals.get(item.category, 0) + 1
        forwarded[item.category] = forwarded.get(item.category, 0) + (score >= threshold)
    return {category: forwarded[category] / totals[category] for category in sorted(totals)}


def weighted_forward_rate(rates: Mapping[str, float], mix: Mapping[str, float]) -> float:
    """구성비로 가중한 전달률. 평가셋에 없는 범주는 빼고, 남은 범주의 구성비 합으로 다시 나눈다."""
    present_weight = sum(weight for category, weight in mix.items() if category in rates)
    if present_weight <= 0:
        raise MetricError("구성비가 있는 범주가 평가셋에 하나도 없습니다. 평가셋 범주 이름을 확인하세요.")
    return sum(weight * rates[category] for category, weight in mix.items() if category in rates) / present_weight


def missing_mix_categories(rates: Mapping[str, float], mix: Mapping[str, float]) -> list[str]:
    """구성비에는 있지만 평가셋에 없는 범주. 가중 전달률이 그만큼 덜 대표적이라는 경고에 쓴다."""
    return sorted(category for category, weight in mix.items() if weight > 0 and category not in rates)


def rates_for(rates: Mapping[str, float], categories: Sequence[str] | frozenset[str]) -> list[float]:
    """주어진 범주 중 평가셋에 있는 것의 전달률 목록."""
    return [rates[category] for category in sorted(categories) if category in rates]


def summarize_at_chat_threshold(pairs: Sequence[tuple[ChatEvalItem, float]], threshold: float, mix: Mapping[str, float]) -> dict:
    """한 임계값에서의 요약: 가중 전달률, 핵심 범주 재현율(최소·평균), 허용 유형 최대 전달률, 범주별 전달률."""
    rates = forward_rates_by_category(pairs, threshold)
    critical = rates_for(rates, CRITICAL_CATEGORIES)
    allow = rates_for(rates, ALLOW_CATEGORIES)
    return {
        "threshold": threshold,
        "weighted_forward_rate": round(weighted_forward_rate(rates, mix), METRIC_DECIMALS),
        "critical_recall_min": round(min(critical), METRIC_DECIMALS) if critical else None,
        "critical_recall_mean": round(sum(critical) / len(critical), METRIC_DECIMALS) if critical else None,
        "allow_forward_max": round(max(allow), METRIC_DECIMALS) if allow else None,
        "by_category": {category: round(rate, METRIC_DECIMALS) for category, rate in rates.items()},
    }


def select_budget_threshold(pairs: Sequence[tuple[ChatEvalItem, float]], mix: Mapping[str, float], budget: float) -> float | None:
    """가중 전달률이 예산 이하가 되는 가장 작은 임계값. 어떤 임계값으로도 안 되면 None이다.

    왜 가장 작은 값인가: 임계값이 작을수록 재현율이 높다. 예산을 지키는 범위에서 재현율을 최대로 하는 값이다.
    후보는 점수 자체다(점수 사이에서는 전달 여부가 바뀌지 않는다). 올림한 값을 돌려준다.
    """
    for candidate in sorted({score for _item, score in pairs}):
        if weighted_forward_rate(forward_rates_by_category(pairs, candidate), mix) <= budget:
            return math.ceil(candidate * 10**THRESHOLD_DECIMALS) / 10**THRESHOLD_DECIMALS
    return None


def compute_chat_auc(pairs: Sequence[tuple[ChatEvalItem, float]]) -> float:
    """유해(1)와 허용(0)을 가르는 AUC."""
    scores = [score for _item, score in pairs]
    labels = [int(item.label == "harmful") for item, _score in pairs]
    ensure_valid_scores_and_labels(scores, labels)
    return round(compute_roc_auc(scores, labels), METRIC_DECIMALS)


def build_chat_report(items: Sequence[ChatEvalItem], scores: Sequence[float], mix: Mapping[str, float], decision: dict) -> dict:
    """평가 결과(원문 없음). decision은 {'mode': 'budget'|'fixed', 'budget'?: F_max, 'threshold'?: 값}이다."""
    pairs = scored_pairs(items, scores)
    rates_at_half = forward_rates_by_category(pairs, 0.5)
    threshold = decision.get("threshold")
    if decision["mode"] == "budget":
        threshold = select_budget_threshold(pairs, mix, decision["budget"])
    return {
        "split": items[0].split,
        "counts": {"scored": len(pairs), "ambiguous": len(items) - len(pairs)},
        "auc": compute_chat_auc(pairs),
        "traffic_mix": dict(mix),
        "missing_mix_categories": missing_mix_categories(rates_at_half, mix),
        "threshold_table": [summarize_at_chat_threshold(pairs, value, mix) for value in CHAT_REPORT_THRESHOLDS],
        "decision": {**decision, "threshold": threshold, "at_threshold": None if threshold is None else summarize_at_chat_threshold(pairs, threshold, mix)},
        "scores": {item.item_id: round(score, METRIC_DECIMALS) for item, score in zip(items, scores, strict=True)},
    }


def build_argument_parser() -> argparse.ArgumentParser:
    """CLI 인자. --forward-budget(개발셋)과 --threshold(보류셋) 중 하나만 준다."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage1.evaluate_chat", description="채팅 평가셋으로 1차 분류기 평가(기본 CPU)")
    parser.add_argument("--model-dir", type=Path, required=True, help="train이 만든 출력 디렉터리")
    parser.add_argument("--eval-file", type=Path, required=True, help="채팅 평가셋 JSONL(개발셋 또는 보류셋)")
    decision = parser.add_mutually_exclusive_group(required=True)
    decision.add_argument("--forward-budget", type=probability_argument, help="F_max(개발셋에서 임계값을 고를 때)")
    decision.add_argument("--threshold", type=probability_argument, help="고정 임계값(보류셋을 볼 때. 개발셋에서 고른 값)")
    parser.add_argument("--mix-file", type=Path, help="트래픽 구성비 JSON(범주→비율, 합 1). 없으면 기본 가정")
    parser.add_argument("--device", choices=modeling.DEVICE_CHOICES, default="cpu", help="점수 계산 장치(기본 cpu)")
    parser.add_argument("--batch-size", type=positive_integer, default=modeling.DEFAULT_INFERENCE_BATCH_SIZE, help="점수 계산 배치 크기")
    parser.add_argument("--output", type=Path, help="결과 JSON 경로(기본: <모델>/chat-eval-<셋>.json)")
    parser.add_argument("--overwrite", action="store_true", help="이미 있는 결과 파일을 덮어쓴다")
    return parser


def resolve_decision(arguments: argparse.Namespace, split: str) -> dict:
    """임계값 결정 방식을 정한다. 보류셋으로 임계값을 고르려 하면 오류를 낸다(보류셋이 튜닝에 쓰이지 않게)."""
    if arguments.forward_budget is None:
        return {"mode": "fixed", "threshold": arguments.threshold}
    if split != "dev":
        raise DatasetFormatError("보류셋으로 임계값을 고르지 않습니다. 개발셋에서 고른 값을 --threshold로 주세요.")
    return {"mode": "budget", "budget": arguments.forward_budget}


def load_traffic_mix(path: Path | None) -> dict[str, float]:
    """구성비를 읽는다. 경로가 없으면 기본 가정을 쓴다. 어느 쪽이든 검증한다."""
    mix = DEFAULT_TRAFFIC_MIX if path is None else json.loads(path.read_text(encoding="utf-8"))
    validate_traffic_mix(mix)
    return dict(mix)


def resolve_output_path(arguments: argparse.Namespace, split: str) -> Path:
    """결과 파일 경로. 이미 있으면 --overwrite 없이는 덮어쓰지 않는다(앞선 결과를 지키기 위해서다)."""
    output = arguments.output or arguments.model_dir / f"chat-eval-{split}.json"
    if output.exists() and not arguments.overwrite:
        raise OutputExistsError(f"{output.name}이 이미 있습니다. 바꾸려면 --overwrite를 주세요.")
    return output


def score_items(arguments: argparse.Namespace, items: Sequence[ChatEvalItem]) -> list[float]:
    """학습된 모델로 문장의 유해 확률을 계산한다."""
    device = modeling.resolve_device(arguments.device)
    max_length = resolve_max_length(arguments.model_dir, read_model_card(arguments.model_dir))
    tokenizer = modeling.load_trained_tokenizer(arguments.model_dir)
    model = modeling.move_model_to_device(modeling.load_trained_classifier(arguments.model_dir), device).eval()
    return modeling.score_texts(model, tokenizer, [item.text for item in items], device, max_length, arguments.batch_size)


def format_chat_report_markdown(report: dict) -> str:
    """결과 요약 표(원문 없음)."""
    lines = [f"### 채팅 평가({report['split']}, {report['counts']['scored']}문장, 애매 {report['counts']['ambiguous']}): AUC {report['auc']:.4f}", ""]
    if report["missing_mix_categories"]:
        lines += [f"[경고] 평가셋에 없는 범주(가중에서 뺌): {', '.join(report['missing_mix_categories'])}", ""]
    lines += ["| 임계값 | 가중 전달률 | 핵심 재현율 최소 | 핵심 재현율 평균 | 허용 전달 최대 |", "|---|---|---|---|---|"]
    rows = report["threshold_table"] + ([report["decision"]["at_threshold"]] if report["decision"]["at_threshold"] else [])
    for row in rows:
        cells = [row["threshold"], row["weighted_forward_rate"], row["critical_recall_min"], row["critical_recall_mean"], row["allow_forward_max"]]
        lines.append("| " + " | ".join(str(cell) for cell in cells) + " |")
    at_threshold = report["decision"]["at_threshold"]
    lines += ["", f"결정: {json.dumps({key: value for key, value in report['decision'].items() if key != 'at_threshold'}, ensure_ascii=False)}"]
    if at_threshold:
        lines += ["", "범주별 전달률: " + ", ".join(f"{category} {rate}" for category, rate in at_threshold["by_category"].items())]
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> None:
    """평가셋 읽기 → 결정 방식 확인 → 채점 → 보고서 저장·출력."""
    arguments = build_argument_parser().parse_args(argv)
    items = load_chat_eval_set(arguments.eval_file)
    decision = resolve_decision(arguments, items[0].split)
    mix = load_traffic_mix(arguments.mix_file)
    output = resolve_output_path(arguments, items[0].split)
    report = build_chat_report(items, score_items(arguments, items), mix, decision)
    report |= {"created_at": utc_timestamp(), "model_dir": arguments.model_dir.name, "eval_file": describe_file_provenance(arguments.eval_file)}
    write_json_atomically(output, report)
    print(format_chat_report_markdown(report))
    print(f"\n저장: {output.name}")


if __name__ == "__main__":
    run_command_line(main)
