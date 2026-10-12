"""1차 분류기 평가 CLI.

사용 예: uv run python -m zg_stage1.evaluate --model-dir "$ZG_DATA_DIR/ml/stage1/kcelectra-<시각>"
기본 장치는 CPU다. 워커가 CPU로 돌기 때문이다(스펙 §4: GPU는 2차 kanana가 쓴다).
보고 내용:
  - K-HATERS test: AUC, F1@0.5, 임계값 표(유해 재현율·통과율·정밀도), 원래 라벨별 표시 비율
  - K-HATERS 회귀 표본 400건(스펙 §13, 라벨별 100건·시드 20261011): AUC와 임계값 표
  - 채팅 회귀 72문장: 문장별 점수(id로만 표시), 범주별 재현율(임계값 0.05)
  - CPU 처리량: 16건 묶음, max_length 128, 고정 표본(채팅 72문장 × 20)
  - 검증셋 기준 임계값 선택(참고용, thresholds 모듈)
출력: <model-dir>/evaluation.json, <model-dir>/validation-scores.json, 표준 출력에 Markdown 요약.
원문은 출력하지 않는다.
"""

from __future__ import annotations

import argparse
import os
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import torch
from transformers import PreTrainedModel, PreTrainedTokenizerBase

from zg_stage1 import modeling
from zg_stage1.arguments import positive_integer, probability_argument
from zg_stage1.data import (
    LABEL_TO_BINARY,
    REGRESSION_SAMPLE_PER_LABEL,
    REGRESSION_SAMPLE_SEED,
    ChatSample,
    LabeledText,
    describe_file_provenance,
    load_chat_samples,
    load_labeled_texts,
    select_regression_sample,
)
from zg_stage1.errors import OutputExistsError, run_command_line
from zg_stage1.inference_contract import read_inference_contract
from zg_stage1.metrics import (
    METRIC_DECIMALS,
    REPORT_THRESHOLDS,
    STANDARD_THRESHOLD,
    build_threshold_table,
    compute_roc_auc,
    safe_divide,
    summarize_at_threshold,
)
from zg_stage1.model_card import annotate_reference_match, read_model_card, utc_timestamp, write_json_atomically
from zg_stage1.paths import (
    CHAT_SAMPLES_PATH,
    KHATERS_RELATIVE_PATH,
    KHATERS_TEST_FILE_NAME,
    KHATERS_VALIDATION_FILE_NAME,
    choose_path,
    ensure_existing_file,
    ensure_safetensors_only,
    resolve_ml_directory,
)
from zg_stage1.thresholds import (
    DEFAULT_TARGET_RECALL,
    SPEC_STAGE1_THRESHOLD,
    ThresholdSelection,
    format_selection_markdown,
    format_threshold_table_markdown,
    select_threshold_for_recall,
    selection_to_dict,
)

# 평가 결과 파일 이름(모델 디렉터리 안).
EVALUATION_FILE_NAME = "evaluation.json"

# 검증 점수 파일 이름(모델 디렉터리 안). thresholds CLI가 다시 읽어 다른 목표로 임계값을 고를 때 쓴다. 원문은 없다.
VALIDATION_SCORES_FILE_NAME = "validation-scores.json"

# 평가 결과 형식 버전. 필드를 바꾸면 올린다.
EVALUATION_SCHEMA_VERSION = 1

# 처리량 측정 묶음 크기: 워커가 한 번에 처리하는 최대 건수와 같다(스펙 §5.2 ④ '최대 16건씩 묶음').
THROUGHPUT_BATCH_SIZE = 16

# 처리량 측정 max_length: 학습 기본값과 같게 해서 워커 조건을 재현한다.
THROUGHPUT_MAX_LENGTH = 128

# 처리량 표본: 채팅 72문장을 이만큼 반복한다(72 × 20 = 1,440건, 스파이크와 같은 조건).
THROUGHPUT_REPEAT = 20

# 처리량을 재기 전에 버리는 워밍업 건수. 첫 실행의 메모리 할당·초기화 비용을 측정에서 빼기 위해서다.
THROUGHPUT_WARMUP_MESSAGES = 64

