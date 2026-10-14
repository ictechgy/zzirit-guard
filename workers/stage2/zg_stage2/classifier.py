"""kanana-safeguard-8b(mlx 4비트) 2차 분류기: 채팅 한 줄의 유해 확률과 가장 높은 유해 범주를 낸다(스펙 §5.2 ⑤).

근거: docs/spikes/2026-10-11-guard-models/scripts/bench_guard.py의 classify_with_kanana·PrefixCache(버리는 코드라 다시 썼다).
- 모델 카드의 채팅 템플릿에 [사용자 발화, 빈 assistant]를 넣고, 다음 토큰 하나의 분포에서 분류 토큰 8개
  (<SAFE>, <UNSAFE-S1>~<UNSAFE-S7>)의 확률을 읽는다. 생성은 하지 않는다(순전파 한 번).
- 유해 확률은 UNSAFE 확률의 합이고, 범주는 UNSAFE 중 가장 높은 것이다. 스펙: 0.5 이상 후보, 가장 높은 범주가 S6면 '도움 필요'.

채팅은 공격자가 쓴 입력이다. 템플릿 경계를 넘지 못하게 프롬프트를 세 조각으로 만든다.
- 템플릿 앞부분(시스템 지시문 ~ 사용자 발화 시작)과 뒷부분(사용자 발화 끝 ~ assistant 차례)은 템플릿 그대로 토큰화한다.
- 가운데 채팅 내용은 따로 토큰화한다.
  - 특수 토큰(<|eot_id|> 등)은 일반 글자로 쪼갠다.
  - 추가 토큰 문자열(<SAFE> 등)과 역할 표시(<human> 등)는 꺾쇠를 전각(＜＞)으로 바꿔 실제 제어 토큰이 되지 않게 한다.
  - 그래도 추가 토큰 번호가 남으면 판정하지 않는다.
- 앞부분은 모든 프롬프트에 같아 KV 캐시로 한 번만 계산하고, 판정마다 그 상태로 되감는다(접두 캐시).
- 채팅 내용이 MAX_CONTENT_TOKENS를 넘으면 판정하지 않는다(400 text_too_long). 이 맥 미니에서 프롬프트 처리는 초당 약 350~400토큰이다.
  넘는 문장은 서버의 2초 제한을 넘기기 때문이다. 자르지 않는다(판정 입력을 몰래 바꾸지 않기 위해서다).
주의: 이 모듈의 함수는 추론 스레드 하나에서만 부른다(mlx 모델과 캐시를 여러 스레드가 만지지 않게).
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
from mlx_lm import load
from mlx_lm.models import cache as cache_module

from zg_stage2.errors import ModelFormatError
from zg_stage2.worker_contract import ContractError, ItemVerdict

# kanana-safeguard 분류 토큰(모델 카드의 채팅 템플릿 기준). 첫째가 SAFE이고 나머지는 범주 S1~S7이다.
LABEL_TOKENS: tuple[str, ...] = ("<SAFE>",) + tuple(f"<UNSAFE-S{index}>" for index in range(1, 8))

# 응답에 싣는 범주 코드(계약 v1).
CATEGORY_CODES: tuple[str, ...] = tuple(f"S{index}" for index in range(1, 8))

# 채팅 내용 토큰 수 상한. 약 1초 안에 끝나는 길이다(측정: 한국어 1,000자 ≈ 970토큰 2.6초).
MAX_CONTENT_TOKENS = 384

# 템플릿에서 채팅 내용 자리를 찾을 때 넣는 표식(사용자 영역 문자, 채팅 템플릿의 trim에 지워지지 않는다).
CONTENT_PLACEHOLDER = ""

# 템플릿의 역할 표시. 채팅 안에 있으면 꺾쇠를 전각으로 바꾼다(대소문자 무시).
ROLE_MARKER_PATTERN = r"</?(?:human|ai)>"


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
    """분류 토큰 8개의 토큰 번호. 각각 토큰 하나이고, 서로 다르고, unk가 아니어야 한다. 아니면 다른 판의 토크나이저라 시작하지 않는다."""
    token_ids = []
    for label in LABEL_TOKENS:
        encoded = tokenizer.encode(label, add_special_tokens=False)  # type: ignore[attr-defined]
        if len(encoded) != 1:
            raise ModelFormatError(f"{label}이 토큰 하나가 아닙니다. kanana-safeguard 원본 토크나이저를 쓰는지 확인하세요.")
        token_ids.append(int(encoded[0]))
    unknown_id = getattr(tokenizer, "unk_token_id", None)
    if len(set(token_ids)) != len(token_ids) or unknown_id in token_ids:
        raise ModelFormatError("분류 토큰 번호가 겹치거나 unk입니다. kanana-safeguard 원본 토크나이저를 쓰는지 확인하세요.")
    return token_ids


def build_messages(text: str) -> list[dict[str, str]]:
    """사용자 발화 판정용 메시지. 모델 카드대로 빈 assistant 메시지를 붙인다."""
    return [{"role": "user", "content": text}, {"role": "assistant", "content": ""}]


def split_template(tokenizer: object) -> tuple[str, str]:
    """채팅 템플릿을 (채팅 내용 앞, 채팅 내용 뒤) 두 문자열로 나눈다. 표식이 정확히 한 번 나와야 한다."""
    rendered = tokenizer.apply_chat_template(build_messages(CONTENT_PLACEHOLDER), tokenize=False)  # type: ignore[attr-defined]
    if not isinstance(rendered, str) or rendered.count(CONTENT_PLACEHOLDER) != 1:
        raise ModelFormatError("채팅 템플릿에서 사용자 발화 자리를 찾지 못했습니다. kanana-safeguard 원본 템플릿인지 확인하세요.")
    before, after = rendered.split(CONTENT_PLACEHOLDER)
    return before, after


def added_token_strings(tokenizer: object) -> dict[int, str]:
    """토크나이저에 추가된 토큰(특수 토큰과 분류 토큰)의 번호 → 문자열."""
    decoder = getattr(tokenizer, "added_tokens_decoder", None) or {}
    return {int(token_id): str(getattr(token, "content", token)) for token_id, token in decoder.items()}


def build_marker_pattern(markers: Sequence[str]) -> re.Pattern[str]:
    """채팅 안에서 바꿀 문자열(추가 토큰, 역할 표시)을 찾는 정규식. 긴 것부터 맞춘다."""
    escaped = [re.escape(marker) for marker in sorted(set(markers), key=len, reverse=True) if marker]
    return re.compile("|".join([*escaped, ROLE_MARKER_PATTERN]), re.IGNORECASE)


def neutralize_markers(text: str, pattern: re.Pattern[str]) -> str:
    """찾은 표시의 꺾쇠를 전각(＜＞)으로 바꾼다. 사람이 읽는 뜻은 같고, 토크나이저는 제어 토큰으로 보지 않는다."""
    return pattern.sub(lambda matched: matched.group(0).replace("<", "＜").replace(">", "＞"), text)


class PromptEncoder:
    """프롬프트를 (템플릿 앞부분, 채팅 내용, 템플릿 뒷부분) 토큰으로 만든다. 앞부분은 모든 프롬프트에 같다."""

    def __init__(self, tokenizer: object) -> None:
        self._tokenizer = tokenizer
        before, after = split_template(tokenizer)
        self.prefix_ids = self._encode_template(before)
        self.suffix_ids = self._encode_template(after)
        self._added_ids = set(added_token_strings(tokenizer))
        self._marker_pattern = build_marker_pattern(list(added_token_strings(tokenizer).values()))

    def encode_content(self, text: str) -> list[int]:
        """채팅 내용을 토큰으로 만든다. 템플릿처럼 앞뒤 공백을 지우고, 제어 토큰이 될 문자열은 바꾼 뒤 특수 토큰을 쪼개 토큰화한다.

        추가 토큰 번호가 남거나 MAX_CONTENT_TOKENS를 넘으면 ContractError다(판정하지 않는다).
        """
        content = neutralize_markers(text.strip(), self._marker_pattern)
        token_ids = list(self._tokenizer.encode(content, add_special_tokens=False, split_special_tokens=True))  # type: ignore[attr-defined]
        if self._added_ids.intersection(token_ids):
            raise ContractError("bad_text")
        if len(token_ids) > MAX_CONTENT_TOKENS:
            raise ContractError("text_too_long")
        return token_ids

    def _encode_template(self, text: str) -> list[int]:
        """템플릿 조각을 토큰화한다(템플릿의 특수 토큰은 그대로 쓴다)."""
        return list(self._tokenizer.encode(text, add_special_tokens=False))  # type: ignore[attr-defined]


class PrefixCache:
    """템플릿 앞부분의 KV 캐시. 판정이 끝날 때마다(예외가 나도) 모든 층을 앞부분 길이로 되감는다."""

    def __init__(self, model: nn.Module, prefix_ids: Sequence[int]) -> None:
        if not prefix_ids:
            raise ModelFormatError("채팅 템플릿 앞부분이 비었습니다. kanana-safeguard 원본 템플릿인지 확인하세요.")
        self.prefix_length = len(prefix_ids)
        self.cache = cache_module.make_prompt_cache(model)
        model(mx.array(list(prefix_ids))[None], cache=self.cache)
        mx.eval([layer_cache.state for layer_cache in self.cache])

    def offsets(self) -> list[int]:
        """층마다 캐시에 든 토큰 수(테스트·확인용)."""
        return [int(layer_cache.offset) for layer_cache in self.cache]

    def rewind(self) -> None:
        """판정 중 쌓인 토큰을 지워 캐시를 앞부분 상태로 되돌린다."""
        extra = max(self.offsets()) - self.prefix_length
        if extra > 0:
            cache_module.trim_prompt_cache(self.cache, extra)


class KananaClassifier:
    """kanana-safeguard 판정기. 모델·토크나이저와 접두 캐시를 가진다. 추론 스레드에서만 쓴다."""

    def __init__(self, model: nn.Module, tokenizer: object) -> None:
        self._model = model
        self._label_ids = mx.array(resolve_label_token_ids(tokenizer))
        self._encoder = PromptEncoder(tokenizer)
        self._prefix = PrefixCache(model, self._encoder.prefix_ids)

    def classify(self, texts: Sequence[str]) -> list[ItemVerdict]:
        """문장마다 판정한다(직렬). 묶음 처리는 프롬프트 처리량이 병목이라 효과가 거의 없었다(스파이크)."""
        return [self.classify_one(text) for text in texts]

    def classify_one(self, text: str) -> ItemVerdict:
        """한 문장을 판정한다. 앞부분은 캐시에서 쓰고 채팅 내용과 뒷부분만 계산한 뒤, 캐시를 되감는다."""
        remaining = self._encoder.encode_content(text) + self._encoder.suffix_ids
        try:
            return self._summarize(self._model(mx.array(remaining)[None], cache=self._prefix.cache)[0, -1])
        finally:
            self._prefix.rewind()

    def classify_without_cache(self, text: str) -> ItemVerdict:
        """접두 캐시 없이 프롬프트 전체를 계산한다(접두 캐시 결과를 확인할 때 쓴다)."""
        prompt = self._encoder.prefix_ids + self._encoder.encode_content(text) + self._encoder.suffix_ids
        return self._summarize(self._model(mx.array(prompt)[None])[0, -1])

    def _summarize(self, last_logits: mx.array) -> ItemVerdict:
        """마지막 위치의 logits에서 분류 토큰 확률을 구한다. bf16 그대로 지수를 취하면 합이 1을 넘는 오차가 생겨 float32로 올린다."""
        logits = last_logits.astype(mx.float32)
        label_probabilities = mx.exp((logits - mx.logsumexp(logits))[self._label_ids])
        mx.eval(label_probabilities)
        values = label_probabilities.tolist()
        if not isinstance(values, list):
            raise ValueError("분류 토큰 확률이 목록이 아닙니다. 분류 토큰 번호를 확인하세요.")
        return summarize_label_probabilities([float(value) for value in values])  # type: ignore[arg-type]


def ensure_no_custom_model_code(model_directory: Path) -> None:
    """config.json이 모델 디렉터리의 파이썬 파일을 불러오게 하면(model_file) 시작하지 않는다. mlx_lm은 그 파일을 실행한다."""
    config = json.loads((model_directory / "config.json").read_text(encoding="utf-8"))
    if "model_file" in config:
        raise ModelFormatError("config.json의 model_file은 모델 디렉터리의 코드를 실행합니다. 공식 변환 결과만 쓰세요.")


def load_kanana(model_directory: Path) -> KananaClassifier:
    """로컬 디렉터리의 mlx 모델과 토크나이저를 불러와 판정기를 만든다. 원격 코드는 실행하지 않는다."""
    ensure_no_custom_model_code(model_directory)
    loaded = load(str(model_directory), tokenizer_config={"trust_remote_code": False})
    return KananaClassifier(loaded[0], loaded[1])
