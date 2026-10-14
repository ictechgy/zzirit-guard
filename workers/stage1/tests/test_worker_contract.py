"""worker_contract 테스트: 계약 사례 파일(workers/contract/v1/requests.json)의 본문 사례와 응답 만들기."""

from __future__ import annotations

import json
import math

import pytest

from tests.worker_cases import build_case_body, expected_error, expected_status, load_request_cases
from zg_stage1.worker_contract import (
    MAX_BODY_BYTES,
    ClassifyItem,
    ContractError,
    ItemVerdict,
    build_classify_response,
    build_error_response,
    build_health_response,
    parse_classify_request,
    validate_model_identifier,
)

# 1차 워커의 항목 수 상한(계약 v1).
STAGE1_MAX_ITEMS = 32

# 본문 검증만으로 판정할 수 있는 사례: 헤더·경로·메서드·크기를 보는 사례는 HTTP 테스트가 맡는다.
HTTP_ONLY_KEYS = {"method", "path", "content_type", "omit_content_length", "transfer_encoding", "generate_raw_bytes"}
BODY_CASES = [case for case in load_request_cases() if not HTTP_ONLY_KEYS & set(case) and build_case_body(case) is not None]


@pytest.mark.parametrize("case", BODY_CASES, ids=[case["name"] for case in BODY_CASES])
def test_body_cases_match_contract(case: dict) -> None:
    """사례 본문을 검증하면 기대한 상태 코드(200이면 통과, 아니면 그 오류 코드)가 나온다."""
    body = build_case_body(case)
    assert body is not None
    if expected_status(case, "stage1") == 200:
        assert len(parse_classify_request(body, STAGE1_MAX_ITEMS)) >= 1
        return
    with pytest.raises(ContractError) as raised:
        parse_classify_request(body, STAGE1_MAX_ITEMS)
    assert (raised.value.status, raised.value.code) == (expected_status(case, "stage1"), expected_error(case, "stage1"))


def test_body_cases_cover_every_error_code_checked_in_bodies() -> None:
    """본문 사례가 본문 검증의 모든 오류 코드를 한 번 이상 다룬다(사례 파일이 줄어들어 검증이 빠지지 않게)."""
    codes = {expected_error(case, "stage1") for case in BODY_CASES if "error" in case}
    assert codes >= {"invalid_json", "invalid_body", "too_many_items", "bad_id", "duplicate_id", "bad_text"}


def test_contract_constants_match_readme() -> None:
    """본문 상한은 계약 문서와 같은 65,536바이트다."""
    assert MAX_BODY_BYTES == 65_536


def test_response_keeps_request_order_and_ids() -> None:
    """응답 항목은 요청과 같은 순서·id이고, 1차는 범주가 null이다."""
    items = [ClassifyItem("b", "둘"), ClassifyItem("a", "하나")]
    document = json.loads(build_classify_response("m@0123456789ab", items, [ItemVerdict(0.2, None), ItemVerdict(1, None)]))
    assert document == {
        "contract": 1,
        "model": "m@0123456789ab",
        "items": [{"id": "b", "unsafe_probability": 0.2, "category": None}, {"id": "a", "unsafe_probability": 1.0, "category": None}],
    }


@pytest.mark.parametrize("probability", [math.nan, math.inf, -0.01, 1.01])
def test_response_rejects_invalid_probability(probability: float) -> None:
    """모델이 계약 밖의 확률을 내면 응답을 만들지 않는다(서버가 잘못된 값을 받지 않게)."""
    with pytest.raises(ValueError):
        build_classify_response("m", [ClassifyItem("a", "가")], [ItemVerdict(probability, None)])


def test_response_rejects_count_mismatch() -> None:
    """판정 수가 항목 수와 다르면 응답을 만들지 않는다."""
    with pytest.raises(ValueError):
        build_classify_response("m", [ClassifyItem("a", "가")], [])


def test_health_and_error_bodies() -> None:
    """상태 확인과 오류 본문의 모양."""
    assert json.loads(build_health_response("m")) == {"contract": 1, "model": "m", "ready": True}
    assert json.loads(build_error_response("bad_text")) == {"error": "bad_text"}


@pytest.mark.parametrize("model", ["", "m" * 201])
def test_model_identifier_length(model: str) -> None:
    """모델 식별자는 1~200자다."""
    with pytest.raises(ValueError):
        validate_model_identifier(model)


@pytest.mark.parametrize("category", [None, "S1", "S7"])
def test_response_accepts_contract_categories(category: str | None) -> None:
    """범주는 None(1차)이나 S1~S7(2차)이다."""
    build_classify_response("m", [ClassifyItem("a", "가")], [ItemVerdict(0.5, category)])


@pytest.mark.parametrize("category", ["S0", "S8", "s1", ""])
def test_response_rejects_unknown_category(category: str) -> None:
    """계약 밖의 범주는 응답을 만들지 않는다."""
    with pytest.raises(ValueError):
        build_classify_response("m", [ClassifyItem("a", "가")], [ItemVerdict(0.5, category)])
