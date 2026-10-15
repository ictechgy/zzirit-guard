"""1차 분류기 학습 파일을 만든다: K-HATERS train에 채팅 형식의 '허용 어려운 예제'를 섞고, 필요하면 유해 비율을 낮춘다.

왜 필요한가(docs/ml/2026-10-14-chat-eval-baseline.md):
- 뉴스 댓글에는 칭찬 비속어·게임 표현·인용/신고 같은 방송 채팅이 없어, 이런 문장을 유해로 본다. 그 문장들을 정상(normal)으로 넣는다.
- K-HATERS train은 73%가 유해라 점수가 전반적으로 높다. --toxic-fraction으로 유해를 줄여 볼 수 있다.
결과 파일은 K-HATERS와 같은 형식(id·text·label)이라 train의 --train-file로 그대로 쓴다. 옆에 만든 manifest에 입력 파일의
sha256과 설정, 평가셋과 겹쳐 뺀 줄을 남겨, 같은 입력·설정이면 같은 파일이 나오게 한다. 데이터 원문은 저장소에 넣지 않는다(출력은 ML 디렉터리에 둔다).

기본값은 M2 1차 후보(kcelectra-hn-f73-r3)의 설정이다: 허용 문장 v1, K-HATERS 유해 비율 그대로, 3번 반복
(docs/ml/2026-10-14-stage1-retrain-results.md).

CLI 사용 예:
  uv run python -m zg_stage1.training_mix --out "$ZG_DATA_DIR/ml/data/mix/train-hn-v1-r3.jsonl"
  uv run python -m zg_stage1.training_mix --out "$ZG_DATA_DIR/ml/data/mix/train-hn2-f50-r3.jsonl" --hard-negative-version v2 --toxic-fraction 0.5
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import random
import re
import tempfile
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

from zg_stage1.arguments import fraction_below_one, non_negative_integer, positive_integer
from zg_stage1.chat_eval_data import (
    ALLOW_CATEGORIES,
    OverlapFinding,
    OverlapIndex,
    ensure_sealed_regression_unchanged,
    load_chat_eval_set,
    load_sealed_regression_index,
)
from zg_stage1.data import (
    LabeledText,
    compute_identifier_list_sha256,
    compute_file_sha256,
    describe_file_provenance,
    iterate_nonblank_lines,
    load_labeled_texts,
    load_labeled_texts_excluding_untargeted_offensive,
    parse_json_object,
    require_string_field,
)
from zg_stage1.errors import DatasetFormatError, OutputExistsError, OutputLocationError, run_command_line
from zg_stage1.paths import KHATERS_RELATIVE_PATH, KHATERS_TRAIN_FILE_NAME, ML_DIRECTORY_VARIABLE, ensure_outside_repository, resolve_ml_directory

# 저장소에 넣은 학습용 허용 문장과 평가셋 위치. 평가셋과 겹치지 않는지 만들 때마다 확인한다.
STAGE1_DIRECTORY = Path(__file__).resolve().parents[1]
DEFAULT_HARD_NEGATIVES_PATH = STAGE1_DIRECTORY / "train_data" / "hard-negatives-v2.jsonl"
EVAL_SET_PATHS: tuple[Path, ...] = (STAGE1_DIRECTORY / "eval_data" / "chat-dev-v2.jsonl", STAGE1_DIRECTORY / "eval_data" / "chat-holdout-v2.jsonl")
# manifest에 그대로 적어도 되는 외부 id 모양(짧은 영숫자). 공식 K-HATERS id는 숫자라 그대로 남는다.
SAFE_EXTERNAL_IDENTIFIER_PATTERN = re.compile(r"[A-Za-z0-9_:-]{1,64}")
# 학습 파일·manifest를 최종 이름에 넣기 전에 쓰는 임시 파일의 이름 앞뒤. 강제 종료로 남으면 이 이름으로 찾아 지운다.
STAGED_FILE_PREFIX = ".training-mix-"
STAGED_FILE_SUFFIX = ".tmp"
# 학습 파일·manifest의 권한(mkstemp가 주는 값). 데이터 원문이 든 파일이라 만든 사용자만 읽고 쓴다. 학습도 같은 사용자가 한다.
OUTPUT_FILE_MODE = 0o600
# 하드 링크를 만들 수 없는 파일 시스템(exFAT, 일부 네트워크·FUSE)에서 os.link가 내는 errno.
LINK_UNSUPPORTED_ERRNOS = frozenset({errno.EPERM, errno.ENOTSUP, errno.EOPNOTSUPP, errno.EXDEV})


@dataclass(frozen=True)
class HardNegativeVersion:
    """저장소 허용 문장 파일의 판(version) 하나: 파일 앞에서부터 몇 줄인지와 그 줄들(줄바꿈 포함)의 sha256."""

    line_count: int
    sha256: str


# 판별 줄 수와 sha256. v2는 v1(앞 2,934줄) 뒤에 734줄을 덧붙인 파일이다.
# 왜 해시로 확인하나: v1으로 학습한 후보 모델을 v2 파일에서 정확히 다시 만들 수 있어야 하고, 파일 앞부분이 바뀌면 알아차려야 하기 때문이다.
HARD_NEGATIVE_VERSIONS: dict[str, HardNegativeVersion] = {
    "v1": HardNegativeVersion(2934, "335e2c188bac7fad4ac7a162874c150e47d5734be9268c68c37cf2f361431e40"),
    "v2": HardNegativeVersion(3668, "3b7ef3e4c896767859b060e325356bbdd151f8c031e9a29ae3066cdae92e9e47"),
}

# 기본 설정: 후보 모델의 설정(허용 문장 v1, 유해 비율 그대로, 3번 반복). 2천여 문장을 한 번만 넣으면 효과가 묻혔다(B1b).
DEFAULT_HARD_NEGATIVE_VERSION = "v1"
DEFAULT_EXTRA_REPEAT = 3
DEFAULT_SEED = 20261014
DEFAULT_GENERATED_REPEAT = 1
V1_FRIENDLY_PROFANITY_ROWS = 986

# 섞은 문장의 id 접두사. K-HATERS의 숫자 id와 겹치지 않게 한다.
HARD_NEGATIVE_ID_PREFIX = "hn-"
GENERATED_HARMFUL_ID_PREFIX = "gh:"
GENERATED_ALLOW_ID_PREFIX = "ga:"

# 섞은 문장에 붙이는 K-HATERS 라벨. 이진 변환에서 0(정상)이 되는 값이다.
NORMAL_LABEL = "normal"
OFFENSIVE_LABEL = "offensive"

# 봉인 제외 집계의 키 순서. 범주별 정보가 아니라 학습 출처만 남겨 보류셋 구성을 드러내지 않는다.
TRAINING_SOURCES: tuple[str, ...] = ("khaters", "hard_negative", "generated_harmful", "generated_allow")


@dataclass(frozen=True)
class HardNegative:
    """학습용 허용 문장 한 줄. 출력·로그에는 id만 쓴다."""

    item_id: str
    category: str
    text: str


@dataclass(frozen=True)
class GeneratedExample:
    """외부에서 만든 학습 문장 한 줄. 원문은 학습 행에만 쓰고 오류·manifest에는 넣지 않는다."""

    item_id: str
    text: str


@dataclass(frozen=True)
class GeneratedSelection:
    """평가 겹침을 뺀 생성 입력과 출처 기록. 옵션이 없을 때 기존 manifest를 유지하려고 enabled를 둔다."""

    harmful: tuple[GeneratedExample, ...]
    allow: tuple[GeneratedExample, ...]
    excluded_ids: tuple[str, ...]
    inputs: dict[str, dict]
    enabled: bool


@dataclass(frozen=True)
class CreatedFile:
    """이번 실행이 만든 파일 하나: 경로와 그 파일의 (장치, inode). 지울 때 그 경로가 아직 이 파일인지 확인하는 데 쓴다."""

    path: Path
    identity: tuple[int, int]


@dataclass(frozen=True)
class MixSettings:
    """혼합 설정. manifest에 그대로 남긴다. toxic_fraction이 None이면 K-HATERS의 유해 비율을 그대로 둔다."""

    toxic_fraction: float | None = None
    extra_repeat: int = DEFAULT_EXTRA_REPEAT
    seed: int = DEFAULT_SEED


def parse_hard_negative(line: str, location: str) -> HardNegative:
    """학습용 허용 문장 한 줄을 읽는다. 라벨은 allow, 범주는 허용 유형, 작성자와 검토자는 달라야 한다."""
    record = parse_json_object(line, location)
    if require_string_field(record, "label", location) != "allow":
        raise DatasetFormatError(f"{location}: 학습용 허용 문장의 label은 allow여야 합니다.")
    category = require_string_field(record, "category", location)
    if category not in ALLOW_CATEGORIES:
        raise DatasetFormatError(f"{location}: 허용 유형이 아닌 category {category!r}입니다. {', '.join(ALLOW_CATEGORIES)} 중 하나로 고치세요.")
    if require_string_field(record, "author", location) == require_string_field(record, "reviewer", location):
        raise DatasetFormatError(f"{location}: 작성자와 검토자가 같습니다. 다른 모델이 검토한 문장만 넣으세요.")
    return HardNegative(require_string_field(record, "id", location), category, require_string_field(record, "text", location))


def parse_hard_negative_lines(located_lines: Iterable[tuple[str, str]], source_name: str) -> list[HardNegative]:
    """('파일:줄번호', 줄) 목록을 허용 문장으로 읽는다. 비었거나 id가 겹치면 오류다."""
    items = [parse_hard_negative(line, location) for location, line in located_lines]
    if not items:
        raise DatasetFormatError(f"{source_name}: 학습용 허용 문장이 없습니다.")
    duplicated = sorted(identifier for identifier, count in Counter(item.item_id for item in items).items() if count > 1)
    if duplicated:
        raise DatasetFormatError(f"{source_name}: id가 겹칩니다({', '.join(duplicated[:5])}).")
    return items


def load_hard_negatives(path: Path) -> list[HardNegative]:
    """학습용 허용 문장 파일 전체를 읽는다(운영자가 따로 만든 파일용)."""
    return parse_hard_negative_lines(iterate_nonblank_lines(path, None), path.name)


def parse_generated_example(line: str, location: str) -> GeneratedExample:
    """생성 학습 한 줄을 읽는다. 왜 id를 제한하나: manifest에 원문 대신 안전하게 기록해야 하기 때문이다."""
    record = parse_json_object(line, location)
    identifier = require_string_field(record, "id", location)
    if SAFE_EXTERNAL_IDENTIFIER_PATTERN.fullmatch(identifier) is None:
        raise DatasetFormatError(f"{location}: 'id' 형식이 안전하지 않습니다. 1~64자의 영문·숫자·_:- 조합으로 고치세요.")
    text = require_string_field(record, "text", location)
    if not text.strip():
        raise DatasetFormatError(f"{location}: 'text'가 비어 있습니다. 비어 있지 않은 문자열을 넣으세요.")
    return GeneratedExample(identifier, text)


def ensure_unique_generated_ids(located_items: Sequence[tuple[str, GeneratedExample]]) -> None:
    """한 생성 파일의 id가 고유한지 확인한다. 왜: 제외 기록과 원본 줄을 모호하지 않게 대응시키기 위해서다."""
    first_locations: dict[str, str] = {}
    for location, item in located_items:
        first = first_locations.setdefault(item.item_id, location)
        if first != location:
            raise DatasetFormatError(f"{location}: id {item.item_id!r}가 {first}에 이미 있습니다. 각 줄에 고유한 id를 넣으세요.")


def load_generated_examples(path: Path) -> list[GeneratedExample]:
    """생성 학습 파일 전체를 검증해 읽는다. 빈 파일은 설정 실수를 숨기므로 오류로 알린다."""
    located = [(location, parse_generated_example(line, location)) for location, line in iterate_nonblank_lines(path, None)]
    if not located:
        raise DatasetFormatError(f"{path.name}: 생성 학습 문장이 없습니다. 경로를 확인하고 JSONL 문장을 넣으세요.")
    ensure_unique_generated_ids(located)
    return [item for _, item in located]


def read_hard_negative_version_lines(path: Path, version_name: str) -> list[tuple[str, str]]:
    """저장소 파일에서 한 판의 앞쪽 줄만 꺼내고 sha256이 기록과 같은지 확인한다. 빈 줄은 건너뛴다."""
    version = HARD_NEGATIVE_VERSIONS[version_name]
    lines = path.read_bytes().splitlines(keepends=True)[: version.line_count]
    if len(lines) != version.line_count or hashlib.sha256(b"".join(lines)).hexdigest() != version.sha256:
        message = f"{path.name}: 허용 문장 {version_name}의 앞 {version.line_count}줄이 기록한 sha256과 다릅니다."
        raise DatasetFormatError(f"{message} 앞선 판의 줄은 고치지 말고, 새 문장은 파일 뒤에 덧붙이세요.")
    decoded = ((f"{path.name}:{number}", line.decode("utf-8")) for number, line in enumerate(lines, start=1))
    return [(location, line) for location, line in decoded if line.strip()]


def load_hard_negative_version(version_name: str, path: Path = DEFAULT_HARD_NEGATIVES_PATH) -> list[HardNegative]:
    """저장소 허용 문장의 한 판을 읽는다."""
    return parse_hard_negative_lines(read_hard_negative_version_lines(path, version_name), f"{path.name}({version_name})")


def load_evaluation_references(eval_paths: Sequence[Path] = EVAL_SET_PATHS) -> list[OverlapIndex]:
    """평가셋(개발·보류)과 봉인한 72문장의 겹침 색인. 72문장 파일이 바뀌었으면 오류를 낸다."""
    ensure_sealed_regression_unchanged()
    eval_items = [item for path in eval_paths for item in load_chat_eval_set(path)]
    return [OverlapIndex.build((item.item_id, item.text) for item in eval_items), load_sealed_regression_index()]


def find_evaluation_overlap(item_id: str, text: str, references: Sequence[OverlapIndex]) -> OverlapFinding | None:
    """한 문장이 평가 문장과 같거나 거의 같으면 그 겹침 하나(없으면 None)."""
    return next((finding for index in references if (finding := index.find_overlap(item_id, text)) is not None), None)


def ensure_no_evaluation_overlap(items: Sequence[HardNegative], references: Sequence[OverlapIndex]) -> None:
    """저장소 허용 문장이 평가 문장과 겹치면 오류를 낸다.

    왜 오류인가: 이 파일은 우리가 쓰고 검토한 파일이라, 겹치는 문장은 파일에서 빼는 것이 맞다. 평가 문장을 학습하면 평가 숫자가 부풀려진다.
    """
    overlapping = [item.item_id for item in items if find_evaluation_overlap(item.item_id, item.text, references)]
    if overlapping:
        raise DatasetFormatError(f"학습 문장 {len(overlapping)}건이 평가셋과 겹칩니다({', '.join(overlapping[:10])}). 해당 문장을 빼세요.")


def exclude_evaluation_overlaps(records: Sequence[LabeledText], references: Sequence[OverlapIndex]) -> tuple[list[LabeledText], list[OverlapFinding]]:
    """K-HATERS에서 평가 문장과 겹치는 줄을 빼고, 뺀 겹침 목록을 함께 돌려준다.

    왜 빼기만 하나: 외부 데이터라 고칠 수 없고, "감사합니다!"처럼 흔한 짧은 문장이 우연히 같은 경우가 대부분이다.
    """
    findings = [find_evaluation_overlap(record.record_id, record.text, references) for record in records]
    kept = [record for record, finding in zip(records, findings, strict=True) if finding is None]
    return kept, [finding for finding in findings if finding is not None]


def exclude_generated_evaluation_overlaps(items: Sequence[GeneratedExample], references: Sequence[OverlapIndex]) -> tuple[list[GeneratedExample], list[str]]:
    """생성 문장에서 공개 평가 참조와 겹친 줄을 빼고 입력 id만 남긴다. 원문·평가 id는 기록하지 않는다."""
    overlaps = [find_evaluation_overlap(item.item_id, item.text, references) is not None for item in items]
    kept = [item for item, overlaps_evaluation in zip(items, overlaps, strict=True) if not overlaps_evaluation]
    excluded_ids = [item.item_id for item, overlaps_evaluation in zip(items, overlaps, strict=True) if overlaps_evaluation]
    return kept, excluded_ids


def load_generated_source(path: Path, repeat: int, references: Sequence[OverlapIndex]) -> tuple[list[GeneratedExample], list[str], dict]:
    """생성 파일 하나를 읽고 공개 평가 겹침을 뺀다. 반복 횟수는 설정이 아니라 이 입력의 출처에 붙인다."""
    kept, excluded = exclude_generated_evaluation_overlaps(load_generated_examples(path), references)
    return kept, excluded, describe_file_provenance(path) | {"repeat": repeat}


def load_generated_selection(arguments: argparse.Namespace, references: Sequence[OverlapIndex]) -> GeneratedSelection:
    """지정된 생성 입력만 읽는다. 왜 조건부인가: 새 옵션이 없으면 기존 manifest 바이트 구조를 유지해야 한다."""
    harmful: list[GeneratedExample] = []
    allow: list[GeneratedExample] = []
    excluded: list[str] = []
    inputs: dict[str, dict] = {}
    for name, path, repeat in (
        ("generated_harmful", arguments.generated_harmful, arguments.generated_harmful_repeat),
        ("generated_allow", arguments.generated_allow, arguments.generated_allow_repeat),
    ):
        if path is not None:
            kept, removed, inputs[name] = load_generated_source(path, repeat, references)
            (harmful if name == "generated_harmful" else allow).extend(kept)
            excluded.extend(removed)
    return GeneratedSelection(tuple(harmful), tuple(allow), tuple(excluded), inputs, bool(inputs))


def downsample_toxic(records: Sequence[LabeledText], toxic_fraction: float | None, seed: int) -> list[LabeledText]:
    """정상은 모두 두고 유해만 줄여 유해 비율을 toxic_fraction으로 맞춘다. 원래 순서를 지킨다.

    toxic_fraction이 None이거나 이미 유해 비율이 목표 이하이면 그대로 둔다(늘리지는 않는다).
    """
    toxic_indices = [index for index, record in enumerate(records) if record.binary_label == 1]
    target = len(toxic_indices) if toxic_fraction is None else round((len(records) - len(toxic_indices)) * toxic_fraction / (1 - toxic_fraction))
    if target >= len(toxic_indices):
        return list(records)
    kept_toxic = set(random.Random(seed).sample(toxic_indices, target))
    return [record for index, record in enumerate(records) if record.binary_label == 0 or index in kept_toxic]


def hard_negative_rows(items: Sequence[HardNegative], repeat: int) -> list[dict]:
    """허용 문장을 K-HATERS 형식의 정상 줄로 바꾼다. 반복마다 id 끝에 번호를 붙여 겹치지 않게 한다."""
    return [{"id": f"{HARD_NEGATIVE_ID_PREFIX}{item.item_id}-{copy}", "text": item.text, "label": NORMAL_LABEL} for copy in range(repeat) for item in items]


def selected_hard_negative_rows(items: Sequence[HardNegative], repeat: int, friendly_repeat: int | None) -> list[dict]:
    """허용 문장을 범주별 반복 수로 만든다. 전용 값이 없으면 기존 함수 그대로 써서 행 순서와 바이트를 보존한다."""
    if friendly_repeat is None:
        return hard_negative_rows(items, repeat)
    repeats = {item.item_id: friendly_repeat if item.category == "friendly_profanity" else repeat for item in items}
    maximum = max(repeats.values(), default=0)
    return [
        {"id": f"{HARD_NEGATIVE_ID_PREFIX}{item.item_id}-{copy}", "text": item.text, "label": NORMAL_LABEL}
        for copy in range(maximum)
        for item in items
        if copy < repeats[item.item_id]
    ]


def generated_rows(items: Sequence[GeneratedExample], repeat: int, prefix: str, label: str) -> list[dict]:
    """생성 문장을 반복 가능한 학습 행으로 바꾼다. 출처 접두사로 다른 입력의 같은 id도 충돌하지 않는다."""
    return [{"id": f"{prefix}{item.item_id}-{copy}", "text": item.text, "label": label} for copy in range(repeat) for item in items]


def khaters_rows(records: Sequence[LabeledText]) -> list[dict]:
    """K-HATERS 레코드를 원래 라벨 그대로 줄로 만든다."""
    return [{"id": record.record_id, "text": record.text, "label": record.original_label} for record in records]


def count_binary_labels(rows: Sequence[Mapping[str, str]]) -> dict[str, int]:
    """정상·유해 줄 수."""
    normal = sum(1 for row in rows if row["label"] == NORMAL_LABEL)
    return {"normal": normal, "toxic": len(rows) - normal}


def build_training_rows(khaters: Sequence[LabeledText], hard_negatives: Sequence[HardNegative], settings: MixSettings) -> list[dict]:
    """K-HATERS(필요하면 유해를 줄인 것) 뒤에 허용 문장을 붙인 학습 줄 목록. 섞는 일은 학습의 길이 기준 배치가 한다."""
    kept = downsample_toxic(khaters, settings.toxic_fraction, settings.seed)
    return khaters_rows(kept) + hard_negative_rows(hard_negatives, settings.extra_repeat)


def tag_source(source: str, rows: Sequence[dict]) -> list[tuple[str, dict]]:
    """봉인 제외가 출처별 건수를 낼 수 있게 행에 내부용 출처를 붙인다. 출력 JSON에는 이 값이 들어가지 않는다."""
    return [(source, row) for row in rows]


def build_sourced_training_rows(
    khaters: Sequence[LabeledText], hard_negatives: Sequence[HardNegative], generated: GeneratedSelection, settings: MixSettings, arguments: argparse.Namespace
) -> list[tuple[str, dict]]:
    """모든 학습 행을 만든 뒤 출처와 묶는다. 왜: 봉인 검사는 반복까지 끝난 실제 학습 행 각각을 제외해야 한다."""
    kept = downsample_toxic(khaters, settings.toxic_fraction, settings.seed)
    rows = tag_source("khaters", khaters_rows(kept))
    rows += tag_source("hard_negative", selected_hard_negative_rows(hard_negatives, settings.extra_repeat, arguments.friendly_profanity_repeat))
    rows += tag_source("generated_harmful", generated_rows(generated.harmful, arguments.generated_harmful_repeat, GENERATED_HARMFUL_ID_PREFIX, OFFENSIVE_LABEL))
    rows += tag_source("generated_allow", generated_rows(generated.allow, arguments.generated_allow_repeat, GENERATED_ALLOW_ID_PREFIX, NORMAL_LABEL))
    return rows


def file_identity(status: os.stat_result) -> tuple[int, int]:
    """파일의 (장치, inode). 두 경로의 값이 같으면 같은 파일이다."""
    return (status.st_dev, status.st_ino)


def identify_new_file(descriptor: int, path: Path) -> CreatedFile:
    """mkstemp가 막 만든 파일의 기록. 신원을 못 읽으면 닫고 지운 뒤 오류를 올린다(아직 정리 목록에 없어 여기서 지워야 한다)."""
    try:
        return CreatedFile(path, file_identity(os.fstat(descriptor)))
    except OSError:
        os.close(descriptor)
        path.unlink(missing_ok=True)
        raise


def stage_text_file(directory: Path, text: str, created: list[CreatedFile]) -> CreatedFile:
    """directory에 고유한 이름의 임시 파일(권한 OUTPUT_FILE_MODE)을 만들어 text를 쓴다.

    created: 이번 실행이 만든 파일 목록. 쓰기 전에 먼저 적어 두어, 쓰다 실패해도 호출한 쪽이 지울 수 있게 한다.
    """
    descriptor, name = tempfile.mkstemp(dir=directory, prefix=STAGED_FILE_PREFIX, suffix=STAGED_FILE_SUFFIX)
    staged = identify_new_file(descriptor, Path(name))
    created.append(staged)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(text)
    return staged


def publish_without_overwrite(staged: CreatedFile, destination: Path, created: list[CreatedFile]) -> None:
    """임시 파일을 최종 이름에 하드 링크로 넣는다.

    왜 링크인가: 이름 바꾸기(os.replace)와 달리, 시작할 때 확인한 뒤에 같은 이름의 파일이 생겼어도 덮어쓰지 않고 FileExistsError를 낸다.
    하드 링크를 못 만드는 파일 시스템이면 출력 위치를 바꾸라는 오류를 낸다.
    """
    try:
        os.link(staged.path, destination)
    except OSError as error:
        if error.errno in LINK_UNSUPPORTED_ERRNOS:
            message = f"{destination.name}을 넣을 파일 시스템이 하드 링크를 지원하지 않습니다. APFS 같은 로컬 디스크의 경로를 --out으로 주세요."
            raise OutputLocationError(message) from error
        raise
    created.append(CreatedFile(destination, staged.identity))


def is_still_created_file(created_file: CreatedFile) -> bool:
    """경로가 아직 이번 실행이 만든 파일을 가리키는지. 경로가 없거나 다른 파일로 바뀌었으면 False다."""
    try:
        return file_identity(os.stat(created_file.path)) == created_file.identity
    except FileNotFoundError:
        return False


def remove_created_files(files: Sequence[CreatedFile]) -> None:
    """이번 실행이 만든 파일(임시·최종)을 지운다. 그 사이 다른 파일로 바뀐 경로는 남이 넣은 파일이므로 지우지 않는다."""
    for created_file in files:
        if is_still_created_file(created_file):
            created_file.path.unlink(missing_ok=True)


def manifest_path_for(output_path: Path) -> Path:
    """학습 파일의 manifest 경로: 파일 이름 전체 뒤에 .manifest.json을 붙인다. 확장자만 다른 두 학습 파일이 manifest를 나눠 쓰지 않게 하기 위해서다."""
    return output_path.with_name(f"{output_path.name}.manifest.json")


def describe_hard_negative_source(path: Path, version_name: str | None) -> dict:
    """허용 문장 입력의 출처. 저장소 판을 쓰면 판 이름과 줄 수, 그 줄들의 sha256을 덧붙인다."""
    provenance = describe_file_provenance(path)
    if version_name is None:
        return provenance
    version = HARD_NEGATIVE_VERSIONS[version_name]
    return provenance | {"version": version_name, "line_count": version.line_count, "selected_sha256": version.sha256}


def describe_external_identifier(identifier: str) -> str:
    """외부 파일의 id를 manifest에 적을 모양으로 바꾼다.

    왜: --khaters-train은 아무 파일이나 받으므로 id에 문장이나 로컬 경로가 들어 있을 수 있다. 짧은 영숫자 id만 그대로 두고,
    그 밖은 sha256 앞 16자로 바꿔 원문·경로가 manifest에 남지 않게 한다. 같은 id는 같은 값이 되므로 원래 파일에서 다시 찾을 수 있다.
    """
    if SAFE_EXTERNAL_IDENTIFIER_PATTERN.fullmatch(identifier):
        return identifier
    return "sha256:" + hashlib.sha256(identifier.encode("utf-8")).hexdigest()[:16]


def describe_excluded_overlap(finding: OverlapFinding) -> dict:
    """뺀 K-HATERS 줄 하나의 manifest 기록. 평가 문장 id는 저장소 파일의 것이라 그대로, K-HATERS id는 안전한 모양으로 적는다."""
    return asdict(finding) | {"item_id": describe_external_identifier(finding.item_id)}


def load_sealed_holdout_index(path: Path) -> OverlapIndex:
    """봉인 평가 파일을 한 번 읽어 색인으로 만든다. 형식 오류도 내부 id·원문을 숨긴 채 고치는 방법만 알린다."""
    try:
        items = load_chat_eval_set(path)
    except DatasetFormatError:
        message = f"{path.name}: 봉인 보류셋 형식이 올바르지 않습니다. chat eval JSONL 형식과 고유 id를 확인하세요."
        raise DatasetFormatError(message) from None
    return OverlapIndex.build((item.item_id, item.text) for item in items)


def exclude_sealed_holdout_overlaps(sourced_rows: Sequence[tuple[str, dict]], index: OverlapIndex) -> tuple[list[tuple[str, dict]], dict[str, int], list[str]]:
    """봉인 보류셋과 겹친 실제 학습 행을 뺀다. 왜: 반복된 복사본까지 빠졌는지 출처별로 확인해야 한다."""
    kept: list[tuple[str, dict]] = []
    counts = {source: 0 for source in TRAINING_SOURCES}
    excluded_ids: list[str] = []
    for source, row in sourced_rows:
        if index.find_overlap(str(row["id"]), str(row["text"])) is None:
            kept.append((source, row))
        else:
            counts[source] += 1
            excluded_ids.append(describe_external_identifier(str(row["id"])))
    return kept, counts, excluded_ids


def apply_sealed_holdout(path: Path, sourced_rows: Sequence[tuple[str, dict]]) -> tuple[list[tuple[str, dict]], dict]:
    """봉인 색인을 한 번 구축해 단방향 제외하고, 허용된 출처별 건수와 학습 id만 요약한다."""
    kept, counts, excluded_ids = exclude_sealed_holdout_overlaps(sourced_rows, load_sealed_holdout_index(path))
    summary = {
        "file_name": path.name,
        "sha256": compute_file_sha256(path),
        "excluded_rows": len(excluded_ids),
        "excluded_by_source": counts,
        "excluded_training_ids": excluded_ids,
    }
    return kept, summary


def apply_optional_sealed_holdout(arguments: argparse.Namespace, sourced_rows: Sequence[tuple[str, dict]]) -> tuple[list[tuple[str, dict]], dict | None]:
    """옵션이 있을 때만 봉인 제외를 적용한다. 없으면 기존 행과 manifest 구조를 그대로 둔다."""
    if arguments.sealed_holdout is None:
        return list(sourced_rows), None
    return apply_sealed_holdout(arguments.sealed_holdout, sourced_rows)


def build_manifest(
    settings: MixSettings,
    inputs: Mapping[str, dict],
    excluded: Sequence[OverlapFinding],
    rows: Sequence[Mapping[str, str]],
    excluded_generated: Sequence[str] | None = None,
    sealed_holdout: Mapping[str, object] | None = None,
    dropped_untargeted_offensive: Mapping[str, object] | None = None,
    friendly_profanity_repeat: Mapping[str, object] | None = None,
) -> dict:
    """설정, 입력 출처, 평가셋과 겹쳐 뺀 K-HATERS 줄(id만), 줄 수. 출력 파일 기록("output")은 학습 파일을 쓴 뒤에 붙인다. 원문은 넣지 않는다."""
    manifest = {
        "settings": asdict(settings),
        "inputs": dict(inputs),
        "excluded_khaters_overlaps": [describe_excluded_overlap(finding) for finding in excluded],
        "counts": count_binary_labels(rows),
    }
    if excluded_generated is not None:
        manifest["excluded_generated_overlaps"] = list(excluded_generated)
    if sealed_holdout is not None:
        manifest["sealed_holdout"] = dict(sealed_holdout)
    if dropped_untargeted_offensive is not None:
        manifest["dropped_untargeted_offensive"] = dict(dropped_untargeted_offensive)
    if friendly_profanity_repeat is not None:
        manifest["friendly_profanity_repeat"] = dict(friendly_profanity_repeat)
    return manifest


def build_argument_parser() -> argparse.ArgumentParser:
    """CLI 인자."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage1.training_mix", description="1차 분류기 학습 파일 만들기(K-HATERS + 허용 어려운 예제)")
    parser.add_argument("--out", type=Path, required=True, help="만들 학습 JSONL 경로(학습 파일이나 manifest가 이미 있으면 거부). 저장소 밖에 둔다")
    default_khaters = f"${ML_DIRECTORY_VARIABLE}/{KHATERS_RELATIVE_PATH}/{KHATERS_TRAIN_FILE_NAME}"
    parser.add_argument("--khaters-train", type=Path, help=f"K-HATERS train JSONL(기본: {default_khaters})")
    source = parser.add_mutually_exclusive_group()
    versions = sorted(HARD_NEGATIVE_VERSIONS)
    source.add_argument("--hard-negative-version", choices=versions, default=DEFAULT_HARD_NEGATIVE_VERSION, help="저장소 허용 문장의 판(기본 v1)")
    source.add_argument("--hard-negatives", type=Path, help="저장소 대신 쓸 허용 문장 JSONL(파일 전체를 쓴다)")
    parser.add_argument("--toxic-fraction", type=fraction_below_one, help="K-HATERS 부분의 유해 비율 목표(기본: 줄이지 않음)")
    parser.add_argument("--extra-repeat", type=non_negative_integer, default=DEFAULT_EXTRA_REPEAT, help="허용 문장 반복 횟수(기본 3, 0이면 넣지 않음)")
    round3_variant = parser.add_mutually_exclusive_group()
    round3_variant.add_argument(
        "--friendly-profanity-repeat",
        type=positive_integer,
        help="friendly_profanity 허용 문장만 --extra-repeat 대신 넣을 횟수(1 이상)",
    )
    round3_variant.add_argument(
        "--drop-untargeted-offensive",
        action="store_true",
        help="K-HATERS의 offensive이면서 target_label이 빈 목록인 줄을 제외한다",
    )
    parser.add_argument("--generated-harmful", type=Path, help="추가할 생성 유해 JSONL(id, text)")
    parser.add_argument("--generated-harmful-repeat", type=non_negative_integer, default=DEFAULT_GENERATED_REPEAT, help="생성 유해 반복 횟수(기본 1)")
    parser.add_argument("--generated-allow", type=Path, help="추가할 생성 허용 JSONL(id, text)")
    parser.add_argument("--generated-allow-repeat", type=non_negative_integer, default=DEFAULT_GENERATED_REPEAT, help="생성 허용 반복 횟수(기본 1)")
    parser.add_argument("--sealed-holdout", type=Path, help="마지막에 단방향 겹침을 제외할 봉인 chat eval JSONL")
    parser.add_argument("--seed", type=positive_integer, default=DEFAULT_SEED, help="유해 표본 시드")
    return parser


