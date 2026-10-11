"""가드 모델(kanana-safeguard / Qwen3Guard-Gen) 스파이크 측정 스크립트.

버리는 코드다. 목적은 세 가지:
1) 메시지 1건당 판정 지연(ms), 2) 메모리 사용량, 3) 한국어 방송 채팅 샘플·K-HATERS 판정 결과.
모델 디렉터리는 신뢰하지 않는 다운로드물이므로 trust_remote_code 없이 safetensors만 읽는다.
"""

import argparse
import importlib
import json
import random
import re
import statistics
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import mlx.core as mx
from mlx_lm import load

# mlx_lm 패키지가 generate 함수를 같은 이름으로 내보내서, 모듈은 importlib로 가져와야 한다.
generate_module = importlib.import_module("mlx_lm.generate")
cache_module = importlib.import_module("mlx_lm.models.cache")

# kanana-safeguard가 출력하는 분류 토큰 목록(모델 카드의 chat_template 기준).
KANANA_LABEL_TOKENS = ["<SAFE>"] + [f"<UNSAFE-S{index}>" for index in range(1, 8)]

# Qwen3Guard 출력 파싱 정규식(모델 카드 Quickstart 코드와 동일).
QWEN_SAFETY_PATTERN = re.compile(r"Safety: (Safe|Unsafe|Controversial)")
QWEN_CATEGORY_PATTERN = re.compile(
    r"(Violent|Non-violent Illegal Acts|Sexual Content or Sexual Acts|PII|Suicide & Self-Harm"
    r"|Unethical Acts|Politically Sensitive Topics|Copyright Violation|Jailbreak|None)"
)

# Qwen 출력은 "Safety: X\nCategories: Y" 두 줄이면 충분하다. 넉넉히 잡되 무한 생성은 막는다.
QWEN_MAX_NEW_TOKENS = 32


@dataclass
class Sample:
    """판정할 문장 1건. source는 chat(직접 작성) 또는 khaters(K-HATERS test)."""

    source: str
    sample_id: int
    text: str
    group: str
    expected: str


@dataclass
class Verdict:
    """모델 1회 판정 결과. unsafe_probability는 계산 가능한 경우에만 채운다."""

    raw_output: str
    label: str
    categories: list[str] = field(default_factory=list)
    unsafe_probability: float | None = None
    prompt_token_count: int = 0


def parse_arguments() -> argparse.Namespace:
    """명령행 인자를 읽는다. 모델 경로와 계열(kanana/qwen)은 필수다."""
    parser = argparse.ArgumentParser(description="가드 모델 스파이크 측정")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--family", required=True, choices=["kanana", "qwen"])
    parser.add_argument("--run-label", required=True)
    parser.add_argument("--chat-file", required=True)
    parser.add_argument("--khaters-file", required=True)
    parser.add_argument("--khaters-per-label", type=int, default=100)
    parser.add_argument("--seed", type=int, default=20261011)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--prefix-cache", action="store_true", help="고정 템플릿 앞부분 KV 캐시 재사용")
    parser.add_argument("--label-only", action="store_true", help="Qwen: Safety 라벨까지만 생성(카테고리 생략)")
    return parser.parse_args()


def load_chat_samples(chat_file: str) -> list[Sample]:
    """직접 작성한 방송 채팅 샘플(jsonl)을 읽는다."""
    samples = []
    for line in Path(chat_file).read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        samples.append(Sample("chat", record["id"], record["text"], record["group"], record["expected"]))
    return samples


def load_khaters_samples(khaters_file: str, per_label: int, seed: int) -> list[Sample]:
    """K-HATERS test에서 라벨별로 같은 수를 고정 시드로 뽑는다(라벨 불균형 보정)."""
    records_by_label: dict[str, list[dict]] = {}
    for line in Path(khaters_file).read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        records_by_label.setdefault(record["label"], []).append(record)
    random_generator = random.Random(seed)
    samples = []
    for label in sorted(records_by_label):
        for record in random_generator.sample(records_by_label[label], per_label):
            expected = "allow" if label == "normal" else "harmful"
            samples.append(Sample("khaters", record["id"], record["text"], label, expected))
    return samples


