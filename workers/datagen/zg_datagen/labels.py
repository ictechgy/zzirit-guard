"""작성 의도를 숨긴 라벨 묶음을 만들고 두 독립 판정의 합의와 신뢰도 집계를 원문 없이 합친다."""

from __future__ import annotations

import argparse
import json
import math
import random
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from zg_datagen._io import ensure_outputs_absent, read_jsonl, require_string, write_jsonl_exclusive

LABELS = frozenset({"harmful", "allow", "ambiguous"})
HARMFUL_CATEGORIES = ("abuse", "sexual", "minors", "threat", "doxxing", "self_harm", "spam")
ALLOW_CATEGORIES = ("friendly_profanity", "game_combat", "short_normal", "long_normal", "quote_report", "number_url_like")
ALL_CATEGORIES = frozenset(HARMFUL_CATEGORIES + ALLOW_CATEGORIES)
MERGE_FILE_NAMES = ("accepted-harmful.jsonl", "accepted-allow.jsonl", "rejected.jsonl")


@dataclass(frozen=True)
class LabelDecision:
    """라벨과 범주를 함께 검증한 뒤 보관해 합의 계산에서 불가능한 조합을 다시 다루지 않게 한다."""

    lid: str
    label: str
    category: str | None


def make_batches(input_paths: Sequence[Path], seed: int, batch_size: int, output_directory: Path, key_path: Path) -> dict[str, object]:
    """섞은 뒤 lid를 매겨 원래 id와 작성 의도가 라벨러의 판단에 영향을 주지 않게 한다.

    key(작성 의도가 든 비공개 연결 파일)는 묶음 디렉터리 밖에 따로 쓴다. 왜: 묶음 디렉터리를 통째로 외부 라벨러에게
    넘기면 key도 함께 넘어가 블라인드가 깨진다(보안 검토).
    """
    if not input_paths or batch_size < 1:
        raise ValueError("--inputs는 하나 이상이고 --batch-size는 1 이상이어야 합니다.")
    ensure_key_outside(key_path, output_directory)
    records = load_generation_records(input_paths)
    random.Random(seed).shuffle(records)
    visible, key = build_blind_records(records)
    paths = prepare_batch_paths(output_directory, len(visible), batch_size) + [key_path]
    ensure_outputs_absent([key_path])
    publish_batches(paths, visible, key, batch_size)
    return {"records": len(visible), "batches": len(paths) - 1}


def ensure_key_outside(key_path: Path, output_directory: Path) -> None:
    """key 경로가 묶음 디렉터리(또는 그 아래)에 있으면 거절한다. 라벨러에게 넘기는 디렉터리에 작성 의도가 섞이지 않게 한다."""
    key_parent = key_path.resolve().parent
    batch_directory = output_directory.resolve()
    if key_parent == batch_directory or batch_directory in key_parent.parents:
        raise ValueError("--key-out은 --out-dir 밖이어야 합니다. 묶음 디렉터리는 외부 라벨러에게 넘기므로 작성 의도가 든 key를 두지 마세요.")


def load_generation_records(input_paths: Sequence[Path]) -> list[dict[str, object]]:
    """모든 입력을 섞기 전에 형식과 id 중복을 검사해 서로 다른 실행의 같은 레코드가 두 번 라벨되지 않게 한다."""
    records: list[dict[str, object]] = []
    identifiers: set[str] = set()
    for path in input_paths:
        append_generation_records(path, read_jsonl(path), records, identifiers)
    if not records:
        raise ValueError("입력 레코드가 없습니다. 필터를 통과한 JSONL을 확인하세요.")
    return records


def append_generation_records(path: Path, source: Sequence[Mapping[str, object]], records: list[dict[str, object]], identifiers: set[str]) -> None:
    """필수 메타데이터를 배치 전에 고정해 key만으로도 나중에 원본 id와 판정을 안전하게 연결하게 한다."""
    for position, record in enumerate(source, 1):
        location = f"{path.name}:{position}"
        identifier = require_string(record, "id", location)
        if identifier in identifiers:
            raise ValueError(f"{location}: id {identifier!r}가 겹칩니다. 입력 파일에서 중복을 제거하세요.")
        for field in ("text", "kind", "intended"):
            require_string(record, field, location)
        identifiers.add(identifier)
        records.append(dict(record))


