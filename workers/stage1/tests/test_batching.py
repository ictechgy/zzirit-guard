"""batching 모듈 테스트: 길이 기준 배치가 모든 인덱스를 한 번씩 담고, 시드가 같으면 같은 결과인지."""

from __future__ import annotations

import random

from zg_stage1.batching import BUCKET_MULTIPLIER, build_inference_batches, build_length_bucketed_batches


def test_every_index_appears_exactly_once() -> None:
    """모든 문장이 정확히 한 번씩 배치에 들어간다."""
    lengths = [(index * 7) % 50 + 1 for index in range(1000)]
    batches = build_length_bucketed_batches(lengths, 8, random.Random(0))
    flattened = [index for batch in batches for index in batch]
    assert sorted(flattened) == list(range(1000))
    assert all(len(batch) <= 8 for batch in batches)


def test_same_seed_same_batches() -> None:
    """시드가 같으면 배치 구성과 순서가 같다(재현성)."""
    lengths = [(index * 13) % 40 + 1 for index in range(500)]
    assert build_length_bucketed_batches(lengths, 4, random.Random(5)) == build_length_bucketed_batches(lengths, 4, random.Random(5))


def test_batches_inside_bucket_are_length_sorted() -> None:
    """한 묶음(배치 크기 × 배수) 안에서 길이순으로 잘라 배치 안의 길이 차이가 작다."""
    batch_size = 2
    lengths = list(range(batch_size * BUCKET_MULTIPLIER))
    batches = build_length_bucketed_batches(lengths, batch_size, random.Random(1))
    assert all(abs(lengths[batch[0]] - lengths[batch[-1]]) <= 1 for batch in batches)


def test_inference_batches_are_sorted_and_complete() -> None:
    """추론 배치는 길이순이고 모든 인덱스를 담는다."""
    lengths = [5, 1, 3, 2, 4]
    batches = build_inference_batches(lengths, 2)
    assert batches == [[1, 3], [2, 4], [0]]