def resolve_khaters_path(arguments: argparse.Namespace, environment: Mapping[str, str]) -> Path:
    """K-HATERS train 경로. 인자가 없으면 ML 디렉터리의 기본 위치다."""
    return arguments.khaters_train or resolve_ml_directory(None, environment) / KHATERS_RELATIVE_PATH / KHATERS_TRAIN_FILE_NAME


def ensure_outputs_absent(output_path: Path) -> None:
    """학습 파일과 manifest가 둘 다 없어야 한다. 앞선 학습 파일과 그 출처 기록을 지키기 위해서다."""
    for path in (output_path, manifest_path_for(output_path)):
        if path.exists():
            raise OutputExistsError(f"{path.name}이 이미 있습니다. 앞선 학습 파일과 출처 기록을 지키려고 덮어쓰지 않습니다. 다른 이름을 주세요.")
    ensure_outside_repository(output_path)


def load_selected_hard_negatives(arguments: argparse.Namespace) -> tuple[list[HardNegative], dict]:
    """인자로 고른 허용 문장과 그 출처. --hard-negatives가 있으면 그 파일 전체, 없으면 저장소 파일의 한 판이다."""
    if arguments.hard_negatives is not None:
        return load_hard_negatives(arguments.hard_negatives), describe_hard_negative_source(arguments.hard_negatives, None)
    version_name = arguments.hard_negative_version
    return load_hard_negative_version(version_name), describe_hard_negative_source(DEFAULT_HARD_NEGATIVES_PATH, version_name)