def build_blind_records(records: Sequence[Mapping[str, object]]) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """라벨러용과 비공개 연결 키를 동시에 만들어 lid 순서가 두 파일에서 어긋날 여지를 없앤다."""
    visible: list[dict[str, str]] = []
    key: list[dict[str, str]] = []
    for index, record in enumerate(records, 1):
        lid = f"L{index:05d}"
        visible.append({"lid": lid, "text": str(record["text"])})
        key.append({"lid": lid, "id": str(record["id"]), "kind": str(record["kind"]), "intended": str(record["intended"])})
    return visible, key


def prepare_output_directory(path: Path) -> None:
    """새 디렉터리는 소유자만 접근하게 만들고 기존 디렉터리는 파일별 배타 생성으로 안전하게 재사용한다."""
    if path.exists() and not path.is_dir():
        raise NotADirectoryError(f"{path}: 출력 디렉터리가 아닙니다. 다른 --out-dir을 지정하세요.")
    if not path.exists():
        path.mkdir(parents=True, mode=0o700)


def prepare_batch_paths(output_directory: Path, record_count: int, batch_size: int) -> list[Path]:
    """쓸 파일을 모두 미리 알아야 하나라도 기존 파일과 겹칠 때 부분 출력을 만들지 않을 수 있다."""
    prepare_output_directory(output_directory)
    batch_count = math.ceil(record_count / batch_size)
    paths = [output_directory / f"batch-{index:03d}.jsonl" for index in range(1, batch_count + 1)]
    ensure_outputs_absent(paths)
    return paths


def publish_batches(paths: Sequence[Path], visible: Sequence[Mapping[str, object]], key: Sequence[Mapping[str, object]], batch_size: int) -> None:
    """중간 실패 시 이번 호출이 만든 파일만 지워 불완전한 라벨 묶음이 전달되지 않게 한다."""
    created: list[Path] = []
    try:
        for index, path in enumerate(paths[:-1]):
            write_jsonl_exclusive(path, visible[index * batch_size : (index + 1) * batch_size])
            created.append(path)
        write_jsonl_exclusive(paths[-1], key)
        created.append(paths[-1])
    except BaseException:
        remove_created(created)
        raise


def remove_created(paths: Sequence[Path]) -> None:
    """호출 중 배타 생성에 성공한 경로만 지워 사용자가 미리 둔 다른 파일을 건드리지 않게 한다."""
    for path in paths:
        path.unlink(missing_ok=True)


def merge_labels(key_path: Path, labeler_a_directory: Path, labeler_b_directory: Path, output_directory: Path) -> dict[str, object]:
    """검증된 두 완전 판정 집합만 합쳐 누락이나 중복을 합의로 오해하지 않게 한다."""
    keys = load_key(key_path)
    expected = set(keys)
    first = load_labeler_directory(labeler_a_directory, expected, "labeler-a")
    second = load_labeler_directory(labeler_b_directory, expected, "labeler-b")
    accepted_harmful, accepted_allow, rejected = merge_records(keys, first, second)
    publish_merge_outputs(output_directory, accepted_harmful, accepted_allow, rejected)
    return build_report(keys, first, second)


def load_key(path: Path) -> dict[str, dict[str, str]]:
    """key의 lid를 유일하게 검증해 서로 다른 원본이 한 판정에 연결되는 일을 막는다."""
    output: dict[str, dict[str, str]] = {}
    for position, record in enumerate(read_jsonl(path), 1):
        location = f"{path.name}:{position}"
        lid = require_string(record, "lid", location)
        if lid in output:
            raise ValueError(f"{location}: lid {lid}가 두 번 있습니다. key를 다시 만드세요.")
        output[lid] = {field: require_string(record, field, location) for field in ("lid", "id", "kind", "intended")}
    if not output:
        raise ValueError(f"{path}: key가 비었습니다. make-batches 출력을 확인하세요.")
    return output


