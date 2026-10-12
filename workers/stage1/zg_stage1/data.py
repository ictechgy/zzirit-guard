"""K-HATERS·채팅 회귀 문장을 읽고, 라벨을 이진으로 바꾸고, 데이터 출처(sha256)를 계산한다.

왜 한곳에 두나: 학습(train.py)과 평가(evaluate.py)가 같은 라벨 규칙을 써야 점수를 비교할 수 있기 때문이다.
데이터 원문은 오류 메시지·로그에 넣지 않는다(스펙 §8: 원문 대신 식별자만 남긴다).
"""

from __future__ import annotations

import hashlib
import json
import random
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from zg_stage1.errors import DatasetFormatError

# K-HATERS 원래 라벨 → 이진 라벨. normal만 0이고 offensive·L1_hate·L2_hate는 1이다.
# 왜: 1차 분류기는 '의심스러운 것만 2차로 넘기는 거름망'이라 세부 등급보다 유해 점수 하나가 필요하다(스파이크와 같은 규칙).
LABEL_TO_BINARY: dict[str, int] = {"normal": 0, "offensive": 1, "L1_hate": 1, "L2_hate": 1}

# 채팅 회귀 문장의 expected 값. harmful이 유해 정답이고, ambiguous는 정답이 없어 지표에서 뺀다(스파이크와 같은 규칙).
CHAT_EXPECTED_VALUES: frozenset[str] = frozenset({"harmful", "allow", "ambiguous"})

# sha256을 계산할 때 한 번에 읽는 크기(1MiB). 큰 학습 파일(약 58MB)도 메모리를 적게 쓰며 읽기 위해서다.
HASH_CHUNK_BYTES = 1024 * 1024

# K-HATERS 회귀 표본을 뽑는 기본 시드. 스파이크·kanana 측정(bench_guard.py)과 같은 400건을 고르기 위해서다.
REGRESSION_SAMPLE_SEED = 20261011

# 회귀 표본의 라벨별 건수 기본값(스펙 §13의 K-HATERS 400건 = 라벨 4개 × 100건).
REGRESSION_SAMPLE_PER_LABEL = 100


@dataclass(frozen=True)
class LabeledText:
    """K-HATERS 한 줄.

    original_label을 함께 두는 이유는 평가에서 원래 라벨별 재현율을 보기 위해서다.
    text는 모델 입력으로만 쓰고 출력·로그에는 쓰지 않는다.
    """

    record_id: str
    text: str
    original_label: str
    binary_label: int


@dataclass(frozen=True)
class ChatSample:
    """직접 작성한 방송 채팅 회귀 문장 한 줄. 결과에는 sample_id·group·expected만 쓰고 text는 쓰지 않는다."""

    sample_id: str
    group: str
    expected: str
    text: str


def map_label_to_binary(label: object, location: str) -> int:
    """K-HATERS 라벨을 이진 라벨(normal=0, 그 밖=1)로 바꾼다.

    label: 파일에서 읽은 label 값.
    location: 오류 메시지에 넣을 '파일:줄' 위치.
    반환: 0 또는 1.
    주의: 모르는 라벨은 추측해서 0/1로 넘기지 않고 오류를 낸다. 데이터 버전이 바뀌어 새 라벨이 생기면
    사람이 규칙을 정해야 하기 때문이다.
    """
    if not isinstance(label, str) or label not in LABEL_TO_BINARY:
        known_labels = ", ".join(sorted(LABEL_TO_BINARY))
        raise DatasetFormatError(
            f"{location}: 알 수 없는 라벨 {label!r}입니다. 알려진 라벨은 {known_labels}입니다. "
            "README의 고정 리비전으로 K-HATERS를 다시 받았는지 확인하고, 새 라벨이라면 LABEL_TO_BINARY에 규칙을 추가하세요."
        )
    return LABEL_TO_BINARY[label]