def encode_prompt(tokenizer, messages: list[dict]) -> list[int]:
    """chat_template을 문자열로 적용한 뒤 특수 토큰 추가 없이 토큰화한다.

    모델 카드 예제(apply_chat_template → 토큰화)와 같은 입력을 만들기 위해서다.
    transformers 5에서 tokenize=True의 반환형이 바뀌어 문자열 경로를 쓴다.
    """
    prompt_text = tokenizer.apply_chat_template(messages, tokenize=False)
    return tokenizer.encode(prompt_text, add_special_tokens=False)


def resolve_kanana_label_ids(tokenizer) -> dict[int, str]:
    """kanana 분류 토큰이 각각 단일 토큰인지 확인하고 id→토큰 표를 만든다."""
    label_ids = {}
    for label_token in KANANA_LABEL_TOKENS:
        token_ids = tokenizer.encode(label_token, add_special_tokens=False)
        if len(token_ids) != 1:
            raise ValueError(f"{label_token}이 단일 토큰이 아님({token_ids}). 토크나이저 파일이 다른 버전인지 확인 필요")
        label_ids[token_ids[0]] = label_token
    return label_ids


def build_kanana_messages(text: str) -> list[dict]:
    """kanana-safeguard 사용자 발화 판정용 메시지. 모델 카드대로 빈 assistant 메시지를 붙인다."""
    return [{"role": "user", "content": text}, {"role": "assistant", "content": ""}]


def classify_with_kanana(model, tokenizer, label_ids: dict[int, str], text: str, prefix_cache) -> Verdict:
    """kanana-safeguard로 1건 판정한다. 다음 토큰 1개(greedy)와 분류 토큰 확률을 함께 얻는다.

    generate_step은 다음 토큰을 미리 계산(파이프라이닝)해서 1토큰만 필요해도 디코드를 한 번 더 돈다.
    그래서 프롬프트 순전파 1회의 마지막 logits만 쓴다(모델 카드의 max_new_tokens=1과 같은 결과).
    """
    prompt_ids = encode_prompt(tokenizer, build_kanana_messages(text))
    input_ids, cache = select_input(prompt_ids, prefix_cache)
    # bf16 그대로 지수를 취하면 확률 합이 1을 넘는 반올림 오차가 생겨 float32로 올린다.
    last_logits = model(mx.array(input_ids)[None], cache=cache)[0, -1].astype(mx.float32)
    logprobs = last_logits - mx.logsumexp(last_logits)
    token = mx.argmax(logprobs)
    mx.eval(token, logprobs)
    if cache is not None:
        prefix_cache.rewind()
    output_token = tokenizer.decode([int(token.item())])
    probabilities = mx.exp(logprobs[mx.array(list(label_ids))]).tolist()
    probability_by_label = dict(zip(label_ids.values(), probabilities))
    unsafe_probability = sum(value for key, value in probability_by_label.items() if key != "<SAFE>")
    return Verdict(output_token, output_token, [], unsafe_probability, len(prompt_ids))


def resolve_qwen_label_ids(tokenizer) -> dict[int, str]:
    """' Safe' / ' Unsafe' / ' Controversial'의 첫 토큰 id를 구한다. 겹치면 확률 계산을 포기한다."""
    label_ids = {}
    for label_word in ["Safe", "Unsafe", "Controversial"]:
        first_token_id = tokenizer.encode(" " + label_word, add_special_tokens=False)[0]
        label_ids[first_token_id] = label_word
    return label_ids if len(label_ids) == 3 else {}


class PrefixCache:
    """모든 메시지에 공통인 템플릿 앞부분(정책문)의 KV 캐시를 한 번만 계산해 재사용한다.

    Qwen3Guard 템플릿은 메시지 앞에 약 250토큰의 고정 정책문이 붙어 매번 다시 계산하면 낭비다.
    접두부를 캐시에 넣어 두고, 판정이 끝날 때마다 캐시를 접두부 길이로 되감는다(trim).
    """

    def __init__(self, model, prefix_ids: list[int]):
        self.prefix_ids = prefix_ids
        self.fallback_count = 0
        self.cache = cache_module.make_prompt_cache(model)
        model(mx.array(prefix_ids)[None], cache=self.cache)
        mx.eval([layer_cache.state for layer_cache in self.cache])

    def split_prompt(self, prompt_ids: list[int]) -> list[int] | None:
        """프롬프트가 접두부로 시작하면 나머지 토큰을 돌려준다. 아니면 None(전체 재계산, 횟수 기록)."""
        if prompt_ids[: len(self.prefix_ids)] != self.prefix_ids:
            self.fallback_count += 1
            return None
        return prompt_ids[len(self.prefix_ids):]

    def rewind(self) -> None:
        """판정 중 쌓인 토큰을 지워 캐시를 접두부 상태로 되돌린다."""
        extra_token_count = self.cache[0].offset - len(self.prefix_ids)
        cache_module.trim_prompt_cache(self.cache, extra_token_count)