def load_labeler_directory(directory: Path, expected: set[str], name: str) -> dict[str, LabelDecision]:
    """디렉터리 전체를 한 판정 집합으로 보아 파일 분할 방식과 무관하게 lid 완전성을 검사한다."""
    if not directory.is_dir():
        raise FileNotFoundError(f"{directory}: {name} 디렉터리가 없습니다. 라벨 결과 경로를 확인하세요.")
    paths = sorted(directory.glob("*.jsonl"))
    if not paths:
        raise ValueError(f"{directory}: {name} JSONL이 없습니다. 라벨 결과를 넣으세요.")
    decisions: dict[str, LabelDecision] = {}
    for path in paths:
        append_decisions(path, read_jsonl(path), decisions)
    validate_lid_coverage(decisions, expected, name)
    return decisions


def append_decisions(path: Path, records: Sequence[Mapping[str, object]], decisions: dict[str, LabelDecision]) -> None:
    """각 줄을 즉시 검증해 잘못된 범주가 지표의 음성 표본으로 조용히 들어가지 않게 한다."""
    for position, record in enumerate(records, 1):
        location = f"{path.name}:{position}"
        decision = parse_decision(record, location)
        if decision.lid in decisions:
            raise ValueError(f"{location}: lid {decision.lid}가 두 번 있습니다. 라벨러 출력을 하나만 남기세요.")
        decisions[decision.lid] = decision


def parse_decision(record: Mapping[str, object], location: str) -> LabelDecision:
    """라벨마다 가능한 범주를 제한해 허용 유형과 유해 범주가 뒤바뀐 응답을 거부한다."""
    lid = require_string(record, "lid", location)
    label = require_string(record, "label", location)
    if label not in LABELS:
        raise ValueError(f"{location}: label {label!r}을 알 수 없습니다. harmful, allow, ambiguous 중 하나로 고치세요.")
    category = record.get("category")
    if category is not None and (not isinstance(category, str) or category not in ALL_CATEGORIES):
        raise ValueError(f"{location}: category를 알 수 없습니다. 라벨 정책의 범주나 null을 쓰세요.")
    validate_category_for_label(label, category, location)
    return LabelDecision(lid, label, category)


def validate_category_for_label(label: str, category: object, location: str) -> None:
    """harmful과 allow의 범주 공간을 분리해 범주 합의와 유효율 계산의 의미를 보존한다."""
    if label == "harmful" and category not in HARMFUL_CATEGORIES:
        raise ValueError(f"{location}: harmful은 유해 범주가 필요합니다. 라벨 정책에 맞게 고치세요.")
    if label == "allow" and category not in ALLOW_CATEGORIES:
        raise ValueError(f"{location}: allow는 허용 유형이 필요합니다. 라벨 정책에 맞게 고치세요.")
    if label == "ambiguous" and category is not None:
        raise ValueError(f"{location}: ambiguous의 category는 null이어야 합니다. 내용을 보태지 말고 null로 고치세요.")


def validate_lid_coverage(decisions: Mapping[str, LabelDecision], expected: set[str], name: str) -> None:
    """누락과 알 수 없는 lid를 함께 보고해 라벨 파일을 다시 나누지 않고 한 번에 고칠 수 있게 한다."""
    missing = sorted(expected - decisions.keys())
    unknown = sorted(decisions.keys() - expected)
    if missing or unknown:
        detail = f"누락 {len(missing)}, 알 수 없음 {len(unknown)}"
        raise ValueError(f"{name}: lid 구성이 key와 다릅니다({detail}). 모든 lid를 정확히 한 번 판정하세요.")


def merge_records(
    keys: Mapping[str, Mapping[str, str]], first: Mapping[str, LabelDecision], second: Mapping[str, LabelDecision]
) -> tuple[list[dict[str, object]], list[dict[str, object]], list[dict[str, object]]]:
    """key 순서를 유지해 합친 파일이 라벨러 파일 분할이나 파일명 순서에 따라 달라지지 않게 한다."""
    harmful: list[dict[str, object]] = []
    allow: list[dict[str, object]] = []
    rejected: list[dict[str, object]] = []
    for lid, key in keys.items():
        merge_one(key, first[lid], second[lid], harmful, allow, rejected)
    return harmful, allow, rejected


