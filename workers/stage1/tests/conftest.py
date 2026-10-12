"""테스트 공용 도구: 작은 JSONL 파일을 임시 디렉터리에 만드는 함수.

모델 다운로드·네트워크 없이, 메모리에서 만든 몇 줄짜리 데이터로만 시험한다.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from tokenizers import Tokenizer, models, pre_tokenizers
from transformers import PreTrainedTokenizerBase, PreTrainedTokenizerFast

# 아주 작은 WordPiece 어휘. 특수 토큰 번호를 KcELECTRA와 같게([CLS]=1, [SEP]=2, [PAD]=3) 맞춰 실제와 비슷한 조건을 만든다.
TINY_VOCABULARY: dict[str, int] = {"[UNK]": 0, "[CLS]": 1, "[SEP]": 2, "[PAD]": 3, "[MASK]": 4, "가": 5, "나": 6, "다": 7, "라": 8}


def write_jsonl(path: Path, records: list[dict]) -> Path:
    """records를 한 줄에 하나씩 JSON으로 써서 JSONL 파일을 만든다."""
    path.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records), encoding="utf-8")
    return path


@pytest.fixture
def khaters_records() -> list[dict]:
    """라벨 4종이 모두 들어 있는 K-HATERS 형식 레코드 6건(문장은 무해한 자리표시자)."""
    labels = ["normal", "offensive", "L1_hate", "L2_hate", "normal", "offensive"]
    return [{"id": index, "text": f"문장{index}", "label": label} for index, label in enumerate(labels)]


def build_tiny_tokenizer(vocabulary: dict[str, int] = TINY_VOCABULARY) -> PreTrainedTokenizerBase:
    """네트워크 없이 메모리에서 만드는 작은 WordPiece 토크나이저. 후처리 규칙이 없어 KcELECTRA 원본과 같은 상태다."""
    backend = Tokenizer(models.WordPiece(vocabulary, unk_token="[UNK]"))
    backend.pre_tokenizer = pre_tokenizers.Whitespace()
    return PreTrainedTokenizerFast(tokenizer_object=backend, unk_token="[UNK]", cls_token="[CLS]", sep_token="[SEP]", pad_token="[PAD]", mask_token="[MASK]")


@pytest.fixture
def tiny_tokenizer() -> PreTrainedTokenizerBase:
    """후처리 규칙이 없는 작은 토크나이저(테스트마다 새로 만든다)."""
    return build_tiny_tokenizer()
