"""1차 분류기(KcELECTRA 이진 거름망) 학습 CLI.

전체 학습: uv run python -m zg_stage1.train                       (ZG_DATA_DIR 또는 ZG_ML_DIR 필요)
스모크:    uv run python -m zg_stage1.train --max-steps 50 --epochs 1 --out-dir <임시 위치>
출력(--out-dir, 기본 <ML 디렉터리>/stage1/kcelectra-<시각>):
  model.safetensors(fp32, 검증 AUC가 가장 높은 epoch), config.json, tokenizer.json, tokenizer_config.json, model-card.json
로그에는 진행 상황과 지표만 쓰고 데이터 원문은 쓰지 않는다(스펙 §8).
"""

from __future__ import annotations

import argparse
import math
import os
import random
import time
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import torch
from transformers import PreTrainedModel, PreTrainedTokenizerBase, get_linear_schedule_with_warmup

from zg_stage1 import modeling
from zg_stage1.arguments import fraction_below_one, non_negative_float, non_negative_integer, positive_float, positive_integer
from zg_stage1.batching import BUCKET_MULTIPLIER, build_length_bucketed_batches
from zg_stage1.data import LabeledText, count_exact_text_overlap, describe_file_provenance, load_labeled_texts
from zg_stage1.inference_contract import build_inference_contract, write_inference_contract_file
from zg_stage1.errors import PathResolutionError, describe_failure, run_command_line
from zg_stage1.metrics import METRIC_DECIMALS, STANDARD_THRESHOLD, compute_roc_auc, summarize_at_threshold
from zg_stage1.model_card import (
    MODEL_CARD_FILE_NAME,
    annotate_reference_match,
    build_initial_model_card,
    utc_timestamp,
    write_json_atomically,
)
from zg_stage1.paths import (
    BASE_MODEL_RELATIVE_PATH,
    KHATERS_RELATIVE_PATH,
    KHATERS_TRAIN_FILE_NAME,
    KHATERS_VALIDATION_FILE_NAME,
    choose_path,
    create_new_output_directory,
    default_training_output_directory,
    ensure_existing_file,
    ensure_output_is_new,
    ensure_outside_repository,
    ensure_safetensors_only,
    resolve_ml_directory,
)
from zg_stage1.thresholds import SPEC_STAGE1_THRESHOLD

# 기본 epoch 수. 스파이크는 2 epoch에서 두 번째가 가장 좋았다(AUC 0.905). 한 번 더 보고 최고 epoch만 남긴다.
DEFAULT_EPOCHS = 3

# 학습 배치 크기(스파이크와 같음). M4 Pro MPS에서 메모리 걱정 없이 도는 크기다.
DEFAULT_BATCH_SIZE = 32

# AdamW 학습률(스파이크와 같음). ELECTRA-base 미세조정에서 흔히 쓰는 값이다.
DEFAULT_LEARNING_RATE = 5e-5

# AdamW 가중치 감쇠(스파이크와 같음).
DEFAULT_WEIGHT_DECAY = 0.01

# 전체 스텝 중 학습률을 0에서 올리는 워밍업 비율(스파이크와 같음). 그 뒤에는 선형으로 0까지 내린다.
DEFAULT_WARMUP_RATIO = 0.06

# 문장당 최대 토큰 수([CLS]·[SEP] 포함). 워커 처리량 측정도 같은 값을 쓴다. 채팅은 대부분 이보다 훨씬 짧다.
DEFAULT_MAX_LENGTH = 128

# 위치 임베딩 한계(config.max_position_embeddings) 때문에 max_length는 이 값을 넘을 수 없다.
MAXIMUM_SUPPORTED_LENGTH = 512

# max_length 하한. [CLS]·[SEP]을 빼고 내용 토큰이 최소 하나는 들어가야 한다.
MINIMUM_SUPPORTED_LENGTH = 3

# 기본 시드(스파이크·회귀 표본과 같은 값).
DEFAULT_SEED = 20261011

