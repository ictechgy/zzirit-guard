"""1차 분류기(KcELECTRA-base) 미세조정 스크립트. 버리는 스파이크 코드다.

K-HATERS 라벨을 이진(normal=0, offensive/L1_hate/L2_hate=1)으로 바꿔 학습한다.
1차 분류기는 '의심스러운 것만 kanana로 넘기는 거름망'이라 세부 등급보다 유해 점수 하나가 필요하기 때문이다.
가중치는 safetensors만 읽는다(pickle .bin 금지).
"""

import argparse
import json
import math
import random
import time
from pathlib import Path

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

# 길이가 비슷한 문장끼리 묶어 패딩 낭비를 줄이기 위한 '큰 묶음' 배수.
BUCKET_MULTIPLIER = 100

# 학습 손실을 몇 스텝마다 기록할지.
LOG_EVERY_STEPS = 200


def parse_arguments() -> argparse.Namespace:
    """명령행 인자를 읽는다."""
    parser = argparse.ArgumentParser(description="KcELECTRA 1차 분류기 미세조정")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--train-file", required=True)
    parser.add_argument("--val-file", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=5e-5)
    parser.add_argument("--max-length", type=int, default=128)
    parser.add_argument("--max-steps", type=int, default=0, help="0이면 제한 없음. 속도 확인용")
    parser.add_argument("--precision", choices=["fp32", "bf16"], default="fp32")
    parser.add_argument("--seed", type=int, default=20261011)
    return parser.parse_args()


def load_binary_dataset(path: str) -> tuple[list[str], list[int]]:
    """K-HATERS jsonl을 (문장 목록, 이진 라벨 목록)으로 읽는다."""
    texts, labels = [], []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        texts.append(record["text"])
        labels.append(0 if record["label"] == "normal" else 1)
    return texts, labels


def tokenize_all(tokenizer, texts: list[str], max_length: int) -> list[list[int]]:
    """전체 문장을 미리 토큰화한다(패딩 없이). 매 스텝 토큰화 비용을 없애기 위해서다."""
    return tokenizer(texts, truncation=True, max_length=max_length)["input_ids"]


def build_length_bucketed_batches(token_lists: list[list[int]], batch_size: int, random_generator: random.Random) -> list[list[int]]:
    """섞은 뒤 큰 묶음 안에서 길이순 정렬해 배치를 만들고, 배치 순서를 다시 섞는다."""
    indices = list(range(len(token_lists)))
    random_generator.shuffle(indices)
    bucket_size = batch_size * BUCKET_MULTIPLIER
    batches = []
    for bucket_start in range(0, len(indices), bucket_size):
        bucket = sorted(indices[bucket_start:bucket_start + bucket_size], key=lambda index: len(token_lists[index]))
        batches.extend(bucket[start:start + batch_size] for start in range(0, len(bucket), batch_size))
    random_generator.shuffle(batches)
    return batches


def collate(token_lists: list[list[int]], batch_indices: list[int], pad_token_id: int, device: str) -> dict:
    """배치 내 최장 길이에 맞춰 패딩하고 attention_mask를 만든다."""
    max_length = max(len(token_lists[index]) for index in batch_indices)
    input_ids = torch.full((len(batch_indices), max_length), pad_token_id, dtype=torch.long)
    attention_mask = torch.zeros((len(batch_indices), max_length), dtype=torch.long)
    for row, index in enumerate(batch_indices):
        tokens = token_lists[index]
        input_ids[row, : len(tokens)] = torch.tensor(tokens)
        attention_mask[row, : len(tokens)] = 1
    return {"input_ids": input_ids.to(device), "attention_mask": attention_mask.to(device)}


def evaluate(model, token_lists, labels, pad_token_id, device, precision) -> dict:
    """검증셋 정확도·정밀도·재현율·F1(임계값 0.5)을 계산한다."""
    model.eval()
    probabilities = predict_probabilities(model, token_lists, pad_token_id, device, precision)
    model.train()
    predictions = [probability >= 0.5 for probability in probabilities]
    true_positive = sum(p and label for p, label in zip(predictions, labels))
    false_positive = sum(p and not label for p, label in zip(predictions, labels))
    false_negative = sum((not p) and label for p, label in zip(predictions, labels))
    precision_value = true_positive / max(true_positive + false_positive, 1)
    recall_value = true_positive / max(true_positive + false_negative, 1)
    f1 = 2 * precision_value * recall_value / max(precision_value + recall_value, 1e-9)
    accuracy = sum(p == bool(label) for p, label in zip(predictions, labels)) / len(labels)
    return {"accuracy": round(accuracy, 4), "precision": round(precision_value, 4), "recall": round(recall_value, 4), "f1": round(f1, 4)}


