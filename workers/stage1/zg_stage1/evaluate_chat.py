"""채팅 형식 평가셋으로 1차 분류기를 '2차 처리 용량 안의 거름망'으로 평가한다.

무엇을 보나(docs/ml/2026-10-14-model-strengthening-plan.md M1):
- 범주별 전달률: 유해 범주에서는 재현율(2차로 넘긴 비율), 허용 유형에서는 잘못 넘긴 비율이다.
- 가중 전달률: 가정한 실제 트래픽 구성(DEFAULT_TRAFFIC_MIX)으로 범주별 전달률을 가중 평균한 값이다. 평가셋은 유해가
  절반쯤이라 그대로 평균하면 실제 2차 부하를 크게 부풀린다. 그래서 구성비로 다시 가중한다.
- 개발셋: F_max(zg_stage1.capacity) 예산을 지키는 가장 작은 임계값을 고르고, 임계값 표와 문장별 점수를 남긴다.
- 보류셋: 개발셋 결과 파일(--dev-report)의 임계값만 쓴다. 모델 가중치가 같은지 확인하고, 그 임계값 하나의 집계만 남긴다.
  임계값 표나 문장별 점수를 남기면 보류셋을 보고 임계값을 다시 고를 수 있기 때문이다.
원문은 출력·결과 파일에 넣지 않는다. 문장은 id로만 가리킨다.

CLI 사용 예:
  uv run python -m zg_stage1.evaluate_chat --model-dir <모델> --eval-file eval_data/chat-dev-v1.jsonl --forward-budget 0.304
  uv run python -m zg_stage1.evaluate_chat --model-dir <모델> --eval-file eval_data/chat-holdout-v1.jsonl --dev-report <모델>/chat-eval-dev.json
"""

from __future__ import annotations

import argparse
import json
import math
from collections.abc import Mapping, Sequence
from pathlib import Path

from zg_stage1 import modeling
from zg_stage1.arguments import positive_integer, probability_argument
from zg_stage1.chat_eval_data import ALLOW_CATEGORIES, CRITICAL_CATEGORIES, HARMFUL_CATEGORIES, ChatEvalItem, load_validated_eval_set
from zg_stage1.data import compute_file_sha256, describe_file_provenance
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

# 고르는 임계값의 소수 자릿수. 운영 설정에 그대로 옮겨 적을 수 있는 정밀도다.
THRESHOLD_DECIMALS = 6

# 임계값이 가질 수 있는 가장 큰 값(probability_argument와 같은 (0, 1] 범위). 점수가 정확히 1.0인 문장은 이 값에서도 넘어간다.
MAX_THRESHOLD = 1.0

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


def summarize_at_chat_threshold(pairs: Sequence[tuple[ChatEvalItem, float]], threshold: float, mix: Mapping[str, float]) -> dict:
    """한 임계값에서의 요약: 가중 전달률, 핵심 범주 재현율(최소·평균), 허용 유형 최대 전달률, 범주별 전달률."""
    rates = forward_rates_by_category(pairs, threshold)
    critical = rates_for(rates, CRITICAL_CATEGORIES)
    allow = rates_for(rates, ALLOW_CATEGORIES)
    return {
        "threshold": threshold,
        "weighted_forward_rate": round(weighted_forward_rate(rates, mix), METRIC_DECIMALS),
        "critical_recall_min": round(min(critical), METRIC_DECIMALS),
        "critical_recall_mean": round(sum(critical) / len(critical), METRIC_DECIMALS),
        "allow_forward_max": round(max(allow), METRIC_DECIMALS),
        "by_category": {category: round(rate, METRIC_DECIMALS) for category, rate in rates.items()},
    }


