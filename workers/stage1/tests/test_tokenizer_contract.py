"""토크나이저 [CLS]·[SEP] 규칙 테스트(오프라인 작은 토크나이저): 설치 → 저장 → 다시 불러오기, 잘림, 빈 문장, 왕복 검사."""

from __future__ import annotations

from pathlib import Path

import pytest
from transformers import PreTrainedTokenizerBase

from tests.conftest import build_tiny_tokenizer
from zg_stage1 import modeling
from zg_stage1.errors import ModelFormatError

# 잘림을 시험할 때 쓰는 max_length. [CLS]·[SEP]을 빼면 내용 토큰 3개만 들어간다.
SHORT_MAX_LENGTH = 5

# 잘림 시험 문장(내용 토큰 8개, 데이터 원문이 아니다).
LONG_TEXT = "가 나 다 라 가 나 다 라"


def test_template_wraps_normal_input(tiny_tokenizer: PreTrainedTokenizerBase) -> None:
    """규칙을 넣으면 보통 문장이 [CLS] … [SEP]으로 감싸진다."""
    modeling.install_special_token_template(tiny_tokenizer)
    assert tiny_tokenizer("가 나")["input_ids"] == [1, 5, 6, 2]


def test_truncated_input_keeps_separator(tiny_tokenizer: PreTrainedTokenizerBase) -> None:
    """max_length로 자를 때 내용만 잘리고 끝의 [SEP]은 남는다."""
    modeling.install_special_token_template(tiny_tokenizer)
    token_ids = modeling.encode_texts(tiny_tokenizer, [LONG_TEXT], SHORT_MAX_LENGTH)[0]
    assert token_ids == [1, 5, 6, 7, 2]


def test_empty_text_becomes_cls_and_separator(tiny_tokenizer: PreTrainedTokenizerBase) -> None:
    """빈 문장도 [CLS][SEP]이 되어 길이 0 입력이 생기지 않는다."""
    modeling.install_special_token_template(tiny_tokenizer)
    assert modeling.encode_texts(tiny_tokenizer, [""], SHORT_MAX_LENGTH) == [[1, 2]]


def test_template_survives_save_and_reload(tiny_tokenizer: PreTrainedTokenizerBase, tmp_path: Path) -> None:
    """규칙을 넣고 저장한 뒤 다시 불러와도 보통·잘림·빈 문장의 토큰이 같다."""
    modeling.install_special_token_template(tiny_tokenizer)
    tiny_tokenizer.save_pretrained(str(tmp_path))
    reloaded = modeling.load_trained_tokenizer(tmp_path)
    texts = ["가 나", LONG_TEXT, ""]
    assert modeling.encode_texts(reloaded, texts, SHORT_MAX_LENGTH) == modeling.encode_texts(tiny_tokenizer, texts, SHORT_MAX_LENGTH)
    assert modeling.encode_texts(reloaded, texts, SHORT_MAX_LENGTH) == [[1, 5, 6, 2], [1, 5, 6, 7, 2], [1, 2]]


def test_ensure_wraps_rejects_tokenizer_without_template(tiny_tokenizer: PreTrainedTokenizerBase) -> None:
    """규칙이 없는 토크나이저는 거부한다(학습 때와 입력이 달라지기 때문이다)."""
    with pytest.raises(ModelFormatError, match=r"\[CLS\]"):
        modeling.ensure_tokenizer_wraps_special_tokens(tiny_tokenizer)


def test_load_trained_tokenizer_rejects_saved_plain_tokenizer(tiny_tokenizer: PreTrainedTokenizerBase, tmp_path: Path) -> None:
    """규칙 없이 저장된 토크나이저(예: 기반 모델 디렉터리)는 평가·워커용으로 불러오지 않는다."""
    tiny_tokenizer.save_pretrained(str(tmp_path))
    with pytest.raises(ModelFormatError):
        modeling.load_trained_tokenizer(tmp_path)


def test_round_trip_check_passes_for_saved_copy(tiny_tokenizer: PreTrainedTokenizerBase, tmp_path: Path) -> None:
    """저장한 토크나이저를 다시 불러와 고정 탐침 문장의 토큰이 같으면 통과한다."""
    modeling.install_special_token_template(tiny_tokenizer)
    tiny_tokenizer.save_pretrained(str(tmp_path))
    modeling.verify_saved_tokenizer_round_trip(tiny_tokenizer, tmp_path, SHORT_MAX_LENGTH)


def test_round_trip_check_fails_loudly_on_mismatch(tiny_tokenizer: PreTrainedTokenizerBase, tmp_path: Path) -> None:
    """저장된 토크나이저의 토큰이 메모리의 것과 다르면 오류를 낸다(워커가 다른 입력을 받게 되는 사고를 막는다)."""
    other_vocabulary = {"[UNK]": 0, "[CLS]": 1, "[SEP]": 2, "[PAD]": 3, "[MASK]": 4, "가": 8, "나": 7, "다": 6, "라": 5}
    other = build_tiny_tokenizer(other_vocabulary)
    modeling.install_special_token_template(other)
    other.save_pretrained(str(tmp_path))
    modeling.install_special_token_template(tiny_tokenizer)
    with pytest.raises(ModelFormatError, match="다시 불러온 토크나이저"):
        modeling.verify_saved_tokenizer_round_trip(tiny_tokenizer, tmp_path, SHORT_MAX_LENGTH)


def test_round_trip_probes_include_empty_and_long_text() -> None:
    """왕복 검사 탐침에는 빈 문장과 max_length보다 긴 문장이 들어 있다."""
    assert "" in modeling.ROUND_TRIP_PROBE_TEXTS
    assert any(len(text) > 128 for text in modeling.ROUND_TRIP_PROBE_TEXTS)