@torch.no_grad()
def predict_probabilities(model, token_lists, pad_token_id, device, precision, batch_size: int = 128) -> list[float]:
    """유해(라벨 1) 확률을 순서대로 돌려준다. 길이순으로 처리한 뒤 원래 순서로 되돌린다."""
    order = sorted(range(len(token_lists)), key=lambda index: len(token_lists[index]))
    probabilities = [0.0] * len(token_lists)
    for start in range(0, len(order), batch_size):
        batch_indices = order[start:start + batch_size]
        with autocast_context(device, precision):
            logits = model(**collate(token_lists, batch_indices, pad_token_id, device)).logits
        batch_probabilities = torch.softmax(logits.float(), dim=-1)[:, 1].tolist()
        for index, probability in zip(batch_indices, batch_probabilities):
            probabilities[index] = probability
    return probabilities


def autocast_context(device: str, precision: str):
    """bf16이면 autocast를, 아니면 아무것도 하지 않는 컨텍스트를 돌려준다."""
    if precision == "bf16":
        return torch.autocast(device_type=device, dtype=torch.bfloat16)
    return torch.autocast(device_type=device, enabled=False)


def train(arguments) -> None:
    """미세조정 전체 흐름: 데이터 준비 → 학습 → epoch마다 검증 → 저장."""
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    random_generator = random.Random(arguments.seed)
    torch.manual_seed(arguments.seed)
    tokenizer = AutoTokenizer.from_pretrained(arguments.model_dir)
    model = AutoModelForSequenceClassification.from_pretrained(arguments.model_dir, num_labels=2, use_safetensors=True).to(device)

    train_texts, train_labels = load_binary_dataset(arguments.train_file)
    val_texts, val_labels = load_binary_dataset(arguments.val_file)
    train_tokens = tokenize_all(tokenizer, train_texts, arguments.max_length)
    val_tokens = tokenize_all(tokenizer, val_texts, arguments.max_length)
    print(f"device={device} train={len(train_tokens)} val={len(val_tokens)} 유해비율={sum(train_labels)/len(train_labels):.3f}", flush=True)

    steps_per_epoch = math.ceil(len(train_tokens) / arguments.batch_size)
    total_steps = steps_per_epoch * arguments.epochs
    if arguments.max_steps:
        total_steps = min(total_steps, arguments.max_steps)
    optimizer = torch.optim.AdamW(model.parameters(), lr=arguments.learning_rate, weight_decay=0.01)
    scheduler = get_linear_schedule_with_warmup(optimizer, int(total_steps * 0.06), total_steps)
    run_epochs(arguments, model, tokenizer, optimizer, scheduler, train_tokens, train_labels, val_tokens, val_labels, device, total_steps, random_generator)


def run_epochs(arguments, model, tokenizer, optimizer, scheduler, train_tokens, train_labels, val_tokens, val_labels, device, total_steps, random_generator) -> None:
    """epoch 루프. max-steps에 도달하면 멈추고, 매 epoch 끝에 검증·저장한다."""
    label_tensor = torch.tensor(train_labels)
    model.train()
    step = 0
    start_time = time.perf_counter()
    for epoch in range(arguments.epochs):
        for batch_indices in build_length_bucketed_batches(train_tokens, arguments.batch_size, random_generator):
            loss = train_one_step(model, optimizer, scheduler, train_tokens, label_tensor, batch_indices, tokenizer.pad_token_id, device, arguments.precision)
            step += 1
            if step % LOG_EVERY_STEPS == 0 or step == total_steps:
                elapsed = time.perf_counter() - start_time
                print(f"epoch={epoch} step={step}/{total_steps} loss={loss:.4f} {step/elapsed:.2f}step/s 남은예상={(total_steps-step)/(step/elapsed)/60:.1f}분", flush=True)
            if step >= total_steps:
                break
        metrics = evaluate(model, val_tokens, val_labels, tokenizer.pad_token_id, device, arguments.precision)
        print(f"[검증] epoch={epoch} {json.dumps(metrics)}", flush=True)
        save_model(model, tokenizer, str(Path(arguments.out_dir) / f"epoch-{epoch}"))
        if step >= total_steps:
            break


def train_one_step(model, optimizer, scheduler, train_tokens, label_tensor, batch_indices, pad_token_id, device, precision) -> float:
    """배치 1개로 순전파·역전파·갱신을 하고 손실값을 돌려준다."""
    inputs = collate(train_tokens, batch_indices, pad_token_id, device)
    labels = label_tensor[batch_indices].to(device)
    with autocast_context(device, precision):
        loss = model(**inputs, labels=labels).loss
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
    optimizer.step()
    scheduler.step()
    optimizer.zero_grad(set_to_none=True)
    return loss.item()


def save_model(model, tokenizer, out_dir: str) -> None:
    """미세조정 결과를 safetensors로 저장한다."""
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out_dir, safe_serialization=True)
    tokenizer.save_pretrained(out_dir)


if __name__ == "__main__":
    train(parse_arguments())