def merge_one(
    key: Mapping[str, str],
    first: LabelDecision,
    second: LabelDecision,
    harmful: list[dict[str, object]],
    allow: list[dict[str, object]],
    rejected: list[dict[str, object]],
) -> None:
    """애매 판정을 우선 보류해 다른 라벨과의 불일치를 단순 의견 차이로 축소하지 않게 한다."""
    reason = rejection_reason(first, second)
    if reason is not None:
        rejected.append(rejected_record(key, first, second, reason))
        return
    target = harmful if first.label == "harmful" else allow
    target.append(accepted_record(key, first, second))


def rejection_reason(first: LabelDecision, second: LabelDecision) -> str | None:
    """보류 사유의 우선순위를 고정해 같은 두 판정이 실행마다 다른 집계에 들어가지 않게 한다."""
    if "ambiguous" in {first.label, second.label}:
        return "ambiguous"
    if first.label != second.label:
        return "disagree_label"
    if first.label == "harmful" and first.category != second.category:
        return "disagree_category"
    return None


def accepted_record(key: Mapping[str, str], first: LabelDecision, second: LabelDecision) -> dict[str, object]:
    """허용 유형이 달라도 A 유형을 대표값으로 두고 둘 다 남겨 합의 기준을 숨기지 않게 한다."""
    return dict(key) | {
        "label": first.label,
        "category": first.category,
        "labeler_a_category": first.category,
        "labeler_b_category": second.category,
    }


def rejected_record(key: Mapping[str, str], first: LabelDecision, second: LabelDecision, reason: str) -> dict[str, object]:
    """원문 없이 두 판정을 남겨 보류 이유를 사후 집계하되 라벨러의 차이를 잃지 않게 한다."""
    return dict(key) | {
        "reason": reason,
        "labeler_a": {"label": first.label, "category": first.category},
        "labeler_b": {"label": second.label, "category": second.category},
    }


def publish_merge_outputs(
    output_directory: Path,
    harmful: Sequence[Mapping[str, object]],
    allow: Sequence[Mapping[str, object]],
    rejected: Sequence[Mapping[str, object]],
) -> None:
    """세 결과를 미리 충돌 검사하고 중간 실패 시 이번 파일만 지워 부분 합의를 완성본으로 남기지 않는다."""
    prepare_output_directory(output_directory)
    paths = [output_directory / name for name in MERGE_FILE_NAMES]
    ensure_outputs_absent(paths)
    created: list[Path] = []
    try:
        for path, records in zip(paths, (harmful, allow, rejected), strict=True):
            write_jsonl_exclusive(path, records)
            created.append(path)
    except BaseException:
        remove_created(created)
        raise


def cohens_kappa(first: Sequence[bool], second: Sequence[bool]) -> float:
    """관측 일치에서 두 라벨러의 양성 빈도로 기대되는 우연 일치를 빼 범주별 신뢰도를 비교하게 한다."""
    if len(first) != len(second) or not first:
        raise ValueError("kappa 입력은 길이가 같은 비어 있지 않은 두 목록이어야 합니다.")
    count = len(first)
    observed = sum(left == right for left, right in zip(first, second, strict=True)) / count
    first_rate = sum(first) / count
    second_rate = sum(second) / count
    expected = first_rate * second_rate + (1 - first_rate) * (1 - second_rate)
    return 1.0 if expected == 1.0 else (observed - expected) / (1 - expected)


def build_report(keys: Mapping[str, Mapping[str, str]], first: Mapping[str, LabelDecision], second: Mapping[str, LabelDecision]) -> dict[str, object]:
    """계획의 κ·일치·오수락·유효율을 같은 검증된 판정 집합에서 계산해 분모가 갈리지 않게 한다."""
    lids = list(keys)
    kappa = {category: category_kappa(lids, first, second, category) for category in HARMFUL_CATEGORIES}
    agreement = sum(decisions_agree(first[lid], second[lid]) for lid in lids) / len(lids)
    false_accept = {category: false_accept_rate(lids, first, second, category) for category in HARMFUL_CATEGORIES}
    validity = {category: validity_rate(keys, first, second, category) for category in HARMFUL_CATEGORIES}
    return {"total": len(lids), "cohens_kappa": kappa, "overall_agreement": agreement, "false_accept_rate": false_accept, "validity_rate": validity}