# 검증 AUC가 최고치를 넘지 못한 epoch가 연속 이만큼 나오면 멈춘다("두 번 떨어지면 멈춤").
DEFAULT_EARLY_STOP_PATIENCE = 2

# 기울기 노름 상한. 학습 초반의 큰 기울기로 가중치가 튀는 것을 막는다(스파이크와 같음).
GRADIENT_CLIP_NORM = 1.0

# 진행 로그를 몇 스텝마다 찍을지 기본값.
DEFAULT_LOG_EVERY_STEPS = 100

# 검증 추론 배치 크기.
VALIDATION_BATCH_SIZE = modeling.DEFAULT_INFERENCE_BATCH_SIZE

# 종료 이유(모델 카드 stop_reason): 정한 epoch를 모두 돌았다. 사람이 카드만 보고 왜 멈췄는지 알게 한다.
STOP_REASON_COMPLETED = "completed_all_epochs"

# 종료 이유: --max-steps 예산을 다 썼다(스모크 실행).
STOP_REASON_MAX_STEPS = "max_steps_reached"

# 종료 이유: 검증 AUC가 patience만큼 연속으로 최고치를 넘지 못했다.
STOP_REASON_EARLY_STOP = "early_stopped"


@dataclass(frozen=True)
class TrainingPaths:
    """학습 입력·출력 경로. 인자 → 환경 변수 순서로 정한 결과다."""

    base_model_directory: Path
    train_file: Path
    validation_file: Path
    output_directory: Path


@dataclass
class EncodedSplit:
    """토큰화한 데이터 한 묶음(학습 또는 검증). 원문은 토큰화 뒤 들고 있지 않는다."""

    token_lists: list[list[int]]
    labels: list[int]
    label_counts: dict[str, int]
    # 검증 묶음에서만 채운다: 학습 묶음과 완전히 같은 문장의 수(원문은 남기지 않는다).
    train_overlap_count: int = 0

    @property
    def lengths(self) -> list[int]:
        """문장별 토큰 수(길이 기준 배치에 쓴다)."""
        return [len(tokens) for tokens in self.token_lists]


@dataclass(frozen=True)
class ValidationOutcome:
    """epoch 검증 결과. 최고 epoch·조기 종료 비교는 unrounded_auc로 하고, 카드·로그에는 display_metrics(4자리)를 쓴다.

    왜 나누나: 4자리로 반올림한 값끼리 비교하면 실제로 나아진 epoch를 '같음'으로 보거나 작은 하락을 놓친다.
    """

    unrounded_auc: float
    display_metrics: dict


def summarize_validation(scores: Sequence[float], labels: Sequence[int]) -> ValidationOutcome:
    """검증 점수로 AUC(반올림 안 함)와 표시용 지표(AUC 4자리, 임계값 0.5·0.05에서의 지표)를 만든다."""
    unrounded_auc = compute_roc_auc(scores, labels)
    return ValidationOutcome(
        unrounded_auc=unrounded_auc,
        display_metrics={
            "auc": round(unrounded_auc, METRIC_DECIMALS),
            "auc_unrounded": unrounded_auc,
            "at_0_5": summarize_at_threshold(scores, labels, STANDARD_THRESHOLD),
            "at_stage1_threshold": summarize_at_threshold(scores, labels, SPEC_STAGE1_THRESHOLD),
        },
    )