def parse_json_object(line: str, location: str) -> dict:
    """JSONL 한 줄을 dict로 읽는다.

    깨진 줄은 위치를 담은 DatasetFormatError로 바꾼다. 원문은 메시지에 넣지 않는다.
    """
    try:
        record = json.loads(line)
    except json.JSONDecodeError as error:
        raise DatasetFormatError(f"{location}: JSON으로 읽을 수 없습니다({error.msg}). 파일이 잘렸을 수 있으니 공식 저장소에서 다시 받으세요.") from error
    if not isinstance(record, dict):
        raise DatasetFormatError(f"{location}: 한 줄은 JSON 객체여야 합니다. JSONL 파일이 맞는지 확인하세요.")
    return record


def require_string_field(record: dict, field_name: str, location: str) -> str:
    """record[field_name]이 문자열인지 확인하고 돌려준다. 없거나 다른 형식이면 오류를 낸다."""
    value = record.get(field_name)
    if not isinstance(value, str):
        raise DatasetFormatError(
            f"{location}: '{field_name}' 필드가 문자열이 아닙니다(받은 형식: {type(value).__name__}). 데이터 형식이 바뀌었는지 확인하세요."
        )
    return value


def require_identifier(record: dict, location: str) -> str:
    """record['id']를 문자열로 돌려준다. 결과 파일에서 원문 대신 이 값으로 문장을 가리키기 때문에 반드시 있어야 한다."""
    identifier = record.get("id")
    if identifier is None or isinstance(identifier, dict | list):
        raise DatasetFormatError(f"{location}: 'id' 필드가 없거나 형식이 맞지 않습니다. 문장마다 고유한 id가 있어야 합니다.")
    return str(identifier)


def parse_labeled_text(line: str, location: str) -> LabeledText:
    """K-HATERS 한 줄을 LabeledText로 바꾼다. id·text·label을 검증한다."""
    record = parse_json_object(line, location)
    label = record.get("label")
    return LabeledText(
        record_id=require_identifier(record, location),
        text=require_string_field(record, "text", location),
        original_label=str(label),
        binary_label=map_label_to_binary(label, location),
    )


def iterate_nonblank_lines(path: Path, limit: int | None) -> Iterator[tuple[str, str]]:
    """빈 줄을 건너뛰며 ('파일이름:줄번호', 줄)을 차례로 돌려준다.

    limit: 읽을 최대 줄 수. None이면 끝까지 읽는다(스모크 실행에서 줄여 쓰기 위한 값).
    """
    yielded_count = 0
    with path.open(encoding="utf-8") as file:
        for line_number, line in enumerate(file, start=1):
            if limit is not None and yielded_count >= limit:
                return
            if line.strip():
                yielded_count += 1
                yield f"{path.name}:{line_number}", line


def load_labeled_texts(path: str | Path, limit: int | None = None) -> list[LabeledText]:
    """K-HATERS JSONL 파일을 읽어 LabeledText 목록으로 돌려준다.

    path: train_v2/val_v2/test_v2.jsonl 경로.
    limit: 앞에서부터 읽을 최대 줄 수(None이면 전체).
    주의: 읽은 줄이 하나도 없으면 오류를 낸다. 빈 파일로 학습·평가가 '성공'하는 일을 막기 위해서다.
    """
    file_path = Path(path)
    located_records = [(location, parse_labeled_text(line, location)) for location, line in iterate_nonblank_lines(file_path, limit)]
    if not located_records:
        raise DatasetFormatError(f"{file_path.name}: 읽은 줄이 없습니다. 파일이 비었는지, 경로가 맞는지 확인하세요.")
    ensure_unique_identifiers(located_records)
    return [record for _, record in located_records]


