"""워커 계약 v1(workers/contract/README.md)의 요청 검증과 응답 만들기. HTTP·모델과 상관없는 순수 함수다.

왜 따로 두나: 1차·2차 워커와 서버 클라이언트가 같은 계약을 따라야 한다. 검증을 순수 함수로 두면 계약 사례 파일
(workers/contract/v1/requests.json)로 HTTP 없이 시험할 수 있고, 2차 워커는 이 파일을 그대로 복사해 쓴다.
주의: 오류에는 코드만 담는다. 채팅 원문이 오류 본문·로그로 새지 않게 하기 위해서다.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass

# 계약 번호. 응답에 싣고, 받는 쪽은 모르는 번호를 거절한다.
CONTRACT_VERSION = 1

# 본문 크기 상한(바이트). 1,000자 × 32건을 UTF-8로 넉넉히 담으면서, 큰 본문으로 메모리를 쓰게 하지 않는 값이다.
MAX_BODY_BYTES = 65_536

# text 길이 상한(유니코드 코드 포인트). 방송 채팅 한 줄보다 충분히 길다. 넘으면 자르지 않고 거절한다(판정 입력을 몰래 바꾸지 않기 위해서다).
MAX_TEXT_CODE_POINTS = 1_000

# id 형식. 서버가 만드는 메시지 식별자 모양이고, 로그에 써도 안전한 글자만 받는다.
IDENTIFIER_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,64}")

# 모델 식별자 길이 상한(응답).
MAX_MODEL_LENGTH = 200


class ContractError(Exception):
    """계약에 맞지 않는 요청. code는 오류 본문에 그대로 싣는 짧은 코드이고, status는 HTTP 상태 코드다."""

    def __init__(self, code: str, status: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class ClassifyItem:
    """판정할 채팅 한 줄."""

    item_id: str
    text: str


@dataclass(frozen=True)
class ItemVerdict:
    """한 줄의 판정. category는 1차에서 None, 2차에서 "S1"~"S7"이다."""

    unsafe_probability: float
    category: str | None


def reject_json_constant(name: str) -> float:
    """JSON 표준이 아닌 NaN·Infinity를 거절한다(파이썬 json은 기본으로 받아들인다)."""
    raise ContractError("invalid_json")


def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """같은 키가 두 번 나오면 거절한다. 파이썬 json은 뒤엣것을 조용히 쓰는데, 다른 파서는 앞엣것을 쓸 수 있어서다."""
    keys = [key for key, _ in pairs]
    if len(set(keys)) != len(keys):
        raise ContractError("invalid_body")
    return dict(pairs)


def decode_json_body(body: bytes) -> object:
    """UTF-8 JSON 본문을 읽는다. UTF-8이 아니거나 JSON이 아니면 invalid_json이다."""
    try:
        return json.loads(body.decode("utf-8"), parse_constant=reject_json_constant, object_pairs_hook=reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContractError("invalid_json") from error


def require_exact_keys(value: object, keys: set[str]) -> dict[str, object]:
    """value가 정확히 keys만 가진 객체인지 확인한다. 아니면 invalid_body다."""
    if not isinstance(value, dict) or set(value) != keys:
        raise ContractError("invalid_body")
    return value


def validate_identifier(value: object) -> str:
    """id 형식을 확인한다."""
    if not isinstance(value, str) or not IDENTIFIER_PATTERN.fullmatch(value):
        raise ContractError("bad_id")
    return value


def has_lone_surrogate(text: str) -> bool:
    """짝 없는 서로게이트(U+D800~U+DFFF)가 있는지. JSON 이스케이프로 들어올 수 있고, 토크나이저가 다루지 못한다."""
    return any("\ud800" <= character <= "\udfff" for character in text)


def validate_text(value: object) -> str:
    """text가 1~1,000 코드 포인트의 올바른 유니코드 문자열인지 확인한다."""
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_TEXT_CODE_POINTS or has_lone_surrogate(value):
        raise ContractError("bad_text")
    return value


def validate_item(value: object) -> ClassifyItem:
    """항목 하나를 확인한다. 키 → id → text 순서로 본다."""
    item = require_exact_keys(value, {"id", "text"})
    return ClassifyItem(validate_identifier(item["id"]), validate_text(item["text"]))


def ensure_unique_identifiers(items: Sequence[ClassifyItem]) -> None:
    """한 요청 안에서 id가 겹치지 않아야 한다. 응답을 id로 맞춰 보는 서버가 헷갈리지 않게 하기 위해서다."""
    if len({item.item_id for item in items}) != len(items):
        raise ContractError("duplicate_id")


def parse_classify_request(body: bytes, max_items: int) -> list[ClassifyItem]:
    """`/classify` 본문을 확인하고 항목 목록을 돌려준다.

    max_items: 워커가 한 번에 받는 항목 수 상한(1차 32, 2차 4).
    """
    raw_items = require_exact_keys(decode_json_body(body), {"items"})["items"]
    if not isinstance(raw_items, list) or not raw_items:
        raise ContractError("invalid_body")
    if len(raw_items) > max_items:
        raise ContractError("too_many_items")
    items = [validate_item(raw_item) for raw_item in raw_items]
    ensure_unique_identifiers(items)
    return items


def validate_verdict(verdict: ItemVerdict) -> None:
    """워커가 내보낼 판정이 계약에 맞는지 확인한다. 맞지 않으면 모델·코드 문제라 ValueError로 알린다(요청 탓이 아니다)."""
    probability = verdict.unsafe_probability
    if not (isinstance(probability, float | int) and math.isfinite(probability) and 0.0 <= probability <= 1.0):
        raise ValueError("unsafe_probability가 0~1의 유한한 수가 아닙니다. 모델 출력 계산을 확인하세요.")


def encode_json(document: object) -> bytes:
    """응답 JSON을 UTF-8로 만든다. NaN·Infinity는 표준 JSON이 아니라 만들지 않는다."""
    return json.dumps(document, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def build_classify_response(model: str, items: Sequence[ClassifyItem], verdicts: Sequence[ItemVerdict]) -> bytes:
    """`/classify` 응답 본문. 요청과 같은 순서, 같은 id로 만든다."""
    if len(items) != len(verdicts):
        raise ValueError("판정 수가 항목 수와 다릅니다. 점수 함수가 입력 순서대로 하나씩 돌려주는지 확인하세요.")
    for verdict in verdicts:
        validate_verdict(verdict)
    entries = [
        {"id": item.item_id, "unsafe_probability": float(verdict.unsafe_probability), "category": verdict.category}
        for item, verdict in zip(items, verdicts, strict=True)
    ]
    return encode_json({"contract": CONTRACT_VERSION, "model": model, "items": entries})


def build_health_response(model: str) -> bytes:
    """`/health` 응답 본문."""
    return encode_json({"contract": CONTRACT_VERSION, "model": model, "ready": True})


def build_error_response(code: str) -> bytes:
    """오류 본문. 코드만 담는다."""
    return encode_json({"error": code})


def validate_model_identifier(model: str) -> str:
    """응답에 실을 모델 식별자가 1~200자인지 확인한다. 시작할 때 한 번 본다."""
    if not 1 <= len(model) <= MAX_MODEL_LENGTH:
        raise ValueError(f"모델 식별자는 1~{MAX_MODEL_LENGTH}자여야 합니다. 모델 디렉터리 이름을 줄이세요.")
    return model