def find_common_prefix_ids(tokenizer, build_messages) -> list[int]:
    """내용만 다른 두 프롬프트의 공통 앞 토큰을 구한다. 내용 첫 글자와 합쳐지는 토큰은 자연히 빠진다."""
    first_ids = encode_prompt(tokenizer, build_messages("가나다"))
    second_ids = encode_prompt(tokenizer, build_messages("ㅋㅋ 123"))
    common_length = 0
    while first_ids[common_length] == second_ids[common_length]:
        common_length += 1
    return first_ids[:common_length]


def select_input(prompt_ids: list[int], prefix_cache: PrefixCache | None) -> tuple[list[int], list | None]:
    """접두 캐시를 쓸 수 있으면 (나머지 토큰, 캐시), 아니면 (전체 토큰, None)을 돌려준다."""
    remaining_ids = prefix_cache.split_prompt(prompt_ids) if prefix_cache else None
    if remaining_ids is None:
        return prompt_ids, None
    return remaining_ids, prefix_cache.cache


def build_qwen_messages(text: str) -> list[dict]:
    """Qwen3Guard 프롬프트 판정(사용자 발화 검사)용 메시지."""
    return [{"role": "user", "content": text}]


def classify_with_qwen(
    model, tokenizer, label_ids: dict[int, str], text: str, prefix_cache: PrefixCache | None, label_only: bool
) -> Verdict:
    """Qwen3Guard-Gen으로 1건 판정한다. 'Categories:' 줄이 끝나거나 EOS면 멈춘다."""
    prompt_ids = encode_prompt(tokenizer, build_qwen_messages(text))
    input_ids, cache = select_input(prompt_ids, prefix_cache)
    steps = generate_module.generate_step(mx.array(input_ids), model, max_tokens=QWEN_MAX_NEW_TOKENS, prompt_cache=cache)
    raw_output, label_probabilities = collect_qwen_output(tokenizer, label_ids, steps, label_only)
    if cache is not None:
        prefix_cache.rewind()
    return build_qwen_verdict(raw_output, label_probabilities, len(prompt_ids))


def collect_qwen_output(tokenizer, label_ids: dict[int, str], steps, label_only: bool) -> tuple[str, dict[str, float]]:
    """생성 토큰을 모으며 라벨 토큰 시점의 확률을 기록한다. 끝나면 생성기를 닫아 선계산을 멈춘다.

    label_only면 라벨 첫 토큰 직후 멈춘다. 첫 토큰이 세 라벨에서 서로 달라 라벨이 이미 확정되기 때문이다.
    """
    generated_ids: list[int] = []
    label_probabilities: dict[str, float] = {}
    for token, logprobs in steps:
        token_id = int(token)
        if token_id in tokenizer.eos_token_ids:
            break
        if token_id in label_ids and not label_probabilities:
            probabilities = mx.exp(logprobs[mx.array(list(label_ids))].astype(mx.float32)).tolist()
            label_probabilities = dict(zip(label_ids.values(), probabilities))
        generated_ids.append(token_id)
        if label_only and label_probabilities:
            generated_ids.extend(complete_label_ids(tokenizer, label_ids[token_id]))
            break
        if is_qwen_output_complete(tokenizer.decode(generated_ids)):
            break
    steps.close()
    return tokenizer.decode(generated_ids), label_probabilities


def complete_label_ids(tokenizer, label_word: str) -> list[int]:
    """라벨 첫 토큰만 생성하고 멈췄을 때, 파싱이 되도록 라벨의 나머지 토큰을 채운다(생성이 아니라 표기용)."""
    return tokenizer.encode(" " + label_word, add_special_tokens=False)[1:]