def ensure_unique_identifiers(located_records: list[tuple[str, LabeledText]]) -> None:
    """한 파일 안에서 id가 겹치지 않는지 확인한다. 겹치면 두 위치를 담은 오류를 낸다.

    왜: 회귀 표본과 점수 대응을 id로 하므로, 중복이 있으면 다른 문장의 점수를 조용히 쓰게 된다.
    """
    first_location_by_identifier: dict[str, str] = {}
    for location, record in located_records:
        first_location = first_location_by_identifier.setdefault(record.record_id, location)
        if first_location != location:
            raise DatasetFormatError(
                f"{location}: id {record.record_id!r}가 {first_location}에서 이미 나왔습니다. "
                "파일이 합쳐졌거나 손상됐는지 확인하고 공식 저장소에서 다시 받으세요."
            )


def parse_chat_sample(line: str, location: str) -> ChatSample:
    """채팅 회귀 문장 한 줄을 ChatSample로 바꾼다. expected 값이 정해진 셋 중 하나인지 검증한다."""
    record = parse_json_object(line, location)
    expected = require_string_field(record, "expected", location)
    if expected not in CHAT_EXPECTED_VALUES:
        allowed_values = ", ".join(sorted(CHAT_EXPECTED_VALUES))
        raise DatasetFormatError(f"{location}: expected 값 {expected!r}을 알 수 없습니다. {allowed_values} 중 하나로 고치세요.")
    return ChatSample(
        sample_id=require_identifier(record, location),
        group=require_string_field(record, "group", location),
        expected=expected,
        text=require_string_field(record, "text", location),
    )


def load_chat_samples(path: str | Path) -> list[ChatSample]:
    """채팅 회귀 문장(chat_samples.jsonl)을 모두 읽는다. 비어 있으면 오류를 낸다."""
    file_path = Path(path)
    samples = [parse_chat_sample(line, location) for location, line in iterate_nonblank_lines(file_path, None)]
    if not samples:
        raise DatasetFormatError(f"{file_path.name}: 채팅 회귀 문장이 없습니다. --chat-file 경로를 확인하세요.")
    return samples


def group_by_label(records: list[LabeledText]) -> dict[str, list[LabeledText]]:
    """원래 라벨별로 레코드를 모은다. 파일 순서를 유지한다(표본 추출을 재현하기 위해서다)."""
    records_by_label: dict[str, list[LabeledText]] = {}
    for record in records:
        records_by_label.setdefault(record.original_label, []).append(record)
    return records_by_label


def select_regression_sample(records: list[LabeledText], per_label: int, seed: int) -> list[LabeledText]:
    """라벨별로 같은 수를 고정 시드로 뽑는다(라벨 불균형 보정).

    스파이크(bench_guard.py)와 같은 절차라서, 같은 test 파일이면 kanana 측정과 같은 400건이 나온다.
    per_label: 라벨별 건수. 라벨에 그보다 적게 있으면(--limit로 줄였을 때) 있는 만큼만 뽑는다.
    seed: 표본 시드.
    """
    random_generator = random.Random(seed)
    sample: list[LabeledText] = []
    for _label, candidates in sorted(group_by_label(records).items()):
        sample.extend(random_generator.sample(candidates, min(per_label, len(candidates))))
    return sample


def compute_file_sha256(path: str | Path) -> str:
    """파일 전체의 sha256(16진수)을 계산한다.

    왜: 어떤 기반 모델·데이터로 학습했는지 모델 카드에 남겨, 나중에 같은 조건으로 재현하거나 비교하기 위해서다.
    """
    digest = hashlib.sha256()
    with Path(path).open("rb") as file:
        for chunk in iter(lambda: file.read(HASH_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def describe_file_provenance(path: str | Path) -> dict:
    """모델 카드·평가 결과에 넣을 파일 출처 정보(이름·크기·sha256)를 만든다.

    주의: 전체 경로는 넣지 않는다. 결과 파일을 공유할 때 운영자의 로컬 경로(사용자 이름 등)가 새지 않게 하기 위해서다.
    """
    file_path = Path(path)
    return {
        "file_name": file_path.name,
        "size_bytes": file_path.stat().st_size,
        "sha256": compute_file_sha256(file_path),
    }