def candidate_thresholds(pairs: Sequence[tuple[ChatEvalItem, float]]) -> list[float]:
    """고를 수 있는 임계값 후보(소수 여섯째 자리 격자): 점수마다 내림한 값과 그 바로 위 격자값, 그리고 최댓값 1.0.

    왜 둘 다인가: 내림한 값은 그 점수의 문장을 넣고, 바로 위 값은 빼는 가장 작은 임계값이다. 이 둘이면 격자 위의
    모든 전달 경우를 덮어, 예산을 지키는 가장 작은 격자값을 놓치지 않는다. 범위 (0, 1] 밖의 값은 뺀다.
    """
    step = 10**-THRESHOLD_DECIMALS
    floored = {round(math.floor(score / step) * step, THRESHOLD_DECIMALS) for _item, score in pairs}
    above = {round(value + step, THRESHOLD_DECIMALS) for value in floored}
    return sorted(value for value in floored | above | {MAX_THRESHOLD} if 0 < value <= MAX_THRESHOLD)


def select_budget_threshold(pairs: Sequence[tuple[ChatEvalItem, float]], mix: Mapping[str, float], budget: float) -> float | None:
    """가중 전달률이 예산 이하가 되는 가장 작은 임계값. 돌려주는 값 그대로 계산해 확인한다. 없으면 None이다.

    왜 가장 작은 값인가: 임계값이 작을수록 재현율이 높다. 예산을 지키는 범위에서 재현율을 최대로 하는 값이다.
    None은 임계값 1.0에서도 예산을 넘는다는 뜻이다(점수가 1.0인 문장이 많을 때). 1차 분류기만으로는 예산을 지킬 수 없다.
    """
    for candidate in candidate_thresholds(pairs):
        if weighted_forward_rate(forward_rates_by_category(pairs, candidate), mix) <= budget:
            return candidate
    return None


def compute_chat_auc(pairs: Sequence[tuple[ChatEvalItem, float]]) -> float:
    """유해(1)와 허용(0)을 가르는 AUC."""
    scores = [score for _item, score in pairs]
    labels = [int(item.label == "harmful") for item, _score in pairs]
    ensure_valid_scores_and_labels(scores, labels)
    return round(compute_roc_auc(scores, labels), METRIC_DECIMALS)


def describe_counts(items: Sequence[ChatEvalItem], pairs: Sequence[tuple[ChatEvalItem, float]]) -> dict:
    """채점 문장과 애매 문장 수."""
    return {"scored": len(pairs), "ambiguous": len(items) - len(pairs)}


def build_dev_report(items: Sequence[ChatEvalItem], scores: Sequence[float], mix: Mapping[str, float], budget: float) -> dict:
    """개발셋 결과: 임계값 표, 예산 임계값과 그 요약, 문장별 점수(id만). 원문은 넣지 않는다."""
    pairs = scored_pairs(items, scores)
    threshold = select_budget_threshold(pairs, mix, budget)
    at_threshold = None if threshold is None else summarize_at_chat_threshold(pairs, threshold, mix)
    return {
        "split": "dev",
        "counts": describe_counts(items, pairs),
        "auc": compute_chat_auc(pairs),
        "traffic_mix": dict(mix),
        "threshold_table": [summarize_at_chat_threshold(pairs, value, mix) for value in CHAT_REPORT_THRESHOLDS],
        "decision": {"mode": "budget", "budget": budget, "threshold": threshold, "at_threshold": at_threshold},
        "scores": {item.item_id: round(score, METRIC_DECIMALS) for item, score in zip(items, scores, strict=True)},
    }


def build_holdout_report(items: Sequence[ChatEvalItem], scores: Sequence[float], mix: Mapping[str, float], threshold: float) -> dict:
    """보류셋 결과: 개발셋에서 고른 임계값 하나의 집계와 AUC만. 임계값 표·문장별 점수는 넣지 않는다(보류셋 튜닝 방지)."""
    pairs = scored_pairs(items, scores)
    return {
        "split": "holdout",
        "counts": describe_counts(items, pairs),
        "auc": compute_chat_auc(pairs),
        "traffic_mix": dict(mix),
        "decision": {"mode": "fixed", "threshold": threshold, "at_threshold": summarize_at_chat_threshold(pairs, threshold, mix)},
    }


