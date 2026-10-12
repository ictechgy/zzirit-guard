"""워커가 읽는 추론 계약(inference.json): max_length, 유해 칸 번호, [CLS]·[SEP] 요구.

왜 따로 파일로 두나: 워커(2단계)는 학습 코드와 따로 돈다. 학습 때의 max_length나 입력 형식을 워커가 추측하면
점수가 조용히 어긋난다. 그래서 학습 결과 디렉터리에 기계가 읽을 수 있는 약속을 남기고, 워커는 이 파일을 읽어 따른다.
"""

from __future__ import annotations

import json
from pathlib import Path

from transformers import PreTrainedTokenizerBase

from zg_stage1.errors import ModelFormatError
from zg_stage1.model_card import write_json_atomically
from zg_stage1.modeling import (
    ID_TO_LABEL,
    INPUT_FORMAT_DESCRIPTION,
    TOXIC_CLASS_INDEX,
    ensure_tokenizer_wraps_special_tokens,
)
from zg_stage1.thresholds import SPEC_STAGE1_THRESHOLD

# 추론 계약 파일 이름(학습 결과 디렉터리 안).
INFERENCE_CONTRACT_FILE_NAME = "inference.json"

# 계약 형식 버전. 필드 뜻이 바뀌면 올려서 워커가 모르는 형식을 거부하게 한다.
INFERENCE_CONTRACT_SCHEMA_VERSION = 1

# 계약에 반드시 있어야 하는 정수 필드. 워커가 이 값 없이는 학습 때와 같은 입력·점수를 만들 수 없다.
REQUIRED_INTEGER_FIELDS: tuple[str, ...] = ("schema_version", "max_length", "toxic_class_index")

# 계약을 다시 만드는 방법(오류 메시지용).
REGENERATE_HINT = "python -m zg_stage1.write_inference_contract --model-dir <디렉터리> --overwrite로 다시 만드세요."


def build_inference_contract(tokenizer: PreTrainedTokenizerBase, max_length: int) -> dict:
    """워커용 추론 계약을 만든다.

    tokenizer: [CLS]·[SEP] 규칙이 든 학습 결과 토크나이저. 규칙이 없으면 계약과 동작이 어긋나므로 거부한다.
    max_length: 학습 때의 최대 토큰 수([CLS]·[SEP] 포함). 워커는 이 값으로 잘라야 한다.
    """
    ensure_tokenizer_wraps_special_tokens(tokenizer)
    return {
        "schema_version": INFERENCE_CONTRACT_SCHEMA_VERSION,
        "max_length": max_length,
        "toxic_class_index": TOXIC_CLASS_INDEX,
        "labels": {str(index): label for index, label in ID_TO_LABEL.items()},
        "score": "softmax(logits)[toxic_class_index]",
        "special_tokens": {
            "requires_cls_sep_wrapping": True,
            "cls_token": tokenizer.cls_token,
            "cls_token_id": tokenizer.cls_token_id,
            "sep_token": tokenizer.sep_token,
            "sep_token_id": tokenizer.sep_token_id,
            "pad_token_id": tokenizer.pad_token_id,
        },
        "input_format": INPUT_FORMAT_DESCRIPTION,
        "tokenizer_files": ["tokenizer.json", "tokenizer_config.json"],
        "spec_stage1_threshold": SPEC_STAGE1_THRESHOLD,
    }


def write_inference_contract_file(model_directory: Path, contract: dict) -> Path:
    """계약을 모델 디렉터리에 원자적으로 쓰고 경로를 돌려준다. 덮어쓰기 여부는 호출자가 정한다."""
    contract_path = model_directory / INFERENCE_CONTRACT_FILE_NAME
    write_json_atomically(contract_path, contract)
    return contract_path


def validate_contract(contract: object) -> dict:
    """읽은 계약이 객체이고 필수 정수 필드를 모두 갖췄는지 확인한다. 아니면 다시 만드는 방법을 담은 오류를 낸다."""
    if not isinstance(contract, dict):
        raise ModelFormatError(f"{INFERENCE_CONTRACT_FILE_NAME}이 JSON 객체가 아닙니다. {REGENERATE_HINT}")
    missing = [name for name in REQUIRED_INTEGER_FIELDS if type(contract.get(name)) is not int]
    if missing:
        raise ModelFormatError(f"{INFERENCE_CONTRACT_FILE_NAME}에 정수 필드 {missing}가 없습니다. {REGENERATE_HINT}")
    return contract


def read_inference_contract(model_directory: Path) -> dict | None:
    """모델 디렉터리의 계약을 읽는다. 없으면 None(계약 이전에 만든 학습 결과)이고, 깨졌으면 오류를 낸다."""
    contract_path = model_directory / INFERENCE_CONTRACT_FILE_NAME
    if not contract_path.is_file():
        return None
    try:
        return validate_contract(json.loads(contract_path.read_text(encoding="utf-8")))
    except json.JSONDecodeError as error:
        raise ModelFormatError(f"{INFERENCE_CONTRACT_FILE_NAME}을 JSON으로 읽을 수 없습니다({error.msg}). {REGENERATE_HINT}") from error
