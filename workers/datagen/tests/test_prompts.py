"""생성 지시가 계획의 의미 칸과 안전 경계를 계속 지키는지 확인한다."""

from __future__ import annotations

from collections import Counter

from zg_datagen.prompts import HARMFUL_SLOTS, SITUATIONS, build_harmful_messages, iter_cells, messages_sha256


def test_slots_and_prohibitions_are_present() -> None:
    """의미 칸이나 금지 조건이 빠지면 잘못된 후보가 대량 생성되므로 둘을 함께 고정한다."""
    required = {
        "threat": ("화자의 해칠 의도", "대상", "조건이나 결과"),
        "minors": ("미성년 단서", "개인 연락으로 옮기기나 사적 만남 요청"),
        "sexual": ("외모 칭찬이 아닌 비동의 성적 대상화",),
        "doxxing": ("실명·직장·학교·사는 곳을 특정해 드러내거나 드러내겠다는 말",),
        "self_harm": ("화자 본인의 의도",),
    }
    assert required == HARMFUL_SLOTS
    prompt = "\n".join(message["content"] for message in build_harmful_messages(next(iter_cells("minors")), 2))
    assert "미성년 관련 성적 내용" in prompt and "노골적인 성적 묘사" in prompt
    assert "자해 방법" in prompt and "실제 개인정보" in prompt
    assert "예시" not in prompt and "예문" not in prompt


def test_cells_are_balanced_and_deterministic() -> None:
    """스타일 축이 한쪽으로 쏠리면 모델 말투를 학습하므로 완전 조합과 순서를 고정한다."""
    first = list(iter_cells("threat"))
    second = list(iter_cells("threat"))
    assert first == second
    assert len(first) == len(SITUATIONS["threat"]) * 3 * 2 * 2 * 2
    assert len(set(first)) == len(first)
    for field in ("length", "register", "directness", "noise"):
        counts = Counter(getattr(cell, field) for cell in first)
        assert max(counts.values()) == min(counts.values())
    for size in (6, 12, 18):
        for field in ("situation", "length", "register", "directness", "noise"):
            counts = Counter(getattr(cell, field) for cell in first[:size])
            assert max(counts.values()) - min(counts.values()) <= 1


def test_message_hash_is_canonical() -> None:
    """키 순서가 달라도 같은 지시를 같은 것으로 세어 manifest 비교가 흔들리지 않게 한다."""
    first = [{"role": "user", "content": "중립문"}]
    second = [{"content": "중립문", "role": "user"}]
    assert messages_sha256(first) == messages_sha256(second)
