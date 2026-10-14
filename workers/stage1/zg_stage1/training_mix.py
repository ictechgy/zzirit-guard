"""1차 분류기 학습 파일을 만든다: K-HATERS train의 유해 비율을 낮추고, 채팅 형식의 '허용 어려운 예제'를 섞는다.

왜 필요한가(docs/ml/2026-10-14-chat-eval-baseline.md):
- K-HATERS train은 73%가 유해라 점수가 전반적으로 높다. 유해를 줄여 사전 확률을 낮춘다.
- 뉴스 댓글에는 칭찬 비속어·게임 표현·인용/신고 같은 방송 채팅이 없어, 이런 문장을 유해로 본다. 그 문장들을 정상(normal)으로 넣는다.
결과 파일은 K-HATERS와 같은 형식(id·text·label)이라 train의 --train-file로 그대로 쓴다. 옆에 만든 manifest에 입력 파일의
sha256과 설정을 남겨, 같은 입력·설정이면 같은 파일이 나오게 한다. 데이터 원문은 저장소에 넣지 않는다(출력은 ML 디렉터리에 둔다).

CLI 사용 예:
  uv run python -m zg_stage1.training_mix --out "$ZG_DATA_DIR/ml/data/mix/train-hn-f50-r3.jsonl" --toxic-fraction 0.5 --extra-repeat 3
"""

from __future__ import annotations

import argparse
import json
import os
import random
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

from zg_stage1.arguments import fraction_below_one, non_negative_integer, positive_integer
from zg_stage1.chat_eval_data import ALLOW_CATEGORIES, OverlapIndex, ensure_sealed_regression_unchanged, load_chat_eval_set, load_sealed_regression_index
from zg_stage1.data import (
    LabeledText,
    compute_file_sha256,
    describe_file_provenance,
    iterate_nonblank_lines,
    load_labeled_texts,
    parse_json_object,
    require_string_field,
)
from zg_stage1.errors import DatasetFormatError, OutputExistsError, run_command_line
from zg_stage1.paths import KHATERS_RELATIVE_PATH, KHATERS_TRAIN_FILE_NAME, ML_DIRECTORY_VARIABLE, ensure_outside_repository, resolve_ml_directory

# 저장소에 넣은 학습용 허용 문장과 평가셋 위치. 평가셋과 겹치지 않는지 만들 때마다 확인한다.
STAGE1_DIRECTORY = Path(__file__).resolve().parents[1]
DEFAULT_HARD_NEGATIVES_PATH = STAGE1_DIRECTORY / "train_data" / "hard-negatives-v2.jsonl"
EVAL_SET_PATHS: tuple[Path, ...] = (STAGE1_DIRECTORY / "eval_data" / "chat-dev-v2.jsonl", STAGE1_DIRECTORY / "eval_data" / "chat-holdout-v2.jsonl")

# 기본 설정: 유해 50%(정상과 같은 수), 허용 어려운 예제 3번 반복. 2천여 문장을 한 번만 넣으면 9만여 문장 속에서 효과가 묻힌다.
DEFAULT_TOXIC_FRACTION = 0.5
DEFAULT_EXTRA_REPEAT = 3
DEFAULT_SEED = 20261014

# 섞은 문장의 id 접두사. K-HATERS의 숫자 id와 겹치지 않게 한다.
HARD_NEGATIVE_ID_PREFIX = "hn-"

# 섞은 문장에 붙이는 K-HATERS 라벨. 이진 변환에서 0(정상)이 되는 값이다.
NORMAL_LABEL = "normal"


@dataclass(frozen=True)
class HardNegative:
    """학습용 허용 문장 한 줄. 출력·로그에는 id만 쓴다."""

    item_id: str
    category: str
    text: str


@dataclass(frozen=True)
class MixSettings:
    """혼합 설정. manifest에 그대로 남긴다."""

    toxic_fraction: float = DEFAULT_TOXIC_FRACTION
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


