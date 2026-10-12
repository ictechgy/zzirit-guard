"""길이 기준 배치 구성. torch 없이 인덱스만 다룬다(단위 테스트를 가볍게 하기 위해서다).

왜 길이로 묶나: 배치는 가장 긴 문장에 맞춰 패딩한다. 길이가 비슷한 문장끼리 묶으면 패딩 낭비가 줄어
학습이 빨라진다. 다만 완전히 길이순으로 학습하면 순서 편향이 생기므로, 섞은 뒤 '큰 묶음' 안에서만 정렬한다.
"""

from __future__ import annotations

import random
from collections.abc import Sequence

# 길이로 정렬할 '큰 묶음' 크기 = 배치 크기 × 이 배수. 패딩 절약과 무작위성 사이의 절충값이다(스파이크와 같은 값).
BUCKET_MULTIPLIER = 100


def build_length_bucketed_batches(lengths: Sequence[int], batch_size: int, random_generator: random.Random) -> list[list[int]]:
    """학습용 배치(인덱스 목록의 목록)를 만든다.

    절차: 전체 인덱스를 섞음 → batch_size × BUCKET_MULTIPLIER 크기로 자름 → 각 묶음 안에서 길이순 정렬 →
    batch_size씩 자름 → 배치 순서를 다시 섞음.
    lengths: 문장별 토큰 수. random_generator: 시드를 고정한 난수기(재현을 위해 호출자가 넘긴다).
    반환: 모든 인덱스가 정확히 한 번씩 들어 있는 배치 목록.
    """
    indices = list(range(len(lengths)))
    random_generator.shuffle(indices)
    bucket_size = batch_size * BUCKET_MULTIPLIER
    batches: list[list[int]] = []
    for bucket_start in range(0, len(indices), bucket_size):
        bucket = sorted(indices[bucket_start : bucket_start + bucket_size], key=lengths.__getitem__)
        batches.extend(bucket[start : start + batch_size] for start in range(0, len(bucket), batch_size))
    random_generator.shuffle(batches)
    return batches


def build_inference_batches(lengths: Sequence[int], batch_size: int) -> list[list[int]]:
    """추론용 배치를 만든다. 무작위성 없이 전체를 길이순으로 정렬해 자른다(패딩 최소화).

    호출자는 결과 점수를 인덱스로 원래 순서에 되돌려 놓는다.
    """
    order = sorted(range(len(lengths)), key=lengths.__getitem__)
    return [order[start : start + batch_size] for start in range(0, len(order), batch_size)]
