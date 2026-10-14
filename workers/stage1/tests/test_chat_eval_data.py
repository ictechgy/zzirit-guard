"""chat_eval_data 모듈 테스트: 형식 검증, 겹침 검사(72문장·셋 사이·셋 안), 봉인 해시."""

from __future__ import annotations

import random
from pathlib import Path

import pytest

from tests.conftest import write_jsonl
from zg_stage1.chat_eval_data import (
    ALLOW_CATEGORIES,
    HARMFUL_CATEGORIES,
    MIN_SCORED_PER_CATEGORY,
    SEALED_REGRESSION_SHA256,
    OverlapIndex,
    character_ngrams,
    ensure_ambiguous_limit,
    ensure_category_coverage,
    find_family_conflicts,
    find_internal_duplicates,
    find_overlaps,
    jaccard_similarity,
    load_chat_eval_set,
    load_sealed_regression_index,
    load_validated_eval_set,
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


def test_normalization_keeps_separators_between_digits() -> None:
    """숫자 사이의 점·콜론은 남긴다. "1.5배속"과 "15배속"은 다른 문장이다. 숫자 뒤 마침표는 지운다."""
    assert normalize_for_overlap("1.5배속") != normalize_for_overlap("15배속")
    assert normalize_for_overlap("2:1 역전") != normalize_for_overlap("21 역전")
    assert normalize_for_overlap("3판.") == normalize_for_overlap("3판")
    assert len({normalize_for_overlap(text) for text in ("1.5배속", "1:5배속", "1,5배속")}) == 3


def test_cli_rejects_same_split_twice(tmp_path: Path) -> None:
    """개발셋 두 개처럼 같은 셋이 두 번 오면 오류다."""
    first = write_jsonl(tmp_path / "a.jsonl", full_coverage_records("dev"))
    second = write_jsonl(tmp_path / "b.jsonl", full_coverage_records("dev", seed_offset=10_000))
    with pytest.raises(DatasetFormatError, match="같은 셋"):
        main([str(first), str(second)])


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


def test_finds_internal_near_duplicates(tmp_path: Path) -> None:
    """한 셋 안에서 같거나 거의 같은(낱말 하나만 다른) 문장은 뒤의 것을 보고한다."""
    records = [eval_record("d1", "오늘 방송 진짜 재밌다 ㅋㅋ"), eval_record("d2", "오늘 방송 진짜 재밌다 ㅋㅋㅋ"), eval_record("d3", "점심 뭐 드셨어요")]
    items = load_chat_eval_set(write_jsonl(tmp_path / "dev.jsonl", records))
    assert [(finding.item_id, finding.reference_id) for finding in find_internal_duplicates(items)] == [("d2", "d1")]


def test_symbol_only_texts_are_not_internal_duplicates(tmp_path: Path) -> None:
    """기호만 있는 문장끼리는 같다고 보지 않는다."""
    items = load_chat_eval_set(write_jsonl(tmp_path / "dev.jsonl", [eval_record("d1", "!!!"), eval_record("d2", "???")]))
    assert find_internal_duplicates(items) == []


def test_family_conflicts_are_per_author(tmp_path: Path) -> None:
    """같은 작성자의 같은 계열이 두 셋에 걸치면 보고한다. 다른 작성자가 우연히 같은 이름을 쓴 것은 괜찮다."""
    dev = load_chat_eval_set(write_jsonl(tmp_path / "dev.jsonl", [eval_record("d1", "가나다라마")]))
    same_author = load_chat_eval_set(write_jsonl(tmp_path / "h1.jsonl", [eval_record("h1", "바사아자차", split="holdout")]))
    other_author = load_chat_eval_set(
        write_jsonl(tmp_path / "h2.jsonl", [eval_record("h2", "카타파하가", split="holdout", author="model-c", reviewer="model-a")])
    )
    assert [(finding.item_id, finding.reference_id) for finding in find_family_conflicts([dev, same_author])] == [("h1", "d1")]
    assert find_family_conflicts([dev, other_author]) == []


def test_ambiguous_limit(tmp_path: Path) -> None:
    """ambiguous가 5%를 넘으면 오류다."""
    records = [eval_record(f"d{index}", f"문장 {index}") for index in range(19)] + [eval_record("dx", "애매", label="ambiguous", category="abuse")]
    ensure_ambiguous_limit(load_chat_eval_set(write_jsonl(tmp_path / "ok.jsonl", records)), "ok.jsonl")
    records.append(eval_record("dy", "애매2", label="ambiguous", category="abuse"))
    with pytest.raises(DatasetFormatError, match="5%"):
        ensure_ambiguous_limit(load_chat_eval_set(write_jsonl(tmp_path / "bad.jsonl", records)), "bad.jsonl")


def diverse_text(seed: int) -> str:
    """서로 겹치지 않는 임의 음절 8개짜리 문장. 범주 구성 테스트용 자리표시자다."""
    random_generator = random.Random(seed)
    return "".join(chr(0xAC00 + random_generator.randrange(11172)) for _ in range(8))


def full_coverage_records(split: str, seed_offset: int = 0) -> list[dict]:
    """모든 범주에 최소 수만큼의 채점 문장을 담은 평가셋. 계열 이름에 셋 이름을 넣어 두 셋의 계열이 겹치지 않게 한다."""
    categories = [("harmful", category) for category in HARMFUL_CATEGORIES] + [("allow", category) for category in ALLOW_CATEGORIES]
    records = []
    for label, category in categories:
        for index in range(MIN_SCORED_PER_CATEGORY):
            identifier = f"{split}-{category}-{index}"
            text = diverse_text(seed_offset + len(records))
            records.append(eval_record(identifier, text, label=label, category=category, split=split, family=f"{split}-{category}"))
    return records


def test_category_coverage(tmp_path: Path) -> None:
    """모든 범주에 최소 수가 있으면 통과하고, 하나라도 모자라면 그 범주를 알려 준다."""
    records = full_coverage_records("dev")
    ensure_category_coverage(load_chat_eval_set(write_jsonl(tmp_path / "ok.jsonl", records)), "ok.jsonl")
    short = [record for record in records if not (record["category"] == "minors" and record["id"].endswith("-0"))]
    with pytest.raises(DatasetFormatError, match="minors"):
        ensure_category_coverage(load_chat_eval_set(write_jsonl(tmp_path / "short.jsonl", short)), "short.jsonl")


def test_validated_load_rejects_copy_of_sealed_sentence(tmp_path: Path) -> None:
    """평가용으로 읽을 때도 72문장 겹침을 검사한다. 검사 CLI를 건너뛰어도 막힌다."""
    sealed_text = load_sealed_regression_index().entries[0][1]
    records = full_coverage_records("dev")
    records[0]["text"] = sealed_text
    with pytest.raises(DatasetFormatError, match="sealed:"):
        load_validated_eval_set(write_jsonl(tmp_path / "dev.jsonl", records))


def test_sealed_index_covers_all_regression_sentences() -> None:
    """봉인 색인은 72문장 중 기호만 있는 문장을 뺀 나머지를 모두 담고, id에 sealed: 접두사를 붙인다."""
    index = load_sealed_regression_index()
    assert 60 <= len(index.entries) <= 72
    assert all(entry[0].startswith("sealed:") for entry in index.entries)


def test_cli_reports_overlap_between_files(tmp_path: Path) -> None:
    """개발셋과 보류셋에 거의 같은 문장이 있으면 CLI가 id와 함께 오류를 낸다. 원문은 메시지에 넣지 않는다."""
    dev_records = full_coverage_records("dev")
    holdout_records = full_coverage_records("holdout", seed_offset=10_000)
    holdout_records[0]["text"] = dev_records[0]["text"] + "!!"
    dev = write_jsonl(tmp_path / "dev.jsonl", dev_records)
    holdout = write_jsonl(tmp_path / "holdout.jsonl", holdout_records)
    with pytest.raises(DatasetFormatError, match=f"{dev_records[0]['id']}~{holdout_records[0]['id']}") as raised:
        main([str(dev), str(holdout)])
    assert dev_records[0]["text"] not in str(raised.value)


def test_cli_passes_clean_files(tmp_path: Path, capsys) -> None:
    """겹침이 없으면 건수 요약과 '겹침 없음'을 출력한다."""
    dev = write_jsonl(tmp_path / "dev.jsonl", full_coverage_records("dev"))
    holdout = write_jsonl(tmp_path / "holdout.jsonl", full_coverage_records("holdout", seed_offset=10_000))
    for record_path in (dev, holdout):
        records = [line for line in record_path.read_text(encoding="utf-8").splitlines() if line]
        assert len(records) == 13 * MIN_SCORED_PER_CATEGORY
    main([str(dev), str(holdout)])
    output = capsys.readouterr().out
    assert "dev.jsonl: 260건(dev)" in output and "겹침 없음" in output


def test_committed_eval_sets_are_clean() -> None:
    """저장소에 커밋한 개발셋·보류셋이 모든 검사(72문장·셋 사이·셋 안·계열·범주 구성·애매 비율)를 통과한다."""
    eval_directory = Path(__file__).resolve().parents[1] / "eval_data"
    main([str(eval_directory / "chat-dev-v2.jsonl"), str(eval_directory / "chat-holdout-v2.jsonl")])