@dataclass
class TrainingProgress:
    """학습 진행 상태: 스텝 예산과 지금까지의 스텝, 최고 검증 AUC와 그 epoch, 개선 없는 epoch 수."""

    total_steps: int
    completed_steps: int = 0
    best_auc: float | None = None
    best_epoch: int | None = None
    epochs_without_improvement: int = 0
    started_clock: float = field(default_factory=time.perf_counter)

    @property
    def is_step_budget_exhausted(self) -> bool:
        """스텝 예산을 다 썼는지."""
        return self.completed_steps >= self.total_steps

    def elapsed_seconds(self) -> float:
        """학습 시작 뒤 지난 시간(초). 검증 시간도 포함한다."""
        return time.perf_counter() - self.started_clock

    def record_validation(self, epoch: int, auc: float) -> bool:
        """epoch의 검증 AUC를 반영하고, 최고 기록이면 True를 돌려준다(같은 값은 개선이 아니다)."""
        is_best = self.best_auc is None or auc > self.best_auc
        if is_best:
            self.best_auc, self.best_epoch, self.epochs_without_improvement = auc, epoch, 0
        else:
            self.epochs_without_improvement += 1
        return is_best


def build_argument_parser() -> argparse.ArgumentParser:
    """train CLI의 인자 정의를 만든다. 값 범위 검사는 arguments 모듈의 type 함수가 한다."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage1.train", description="KcELECTRA 1차 분류기(이진) 미세조정")
    add_path_arguments(parser)
    add_hyperparameter_arguments(parser)
    parser.add_argument("--device", choices=modeling.DEVICE_CHOICES, default="auto", help="학습 장치(기본 auto: MPS가 되면 mps)")
    parser.add_argument("--max-steps", type=non_negative_integer, default=0, help="전체 스텝 상한. 0이면 제한 없음(스모크용)")
    parser.add_argument("--log-every-steps", type=positive_integer, default=DEFAULT_LOG_EVERY_STEPS, help="진행 로그 간격(스텝)")
    return parser


def add_path_arguments(parser: argparse.ArgumentParser) -> None:
    """경로 인자를 더한다. 주지 않으면 --ml-dir·ZG_ML_DIR·ZG_DATA_DIR/ml 아래 기본 위치를 쓴다."""
    parser.add_argument("--ml-dir", help="ML 자료 최상위(기본: $ZG_ML_DIR 또는 $ZG_DATA_DIR/ml)")
    parser.add_argument("--base-model-dir", help="기반 모델 디렉터리(기본: <ML>/base/kcelectra-base)")
    parser.add_argument("--train-file", help="학습 JSONL(기본: <ML>/data/k-haters/train_v2.jsonl)")
    parser.add_argument("--val-file", help="검증 JSONL(기본: <ML>/data/k-haters/val_v2.jsonl)")
    parser.add_argument("--out-dir", help="출력 디렉터리. 이미 있으면 거부한다(기본: <ML>/stage1/kcelectra-<시각>)")


def add_hyperparameter_arguments(parser: argparse.ArgumentParser) -> None:
    """학습 설정 인자를 더한다. 기본값은 스파이크에서 쓴 값이다."""
    parser.add_argument("--epochs", type=positive_integer, default=DEFAULT_EPOCHS, help="최대 epoch 수(기본 3)")
    parser.add_argument("--batch-size", type=positive_integer, default=DEFAULT_BATCH_SIZE, help="학습 배치 크기(기본 32)")
    parser.add_argument("--learning-rate", type=positive_float, default=DEFAULT_LEARNING_RATE, help="학습률(기본 5e-5)")
    parser.add_argument("--weight-decay", type=non_negative_float, default=DEFAULT_WEIGHT_DECAY, help="가중치 감쇠(기본 0.01)")
    parser.add_argument("--warmup-ratio", type=fraction_below_one, default=DEFAULT_WARMUP_RATIO, help="워밍업 비율(기본 0.06)")
    parser.add_argument("--max-length", type=positive_integer, default=DEFAULT_MAX_LENGTH, help="최대 토큰 수(기본 128)")
    parser.add_argument("--seed", type=non_negative_integer, default=DEFAULT_SEED, help="난수 시드")
    parser.add_argument(
        "--early-stop-patience", type=positive_integer, default=DEFAULT_EARLY_STOP_PATIENCE, help="개선 없는 epoch가 연속 이만큼이면 멈춤(기본 2)"
    )


def parse_arguments(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """인자를 읽고, 서로 얽힌 값(max_length 범위)을 검사한다. 잘못되면 argparse가 사용법과 함께 종료 코드 2로 끝낸다."""
    parser = build_argument_parser()
    arguments = parser.parse_args(argv)
    if not MINIMUM_SUPPORTED_LENGTH <= arguments.max_length <= MAXIMUM_SUPPORTED_LENGTH:
        parser.error(f"--max-length는 {MINIMUM_SUPPORTED_LENGTH}~{MAXIMUM_SUPPORTED_LENGTH} 사이여야 합니다(받은 값: {arguments.max_length}).")
    return arguments


def resolve_training_paths(arguments: argparse.Namespace, environment: Mapping[str, str], started_at: datetime) -> TrainingPaths:
    """인자와 환경 변수로 입력·출력 경로를 정한다. ML 디렉터리는 기본값이 필요할 때만 계산한다."""

    def ml_directory() -> Path:
        """ML 자료 최상위 디렉터리(인자 → ZG_ML_DIR → ZG_DATA_DIR/ml)."""
        return resolve_ml_directory(arguments.ml_dir, environment)

    return TrainingPaths(
        base_model_directory=choose_path(arguments.base_model_dir, lambda: ml_directory() / BASE_MODEL_RELATIVE_PATH),
        train_file=choose_path(arguments.train_file, lambda: ml_directory() / KHATERS_RELATIVE_PATH / KHATERS_TRAIN_FILE_NAME),
        validation_file=choose_path(arguments.val_file, lambda: ml_directory() / KHATERS_RELATIVE_PATH / KHATERS_VALIDATION_FILE_NAME),
        output_directory=choose_path(arguments.out_dir, lambda: default_training_output_directory(ml_directory(), started_at)),
    )


def validate_training_paths(paths: TrainingPaths) -> None:
    """무거운 작업 전에 입력이 있는지, 가중치가 safetensors뿐인지, 출력 위치가 저장소 밖이고 비어 있는지 확인한다."""
    ensure_safetensors_only(paths.base_model_directory)
    ensure_existing_file(paths.train_file, "학습 데이터")
    ensure_existing_file(paths.validation_file, "검증 데이터")
    ensure_distinct_train_and_validation_files(paths)
    ensure_outside_repository(paths.output_directory)
    ensure_output_is_new(paths.output_directory)


def ensure_distinct_train_and_validation_files(paths: TrainingPaths) -> None:
    """학습·검증 경로가 (심볼릭 링크를 풀어도) 같은 파일이면 거부한다.

    왜: 같은 파일을 양쪽에 주면 검증 AUC·조기 종료·최고 epoch 선택이 학습 데이터 위에서 돌아 일반화 성능이 부풀려진다.
    """
    if paths.train_file.resolve() == paths.validation_file.resolve():
        raise PathResolutionError("학습 파일과 검증 파일이 같은 파일입니다. --train-file과 --val-file에 서로 다른 파일을 주세요.")


def compute_total_steps(example_count: int, batch_size: int, epochs: int, max_steps: int) -> int:
    """전체 스텝 수 = epoch당 배치 수 × epoch 수. --max-steps(0이 아니면)로 상한을 둔다."""
    planned_steps = math.ceil(example_count / batch_size) * epochs
    return min(planned_steps, max_steps) if max_steps else planned_steps


def encode_split(tokenizer: PreTrainedTokenizerBase, records: list[LabeledText], max_length: int) -> EncodedSplit:
    """레코드를 토큰화해 EncodedSplit으로 만든다. 원래 라벨별 건수도 센다(모델 카드용)."""
    return EncodedSplit(
        token_lists=modeling.encode_texts(tokenizer, [record.text for record in records], max_length),
        labels=[record.binary_label for record in records],
        label_counts=dict(sorted(Counter(record.original_label for record in records).items())),
    )


def build_optimizer_and_scheduler(
    model: PreTrainedModel, arguments: argparse.Namespace, total_steps: int
) -> tuple[torch.optim.Optimizer, torch.optim.lr_scheduler.LambdaLR]:
    """AdamW와 선형 워밍업·감쇠 스케줄러를 만든다. 워밍업 스텝은 전체의 warmup_ratio(올림)다."""
    optimizer = torch.optim.AdamW(model.parameters(), lr=arguments.learning_rate, weight_decay=arguments.weight_decay)
    warmup_steps = math.ceil(total_steps * arguments.warmup_ratio)
    return optimizer, get_linear_schedule_with_warmup(optimizer, warmup_steps, total_steps)


def describe_hyperparameters(arguments: argparse.Namespace, total_steps: int) -> dict:
    """모델 카드에 남길 학습 설정. 경로는 넣지 않는다."""
    return {
        "epochs": arguments.epochs,
        "batch_size": arguments.batch_size,
        "learning_rate": arguments.learning_rate,
        "weight_decay": arguments.weight_decay,
        "warmup_ratio": arguments.warmup_ratio,
        "warmup_steps": math.ceil(total_steps * arguments.warmup_ratio),
        "max_length": arguments.max_length,
        "max_steps": arguments.max_steps,
        "total_steps": total_steps,
        "seed": arguments.seed,
        "early_stop_patience": arguments.early_stop_patience,
        "gradient_clip_norm": GRADIENT_CLIP_NORM,
        "optimizer": "AdamW",
        "scheduler": "linear warmup + linear decay",
        "length_bucket_multiplier": BUCKET_MULTIPLIER,
        "precision": "fp32",
    }


@dataclass
class TrainingSession:
    """학습 한 번의 상태(모델·옵티마이저·데이터·진행·모델 카드)를 묶는다. main은 만든 뒤 run_and_record()만 부른다."""

    arguments: argparse.Namespace
    paths: TrainingPaths
    device: str
    tokenizer: PreTrainedTokenizerBase
    model: PreTrainedModel
    train_split: EncodedSplit
    validation_split: EncodedSplit
    optimizer: torch.optim.Optimizer
    scheduler: torch.optim.lr_scheduler.LambdaLR
    progress: TrainingProgress
    model_card: dict
    random_generator: random.Random

    def run_and_record(self) -> None:
        """학습을 돌리고, 중단·오류가 나면 카드에 그 사실을 남긴 뒤 예외를 다시 올린다(삼키지 않는다)."""
        try:
            self.run()
        except BaseException as error:
            self.model_card.update(
                status="interrupted",
                stop_reason=type(error).__name__,
                failure_message=describe_failure(error),
                finished_at=utc_timestamp(),
            )
            self.write_model_card()
            print(f"[중단] {type(error).__name__}: 지금까지의 최고 epoch는 {self.progress.best_epoch}입니다. 카드에 기록했습니다.", flush=True)
            raise

    def run(self) -> None:
        """epoch를 돌며 학습·검증·저장을 하고, 스텝 예산이나 조기 종료 조건에 걸리면 멈춘다."""
        stop_reason = STOP_REASON_COMPLETED
        for epoch in range(1, self.arguments.epochs + 1):
            mean_loss = self.train_epoch(epoch)
            self.finish_epoch(epoch, mean_loss)
            early_reason = self.decide_early_stop_reason(epoch)
            if early_reason:
                stop_reason = early_reason
                break
        self.finalize(stop_reason)

    def decide_early_stop_reason(self, epoch: int) -> str | None:
        """epoch를 마친 뒤 일찍 멈출 이유를 돌려준다. --max-steps 예산을 다 썼거나, 남은 epoch가 있는데
        개선 없는 epoch가 patience에 닿았을 때다. 마지막 epoch는 조기 종료가 아니라 완료로 본다."""
        if self.arguments.max_steps and self.progress.is_step_budget_exhausted:
            return STOP_REASON_MAX_STEPS
        has_remaining_epochs = epoch < self.arguments.epochs
        if has_remaining_epochs and self.progress.epochs_without_improvement >= self.arguments.early_stop_patience:
            return STOP_REASON_EARLY_STOP
        return None

    def train_epoch(self, epoch: int) -> float:
        """한 epoch를 학습하고 평균 손실을 돌려준다. 스텝 예산이 다 되면 epoch 중간에 멈춘다."""
        self.model.train()
        loss_sum, epoch_steps = torch.zeros((), device=self.device), 0
        for batch_indices in build_length_bucketed_batches(self.train_split.lengths, self.arguments.batch_size, self.random_generator):
            if self.progress.is_step_budget_exhausted:
                break
            loss_sum += self.train_step(batch_indices)
            epoch_steps += 1
            self.progress.completed_steps += 1
            if self.progress.completed_steps % self.arguments.log_every_steps == 0:
                self.log_progress(epoch, (loss_sum / epoch_steps).item())
        return (loss_sum / max(epoch_steps, 1)).item()

    def train_step(self, batch_indices: list[int]) -> torch.Tensor:
        """배치 1개로 순전파·역전파·갱신을 하고, 그래프에서 떼어 낸 손실 텐서를 돌려준다.

        손실을 매번 .item()으로 꺼내지 않는 이유: MPS에서 스텝마다 동기화가 생겨 느려지기 때문이다.
        """
        batch = modeling.collate_batch(self.train_split.token_lists, batch_indices, self.tokenizer.pad_token_id)
        labels = torch.tensor([self.train_split.labels[index] for index in batch_indices], dtype=torch.long, device=self.device)
        loss = self.model(**modeling.move_batch_to_device(batch, self.device), labels=labels).loss
        loss.backward()
        torch.nn.utils.clip_grad_norm_(self.model.parameters(), GRADIENT_CLIP_NORM)
        self.optimizer.step()
        self.scheduler.step()
        self.optimizer.zero_grad(set_to_none=True)
        return loss.detach()

    def log_progress(self, epoch: int, mean_loss: float) -> None:
        """진행 로그 한 줄(epoch·스텝·평균 손실·학습률·속도·남은 예상 시간)을 찍는다. 원문은 찍지 않는다."""
        elapsed = self.progress.elapsed_seconds()
        steps_per_second = self.progress.completed_steps / elapsed
        remaining_minutes = (self.progress.total_steps - self.progress.completed_steps) / steps_per_second / 60
        print(
            f"[학습] epoch={epoch} step={self.progress.completed_steps}/{self.progress.total_steps} loss={mean_loss:.4f} "
            f"lr={self.scheduler.get_last_lr()[0]:.2e} elapsed={elapsed:.1f}s {steps_per_second:.2f}step/s 남은예상={remaining_minutes:.1f}분",
            flush=True,
        )

    def validate(self) -> ValidationOutcome:
        """검증셋 점수를 계산해 비교용(반올림 안 함)·표시용 지표로 요약한다."""
        scores = modeling.predict_toxic_probabilities(
            self.model, self.validation_split.token_lists, self.tokenizer.pad_token_id, self.device, VALIDATION_BATCH_SIZE
        )
        return summarize_validation(scores, self.validation_split.labels)

    def finish_epoch(self, epoch: int, mean_loss: float) -> None:
        """검증하고, 최고 AUC면 가중치를 저장한 뒤 카드에 epoch 결과를 남긴다(저장 → 카드 순서라 카드가 앞서지 않는다)."""
        started_clock = time.perf_counter()
        outcome = self.validate()
        is_best = self.progress.record_validation(epoch, outcome.unrounded_auc)
        if is_best:
            self.save_best_model()
        metrics = outcome.display_metrics
        self.record_epoch(epoch, mean_loss, metrics, is_best, time.perf_counter() - started_clock)
        at_threshold = metrics["at_stage1_threshold"]
        print(
            f"[검증] epoch={epoch} auc={metrics['auc']:.4f} f1@0.5={metrics['at_0_5']['f1']:.4f} "
            f"recall@{SPEC_STAGE1_THRESHOLD}={at_threshold['toxic_recall']:.4f} forward@{SPEC_STAGE1_THRESHOLD}={at_threshold['forward_rate']:.4f}"
            f"{' (최고, 저장함)' if is_best else ''}",
            flush=True,
        )

    def save_best_model(self) -> None:
        """현재 가중치를 원자적으로 저장하고, 저장한 토크나이저가 메모리의 것과 같은 토큰을 내는지 다시 불러와 확인한다."""
        state_dict = modeling.copy_state_to_cpu(self.model)
        modeling.save_classifier_atomically(self.model, self.tokenizer, state_dict, self.paths.output_directory)
        modeling.verify_saved_tokenizer_round_trip(self.tokenizer, self.paths.output_directory, self.arguments.max_length)

    def record_epoch(self, epoch: int, mean_loss: float, metrics: dict, is_best: bool, validation_seconds: float) -> None:
        """epoch 결과를 카드에 덧붙이고 최고 epoch 정보를 갱신해 저장한다."""
        self.model_card["epochs"].append(
            {
                "epoch": epoch,
                "completed_steps": self.progress.completed_steps,
                "mean_train_loss": round(mean_loss, METRIC_DECIMALS),
                "validation": metrics,
                "validation_seconds": round(validation_seconds, 1),
                "is_best": is_best,
                "finished_at": utc_timestamp(),
            }
        )
        best_auc = self.progress.best_auc
        self.model_card.update(
            chosen_epoch=self.progress.best_epoch,
            best_validation_auc=None if best_auc is None else round(best_auc, METRIC_DECIMALS),
            best_validation_auc_unrounded=best_auc,
        )
        self.write_model_card()

    def finalize(self, stop_reason: str) -> None:
        """카드를 완료 상태로 만들고 요약을 출력한다."""
        elapsed = self.progress.elapsed_seconds()
        self.model_card.update(
            status="completed",
            stop_reason=stop_reason,
            finished_at=utc_timestamp(),
            completed_steps=self.progress.completed_steps,
            elapsed_seconds=round(elapsed, 1),
        )
        self.write_model_card()
        print(
            f"[완료] {stop_reason}: 최고 epoch={self.progress.best_epoch} 검증 AUC={self.progress.best_auc:.4f} "
            f"스텝={self.progress.completed_steps} 걸린 시간={elapsed / 60:.1f}분 → {self.paths.output_directory}",
            flush=True,
        )

    def write_model_card(self) -> None:
        """카드를 출력 디렉터리에 원자적으로 쓴다."""
        write_json_atomically(self.paths.output_directory / MODEL_CARD_FILE_NAME, self.model_card)


def load_and_encode_splits(tokenizer: PreTrainedTokenizerBase, paths: TrainingPaths, max_length: int) -> tuple[EncodedSplit, EncodedSplit]:
    """학습·검증 데이터를 읽어 토큰화한다. 원문은 이 함수 밖으로 나가지 않는다."""
    train_records = load_labeled_texts(paths.train_file)
    validation_records = load_labeled_texts(paths.validation_file)
    train_split = encode_split(tokenizer, train_records, max_length)
    validation_split = encode_split(tokenizer, validation_records, max_length)
    validation_split.train_overlap_count = count_exact_text_overlap(train_records, validation_records)
    toxic_ratio = sum(train_split.labels) / len(train_split.labels)
    print(
        f"[준비] 학습 {len(train_split.labels)}건(유해 비율 {toxic_ratio:.3f}) 검증 {len(validation_split.labels)}건 max_length={max_length}",
        flush=True,
    )
    print(f"[준비] 학습·검증 완전 일치 문장 {validation_split.train_overlap_count}건(공식 분할에도 있을 수 있어 오류는 아님)", flush=True)
    return train_split, validation_split


def describe_inputs(paths: TrainingPaths, train_split: EncodedSplit, validation_split: EncodedSplit) -> tuple[dict, dict]:
    """모델 카드용 기반 모델·학습 데이터 출처(이름·크기·sha256·고정 리비전 일치 여부·라벨별 건수)를 만든다."""
    base_model = {
        "directory_name": paths.base_model_directory.name,
        "weights": [annotate_reference_match(describe_file_provenance(path)) for path in ensure_safetensors_only(paths.base_model_directory)],
    }
    training_data = {
        "train": {**annotate_reference_match(describe_file_provenance(paths.train_file)), "label_counts": train_split.label_counts},
        "validation": {
            **annotate_reference_match(describe_file_provenance(paths.validation_file)),
            "label_counts": validation_split.label_counts,
            "exact_text_overlap_with_train": validation_split.train_overlap_count,
        },
    }
    return base_model, training_data


def prepare_output_directory(output_directory: Path, tokenizer: PreTrainedTokenizerBase, max_length: int) -> None:
    """출력 디렉터리를 새로 만들고(있으면 거부) 워커용 추론 계약(inference.json)을 먼저 써 둔다.

    계약은 학습 내내 바뀌지 않으므로 처음에 한 번 쓴다. 워커는 이 파일의 max_length·입력 형식을 따른다.
    """
    create_new_output_directory(output_directory)
    write_inference_contract_file(output_directory, build_inference_contract(tokenizer, max_length))


def create_training_session(arguments: argparse.Namespace, paths: TrainingPaths, device: str) -> TrainingSession:
    """모델·데이터·옵티마이저·카드를 준비해 TrainingSession을 만든다. 출력 디렉터리는 준비가 끝난 뒤에 만든다
    (준비 중 실패하면 빈 디렉터리가 남아 다음 실행이 덮어쓰기 거부에 걸리는 일을 막기 위해서다)."""
    tokenizer = modeling.load_base_tokenizer(paths.base_model_directory)
    model = modeling.move_model_to_device(modeling.load_base_classifier(paths.base_model_directory), device)
    train_split, validation_split = load_and_encode_splits(tokenizer, paths, arguments.max_length)
    total_steps = compute_total_steps(len(train_split.labels), arguments.batch_size, arguments.epochs, arguments.max_steps)
    optimizer, scheduler = build_optimizer_and_scheduler(model, arguments, total_steps)
    base_model, training_data = describe_inputs(paths, train_split, validation_split)
    card = build_initial_model_card(base_model, training_data, describe_hyperparameters(arguments, total_steps), device, modeling.INPUT_FORMAT_DESCRIPTION)
    prepare_output_directory(paths.output_directory, tokenizer, arguments.max_length)
    print(f"[준비] device={device} 전체 스텝={total_steps} 출력={paths.output_directory}", flush=True)
    return TrainingSession(
        arguments=arguments,
        paths=paths,
        device=device,
        tokenizer=tokenizer,
        model=model,
        train_split=train_split,
        validation_split=validation_split,
        optimizer=optimizer,
        scheduler=scheduler,
        progress=TrainingProgress(total_steps=total_steps),
        model_card=card,
        random_generator=random.Random(arguments.seed),
    )


def main(argv: Sequence[str] | None = None, environment: Mapping[str, str] | None = None) -> None:
    """인자 확인 → 경로 확인 → 시드 고정 → 준비 → 학습. 사용자 오류는 run_command_line이 메시지로 바꾼다."""
    arguments = parse_arguments(argv)
    paths = resolve_training_paths(arguments, os.environ if environment is None else environment, datetime.now())
    validate_training_paths(paths)
    device = modeling.resolve_device(arguments.device)
    modeling.set_global_seed(arguments.seed)
    create_training_session(arguments, paths, device).run_and_record()


if __name__ == "__main__":
    run_command_line(main)
