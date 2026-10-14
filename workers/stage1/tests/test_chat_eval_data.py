"""chat_eval_data 모듈 테스트: 형식 검증, 겹침 검사(72문장·셋 사이·셋 안), 봉인 해시."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.conftest import write_jsonl
from zg_stage1.chat_eval_data import (
    SEALED_REGRESSION_SHA256,
    OverlapIndex,
    character_ngrams,
    find_internal_duplicates,
    find_overlaps,
    jaccard_similarity,
    load_chat_eval_set,
    load_sealed_regression_index,
    main,
    normalize_for_overlap,
)
from zg_stage1.data import compute_file_sha256
from zg_stage1.errors import DatasetFormatError
from zg_stage1.paths import CHAT_SAMPLES_PATH


def eval_record(identifier: str, text: str, label: str = "allow", category: str = "long_normal", split: str = "dev", **overrides: str) -> dict:
    """평가셋 한 줄(기본은 개발셋의 일반 허용 문장). 작성자와 검토자는 서로 다르다."""
    record = {"id": identifier, "split": split, "label": label, "category": category, "family": f"{category}-test"}
    record |= {"author": "model-a", "reviewer": "model-b", "text": text}
    record.update(overrides)
    return record


def test_sealed_regression_file_is_unchanged() -> None:
    """72문장 회귀 세트는 봉인했다. 내용이 바뀌면 이 테스트가 실패한다."""
    assert compute_file_sha256(CHAT_SAMPLES_PATH) == SEALED_REGRESSION_SHA256


def test_loads_valid_items(tmp_path: Path) -> None:
    """올바른 줄은 ChatEvalItem으로 읽히고, ambiguous는 지표 대상이 아니다."""
    records = [eval_record("d1", "오늘 방송 몇시까지 해요?"), eval_record("d2", "애매한 말", label="ambiguous", category="abuse")]
    path = write_jsonl(tmp_path / "dev.jsonl", records)
    items = load_chat_eval_set(path)
    assert [item.item_id for item in items] == ["d1", "d2"]
    assert [item.is_scored for item in items] == [True, False]


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"label": "toxic"}, "label 값"),
        ({"label": "harmful", "category": "long_normal"}, "category 값"),
        ({"label": "allow", "category": "sexual"}, "category 값"),
        ({"split": "train"}, "split 값"),
        ({"reviewer": "model-a"}, "작성자와 검토자가 같습니다"),
        ({"family": 3}, "'family' 필드"),
    ],
)
def test_rejects_invalid_fields(tmp_path: Path, overrides: dict, message: str) -> None:
    """라벨·범주·셋 값이 틀리거나, 검토자가 작성자와 같거나, 필드 형식이 틀리면 오류를 낸다."""
    path = write_jsonl(tmp_path / "dev.jsonl", [eval_record("d1", "문장", **overrides)])
    with pytest.raises(DatasetFormatError, match=message):
        load_chat_eval_set(path)


def test_rejects_duplicate_ids_and_mixed_splits(tmp_path: Path) -> None:
    """id가 겹치거나 한 파일에 개발셋·보류셋이 섞이면 오류를 낸다."""
    duplicated = write_jsonl(tmp_path / "a.jsonl", [eval_record("d1", "가나다"), eval_record("d1", "라마바")])
    with pytest.raises(DatasetFormatError, match="id가 겹칩니다"):
        load_chat_eval_set(duplicated)
    mixed = write_jsonl(tmp_path / "b.jsonl", [eval_record("d1", "가나다"), eval_record("h1", "라마바", split="holdout")])
    with pytest.raises(DatasetFormatError, match="여러 셋"):
        load_chat_eval_set(mixed)


def test_rejects_empty_file(tmp_path: Path) -> None:
    """빈 파일은 오류다."""
    path = tmp_path / "empty.jsonl"
    path.write_text("\n", encoding="utf-8")
    with pytest.raises(DatasetFormatError, match="평가 문장이 없습니다"):
        load_chat_eval_set(path)


def test_normalization_ignores_spacing_case_and_punctuation() -> None:
    """띄어쓰기·대소문자·문장부호·전각 문자만 다른 문장은 같게 정규화된다."""
    assert normalize_for_overlap("GG 잘했다!!") == normalize_for_overlap("ｇｇ잘 했다.")


def test_jaccard_on_character_ngrams() -> None:
    """같으면 1, 전혀 다르면 0, 짧은 문장은 문장 전체 하나로 비교한다."""
    assert jaccard_similarity(character_ngrams("가나다라"), character_ngrams("가나다라")) == 1.0
    assert jaccard_similarity(character_ngrams("가나다라"), character_ngrams("마바사아")) == 0.0
    assert character_ngrams("가나") == frozenset({"가나"})
    assert jaccard_similarity(frozenset(), frozenset()) == 0.0


def test_finds_exact_and_near_duplicates_against_reference(tmp_path: Path) -> None:
    """참조 문장과 같거나(띄어쓰기만 다름) 거의 같은 문장은 잡고, 다른 문장은 잡지 않는다."""
    index = OverlapIndex.build([("r1", "오늘 방송 진짜 재밌다 ㅋㅋ"), ("r2", "내일은 몇 시에 켜요")])
    items = load_chat_eval_set(
        write_jsonl(
            tmp_path / "dev.jsonl",
            [eval_record("d1", "오늘방송 진짜재밌다ㅋㅋ"), eval_record("d2", "오늘 방송 진짜 재밌다 ㅋㅋㅋ 굿"), eval_record("d3", "점심 뭐 먹었어요")],
        )
    )
    findings = find_overlaps(items, index)
    assert [(finding.item_id, finding.reference_id) for finding in findings] == [("d1", "r1"), ("d2", "r1")]
    assert findings[0].similarity == 1.0


def test_symbol_only_texts_are_not_compared(tmp_path: Path) -> None:
    """정규화하면 비는 문장(기호만)은 겹침 비교에서 뺀다. 모든 기호 문장이 서로 같다고 나오지 않게 하기 위해서다."""
    index = OverlapIndex.build([("r1", "!!!")])
    items = load_chat_eval_set(write_jsonl(tmp_path / "dev.jsonl", [eval_record("d1", "???"), eval_record("d2", "...")]))
    assert find_overlaps(items, index) == []
    assert find_internal_duplicates(items) == []


def test_finds_internal_duplicates(tmp_path: Path) -> None:
    """한 셋 안에서 정규화 후 같은 문장은 두 번째 것을 보고한다."""
    items = load_chat_eval_set(write_jsonl(tmp_path / "dev.jsonl", [eval_record("d1", "화이팅!"), eval_record("d2", "화이팅"), eval_record("d3", "굿")]))
    assert [(finding.item_id, finding.reference_id) for finding in find_internal_duplicates(items)] == [("d2", "d1")]


def test_sealed_index_covers_all_regression_sentences() -> None:
    """봉인 색인은 72문장 중 기호만 있는 문장을 뺀 나머지를 모두 담고, id에 sealed: 접두사를 붙인다."""
    index = load_sealed_regression_index()
    assert 60 <= len(index.entries) <= 72
    assert all(entry[0].startswith("sealed:") for entry in index.entries)


def test_cli_reports_overlap_between_files(tmp_path: Path, capsys) -> None:
    """개발셋과 보류셋에 거의 같은 문장이 있으면 CLI가 id와 함께 오류를 낸다. 원문은 메시지에 넣지 않는다."""
    dev = write_jsonl(tmp_path / "dev.jsonl", [eval_record("d1", "이번 판 정글 동선 너무 좋았어요")])
    holdout = write_jsonl(tmp_path / "holdout.jsonl", [eval_record("h1", "이번 판 정글 동선 너무 좋았어요!!", split="holdout")])
    with pytest.raises(DatasetFormatError, match="d1~h1") as raised:
        main([str(dev), str(holdout)])
    assert "정글" not in str(raised.value)


def test_cli_passes_clean_files(tmp_path: Path, capsys) -> None:
    """겹침이 없으면 건수 요약과 '겹침 없음'을 출력한다."""
    dev = write_jsonl(tmp_path / "dev.jsonl", [eval_record("d1", "이번 판 정글 동선 너무 좋았어요")])
    holdout = write_jsonl(tmp_path / "holdout.jsonl", [eval_record("h1", "저녁 메뉴 추천 좀 해주세요", split="holdout")])
    main([str(dev), str(holdout)])
    output = capsys.readouterr().out
    assert "dev.jsonl: 1건(dev)" in output and "겹침 없음" in output
