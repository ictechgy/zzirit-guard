"""1차 분류기(미세조정한 KcELECTRA) 평가 스크립트. 버리는 스파이크 코드다.

1) 품질: 채팅 72문장, K-HATERS 400건(kanana 측정과 같은 표본), K-HATERS test 1만 건
2) 처리량: MPS(GPU)·CPU에서 묶음 크기별 초당 처리 건수
3) 2단계 시뮬레이션: 1차 점수 ≥ t인 것만 kanana로 넘겼을 때의 kanana 부하와 최종 정밀도·재현율
kanana 판정은 이미 저장한 kanana-8b-4-pc 결과를 재사용한다(같은 문장, 같은 순서).
"""

import argparse
import json
import statistics
import time
from pathlib import Path

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

# 1차 분류기 통과 임계값 후보. 거름망이라 낮은 값(재현율 우선)을 주로 본다.
FORWARD_THRESHOLDS = [0.05, 0.1, 0.2, 0.3, 0.5, 0.7]

# 처리량 측정 시 채팅 문장을 몇 번 반복할지(72 × 20 = 1,440건).
THROUGHPUT_REPEAT = 20

# 처리량 측정 묶음 크기.
THROUGHPUT_BATCH_SIZES = [1, 16, 64]


def parse_arguments() -> argparse.Namespace:
    """명령행 인자를 읽는다."""
    parser = argparse.ArgumentParser(description="1차 분류기 평가")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--chat-file", required=True)
    parser.add_argument("--khaters-test", required=True)
    parser.add_argument("--kanana-rows", required=True)
    parser.add_argument("--run-label", required=True)
    parser.add_argument("--out-dir", required=True)
    return parser.parse_args()


def load_jsonl(path: str) -> list[dict]:
    """jsonl 파일을 dict 목록으로 읽는다."""
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines()]


@torch.no_grad()
def score_texts(model, tokenizer, texts: list[str], device: str, batch_size: int = 64) -> list[float]:
    """문장마다 유해 확률을 계산한다. 길이순으로 묶어 처리한 뒤 원래 순서로 되돌린다."""
    order = sorted(range(len(texts)), key=lambda index: len(texts[index]))
    scores = [0.0] * len(texts)
    for start in range(0, len(order), batch_size):
        batch_indices = order[start:start + batch_size]
        encoded = tokenizer([texts[index] for index in batch_indices], truncation=True, max_length=128, padding=True, return_tensors="pt").to(device)
        probabilities = torch.softmax(model(**encoded).logits.float(), dim=-1)[:, 1].tolist()
        for index, probability in zip(batch_indices, probabilities):
            scores[index] = probability
    return scores


def binary_metrics(flags: list[bool], is_harmful: list[bool]) -> dict:
    """표시 여부와 정답(유해 여부)으로 정밀도·재현율·F1을 계산한다."""
    true_positive = sum(flag and harmful for flag, harmful in zip(flags, is_harmful))
    false_positive = sum(flag and not harmful for flag, harmful in zip(flags, is_harmful))
    false_negative = sum((not flag) and harmful for flag, harmful in zip(flags, is_harmful))
    precision = true_positive / max(true_positive + false_positive, 1)
    recall = true_positive / max(true_positive + false_negative, 1)
    f1 = 2 * precision * recall / max(precision + recall, 1e-9)
    return {"precision": round(precision, 3), "recall": round(recall, 3), "f1": round(f1, 3), "false_positive": false_positive}


def area_under_curve(scores: list[float], is_harmful: list[bool]) -> float:
    """ROC AUC를 순위 합(Mann-Whitney U)으로 계산한다. 임계값과 무관한 분리 능력 지표다."""
    ranked = sorted(zip(scores, is_harmful))
    positive_rank_sum = sum(rank + 1 for rank, (_, harmful) in enumerate(ranked) if harmful)
    positive_count = sum(is_harmful)
    negative_count = len(is_harmful) - positive_count
    return (positive_rank_sum - positive_count * (positive_count + 1) / 2) / (positive_count * negative_count)