def load_hard_negatives(path: Path) -> list[HardNegative]:
    """학습용 허용 문장 파일을 모두 읽는다. 비었거나 id가 겹치면 오류다."""
    items = [parse_hard_negative(line, location) for location, line in iterate_nonblank_lines(path, None)]
    if not items:
        raise DatasetFormatError(f"{path.name}: 학습용 허용 문장이 없습니다.")
    duplicated = sorted(identifier for identifier, count in Counter(item.item_id for item in items).items() if count > 1)
    if duplicated:
        raise DatasetFormatError(f"{path.name}: id가 겹칩니다({', '.join(duplicated[:5])}).")
    return items


def ensure_no_evaluation_overlap(items: Sequence[HardNegative], eval_paths: Sequence[Path] = EVAL_SET_PATHS) -> None:
    """학습 문장이 평가셋(개발·보류)이나 봉인한 72문장과 같거나 거의 같으면 오류를 낸다.

    왜: 평가 문장을 학습하면 평가 숫자가 부풀려진다. 학습 파일을 만들 때마다 확인해, 평가셋이 바뀌어도 누수가 생기지 않게 한다.
    """
    ensure_sealed_regression_unchanged()
    eval_items = [item for path in eval_paths for item in load_chat_eval_set(path)]
    references = [OverlapIndex.build((item.item_id, item.text) for item in eval_items), load_sealed_regression_index()]
    overlapping = [item.item_id for item in items if any(index.find_overlap(item.item_id, item.text) for index in references)]
    if overlapping:
        raise DatasetFormatError(f"학습 문장 {len(overlapping)}건이 평가셋과 겹칩니다({', '.join(overlapping[:10])}). 해당 문장을 빼세요.")


def downsample_toxic(records: Sequence[LabeledText], toxic_fraction: float, seed: int) -> list[LabeledText]:
    """정상은 모두 두고 유해만 줄여 유해 비율을 toxic_fraction으로 맞춘다. 원래 순서를 지킨다.

    이미 유해 비율이 목표 이하이면 그대로 둔다(늘리지는 않는다).
    """
    toxic_indices = [index for index, record in enumerate(records) if record.binary_label == 1]
    normal_count = len(records) - len(toxic_indices)
    target = round(normal_count * toxic_fraction / (1 - toxic_fraction))
    if target >= len(toxic_indices):
        return list(records)
    kept_toxic = set(random.Random(seed).sample(toxic_indices, target))
    return [record for index, record in enumerate(records) if record.binary_label == 0 or index in kept_toxic]


def hard_negative_rows(items: Sequence[HardNegative], repeat: int) -> list[dict]:
    """허용 문장을 K-HATERS 형식의 정상 줄로 바꾼다. 반복마다 id 끝에 번호를 붙여 겹치지 않게 한다."""
    return [{"id": f"{HARD_NEGATIVE_ID_PREFIX}{item.item_id}-{copy}", "text": item.text, "label": NORMAL_LABEL} for copy in range(repeat) for item in items]


def khaters_rows(records: Sequence[LabeledText]) -> list[dict]:
    """K-HATERS 레코드를 원래 라벨 그대로 줄로 만든다."""
    return [{"id": record.record_id, "text": record.text, "label": record.original_label} for record in records]


def count_binary_labels(rows: Sequence[Mapping[str, str]]) -> dict[str, int]:
    """정상·유해 줄 수."""
    normal = sum(1 for row in rows if row["label"] == NORMAL_LABEL)
    return {"normal": normal, "toxic": len(rows) - normal}


def build_training_rows(khaters: Sequence[LabeledText], hard_negatives: Sequence[HardNegative], settings: MixSettings) -> list[dict]:
    """K-HATERS(유해를 줄인 것) 뒤에 허용 문장을 붙인 학습 줄 목록. 섞는 일은 학습의 길이 기준 배치가 한다."""
    kept = downsample_toxic(khaters, settings.toxic_fraction, settings.seed)
    return khaters_rows(kept) + hard_negative_rows(hard_negatives, settings.extra_repeat)


def write_jsonl_atomically(path: Path, rows: Sequence[Mapping[str, str]]) -> None:
    """JSONL을 임시 파일에 쓴 뒤 이름을 바꿔 넣는다. 중간에 멈춰도 반쯤 쓴 학습 파일이 남지 않게 하기 위해서다."""
    temporary_path = path.with_name(f".{path.name}.tmp")
    temporary_path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    os.replace(temporary_path, path)