# 처리량 측정 지연의 상위 백분위(p95).
LATENCY_PERCENTILE = 0.95

# 문장별 점수를 결과에 쓸 때의 소수점 자릿수.
SCORE_DECIMALS = 4

# Markdown 요약에서 채팅 문장별 점수를 한 줄에 몇 개씩 보여 줄지.
CHAT_SCORES_PER_LINE = 12


@dataclass(frozen=True)
class EvaluationPaths:
    """평가 입력·출력 경로."""

    model_directory: Path
    test_file: Path
    validation_file: Path
    chat_file: Path
    evaluation_output: Path
    scores_output: Path


def build_argument_parser() -> argparse.ArgumentParser:
    """evaluate CLI의 인자 정의를 만든다."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage1.evaluate", description="1차 분류기 평가(기본 CPU)")
    parser.add_argument("--model-dir", required=True, help="train이 만든 출력 디렉터리")
    parser.add_argument("--ml-dir", help="ML 자료 최상위(기본: $ZG_ML_DIR 또는 $ZG_DATA_DIR/ml)")
    parser.add_argument("--test-file", help="K-HATERS test JSONL(기본: <ML>/data/k-haters/test_v2.jsonl)")
    parser.add_argument("--val-file", help="K-HATERS 검증 JSONL(기본: <ML>/data/k-haters/val_v2.jsonl)")
    parser.add_argument("--chat-file", help="채팅 회귀 문장(기본: 저장소의 docs/spikes/…/chat_samples.jsonl)")
    parser.add_argument("--device", choices=modeling.DEVICE_CHOICES, default="cpu", help="점수 계산 장치(기본 cpu). 처리량은 항상 CPU로 잰다")
    parser.add_argument("--limit", type=positive_integer, help="test·검증 파일에서 앞의 N줄만 쓴다(스모크용)")
    parser.add_argument("--batch-size", type=positive_integer, default=modeling.DEFAULT_INFERENCE_BATCH_SIZE, help="점수 계산 배치 크기")
    parser.add_argument("--stage1-threshold", type=probability_argument, default=SPEC_STAGE1_THRESHOLD, help="2차로 넘기는 임계값(기본 0.05)")
    parser.add_argument("--target-recall", type=probability_argument, default=DEFAULT_TARGET_RECALL, help="임계값 선택의 재현율 목표(기본 0.97)")
    parser.add_argument("--overwrite", action="store_true", help="이미 있는 evaluation.json·validation-scores.json을 덮어쓴다")
    return parser


def resolve_evaluation_paths(arguments: argparse.Namespace, environment: Mapping[str, str]) -> EvaluationPaths:
    """인자와 환경 변수로 평가 경로를 정한다. ML 디렉터리는 기본값이 필요할 때만 계산한다."""

    def ml_directory() -> Path:
        """ML 자료 최상위 디렉터리(인자 → ZG_ML_DIR → ZG_DATA_DIR/ml)."""
        return resolve_ml_directory(arguments.ml_dir, environment)

    model_directory = Path(arguments.model_dir).expanduser()
    return EvaluationPaths(
        model_directory=model_directory,
        test_file=choose_path(arguments.test_file, lambda: ml_directory() / KHATERS_RELATIVE_PATH / KHATERS_TEST_FILE_NAME),
        validation_file=choose_path(arguments.val_file, lambda: ml_directory() / KHATERS_RELATIVE_PATH / KHATERS_VALIDATION_FILE_NAME),
        chat_file=choose_path(arguments.chat_file, lambda: CHAT_SAMPLES_PATH),
        evaluation_output=model_directory / EVALUATION_FILE_NAME,
        scores_output=model_directory / VALIDATION_SCORES_FILE_NAME,
    )


def validate_evaluation_paths(paths: EvaluationPaths, should_overwrite: bool) -> None:
    """무거운 작업 전에 입력 파일·가중치 형식·출력 충돌을 확인한다."""
    ensure_safetensors_only(paths.model_directory)
    ensure_existing_file(paths.test_file, "K-HATERS test")
    ensure_existing_file(paths.validation_file, "K-HATERS 검증")
    ensure_existing_file(paths.chat_file, "채팅 회귀 문장")
    for output in (paths.evaluation_output, paths.scores_output):
        if output.exists() and not should_overwrite:
            raise OutputExistsError(f"{output.name}이 이미 있습니다: {output}. 앞선 평가를 지키려고 덮어쓰지 않습니다. 바꾸려면 --overwrite를 주세요.")


def resolve_max_length(model_directory: Path, model_card: dict | None) -> int:
    """채점에 쓸 max_length를 정한다. 우선순위: inference.json(워커와 같은 값) → 모델 카드 → 128."""
    contract = read_inference_contract(model_directory)
    if contract is not None:
        return int(contract["max_length"])
    if model_card is None:
        return THROUGHPUT_MAX_LENGTH
    return int(model_card.get("hyperparameters", {}).get("max_length", THROUGHPUT_MAX_LENGTH))


def warn_if_card_incomplete(model_card: dict | None) -> None:
    """카드가 없거나 학습이 완료되지 않았으면 경고를 출력한다. 평가 자체는 막지 않는다(중간 결과도 볼 수 있게)."""
    if model_card is None:
        print("[경고] model-card.json이 없습니다. 이 패키지의 train으로 만든 디렉터리인지 확인하세요.", flush=True)
    elif model_card.get("status") != "completed":
        print(f"[경고] 학습 상태가 '{model_card.get('status')}'입니다. 완료되지 않은 학습의 가중치일 수 있습니다.", flush=True)


def flag_rate(scores: Sequence[float], threshold: float) -> float:
    """점수 중 임계값 이상인 비율(소수점 METRIC_DECIMALS자리)."""
    return round(safe_divide(sum(score >= threshold for score in scores), len(scores)), METRIC_DECIMALS)


def summarize_by_label(scores: Sequence[float], records: Sequence[LabeledText], thresholds: Sequence[float]) -> dict:
    """원래 라벨별로 임계값 이상으로 표시된 비율을 센다. 유해 라벨에서는 재현율, normal에서는 오탐률이다."""
    scores_by_label: dict[str, list[float]] = {}
    for score, record in zip(scores, records, strict=True):
        scores_by_label.setdefault(record.original_label, []).append(score)
    return {
        label: {
            "count": len(label_scores),
            "is_toxic_label": LABEL_TO_BINARY[label] == 1,
            "flagged_rate": {str(threshold): flag_rate(label_scores, threshold) for threshold in thresholds},
        }
        for label, label_scores in sorted(scores_by_label.items())
    }


def summarize_khaters(scores: Sequence[float], records: Sequence[LabeledText], stage1_threshold: float) -> dict:
    """K-HATERS 점수의 AUC·F1@0.5·임계값 표·라벨별 표시 비율을 만든다."""
    labels = [record.binary_label for record in records]
    return {
        "count": len(records),
        "toxic_count": sum(labels),
        "auc": round(compute_roc_auc(scores, labels), METRIC_DECIMALS),
        "at_0_5": summarize_at_threshold(scores, labels, STANDARD_THRESHOLD),
        "threshold_table": build_threshold_table(scores, labels, sorted({*REPORT_THRESHOLDS, stage1_threshold})),
        "by_label": summarize_by_label(scores, records, sorted({stage1_threshold, STANDARD_THRESHOLD})),
    }


def summarize_regression_sample(scores: Sequence[float], records: Sequence[LabeledText], stage1_threshold: float) -> dict:
    """스펙 §13의 K-HATERS 회귀 표본(라벨별 100건, 시드 고정)을 test 점수에서 골라 요약한다(추가 추론 없음)."""
    score_by_identifier = {record.record_id: score for record, score in zip(records, scores, strict=True)}
    sample = select_regression_sample(list(records), REGRESSION_SAMPLE_PER_LABEL, REGRESSION_SAMPLE_SEED)
    sample_scores = [score_by_identifier[record.record_id] for record in sample]
    return {
        "seed": REGRESSION_SAMPLE_SEED,
        "per_label": REGRESSION_SAMPLE_PER_LABEL,
        "sample_ids": [record.record_id for record in sample],
        **summarize_khaters(sample_scores, sample, stage1_threshold),
    }


def summarize_chat_group(members: Sequence[tuple[float, ChatSample]], threshold: float) -> dict:
    """채팅 범주 하나의 유해 재현율(harmful 문장 중 임계값 이상 비율)과 전체 표시 비율을 센다."""
    harmful_scores = [score for score, sample in members if sample.expected == "harmful"]
    return {
        "count": len(members),
        "harmful_count": len(harmful_scores),
        "recall_at_threshold": flag_rate(harmful_scores, threshold) if harmful_scores else None,
        "flagged_rate": flag_rate([score for score, _ in members], threshold),
    }


def summarize_chat(scores: Sequence[float], samples: Sequence[ChatSample], threshold: float) -> dict:
    """채팅 회귀 문장 요약: 전체(ambiguous 제외) AUC·임계값 지표, 범주별 재현율, 문장별 점수(id로만)."""
    labeled = [(score, sample) for score, sample in zip(scores, samples, strict=True) if sample.expected != "ambiguous"]
    labeled_scores = [score for score, _ in labeled]
    labels = [1 if sample.expected == "harmful" else 0 for _, sample in labeled]
    members_by_group: dict[str, list[tuple[float, ChatSample]]] = {}
    for score, sample in zip(scores, samples, strict=True):
        members_by_group.setdefault(sample.group, []).append((score, sample))
    return {
        "count": len(samples),
        "labeled_count": len(labeled),
        "threshold": threshold,
        "auc": round(compute_roc_auc(labeled_scores, labels), METRIC_DECIMALS),
        "at_threshold": summarize_at_threshold(labeled_scores, labels, threshold),
        "by_group": {group: summarize_chat_group(members, threshold) for group, members in sorted(members_by_group.items())},
        "sentences": [
            {"id": sample.sample_id, "group": sample.group, "expected": sample.expected, "score": round(score, SCORE_DECIMALS)}
            for score, sample in zip(scores, samples, strict=True)
        ],
    }


@torch.no_grad()
def time_cpu_batches(model: PreTrainedModel, tokenizer: PreTrainedTokenizerBase, texts: Sequence[str]) -> list[float]:
    """도착 순서대로(길이 정렬 없이) 16건씩 묶어 토큰화+추론 시간(초)을 묶음마다 잰다. 실제 대기열과 같은 조건이다."""
    latencies = []
    for start in range(0, len(texts), THROUGHPUT_BATCH_SIZE):
        started_clock = time.perf_counter()
        token_lists = modeling.encode_texts(tokenizer, texts[start : start + THROUGHPUT_BATCH_SIZE], THROUGHPUT_MAX_LENGTH)
        batch = modeling.collate_batch(token_lists, range(len(token_lists)), tokenizer.pad_token_id)
        modeling.compute_toxic_probabilities(model(**batch).logits)
        latencies.append(time.perf_counter() - started_clock)
    return latencies


def measure_cpu_throughput(model: PreTrainedModel, tokenizer: PreTrainedTokenizerBase, texts: Sequence[str]) -> dict:
    """CPU 처리량(건/s)과 묶음 지연(중앙값·p95)을 잰다. 모델을 CPU로 옮기고 eval 상태로 둔다."""
    modeling.move_model_to_device(model, "cpu").eval()
    time_cpu_batches(model, tokenizer, texts[:THROUGHPUT_WARMUP_MESSAGES])
    latencies = sorted(time_cpu_batches(model, tokenizer, texts))
    return {
        "device": "cpu",
        "batch_size": THROUGHPUT_BATCH_SIZE,
        "max_length": THROUGHPUT_MAX_LENGTH,
        "messages": len(texts),
        "torch_threads": torch.get_num_threads(),
        "messages_per_second": round(len(texts) / sum(latencies), 1),
        "median_batch_ms": round(latencies[len(latencies) // 2] * 1000, 2),
        "p95_batch_ms": round(latencies[int(LATENCY_PERCENTILE * (len(latencies) - 1))] * 1000, 2),
    }


def describe_model(paths: EvaluationPaths, model_card: dict | None) -> dict:
    """평가한 모델의 이름·가중치 sha256·카드 요약(상태·선택 epoch·검증 AUC)을 만든다. 경로는 넣지 않는다."""
    card = model_card or {}
    return {
        "directory_name": paths.model_directory.name,
        "weights": [describe_file_provenance(path) for path in ensure_safetensors_only(paths.model_directory)],
        "card_status": card.get("status"),
        "chosen_epoch": card.get("chosen_epoch"),
        "best_validation_auc": card.get("best_validation_auc"),
    }


def describe_data(paths: EvaluationPaths) -> dict:
    """평가 데이터 출처(이름·크기·sha256·고정 리비전 일치 여부)를 만든다."""
    return {
        "test": annotate_reference_match(describe_file_provenance(paths.test_file)),
        "validation": annotate_reference_match(describe_file_provenance(paths.validation_file)),
        "chat": describe_file_provenance(paths.chat_file),
    }


@dataclass(frozen=True)
class EvaluationInputs:
    """평가에 쓰는 데이터와 max_length. 원문은 채점에만 쓰고 결과에는 넣지 않는다."""

    test_records: list[LabeledText]
    validation_records: list[LabeledText]
    chat_samples: list[ChatSample]
    max_length: int


@dataclass(frozen=True)
class EvaluationScores:
    """데이터별 유해 확률(입력 순서와 같다)."""

    test: list[float]
    validation: list[float]
    chat: list[float]

    def validation_labels(self, inputs: EvaluationInputs) -> list[int]:
        """검증 레코드의 이진 라벨(점수와 같은 순서)."""
        return [record.binary_label for record in inputs.validation_records]


def load_evaluation_inputs(arguments: argparse.Namespace, paths: EvaluationPaths, model_card: dict | None) -> EvaluationInputs:
    """test·검증(--limit 적용)·채팅 문장을 읽는다. 건수만 출력하고 원문은 출력하지 않는다."""
    inputs = EvaluationInputs(
        test_records=load_labeled_texts(paths.test_file, arguments.limit),
        validation_records=load_labeled_texts(paths.validation_file, arguments.limit),
        chat_samples=load_chat_samples(paths.chat_file),
        max_length=resolve_max_length(paths.model_directory, model_card),
    )
    print(
        f"[평가] test {len(inputs.test_records)}건, 검증 {len(inputs.validation_records)}건, 채팅 {len(inputs.chat_samples)}건, "
        f"device={arguments.device}, max_length={inputs.max_length}",
        flush=True,
    )
    return inputs


def score_inputs(model: PreTrainedModel, tokenizer: PreTrainedTokenizerBase, inputs: EvaluationInputs, arguments: argparse.Namespace) -> EvaluationScores:
    """세 데이터를 지정 장치·배치 크기로 채점한다."""

    def score(texts: list[str]) -> list[float]:
        """문장 목록의 유해 확률."""
        return modeling.score_texts(model, tokenizer, texts, arguments.device, inputs.max_length, arguments.batch_size)

    return EvaluationScores(
        test=score([record.text for record in inputs.test_records]),
        validation=score([record.text for record in inputs.validation_records]),
        chat=score([sample.text for sample in inputs.chat_samples]),
    )


def describe_settings(arguments: argparse.Namespace, inputs: EvaluationInputs) -> dict:
    """평가 설정(장치·limit·max_length·배치·임계값·재현율 목표)."""
    return {
        "device": arguments.device,
        "limit": arguments.limit,
        "max_length": inputs.max_length,
        "batch_size": arguments.batch_size,
        "stage1_threshold": arguments.stage1_threshold,
        "target_recall": arguments.target_recall,
    }


def build_report(
    arguments: argparse.Namespace,
    paths: EvaluationPaths,
    model_card: dict | None,
    inputs: EvaluationInputs,
    scores: EvaluationScores,
    throughput: dict,
) -> dict:
    """evaluation.json 내용을 만든다."""
    threshold = arguments.stage1_threshold
    validation_labels = scores.validation_labels(inputs)
    return {
        "schema_version": EVALUATION_SCHEMA_VERSION,
        "created_at": utc_timestamp(),
        "model": describe_model(paths, model_card),
        "settings": describe_settings(arguments, inputs),
        "data": describe_data(paths),
        "khaters_test": summarize_khaters(scores.test, inputs.test_records, threshold),
        "khaters_regression_sample": summarize_regression_sample(scores.test, inputs.test_records, threshold),
        "chat_regression": summarize_chat(scores.chat, inputs.chat_samples, threshold),
        "validation": {"count": len(validation_labels), "auc": round(compute_roc_auc(scores.validation, validation_labels), METRIC_DECIMALS)},
        "threshold_selection": selection_to_dict(select_threshold_for_recall(scores.validation, validation_labels, arguments.target_recall)),
        "throughput": throughput,
    }


def build_scores_payload(report: dict, inputs: EvaluationInputs, scores: EvaluationScores) -> dict:
    """validation-scores.json 내용(점수·이진 라벨만, 원문 없음)을 만든다. thresholds CLI가 읽는다.

    점수는 반올림하지 않는다. 반올림하면 같은 파일로 임계값을 다시 골랐을 때 evaluation.json과 결과가 달라질 수 있다.
    """
    return {
        "schema_version": EVALUATION_SCHEMA_VERSION,
        "model_directory_name": report["model"]["directory_name"],
        "validation_file": report["data"]["validation"],
        "limit": report["settings"]["limit"],
        "scores": list(scores.validation),
        "binary_labels": scores.validation_labels(inputs),
    }


def format_overview_markdown(report: dict) -> list[str]:
    """요약 첫 부분: 모델·설정·K-HATERS test 핵심 지표."""
    model, settings, test = report["model"], report["settings"], report["khaters_test"]
    return [
        f"## 1차 분류기 평가: {model['directory_name']}",
        "",
        f"- 학습 상태 {model['card_status']}, 선택 epoch {model['chosen_epoch']}, 학습 때 검증 AUC {model['best_validation_auc']}",
        f"- 장치 {settings['device']}, limit {settings['limit']}, max_length {settings['max_length']}",
        f"- K-HATERS test {test['count']}건: **AUC {test['auc']:.4f}**, F1@0.5 {test['at_0_5']['f1']:.4f} "
        f"(정밀도 {test['at_0_5']['precision']:.4f}, 재현율 {test['at_0_5']['toxic_recall']:.4f})",
        f"- 검증 {report['validation']['count']}건 AUC {report['validation']['auc']:.4f}",
        "",
        "### K-HATERS test 임계값 표",
        "",
        format_threshold_table_markdown(test["threshold_table"]),
    ]


def format_by_label_markdown(report: dict) -> list[str]:
    """요약: 원래 라벨별 표시 비율(유해 라벨은 재현율, normal은 오탐률)과 회귀 표본 400건."""
    lines = ["", "### 라벨별 표시 비율(유해 라벨은 재현율, normal은 오탐률)", ""]
    for label, summary in report["khaters_test"]["by_label"].items():
        rates = ", ".join(f"≥{threshold}: {rate:.4f}" for threshold, rate in summary["flagged_rate"].items())
        lines.append(f"- {label}({summary['count']}건): {rates}")
    sample = report["khaters_regression_sample"]
    lines += ["", f"### K-HATERS 회귀 표본 {sample['count']}건(라벨별 최대 {sample['per_label']}건): AUC {sample['auc']:.4f}", ""]
    lines.append(format_threshold_table_markdown(sample["threshold_table"]))
    return lines


def format_chat_markdown(report: dict) -> list[str]:
    """요약: 채팅 회귀 문장의 범주별 재현율과 문장별 점수(id:점수, 원문 없음)."""
    chat = report["chat_regression"]
    lines = [
        "",
        f"### 채팅 회귀 {chat['count']}문장(임계값 {chat['threshold']}): AUC {chat['auc']:.4f}, "
        f"재현율 {chat['at_threshold']['toxic_recall']:.4f}, 통과율 {chat['at_threshold']['forward_rate']:.4f}",
        "",
        "| 범주 | 문장 | 유해 | 재현율 | 표시 비율 |",
        "|---|---|---|---|---|",
    ]
    for group, summary in chat["by_group"].items():
        recall = "-" if summary["recall_at_threshold"] is None else f"{summary['recall_at_threshold']:.2f}"
        lines.append(f"| {group} | {summary['count']} | {summary['harmful_count']} | {recall} | {summary['flagged_rate']:.2f} |")
    entries = [f"{sentence['id']}:{sentence['score']:.3f}" for sentence in chat["sentences"]]
    lines += ["", "문장별 점수(id:점수)", ""]
    lines += ["    " + " ".join(entries[start : start + CHAT_SCORES_PER_LINE]) for start in range(0, len(entries), CHAT_SCORES_PER_LINE)]
    return lines


def format_tail_markdown(report: dict, selection_markdown: str) -> list[str]:
    """요약 끝부분: 임계값 선택(참고용)과 CPU 처리량."""
    throughput = report["throughput"]
    return [
        "",
        "### 임계값 선택(검증셋, 참고용)",
        "",
        selection_markdown,
        "",
        "### CPU 처리량",
        "",
        f"- {throughput['messages']}건, {throughput['batch_size']}건 묶음, max_length {throughput['max_length']}, "
        f"스레드 {throughput['torch_threads']}: **{throughput['messages_per_second']}건/s** "
        f"(묶음 중앙값 {throughput['median_batch_ms']}ms, p95 {throughput['p95_batch_ms']}ms)",
    ]


def format_report_markdown(report: dict, selection_markdown: str) -> str:
    """evaluation.json 내용을 표준 출력용 Markdown 요약으로 만든다. 원문은 들어가지 않는다."""
    lines = format_overview_markdown(report) + format_by_label_markdown(report) + format_chat_markdown(report)
    return "\n".join(lines + format_tail_markdown(report, selection_markdown))


def main(argv: Sequence[str] | None = None, environment: Mapping[str, str] | None = None) -> None:
    """인자·경로 확인 → 모델 불러오기 → 채점 → 처리량 → evaluation.json·validation-scores.json 저장 → 요약 출력."""
    arguments = build_argument_parser().parse_args(argv)
    paths = resolve_evaluation_paths(arguments, os.environ if environment is None else environment)
    validate_evaluation_paths(paths, arguments.overwrite)
    arguments.device = modeling.resolve_device(arguments.device)
    model_card = read_model_card(paths.model_directory)
    warn_if_card_incomplete(model_card)
    tokenizer = modeling.load_trained_tokenizer(paths.model_directory)
    model = modeling.move_model_to_device(modeling.load_trained_classifier(paths.model_directory), arguments.device).eval()
    inputs = load_evaluation_inputs(arguments, paths, model_card)
    scores = score_inputs(model, tokenizer, inputs, arguments)
    throughput = measure_cpu_throughput(model, tokenizer, [sample.text for sample in inputs.chat_samples] * THROUGHPUT_REPEAT)
    report = build_report(arguments, paths, model_card, inputs, scores, throughput)
    write_json_atomically(paths.evaluation_output, report)
    write_json_atomically(paths.scores_output, build_scores_payload(report, inputs, scores))
    print(format_report_markdown(report, format_selection_markdown(ThresholdSelection(**report["threshold_selection"]))))
    print(f"\n저장: {paths.evaluation_output.name}, {paths.scores_output.name} → {paths.model_directory}")


if __name__ == "__main__":
    run_command_line(main)
