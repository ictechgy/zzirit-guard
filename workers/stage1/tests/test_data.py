"""data 모듈 테스트: 라벨 매핑(모르는 라벨 오류 포함), JSONL 읽기, sha256 출처, 회귀 표본."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from tests.conftest import write_jsonl
from zg_stage1.data import (
    LABEL_TO_BINARY,
    compute_file_sha256,
    describe_file_provenance,
    load_chat_samples,
    load_labeled_texts,
    map_label_to_binary,
    select_regression_sample,
)
from zg_stage1.errors import DatasetFormatError

# sha256("abc")의 표준 시험값(FIPS 180-2 부록).
SHA256_OF_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"


@pytest.mark.parametrize(("label", "expected"), [("normal", 0), ("offensive", 1), ("L1_hate", 1), ("L2_hate", 1)])
def test_known_labels_map_to_binary(label: str, expected: int) -> None:
    """normal만 0이고 나머지 세 라벨은 1이다."""
    assert map_label_to_binary(label, "test:1") == expected


def test_label_mapping_covers_exactly_four_labels() -> None:
    """매핑 표에는 K-HATERS의 라벨 4종만 있다(새 라벨을 조용히 추가하지 않았는지 확인)."""
    assert set(LABEL_TO_BINARY) == {"normal", "offensive", "L1_hate", "L2_hate"}


@pytest.mark.parametrize("label", ["L3_hate", "Normal", "", None, 1, ["normal"]])
def test_unknown_label_raises_with_location(label: object) -> None:
    """모르는 라벨(대소문자 다름·숫자·목록 포함)은 위치를 담은 오류를 낸다."""
    with pytest.raises(DatasetFormatError, match="train_v2.jsonl:7"):
        map_label_to_binary(label, "train_v2.jsonl:7")


def test_load_labeled_texts_reads_and_maps(tmp_path: Path, khaters_records: list[dict]) -> None:
    """JSONL을 읽어 id·원래 라벨·이진 라벨을 채운다."""
    records = load_labeled_texts(write_jsonl(tmp_path / "train.jsonl", khaters_records))
    assert [record.binary_label for record in records] == [0, 1, 1, 1, 0, 1]
    assert records[2].original_label == "L1_hate"
    assert records[2].record_id == "2"


def test_load_labeled_texts_respects_limit(tmp_path: Path, khaters_records: list[dict]) -> None:
    """limit가 있으면 앞에서부터 그만큼만 읽는다."""
    assert len(load_labeled_texts(write_jsonl(tmp_path / "train.jsonl", khaters_records), limit=3)) == 3


def test_unknown_label_in_file_reports_line_without_text(tmp_path: Path) -> None:
    """파일 속 모르는 라벨은 줄 번호로 알리고, 문장 원문은 메시지에 넣지 않는다."""
    path = write_jsonl(tmp_path / "train.jsonl", [{"id": 1, "text": "비밀문장", "label": "normal"}, {"id": 2, "text": "비밀문장", "label": "weird"}])
    with pytest.raises(DatasetFormatError, match="train.jsonl:2") as error_info:
        load_labeled_texts(path)
    assert "비밀문장" not in str(error_info.value)


def test_broken_json_line_reports_location(tmp_path: Path) -> None:
    """JSON이 깨진 줄은 위치를 알려 준다."""
    path = tmp_path / "broken.jsonl"
    path.write_text('{"id": 1, "text": "a", "label": "normal"}\n{"id": 2,\n', encoding="utf-8")
    with pytest.raises(DatasetFormatError, match="broken.jsonl:2"):
        load_labeled_texts(path)


def test_missing_text_field_raises(tmp_path: Path) -> None:
    """text가 문자열이 아니면 오류를 낸다."""
    path = write_jsonl(tmp_path / "train.jsonl", [{"id": 1, "label": "normal"}])
    with pytest.raises(DatasetFormatError, match="'text'"):
        load_labeled_texts(path)


def test_empty_file_raises(tmp_path: Path) -> None:
    """빈 파일로 학습이 '성공'하지 않도록 오류를 낸다."""
    path = tmp_path / "empty.jsonl"
    path.write_text("\n\n", encoding="utf-8")
    with pytest.raises(DatasetFormatError, match="읽은 줄이 없습니다"):
        load_labeled_texts(path)


def test_compute_file_sha256_matches_known_value(tmp_path: Path) -> None:
    """알려진 시험값과 같은 sha256을 낸다."""
    path = tmp_path / "abc.txt"
    path.write_bytes(b"abc")
    assert compute_file_sha256(path) == SHA256_OF_ABC


def test_compute_file_sha256_handles_multiple_chunks(tmp_path: Path) -> None:
    """읽기 단위(1MiB)보다 큰 파일도 hashlib 결과와 같다."""
    payload = bytes(range(256)) * 9000
    path = tmp_path / "big.bin"
    path.write_bytes(payload)
    assert compute_file_sha256(path) == hashlib.sha256(payload).hexdigest()


def test_describe_file_provenance_has_no_full_path(tmp_path: Path) -> None:
    """출처 정보에는 파일 이름·크기·sha256만 있고 전체 경로는 없다."""
    path = tmp_path / "abc.txt"
    path.write_bytes(b"abc")
    provenance = describe_file_provenance(path)
    assert provenance == {"file_name": "abc.txt", "size_bytes": 3, "sha256": SHA256_OF_ABC}
    assert str(tmp_path) not in str(provenance)


def test_load_chat_samples_rejects_unknown_expected(tmp_path: Path) -> None:
    """채팅 회귀 문장의 expected가 정해진 값이 아니면 오류를 낸다."""
    path = write_jsonl(tmp_path / "chat.jsonl", [{"id": 1, "group": "normal", "expected": "maybe", "text": "가"}])
    with pytest.raises(DatasetFormatError, match="expected"):
        load_chat_samples(path)


def test_load_chat_samples_reads_fields(tmp_path: Path) -> None:
    """id·group·expected를 읽는다."""
    path = write_jsonl(tmp_path / "chat.jsonl", [{"id": 7, "group": "insult", "expected": "harmful", "text": "가"}])
    sample = load_chat_samples(path)[0]
    assert (sample.sample_id, sample.group, sample.expected) == ("7", "insult", "harmful")


def test_regression_sample_is_deterministic_and_balanced(tmp_path: Path) -> None:
    """같은 시드면 같은 표본이고, 라벨별 건수는 per_label과 가진 수 중 작은 쪽이다."""
    raw = [{"id": index, "text": "가", "label": ["normal", "offensive", "L1_hate"][index % 3]} for index in range(30)]
    raw.append({"id": 99, "text": "가", "label": "L2_hate"})
    records = load_labeled_texts(write_jsonl(tmp_path / "test.jsonl", raw))
    first = select_regression_sample(records, per_label=4, seed=1)
    second = select_regression_sample(records, per_label=4, seed=1)
    assert [record.record_id for record in first] == [record.record_id for record in second]
    counts = {label: sum(record.original_label == label for record in first) for label in ("normal", "offensive", "L1_hate", "L2_hate")}
    assert counts == {"normal": 4, "offensive": 4, "L1_hate": 4, "L2_hate": 1}