def build_argument_parser() -> argparse.ArgumentParser:
    """CLI 인자. 개발셋에는 --forward-budget, 보류셋에는 --dev-report를 준다."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage1.evaluate_chat", description="채팅 평가셋으로 1차 분류기 평가(기본 CPU)")
    parser.add_argument("--model-dir", type=Path, required=True, help="train이 만든 출력 디렉터리")
    parser.add_argument("--eval-file", type=Path, required=True, help="채팅 평가셋 JSONL(개발셋 또는 보류셋)")
    decision = parser.add_mutually_exclusive_group(required=True)
    decision.add_argument("--forward-budget", type=probability_argument, help="F_max(개발셋에서 임계값을 고를 때)")
    decision.add_argument("--dev-report", type=Path, help="같은 모델의 개발셋 결과 JSON(보류셋을 볼 때)")
    parser.add_argument("--mix-file", type=Path, help="트래픽 구성비 JSON(범주→비율, 합 1). 없으면 기본 가정")
    parser.add_argument("--device", choices=modeling.DEVICE_CHOICES, default="cpu", help="점수 계산 장치(기본 cpu)")
    parser.add_argument("--batch-size", type=positive_integer, default=modeling.DEFAULT_INFERENCE_BATCH_SIZE, help="점수 계산 배치 크기")
    parser.add_argument("--output", type=Path, help="결과 JSON 경로(기본: <모델>/chat-eval-<셋>.json)")
    parser.add_argument("--overwrite", action="store_true", help="이미 있는 결과 파일을 덮어쓴다(개발셋만)")
    return parser


def compute_model_weights_sha256(model_directory: Path) -> str:
    """모델 가중치 파일의 sha256. 보류셋 평가가 개발셋에서 임계값을 고른 바로 그 모델인지 확인하는 데 쓴다."""
    return compute_file_sha256(model_directory / modeling.WEIGHTS_FILE_NAME)


def require_valid_threshold(value: object, file_name: str) -> float:
    """개발셋 결과의 임계값이 (0, 1] 범위의 유한한 수인지 확인한다. NaN이면 모든 비교가 거짓이 돼 '하나도 안 넘김'으로 보이기 때문이다."""
    if isinstance(value, bool) or not isinstance(value, int | float) or not (math.isfinite(value) and 0 < value <= MAX_THRESHOLD):
        raise DatasetFormatError(f"{file_name}의 임계값({value!r})이 (0, 1] 범위의 수가 아닙니다. 예산을 지키는 임계값이 없었거나 파일이 손상됐습니다.")
    return float(value)


def read_dev_threshold(dev_report_path: Path, model_weights_sha256: str) -> float:
    """개발셋 결과에서 임계값을 읽는다. 개발셋 결과가 아니거나, 다른 모델의 결과거나, 임계값이 잘못됐으면 오류다."""
    report = json.loads(dev_report_path.read_text(encoding="utf-8"))
    if report.get("split") != "dev" or report.get("decision", {}).get("mode") != "budget":
        raise DatasetFormatError(f"{dev_report_path.name}은 개발셋 예산 결과가 아닙니다. --forward-budget으로 만든 개발셋 결과를 주세요.")
    if report.get("model_weights_sha256") != model_weights_sha256:
        raise DatasetFormatError(f"{dev_report_path.name}은 다른 모델의 결과입니다. 같은 --model-dir로 개발셋을 먼저 평가하세요.")
    return require_valid_threshold(report["decision"].get("threshold"), dev_report_path.name)


def require_matching_decision(arguments: argparse.Namespace, split: str) -> None:
    """개발셋에는 예산, 보류셋에는 개발셋 결과를 요구한다. 보류셋으로 임계값을 고르지 못하게 하기 위해서다."""
    if split == "holdout" and arguments.dev_report is None:
        raise DatasetFormatError("보류셋으로 임계값을 고르지 않습니다. 같은 모델의 개발셋 결과를 --dev-report로 주세요.")
    if split == "dev" and arguments.forward_budget is None:
        raise DatasetFormatError("개발셋에는 --forward-budget(F_max)을 주세요.")


def load_traffic_mix(path: Path | None) -> dict[str, float]:
    """구성비를 읽는다. 경로가 없으면 기본 가정을 쓴다. 어느 쪽이든 검증한다."""
    mix = DEFAULT_TRAFFIC_MIX if path is None else json.loads(path.read_text(encoding="utf-8"))
    validate_traffic_mix(mix)
    return dict(mix)


def resolve_output_path(arguments: argparse.Namespace, split: str) -> Path:
    """결과 파일 경로. 이미 있으면 덮어쓰지 않는다. 보류셋은 모델 디렉터리의 정해진 이름에만 쓰고, --overwrite로도 덮어쓰지 않는다.

    왜: 보류셋은 모델마다 한 번만 본다. 다른 경로로 몇 번이고 다시 돌릴 수 있으면 그 결과를 보고 설정을 바꾸게 된다.
    """
    if split == "holdout" and arguments.output is not None:
        raise DatasetFormatError("보류셋 결과는 모델 디렉터리의 chat-eval-holdout.json에만 씁니다. --output을 빼세요.")
    output = arguments.output or arguments.model_dir / f"chat-eval-{split}.json"
    if output.exists() and (split == "holdout" or not arguments.overwrite):
        raise OutputExistsError(f"{output.name}이 이미 있습니다. 개발셋 결과는 --overwrite로 바꿀 수 있고, 보류셋 결과는 바꾸지 않습니다.")
    return output


def score_items(arguments: argparse.Namespace, items: Sequence[ChatEvalItem]) -> list[float]:
    """학습된 모델로 문장의 유해 확률을 계산한다."""
    device = modeling.resolve_device(arguments.device)
    max_length = resolve_max_length(arguments.model_dir, read_model_card(arguments.model_dir))
    tokenizer = modeling.load_trained_tokenizer(arguments.model_dir)
    model = modeling.move_model_to_device(modeling.load_trained_classifier(arguments.model_dir), device).eval()
    return modeling.score_texts(model, tokenizer, [item.text for item in items], device, max_length, arguments.batch_size)


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


def build_report_for_split(arguments: argparse.Namespace, items: Sequence[ChatEvalItem], mix: Mapping[str, float], model_sha: str) -> dict:
    """셋에 맞는 보고서를 만든다. 보류셋은 채점 전에 개발셋 결과를 확인한다(다른 모델이면 채점하지 않는다)."""
    if items[0].split == "holdout":
        threshold = read_dev_threshold(arguments.dev_report, model_sha)
        report = build_holdout_report(items, score_items(arguments, items), mix, threshold)
        return report | {"dev_report": describe_file_provenance(arguments.dev_report)}
    return build_dev_report(items, score_items(arguments, items), mix, arguments.forward_budget)


def main(argv: Sequence[str] | None = None) -> None:
    """평가셋 검증 → 결정 방식 확인 → 채점 → 보고서 저장·출력."""
    arguments = build_argument_parser().parse_args(argv)
    items = load_validated_eval_set(arguments.eval_file)
    require_matching_decision(arguments, items[0].split)
    mix = load_traffic_mix(arguments.mix_file)
    output = resolve_output_path(arguments, items[0].split)
    model_sha = compute_model_weights_sha256(arguments.model_dir)
    report = build_report_for_split(arguments, items, mix, model_sha)
    report |= {"created_at": utc_timestamp(), "model_dir": arguments.model_dir.name, "model_weights_sha256": model_sha}
    report |= {"eval_file": describe_file_provenance(arguments.eval_file)}
    write_json_atomically(output, report)
    print(format_chat_report_markdown(report))
    print(f"\n저장: {output.name}")


if __name__ == "__main__":
    run_command_line(main)