def validate_round3_training_option(arguments: argparse.Namespace, hard_negatives: Sequence[HardNegative]) -> None:
    """W는 고정한 허용 문장 v1의 칭찬 비속어 986줄에만 적용한다."""
    if arguments.friendly_profanity_repeat is None:
        return
    if arguments.hard_negatives is not None or arguments.hard_negative_version != "v1":
        raise DatasetFormatError("--friendly-profanity-repeat는 저장소 허용 문장 --hard-negative-version v1에만 쓸 수 있습니다.")
    source_rows = sum(item.category == "friendly_profanity" for item in hard_negatives)
    if source_rows != V1_FRIENDLY_PROFANITY_ROWS:
        raise DatasetFormatError(f"허용 문장 v1의 friendly_profanity가 {source_rows}줄입니다. 고정값 {V1_FRIENDLY_PROFANITY_ROWS}줄인 원본 v1을 복원하세요.")


def stage_and_publish_outputs(output_path: Path, rows: Sequence[Mapping[str, str]], manifest_body: Mapping[str, object], created: list[CreatedFile]) -> dict:
    """학습 파일과 manifest를 모두 임시 파일로 써 둔 뒤 학습 파일, manifest 순으로 최종 이름에 넣고 임시 파일을 지운다."""
    staged_data = stage_text_file(output_path.parent, "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), created)
    manifest = dict(manifest_body) | {"output": {"file_name": output_path.name, "sha256": compute_file_sha256(staged_data.path)}}
    staged_manifest = stage_text_file(output_path.parent, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", created)
    publish_without_overwrite(staged_data, output_path, created)
    publish_without_overwrite(staged_manifest, manifest_path_for(output_path), created)
    remove_created_files([staged_data, staged_manifest])
    return manifest


def write_training_outputs(
    output_path: Path,
    rows: Sequence[Mapping[str, str]],
    settings: MixSettings,
    inputs: Mapping[str, dict],
    excluded: Sequence[OverlapFinding],
    excluded_generated: Sequence[str] | None = None,
    sealed_holdout: Mapping[str, object] | None = None,
    dropped_untargeted_offensive: Mapping[str, object] | None = None,
    friendly_profanity_repeat: Mapping[str, object] | None = None,
) -> dict:
    """학습 파일과 그 sha256을 담은 manifest를 함께 쓴다. 둘 다 생기거나 둘 다 생기지 않는다.

    왜: 출처 기록 없는 학습 파일이 남으면 그 파일로 학습할 수 있고, 다음 실행도 "이미 있음"으로 막힌다. 그래서 도중에 실패하면 이번 실행이
    만든 파일(임시·최종)을 모두 지우고 오류를 그대로 올린다. 두 최종 이름은 차례로 넣으므로 그 사이에는 학습 파일만 보인다.
    프로세스가 강제로 죽으면(SIGKILL, 전원) 정리할 수 없다. 그때 남은 학습 파일, manifest, `.training-mix-*.tmp`는 지우고 다시 만든다.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    created: list[CreatedFile] = []
    try:
        manifest = build_manifest(
            settings,
            inputs,
            excluded,
            rows,
            excluded_generated,
            sealed_holdout,
            dropped_untargeted_offensive,
            friendly_profanity_repeat,
        )
        return stage_and_publish_outputs(output_path, rows, manifest, created)
    except BaseException:
        remove_created_files(created)
        raise


def main(argv: Sequence[str] | None = None, environment: Mapping[str, str] | None = None) -> None:
    """모든 입력을 섞고 공개 평가·봉인 보류 겹침을 단방향으로 뺀 뒤 트랜잭션으로 쓴다."""
    arguments = build_argument_parser().parse_args(argv)
    ensure_outputs_absent(arguments.out)
    khaters_path = resolve_khaters_path(arguments, os.environ if environment is None else environment)
    hard_negatives, hard_negative_source = load_selected_hard_negatives(arguments)
    validate_round3_training_option(arguments, hard_negatives)
    references = load_evaluation_references()
    ensure_no_evaluation_overlap(hard_negatives, references)
    if arguments.drop_untargeted_offensive:
        loaded_khaters, dropped_ids = load_labeled_texts_excluding_untargeted_offensive(khaters_path)
    else:
        loaded_khaters, dropped_ids = load_labeled_texts(khaters_path), []
    khaters, excluded = exclude_evaluation_overlaps(loaded_khaters, references)
    generated = load_generated_selection(arguments, references)
    settings = MixSettings(arguments.toxic_fraction, arguments.extra_repeat, arguments.seed)
    sourced_rows = build_sourced_training_rows(khaters, hard_negatives, generated, settings, arguments)
    sourced_rows, sealed_summary = apply_optional_sealed_holdout(arguments, sourced_rows)
    rows = [row for _, row in sourced_rows]
    inputs = {"khaters_train": describe_file_provenance(khaters_path), "hard_negatives": hard_negative_source} | generated.inputs
    generated_excluded = generated.excluded_ids if generated.enabled else None
    dropped_summary = None
    if arguments.drop_untargeted_offensive:
        dropped_summary = {"count": len(dropped_ids), "ids_sha256": compute_identifier_list_sha256(dropped_ids)}
    friendly_summary = None
    if arguments.friendly_profanity_repeat is not None:
        source_rows = sum(item.category == "friendly_profanity" for item in hard_negatives)
        friendly_summary = {
            "repeat": arguments.friendly_profanity_repeat,
            "source_rows": source_rows,
            "added_rows": source_rows * (arguments.friendly_profanity_repeat - arguments.extra_repeat),
        }
    manifest = write_training_outputs(
        arguments.out,
        rows,
        settings,
        inputs,
        excluded,
        generated_excluded,
        sealed_summary,
        dropped_summary,
        friendly_summary,
    )
    counts = manifest["counts"]
    sealed_text = "" if sealed_summary is None else f", 봉인 보류셋과 겹쳐 뺀 {sealed_summary['excluded_rows']}줄"
    summary = f"학습 파일 {len(rows)}줄(정상 {counts['normal']}, 유해 {counts['toxic']}, 평가셋과 겹쳐 뺀 K-HATERS {len(excluded)}줄"
    print(f"{summary}{sealed_text}) → {arguments.out.name}")


if __name__ == "__main__":
    run_command_line(main)
