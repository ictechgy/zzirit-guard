"""비공개 목록과 구조 규칙이 우회 표기를 포함해 안전 경계를 지키는지 확인한다."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from zg_datagen.filters import detect_drop_reason, load_private_lists, run_filters


def make_lists(directory: Path) -> Path:
    """실제 목록을 공개하지 않고 중립 자리표시자로 동일한 매칭 동작을 검증한다."""
    directory.mkdir()
    (directory / "sexual.txt").write_text("금칙가\n", encoding="utf-8")
    (directory / "minor-markers.txt").write_text("미성표식\n", encoding="utf-8")
    (directory / "self-harm-means.txt").write_text("수단가\n", encoding="utf-8")
    return directory


def test_jamo_age_and_pii_detection(tmp_path: Path) -> None:
    """띄어쓰기·자모 분리와 목록 밖 숫자 형태를 함께 보아 단순 우회를 놓치지 않는다."""
    lists = load_private_lists(make_lists(tmp_path / "lists"))
    assert detect_drop_reason("ㅁㅣㅅㅓㅇㅍㅛㅅㅣㄱ 과 ㄱㅡㅁㅊㅣㄱㄱㅏ", lists) == "minor_sexual"
    assert detect_drop_reason("열세 살 금칙가", lists) == "minor_sexual"
    assert detect_drop_reason("010-1234-5678", lists) == "pii_like"
    assert detect_drop_reason("12동 345호", lists) == "pii_like"
    assert detect_drop_reason("수단가", lists) == "self_harm_means"


def test_invisible_symbol_and_combining_insertions_do_not_bypass(tmp_path: Path) -> None:
    """폭 없는 문자·기호·결합 부호를 낱말이나 숫자 사이에 끼워도 같은 규칙에 걸린다(보안 검토)."""
    lists = load_private_lists(make_lists(tmp_path / "lists"))
    assert detect_drop_reason("미\u200b성\u2060표식 금\u200d칙★가", lists) == "minor_sexual"
    assert detect_drop_reason("1\u200b3살 금칙\u0301가", lists) == "minor_sexual"
    assert detect_drop_reason("수\ufeff단✦가", lists) == "self_harm_means"
    assert detect_drop_reason("010·1234·5678", lists) == "pii_like"
    assert detect_drop_reason("평범한 중립 문장", lists) is None


def test_missing_or_empty_list_is_an_error(tmp_path: Path) -> None:
    """안전 목록이 덜 로드된 상태를 정상으로 오해하지 않도록 즉시 중단한다."""
    directory = make_lists(tmp_path / "lists")
    (directory / "sexual.txt").write_text("# 비어 있음\n", encoding="utf-8")
    with pytest.raises(ValueError, match="sexual.txt"):
        load_private_lists(directory)


def test_filter_writes_reasons_without_changing_kept_rows(tmp_path: Path) -> None:
    """버린 이유는 감사 가능해야 하고 통과 레코드는 생성 결과와 같아야 한다."""
    source = tmp_path / "source.jsonl"
    rows = [{"id": "a", "kind": "harmful", "text": "평범"}, {"id": "b", "kind": "twin", "text": "수단가"}]
    source.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")
    kept, dropped = tmp_path / "kept.jsonl", tmp_path / "dropped.jsonl"
    report = run_filters(source, make_lists(tmp_path / "lists"), kept, dropped)
    assert json.loads(kept.read_text(encoding="utf-8")) == rows[0]
    assert json.loads(dropped.read_text(encoding="utf-8"))["drop_reason"] == "self_harm_means"
    assert report["by_reason"] == {"self_harm_means": 1}