def build_manifest(settings: MixSettings, input_paths: Mapping[str, Path], rows: Sequence[Mapping[str, str]], output_path: Path) -> dict:
    """설정, 입력 파일 출처(이름·크기·sha256), 줄 수, 출력 sha256. 원문은 넣지 않는다."""
    return {
        "settings": asdict(settings),
        "inputs": {name: describe_file_provenance(path) for name, path in input_paths.items()},
        "counts": count_binary_labels(rows),
        "output": {"file_name": output_path.name, "sha256": compute_file_sha256(output_path)},
    }


def build_argument_parser() -> argparse.ArgumentParser:
    """CLI 인자."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage1.training_mix", description="1차 분류기 학습 파일 만들기(K-HATERS + 허용 어려운 예제)")
    parser.add_argument("--out", type=Path, required=True, help="만들 학습 JSONL 경로(이미 있으면 거부). 저장소 밖에 둔다")
    default_khaters = f"${ML_DIRECTORY_VARIABLE}/{KHATERS_RELATIVE_PATH}/{KHATERS_TRAIN_FILE_NAME}"
    parser.add_argument("--khaters-train", type=Path, help=f"K-HATERS train JSONL(기본: {default_khaters})")
    parser.add_argument("--hard-negatives", type=Path, default=DEFAULT_HARD_NEGATIVES_PATH, help="학습용 허용 문장 JSONL(기본: 저장소의 v1)")
    parser.add_argument("--toxic-fraction", type=fraction_below_one, default=DEFAULT_TOXIC_FRACTION, help="K-HATERS 부분의 유해 비율 목표(기본 0.5)")
    parser.add_argument("--extra-repeat", type=non_negative_integer, default=DEFAULT_EXTRA_REPEAT, help="허용 문장 반복 횟수(기본 3, 0이면 넣지 않음)")
    parser.add_argument("--seed", type=positive_integer, default=DEFAULT_SEED, help="유해 표본 시드")
    return parser


def resolve_khaters_path(arguments: argparse.Namespace, environment: Mapping[str, str]) -> Path:
    """K-HATERS train 경로. 인자가 없으면 ML 디렉터리의 기본 위치다."""
    return arguments.khaters_train or resolve_ml_directory(None, environment) / KHATERS_RELATIVE_PATH / KHATERS_TRAIN_FILE_NAME


def main(argv: Sequence[str] | None = None, environment: Mapping[str, str] | None = None) -> None:
    """입력 읽기 → 평가셋 겹침 확인 → 유해 줄이기·허용 문장 섞기 → 학습 파일과 manifest 쓰기 → 줄 수 출력."""
    arguments = build_argument_parser().parse_args(argv)
    if arguments.out.exists():
        raise OutputExistsError(f"{arguments.out.name}이 이미 있습니다. 앞선 학습 파일을 지키려고 덮어쓰지 않습니다. 다른 이름을 주세요.")
    ensure_outside_repository(arguments.out)
    khaters_path = resolve_khaters_path(arguments, os.environ if environment is None else environment)
    hard_negatives = load_hard_negatives(arguments.hard_negatives)
    ensure_no_evaluation_overlap(hard_negatives)
    settings = MixSettings(arguments.toxic_fraction, arguments.extra_repeat, arguments.seed)
    rows = build_training_rows(load_labeled_texts(khaters_path), hard_negatives, settings)
    arguments.out.parent.mkdir(parents=True, exist_ok=True)
    write_jsonl_atomically(arguments.out, rows)
    manifest = build_manifest(settings, {"khaters_train": khaters_path, "hard_negatives": arguments.hard_negatives}, rows, arguments.out)
    arguments.out.with_suffix(".manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"학습 파일 {len(rows)}줄(정상 {manifest['counts']['normal']}, 유해 {manifest['counts']['toxic']}) → {arguments.out.name}")


if __name__ == "__main__":
    run_command_line(main)
