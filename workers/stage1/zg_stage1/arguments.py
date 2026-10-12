"""argparse용 값 검사 함수 모음.

왜 따로 두나: 잘못된 값(예: --epochs 0)을 무거운 모델 불러오기 전에, argparse의 사용법 안내와 함께 거부하기 위해서다.
train·evaluate·thresholds CLI가 같은 규칙을 쓴다.
"""

from __future__ import annotations

import argparse


def parse_integer(raw_value: str) -> int:
    """문자열을 정수로 바꾼다. 실패하면 argparse가 사용법과 함께 보여 주는 오류로 바꾼다."""
    try:
        return int(raw_value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"{raw_value!r}는 정수가 아닙니다.") from error


def parse_float(raw_value: str) -> float:
    """문자열을 실수로 바꾼다. 실패하면 argparse가 사용법과 함께 보여 주는 오류로 바꾼다."""
    try:
        return float(raw_value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"{raw_value!r}는 실수가 아닙니다.") from error


def positive_integer(raw_value: str) -> int:
    """1 이상의 정수만 받는다(예: --epochs, --batch-size, --limit)."""
    value = parse_integer(raw_value)
    if value < 1:
        raise argparse.ArgumentTypeError(f"{value}는 1 이상이어야 합니다.")
    return value


def non_negative_integer(raw_value: str) -> int:
    """0 이상의 정수만 받는다(예: --max-steps. 0은 '제한 없음'이다)."""
    value = parse_integer(raw_value)
    if value < 0:
        raise argparse.ArgumentTypeError(f"{value}는 0 이상이어야 합니다.")
    return value


def positive_float(raw_value: str) -> float:
    """0보다 큰 실수만 받는다(예: --learning-rate)."""
    value = parse_float(raw_value)
    if not value > 0:
        raise argparse.ArgumentTypeError(f"{value}는 0보다 커야 합니다.")
    return value


def probability_argument(raw_value: str) -> float:
    """(0, 1] 범위 실수만 받는다(예: --target-recall, --stage1-threshold)."""
    value = parse_float(raw_value)
    if not 0 < value <= 1:
        raise argparse.ArgumentTypeError(f"{value}는 0보다 크고 1 이하여야 합니다.")
    return value


def fraction_below_one(raw_value: str) -> float:
    """[0, 1) 범위 실수만 받는다(예: --warmup-ratio. 1이면 학습 내내 워밍업만 한다)."""
    value = parse_float(raw_value)
    if not 0 <= value < 1:
        raise argparse.ArgumentTypeError(f"{value}는 0 이상 1 미만이어야 합니다.")
    return value


def non_negative_float(raw_value: str) -> float:
    """0 이상 실수만 받는다(예: --weight-decay)."""
    value = parse_float(raw_value)
    if value < 0:
        raise argparse.ArgumentTypeError(f"{value}는 0 이상이어야 합니다.")
    return value
