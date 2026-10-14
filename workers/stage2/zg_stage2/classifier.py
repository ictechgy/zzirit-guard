"""kanana-safeguard-8b(mlx 4비트) 2차 분류기: 채팅 한 줄의 유해 확률과 가장 높은 유해 범주를 낸다(스펙 §5.2 ⑤).

근거: docs/spikes/2026-10-11-guard-models/scripts/bench_guard.py의 classify_with_kanana·PrefixCache(버리는 코드라 다시 썼다).
- 모델 카드대로 [사용자 발화, 빈 assistant] 메시지를 채팅 템플릿에 넣고, 다음 토큰 하나의 분포에서 분류 토큰 8개
  (<SAFE>, <UNSAFE-S1>~<UNSAFE-S7>)의 확률을 읽는다. 생성은 하지 않는다(순전파 한 번).
- 유해 확률은 UNSAFE 확률의 합이고, 범주는 UNSAFE 중 가장 높은 것이다. 스펙: 0.5 이상 후보, 가장 높은 범주가 S6면 '도움 필요'.
- 접두 KV 캐시: 모든 프롬프트에 공통인 템플릿 앞부분(시스템 지시문)을 한 번만 계산해 두고, 판정마다 그 상태로 되감는다.
  스파이크에서 지연이 1/2~1/3로 줄었다. 접두부로 시작하지 않는 프롬프트는 캐시 없이 전체를 계산한다.
- 채팅은 템플릿의 사용자 발화 자리에 데이터로만 들어간다. 지시문 공격에 성공해도 결과는 후보 추가에 그친다(스펙 §5.3).
주의: 이 모듈의 함수는 추론 스레드 하나에서만 부른다(mlx 모델과 캐시를 여러 스레드가 만지지 않게).
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
from mlx_lm import load
from mlx_lm.models import cache as cache_module

from zg_stage2.errors import ModelFormatError
from zg_stage2.worker_contract import ItemVerdict

# kanana-safeguard 분류 토큰(모델 카드의 채팅 템플릿 기준). 첫째가 SAFE이고 나머지는 범주 S1~S7이다.
LABEL_TOKENS: tuple[str, ...] = ("<SAFE>",) + tuple(f"<UNSAFE-S{index}>" for index in range(1, 8))

# 응답에 싣는 범주 코드(계약 v1).
CATEGORY_CODES: tuple[str, ...] = tuple(f"S{index}" for index in range(1, 8))

# 공통 접두부를 찾을 때 쓰는 서로 다른 두 문장(채팅이 아닌 고정 문장).
PREFIX_PROBE_TEXTS = ("가나다", "ㅋㅋ 123")


def summarize_label_probabilities(probabilities: Sequence[float]) -> ItemVerdict:
    """[SAFE, S1..S7] 확률을 (UNSAFE 합, 가장 높은 UNSAFE 범주)로 바꾼다. 같으면 앞 범주를 고른다.

    합은 반올림 오차로 1을 아주 조금 넘을 수 있어 0~1로 자른다.
    """
    if len(probabilities) != len(LABEL_TOKENS):
        raise ValueError(f"분류 토큰 확률은 {len(LABEL_TOKENS)}개여야 합니다(받은 수: {len(probabilities)}).")
    unsafe = [float(value) for value in probabilities[1:]]
    top_index = max(range(len(unsafe)), key=unsafe.__getitem__)
    return ItemVerdict(min(1.0, max(0.0, sum(unsafe))), CATEGORY_CODES[top_index])


def resolve_label_token_ids(tokenizer: object) -> list[int]:
    """분류 토큰 8개의 토큰 번호. 하나라도 토큰 하나가 아니면 모델·토크나이저가 다른 판이라 시작하지 않는다."""
    token_ids = []
    for label in LABEL_TOKENS:
        encoded = tokenizer.encode(label, add_special_tokens=False)  # type: ignore[attr-defined]
        if len(encoded) != 1:
            raise ModelFormatError(f"{label}이 토큰 하나가 아닙니다. kanana-safeguard 원본 토크나이저를 쓰는지 확인하세요.")
        token_ids.append(int(encoded[0]))
    return token_ids


def build_messages(text: str) -> list[dict[str, str]]:
    """사용자 발화 판정용 메시지. 모델 카드대로 빈 assistant 메시지를 붙인다."""
    return [{"role": "user", "content": text}, {"role": "assistant", "content": ""}]


def encode_prompt(tokenizer: object, text: str) -> list[int]:
    """채팅 템플릿을 문자열로 적용한 뒤 특수 토큰을 더하지 않고 토큰화한다(모델 카드 예제와 같은 입력)."""
    prompt = tokenizer.apply_chat_template(build_messages(text), tokenize=False)  # type: ignore[attr-defined]
    return list(tokenizer.encode(prompt, add_special_tokens=False))  # type: ignore[attr-defined]


def find_common_prefix(first: Sequence[int], second: Sequence[int]) -> list[int]:
    """두 토큰 목록의 공통 앞부분. 내용 첫 글자와 합쳐지는 토큰은 자연히 빠진다."""
    length = 0
    while length < min(len(first), len(second)) and first[length] == second[length]:
        length += 1
    return list(first[:length])


class PrefixCache:
    """모든 프롬프트에 공통인 템플릿 앞부분의 KV 캐시. 판정이 끝날 때마다 접두부 길이로 되감는다."""

    def __init__(self, model: nn.Module, prefix_ids: Sequence[int]) -> None:
        if not prefix_ids:
            raise ModelFormatError("채팅 템플릿에서 공통 접두부를 찾지 못했습니다. kanana-safeguard 원본 템플릿인지 확인하세요.")
        self.prefix_ids = list(prefix_ids)
        self.cache = cache_module.make_prompt_cache(model)
        model(mx.array(self.prefix_ids)[None], cache=self.cache)
        mx.eval([layer_cache.state for layer_cache in self.cache])

    def remaining_after_prefix(self, prompt_ids: Sequence[int]) -> list[int] | None:
        """프롬프트가 접두부로 시작하고 뒤에 토큰이 남으면 그 나머지를, 아니면 None을 돌려준다."""
        if len(prompt_ids) <= len(self.prefix_ids) or list(prompt_ids[: len(self.prefix_ids)]) != self.prefix_ids:
            return None
        return list(prompt_ids[len(self.prefix_ids) :])

    def rewind(self) -> None:
        """판정 중 쌓인 토큰을 지워 캐시를 접두부 상태로 되돌린다."""
        extra = self.cache[0].offset - len(self.prefix_ids)
        if extra > 0:
            cache_module.trim_prompt_cache(self.cache, extra)


class KananaClassifier:
    """kanana-safeguard 판정기. 모델·토크나이저와 접두 캐시를 가진다. 추론 스레드에서만 쓴다."""

    def __init__(self, model: nn.Module, tokenizer: object) -> None:
        self._model = model
        self._tokenizer = tokenizer
        self._label_ids = mx.array(resolve_label_token_ids(tokenizer))
        probes = [encode_prompt(tokenizer, text) for text in PREFIX_PROBE_TEXTS]
        self._prefix = PrefixCache(model, find_common_prefix(probes[0], probes[1]))
        self.fallback_count = 0

    def classify(self, texts: Sequence[str]) -> list[ItemVerdict]:
        """문장마다 판정한다(직렬). 묶음 처리는 프롬프트 처리량이 병목이라 효과가 거의 없었다(스파이크)."""
        return [self.classify_one(text) for text in texts]

    def classify_one(self, text: str) -> ItemVerdict:
        """한 문장을 판정한다. 접두 캐시를 쓸 수 있으면 나머지 토큰만 계산하고, 끝나면 캐시를 되감는다."""
        prompt_ids = encode_prompt(self._tokenizer, text)
        remaining = self._prefix.remaining_after_prefix(prompt_ids)
        if remaining is None:
            self.fallback_count += 1
            return self._summarize(self._model(mx.array(prompt_ids)[None])[0, -1])
        try:
            return self._summarize(self._model(mx.array(remaining)[None], cache=self._prefix.cache)[0, -1])
        finally:
            self._prefix.rewind()

    def _summarize(self, last_logits: mx.array) -> ItemVerdict:
        """마지막 위치의 logits에서 분류 토큰 확률을 구한다. bf16 그대로 지수를 취하면 합이 1을 넘는 오차가 생겨 float32로 올린다."""
        logits = last_logits.astype(mx.float32)
        label_probabilities = mx.exp((logits - mx.logsumexp(logits))[self._label_ids])
        mx.eval(label_probabilities)
        values = label_probabilities.tolist()
        if not isinstance(values, list):
            raise ValueError("분류 토큰 확률이 목록이 아닙니다. 분류 토큰 번호를 확인하세요.")
        return summarize_label_probabilities([float(value) for value in values])  # type: ignore[arg-type]


def load_kanana(model_directory: Path) -> KananaClassifier:
    """로컬 디렉터리의 mlx 모델과 토크나이저를 불러와 판정기를 만든다. 디렉터리가 있는지는 부르는 쪽이 먼저 확인한다."""
    loaded = load(str(model_directory))
    return KananaClassifier(loaded[0], loaded[1])