def is_qwen_output_complete(decoded_text: str) -> bool:
    """'Categories:' 줄이 줄바꿈으로 끝났으면 더 생성할 필요가 없다."""
    category_position = decoded_text.find("Categories:")
    return category_position >= 0 and "\n" in decoded_text[category_position:]


def build_qwen_verdict(raw_output: str, label_probabilities: dict[str, float], prompt_token_count: int) -> Verdict:
    """Qwen 출력 문자열을 라벨·카테고리로 파싱한다. 파싱 실패는 PARSE_ERROR로 남긴다(무시하지 않음)."""
    safety_match = QWEN_SAFETY_PATTERN.search(raw_output)
    label = safety_match.group(1) if safety_match else "PARSE_ERROR"
    categories = QWEN_CATEGORY_PATTERN.findall(raw_output.split("Categories:", 1)[-1])
    unsafe_probability = None
    if label_probabilities:
        unsafe_probability = label_probabilities.get("Unsafe", 0.0) + label_probabilities.get("Controversial", 0.0)
    return Verdict(raw_output, label, categories, unsafe_probability, prompt_token_count)


def build_classifier(family: str, model, tokenizer, use_prefix_cache: bool, label_only: bool):
    """계열에 맞는 (판정 함수, 접두 캐시 또는 None)을 돌려준다. 분류 토큰 id는 한 번만 계산해 둔다."""
    build_messages = build_kanana_messages if family == "kanana" else build_qwen_messages
    prefix_cache = None
    if use_prefix_cache:
        prefix_cache = PrefixCache(model, find_common_prefix_ids(tokenizer, build_messages))
    if family == "kanana":
        kanana_label_ids = resolve_kanana_label_ids(tokenizer)
        return lambda text: classify_with_kanana(model, tokenizer, kanana_label_ids, text, prefix_cache), prefix_cache
    qwen_label_ids = resolve_qwen_label_ids(tokenizer)
    return lambda text: classify_with_qwen(model, tokenizer, qwen_label_ids, text, prefix_cache, label_only), prefix_cache


def is_flagged(family: str, verdict: Verdict, include_controversial: bool) -> bool:
    """판정을 '유해로 표시됨' 여부로 바꾼다. Qwen은 Controversial 포함 여부를 선택한다."""
    if family == "kanana":
        return verdict.label != "<SAFE>"
    flagged_labels = {"Unsafe", "Controversial"} if include_controversial else {"Unsafe"}
    return verdict.label in flagged_labels


def run_samples(classify, samples: list[Sample]) -> list[dict]:
    """샘플을 하나씩(직렬) 판정하며 건당 경과 시간을 잰다. 실제 서비스도 메시지 단위로 들어오기 때문이다."""
    rows = []
    for sample in samples:
        start_time = time.perf_counter()
        verdict = classify(sample.text)
        elapsed_ms = (time.perf_counter() - start_time) * 1000
        rows.append({**asdict(sample), **asdict(verdict), "elapsed_ms": round(elapsed_ms, 2)})
    return rows


def summarize_latency(rows: list[dict]) -> dict:
    """지연 분포(중앙값·p90·p95·최대)와 직렬 처리 시 초당 처리량을 계산한다."""
    latencies = sorted(row["elapsed_ms"] for row in rows)
    quantiles = statistics.quantiles(latencies, n=20)
    return {
        "count": len(latencies),
        "median_ms": round(statistics.median(latencies), 1),
        "p90_ms": round(quantiles[17], 1),
        "p95_ms": round(quantiles[18], 1),
        "max_ms": round(latencies[-1], 1),
        "serial_messages_per_second": round(1000 / statistics.mean(latencies), 1),
        "mean_prompt_tokens": round(statistics.mean(row["prompt_token_count"] for row in rows), 1),
    }