def simulate_pipeline(rows: list[dict], scores: list[float]) -> list[dict]:
    """임계값별로 '1차 통과 → kanana 판정' 2단계 결과를 계산한다. ambiguous 문장은 지표에서 뺀다."""
    labeled = [(row, score) for row, score in zip(rows, scores) if row["expected"] in ("allow", "harmful")]
    is_harmful = [row["expected"] == "harmful" for row, _ in labeled]
    kanana_flags = [row["label"] != "<SAFE>" for row, _ in labeled]
    results = [{"threshold": "kanana 단독", "forward_rate": 1.0, **binary_metrics(kanana_flags, is_harmful)}]
    for threshold in FORWARD_THRESHOLDS:
        forwarded = [score >= threshold for _, score in labeled]
        final_flags = [forward and kanana_flag for forward, kanana_flag in zip(forwarded, kanana_flags)]
        allow_forwarded = [forward for forward, harmful in zip(forwarded, is_harmful) if not harmful]
        kanana_caught = [forward for forward, kanana_flag in zip(forwarded, kanana_flags) if kanana_flag]
        results.append({
            "threshold": threshold,
            "forward_rate": round(sum(forwarded) / len(forwarded), 3),
            "allow_forward_rate": round(sum(allow_forwarded) / max(len(allow_forwarded), 1), 3),
            "kanana_catch_kept": round(sum(kanana_caught) / max(len(kanana_caught), 1), 3),
            **binary_metrics(final_flags, is_harmful),
        })
    return results


def measure_throughput(model, tokenizer, texts: list[str], device: str) -> list[dict]:
    """묶음 크기별 초당 처리 건수를 잰다. 묶음 1은 건당 지연 중앙값도 기록한다."""
    model.to(device)
    score_texts(model, tokenizer, texts[:64], device)  # 워밍업
    results = []
    for batch_size in THROUGHPUT_BATCH_SIZES:
        sample_texts = texts if batch_size > 1 else texts[:300]
        latencies = time_batches(model, tokenizer, sample_texts, device, batch_size)
        results.append({
            "device": device,
            "batch_size": batch_size,
            "messages_per_second": round(len(sample_texts) / sum(latencies), 1),
            "median_batch_ms": round(statistics.median(latencies) * 1000, 2),
        })
    return results


def time_batches(model, tokenizer, texts: list[str], device: str, batch_size: int) -> list[float]:
    """도착 순서대로(정렬 없이) 묶음을 만들어 묶음별 소요 시간(초)을 잰다. 실제 대기열과 같은 조건이다."""
    latencies = []
    for start in range(0, len(texts), batch_size):
        batch_texts = texts[start:start + batch_size]
        start_time = time.perf_counter()
        with torch.no_grad():
            encoded = tokenizer(batch_texts, truncation=True, max_length=128, padding=True, return_tensors="pt").to(device)
            torch.softmax(model(**encoded).logits.float(), dim=-1)[:, 1].tolist()
        latencies.append(time.perf_counter() - start_time)
    return latencies


def main() -> None:
    """품질 → 2단계 시뮬레이션 → 처리량 순으로 평가하고 결과를 저장한다."""
    arguments = parse_arguments()
    tokenizer = AutoTokenizer.from_pretrained(arguments.model_dir)
    model = AutoModelForSequenceClassification.from_pretrained(arguments.model_dir, use_safetensors=True).eval().to("mps")

    kanana_rows = load_jsonl(arguments.kanana_rows)
    scores = score_texts(model, tokenizer, [row["text"] for row in kanana_rows], "mps")
    test_records = load_jsonl(arguments.khaters_test)
    test_scores = score_texts(model, tokenizer, [record["text"] for record in test_records], "mps")
    test_harmful = [record["label"] != "normal" for record in test_records]

    summary = {
        "run_label": arguments.run_label,
        "khaters_test_full": {"auc": round(area_under_curve(test_scores, test_harmful), 4), **binary_metrics([s >= 0.5 for s in test_scores], test_harmful)},
        "pipeline_chat": simulate_pipeline([r for r in kanana_rows if r["source"] == "chat"], [s for r, s in zip(kanana_rows, scores) if r["source"] == "chat"]),
        "pipeline_khaters400": simulate_pipeline([r for r in kanana_rows if r["source"] == "khaters"], [s for r, s in zip(kanana_rows, scores) if r["source"] == "khaters"]),
    }
    chat_texts = [record["text"] for record in load_jsonl(arguments.chat_file)] * THROUGHPUT_REPEAT
    summary["throughput"] = measure_throughput(model, tokenizer, chat_texts, "mps") + measure_throughput(model, tokenizer, chat_texts, "cpu")
    write_outputs(arguments, kanana_rows, scores, summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def write_outputs(arguments, kanana_rows: list[dict], scores: list[float], summary: dict) -> None:
    """요약(json)과 문장별 1차 점수(jsonl)를 저장한다."""
    out_dir = Path(arguments.out_dir)
    score_rows = [{"source": row["source"], "sample_id": row["sample_id"], "group": row["group"], "expected": row["expected"],
                   "text": row["text"], "stage1_score": round(score, 4), "kanana_label": row["label"]} for row, score in zip(kanana_rows, scores)]
    (out_dir / f"{arguments.run_label}.stage1.rows.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in score_rows) + "\n", encoding="utf-8")
    (out_dir / f"{arguments.run_label}.stage1.summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