def is_harmful_category(decision: LabelDecision, category: str) -> bool:
    """one-vs-rest의 양성을 한 함수로 정의해 κ와 다른 지표가 범주 판정을 다르게 해석하지 않게 한다."""
    return decision.label == "harmful" and decision.category == category


def category_kappa(lids: Sequence[str], first: Mapping[str, LabelDecision], second: Mapping[str, LabelDecision], category: str) -> float:
    """모든 항목을 해당 유해 범주 대 나머지로 바꿔 범주별 우연 보정 일치도를 계산한다."""
    first_values = [is_harmful_category(first[lid], category) for lid in lids]
    second_values = [is_harmful_category(second[lid], category) for lid in lids]
    return cohens_kappa(first_values, second_values)


def decisions_agree(first: LabelDecision, second: LabelDecision) -> bool:
    """허용 유형 차이는 계획상 합의로 보고 유해일 때만 범주까지 같아야 전체 일치로 센다."""
    if first.label != second.label:
        return False
    return first.label != "harmful" or first.category == second.category


def false_accept_rate(lids: Sequence[str], first: Mapping[str, LabelDecision], second: Mapping[str, LabelDecision], category: str) -> float:
    """A가 해당 범주로 받은 항목을 분모로 두어 B가 허용한 비율이 범주 크기에 희석되지 않게 한다."""
    accepted = [lid for lid in lids if is_harmful_category(first[lid], category)]
    if not accepted:
        return 0.0
    return sum(second[lid].label == "allow" for lid in accepted) / len(accepted)


def validity_rate(keys: Mapping[str, Mapping[str, str]], first: Mapping[str, LabelDecision], second: Mapping[str, LabelDecision], category: str) -> float:
    """작성 의도가 해당 범주인 항목만 분모로 두어 파일럿의 범주별 유효 비율을 직접 비교하게 한다."""
    intended = [lid for lid, key in keys.items() if key["intended"] == category]
    if not intended:
        return 0.0
    valid = sum(is_harmful_category(first[lid], category) and is_harmful_category(second[lid], category) for lid in intended)
    return valid / len(intended)


def build_parser() -> argparse.ArgumentParser:
    """배치 작성과 합치기의 입력을 분리해 비공개 key가 라벨러 입력으로 잘못 쓰이는 일을 줄인다."""
    parser = argparse.ArgumentParser(prog="python -m zg_datagen.labels", description="M2 생성 후보의 블라인드 이중 라벨을 준비하고 합친다")
    subparsers = parser.add_subparsers(dest="command", required=True)
    batches = subparsers.add_parser("make-batches")
    batches.add_argument("--inputs", type=Path, nargs="+", required=True)
    batches.add_argument("--seed", type=int, required=True)
    batches.add_argument("--batch-size", type=int, default=100)
    batches.add_argument("--out-dir", type=Path, required=True, help="외부 라벨러에게 넘길 묶음 디렉터리")
    batches.add_argument("--key-out", type=Path, required=True, help="작성 의도가 든 비공개 key 파일(--out-dir 밖)")
    merge = subparsers.add_parser("merge")
    merge.add_argument("--key", type=Path, required=True)
    merge.add_argument("--labeler-a", type=Path, required=True)
    merge.add_argument("--labeler-b", type=Path, required=True)
    merge.add_argument("--out-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    """성공 시 문장 없는 건수·신뢰도 JSON만 출력해 라벨 작업 로그에 원문을 남기지 않게 한다."""
    arguments = build_parser().parse_args(argv)
    report: dict[str, object]
    if arguments.command == "make-batches":
        report = make_batches(arguments.inputs, arguments.seed, arguments.batch_size, arguments.out_dir, arguments.key_out)
    else:
        report = merge_labels(arguments.key, arguments.labeler_a, arguments.labeler_b, arguments.out_dir)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