def summarize_quality(family: str, rows: list[dict], include_controversial: bool) -> dict:
    """allow/harmful 이진 지표와 그룹별 표시 비율을 계산한다. ambiguous는 지표에서 뺀다."""
    labeled_rows = [row for row in rows if row["expected"] in ("allow", "harmful")]
    flags = [is_flagged(family, Verdict(**pick_verdict_fields(row)), include_controversial) for row in labeled_rows]
    true_positive = sum(flag and row["expected"] == "harmful" for flag, row in zip(flags, labeled_rows))
    false_positive = sum(flag and row["expected"] == "allow" for flag, row in zip(flags, labeled_rows))
    false_negative = sum((not flag) and row["expected"] == "harmful" for flag, row in zip(flags, labeled_rows))
    precision = true_positive / (true_positive + false_positive) if true_positive + false_positive else 0.0
    recall = true_positive / (true_positive + false_negative) if true_positive + false_negative else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "precision": round(precision, 3),
        "recall": round(recall, 3),
        "f1": round(f1, 3),
        "false_positive": false_positive,
        "false_negative": false_negative,
        "flag_rate_by_group": flag_rate_by_group(family, rows, include_controversial),
    }


def pick_verdict_fields(row: dict) -> dict:
    """결과 행에서 Verdict 생성에 필요한 필드만 고른다."""
    return {key: row[key] for key in ("raw_output", "label", "categories", "unsafe_probability", "prompt_token_count")}


def flag_rate_by_group(family: str, rows: list[dict], include_controversial: bool) -> dict:
    """그룹별 '표시된 건수/전체 건수'를 문자열로 만든다(사람이 읽기 쉽게)."""
    counts: dict[str, list[int]] = {}
    for row in rows:
        flagged = is_flagged(family, Verdict(**pick_verdict_fields(row)), include_controversial)
        group_count = counts.setdefault(row["group"], [0, 0])
        group_count[0] += int(flagged)
        group_count[1] += 1
    return {group: f"{flagged}/{total}" for group, (flagged, total) in counts.items()}


def main() -> None:
    """모델 적재 → 워밍업 → 채팅·K-HATERS 판정 → 결과 파일 저장 순으로 실행한다."""
    arguments = parse_arguments()
    mx.reset_peak_memory()
    load_start = time.perf_counter()
    model, tokenizer = load(arguments.model_dir)
    load_seconds = time.perf_counter() - load_start
    memory_after_load_gb = mx.get_active_memory() / 1e9
    classify, prefix_cache = build_classifier(arguments.family, model, tokenizer, arguments.prefix_cache, arguments.label_only)
    for warmup_text in ["안녕하세요", "테스트 문장입니다", "ㅋㅋㅋ"]:
        classify(warmup_text)

    chat_rows = run_samples(classify, load_chat_samples(arguments.chat_file))
    khaters_samples = load_khaters_samples(arguments.khaters_file, arguments.khaters_per_label, arguments.seed)
    khaters_rows = run_samples(classify, khaters_samples)

    summary = build_summary(arguments, chat_rows, khaters_rows, load_seconds, memory_after_load_gb)
    if prefix_cache is not None:
        summary["prefix_cache"] = {"prefix_tokens": len(prefix_cache.prefix_ids), "fallbacks": prefix_cache.fallback_count}
    write_outputs(arguments, chat_rows + khaters_rows, summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def build_summary(arguments, chat_rows, khaters_rows, load_seconds, memory_after_load_gb) -> dict:
    """실행 1회의 요약(지연·메모리·품질)을 만든다. Qwen은 Controversial 포함/제외 두 기준을 다 낸다."""
    quality_modes = [False] if arguments.family == "kanana" else [False, True]
    return {
        "run_label": arguments.run_label,
        "load_seconds": round(load_seconds, 1),
        "memory_after_load_gb": round(memory_after_load_gb, 2),
        "peak_memory_gb": round(mx.get_peak_memory() / 1e9, 2),
        "latency_chat": summarize_latency(chat_rows),
        "latency_khaters": summarize_latency(khaters_rows),
        "quality": {
            ("unsafe_or_controversial" if mode else "unsafe_only"): {
                "chat": summarize_quality(arguments.family, chat_rows, mode),
                "khaters": summarize_quality(arguments.family, khaters_rows, mode),
            }
            for mode in quality_modes
        },
    }


def write_outputs(arguments, rows: list[dict], summary: dict) -> None:
    """건별 결과(jsonl)와 요약(json)을 out-dir에 저장한다."""
    out_dir = Path(arguments.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows_text = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
    (out_dir / f"{arguments.run_label}.rows.jsonl").write_text(rows_text + "\n", encoding="utf-8")
    (out_dir / f"{arguments.run_label}.summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
