"""묶음(batch) 처리 시 초당 처리량을 잰다. 도배·레이드처럼 메시지가 몰릴 때의 여유를 보려는 용도다.

직렬 측정(bench_guard.py)의 판정과 묶음 판정이 같은지도 함께 확인한다.
묶음은 왼쪽 패딩을 쓰므로, 결과가 달라지면 묶음 처리를 그대로 쓰면 안 된다는 신호다.
"""

import argparse
import importlib
import json
import time
from pathlib import Path

from mlx_lm import load

generate_module = importlib.import_module("mlx_lm.generate")

# 같은 문장을 몇 번 반복해 표본을 늘릴지. 72건 × 3 = 216건이면 묶음 32에서도 7회 이상 돈다.
REPEAT_COUNT = 3

# 계열별 최대 생성 토큰 수. kanana는 분류 토큰 1개, Qwen은 두 줄 출력 후 EOS.
MAX_TOKENS_BY_FAMILY = {"kanana": 1, "qwen": 24}


def parse_arguments() -> argparse.Namespace:
    """명령행 인자를 읽는다."""
    parser = argparse.ArgumentParser(description="가드 모델 묶음 처리량 측정")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--family", required=True, choices=["kanana", "qwen"])
    parser.add_argument("--run-label", required=True)
    parser.add_argument("--chat-file", required=True)
    parser.add_argument("--serial-rows", required=True, help="bench_guard.py가 만든 같은 모델의 rows.jsonl")
    parser.add_argument("--batch-sizes", default="1,8,16,32")
    parser.add_argument("--out-dir", required=True)
    return parser.parse_args()


def build_prompt(tokenizer, family: str, text: str) -> list[int]:
    """bench_guard.py와 같은 방식으로 프롬프트 토큰을 만든다."""
    if family == "kanana":
        messages = [{"role": "user", "content": text}, {"role": "assistant", "content": ""}]
    else:
        messages = [{"role": "user", "content": text}]
    prompt_text = tokenizer.apply_chat_template(messages, tokenize=False)
    return tokenizer.encode(prompt_text, add_special_tokens=False)


def extract_label(family: str, generated_text: str) -> str:
    """생성 결과에서 라벨만 뽑는다. Qwen은 'Safety: X'의 X, kanana는 토큰 그대로."""
    if family == "kanana":
        return generated_text.strip()
    for label in ("Unsafe", "Controversial", "Safe"):
        if f"Safety: {label}" in generated_text:
            return label
    return "PARSE_ERROR"


def run_batch(model, tokenizer, family: str, prompts: list[list[int]], batch_size: int) -> tuple[float, list[str]]:
    """묶음 크기를 지정해 전체 프롬프트를 처리하고 (경과 초, 라벨 목록)을 돌려준다."""
    start_time = time.perf_counter()
    response = generate_module.batch_generate(
        model, tokenizer, prompts, max_tokens=MAX_TOKENS_BY_FAMILY[family],
        return_token_ids=True, prefill_batch_size=batch_size, completion_batch_size=batch_size,
    )
    elapsed_seconds = time.perf_counter() - start_time
    texts = [tokenizer.decode(token_ids) for token_ids in response.token_ids]
    return elapsed_seconds, [extract_label(family, text) for text in texts]


def load_serial_labels(serial_rows_file: str) -> list[str]:
    """직렬 측정 결과에서 채팅 샘플 라벨만 순서대로 읽는다."""
    rows = [json.loads(line) for line in Path(serial_rows_file).read_text(encoding="utf-8").splitlines()]
    return [row["label"] for row in rows if row["source"] == "chat"]


def main() -> None:
    """묶음 크기별 처리량과 직렬 판정 일치율을 출력·저장한다."""
    arguments = parse_arguments()
    model, tokenizer = load(arguments.model_dir)
    texts = [json.loads(line)["text"] for line in Path(arguments.chat_file).read_text(encoding="utf-8").splitlines()]
    prompts = [build_prompt(tokenizer, arguments.family, text) for text in texts] * REPEAT_COUNT
    serial_labels = load_serial_labels(arguments.serial_rows) * REPEAT_COUNT
    run_batch(model, tokenizer, arguments.family, prompts[:8], 8)  # 워밍업

    results = []
    for batch_size in [int(size) for size in arguments.batch_sizes.split(",")]:
        elapsed_seconds, labels = run_batch(model, tokenizer, arguments.family, prompts, batch_size)
        agreement = sum(label == serial for label, serial in zip(labels, serial_labels)) / len(labels)
        results.append({
            "batch_size": batch_size,
            "messages_per_second": round(len(prompts) / elapsed_seconds, 1),
            "agreement_with_serial": round(agreement, 3),
        })
        print(json.dumps(results[-1]))
    output_path = Path(arguments.out_dir) / f"{arguments.run_label}.batch.json"
    output_path.write_text(json.dumps(results, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
