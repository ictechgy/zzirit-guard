"""classifier 테스트: 분류 토큰 확률 요약, 공통 접두부, 분류 토큰 확인. 실제 모델 확인은 ZG_STAGE2_MODEL_DIR이 있을 때만 돈다."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from zg_stage2.classifier import (
    CATEGORY_CODES,
    LABEL_TOKENS,
    PrefixCache,
    find_common_prefix,
    resolve_label_token_ids,
    summarize_label_probabilities,
)
from zg_stage2.errors import ModelFormatError


def test_summary_sums_unsafe_and_picks_top_category() -> None:
    """유해 확률은 UNSAFE 합이고, 범주는 UNSAFE 중 가장 높은 것이다(SAFE는 범주가 되지 않는다)."""
    verdict = summarize_label_probabilities([0.5, 0.1, 0.05, 0.0, 0.0, 0.0, 0.3, 0.05])
    assert verdict.unsafe_probability == pytest.approx(0.5)
    assert verdict.category == "S6"


def test_summary_breaks_ties_with_first_category() -> None:
    """확률이 같으면 앞 범주를 고른다(같은 입력에 늘 같은 답)."""
    assert summarize_label_probabilities([0.0, 0.2, 0.2, 0.2, 0.2, 0.1, 0.05, 0.05]).category == "S1"


def test_summary_clamps_rounding_overflow() -> None:
    """반올림으로 합이 1을 조금 넘어도 1로 자른다."""
    assert summarize_label_probabilities([0.0, 0.5, 0.5000001, 0, 0, 0, 0, 0]).unsafe_probability == 1.0


def test_summary_requires_eight_probabilities() -> None:
    """분류 토큰 수와 다르면 오류다."""
    with pytest.raises(ValueError):
        summarize_label_probabilities([1.0, 0.0])


def test_label_tokens_and_categories() -> None:
    """분류 토큰은 SAFE와 S1~S7 여덟 개다."""
    assert LABEL_TOKENS[0] == "<SAFE>" and len(LABEL_TOKENS) == 8
    assert CATEGORY_CODES == ("S1", "S2", "S3", "S4", "S5", "S6", "S7")


def test_common_prefix() -> None:
    """두 토큰 목록의 공통 앞부분."""
    assert find_common_prefix([1, 2, 3, 4], [1, 2, 9]) == [1, 2]
    assert find_common_prefix([1, 2], [1, 2, 3]) == [1, 2]
    assert find_common_prefix([5], [6]) == []


class FakeTokenizer:
    """분류 토큰을 몇 개의 토큰으로 쪼개는지 정할 수 있는 가짜 토크나이저."""

    def __init__(self, split_label: str | None = None) -> None:
        self.split_label = split_label

    def encode(self, text: str, add_special_tokens: bool = False) -> list[int]:
        return [1, 2] if text == self.split_label else [hash(text) % 1000]


def test_label_token_ids_must_be_single_tokens() -> None:
    """분류 토큰이 토큰 하나가 아니면(다른 판의 토크나이저) 시작하지 않는다."""
    assert len(resolve_label_token_ids(FakeTokenizer())) == 8
    with pytest.raises(ModelFormatError, match="UNSAFE-S3"):
        resolve_label_token_ids(FakeTokenizer(split_label="<UNSAFE-S3>"))


def test_prefix_split() -> None:
    """접두부로 시작하고 뒤에 남는 토큰이 있으면 그 나머지, 아니면 None(전체 계산)."""
    cache = PrefixCache.__new__(PrefixCache)
    cache.prefix_ids = [1, 2, 3]
    assert cache.remaining_after_prefix([1, 2, 3, 4, 5]) == [4, 5]
    assert cache.remaining_after_prefix([1, 2, 3]) is None
    assert cache.remaining_after_prefix([1, 9, 3, 4]) is None


REAL_MODEL_DIRECTORY = os.environ.get("ZG_STAGE2_MODEL_DIR")


@pytest.mark.skipif(not REAL_MODEL_DIRECTORY, reason="ZG_STAGE2_MODEL_DIR(kanana mlx 디렉터리)가 있을 때만 돈다")
def test_real_model_prefix_cache_matches_full_computation() -> None:
    """실제 모델: 접두 캐시를 쓴 결과가 전체 계산과 같고, 판정 뒤 캐시가 접두부 길이로 돌아간다."""
    from zg_stage2.classifier import load_kanana

    classifier = load_kanana(Path(str(REAL_MODEL_DIRECTORY)))
    for text in ("오늘 방송 재밌네요", "가나다라 ㅋㅋㅋ", "방송 끝나고 기다릴게"):
        cached = classifier.classify_one(text)
        assert classifier._prefix.cache[0].offset == len(classifier._prefix.prefix_ids)
        prefix, classifier._prefix.prefix_ids = classifier._prefix.prefix_ids, [-1]
        full = classifier.classify_one(text)
        classifier._prefix.prefix_ids = prefix
        assert cached.unsafe_probability == pytest.approx(full.unsafe_probability, abs=0.02)
