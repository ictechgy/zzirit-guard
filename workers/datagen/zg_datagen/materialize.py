"""두 라벨러가 합의한 문장을 원문과 다시 이어 학습 입력({id, text})으로 만든다.

왜 따로 두나: labels merge는 원문 없이 판정만 다루고, zg_stage1.training_mix는 {id, text}만 받으므로 이 단계가 둘을 안전하게 잇는다.
거의 같은 문장은 같은 라벨 안에서만 하나를 남긴다. 유해 부모와 최소 편집 twin처럼 상반 라벨의 가까운 문장은 의도한 대조쌍이기 때문이다.
같은 부모의 twin끼리도 서로 비교하지 않지만 다른 허용 행과는 비교해, H1T2/H1T3의 변형 수를 보존하면서 별개 출처의 중복은 제거한다.
선택 상한을 쓰면 seed로 라벨별 순서를 따로 섞어 파일 순서가 결과를 결정하지 않게 하고, 유해 범주 상한 뒤 살아남은 부모에만 twin 상한을 적용한다.

twin의 parent_id는 생성에 쓴 부모 파일에서 이미 실행 이름이 붙은 id이며, 최종 유해 id인 ``<run name>:<original id>``와 정확히 같아야 한다.
materialize에서는 이 값에 접두사를 다시 붙이지 않는다.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from zg_datagen._io import ensure_outputs_absent, read_jsonl, require_string, write_json_exclusive, write_jsonl_exclusive
from zg_datagen.filters import normalize_for_matching

# 계획의 기준을 한곳에 두어 manifest와 실제 비교가 서로 다른 임계값을 기록하지 않게 한다.
NEAR_DUPLICATE_JACCARD = 0.7
# 평가셋 겹침 검사와 같은 크기를 써 생성 자료만 더 느슨하거나 엄격하게 정규화되지 않게 한다.
NGRAM_SIZE = 3


@dataclass
class NearDuplicateIndex:
    """받은 문장의 3-gram과 선택 그룹을 함께 색인해 필요한 후보만 비교한다."""

    grams: list[frozenset[str]] = field(default_factory=list)
    groups: list[str | None] = field(default_factory=list)
    postings: dict[str, list[int]] = field(default_factory=dict)

    def is_near_duplicate(self, grams: frozenset[str], group: str | None = None) -> bool:
        """같은 비어 있지 않은 그룹은 의도한 변형 묶음이므로 중복 비교에서 건너뛴다."""
        candidates = {index for gram in grams for index in self.postings.get(gram, ())}
        return any(self._matches(index, grams, group) for index in candidates)

    def _matches(self, index: int, grams: frozenset[str], group: str | None) -> bool:
        """그룹 예외를 임계값 계산보다 먼저 적용해 같은 부모 twin 수를 보존한다."""
        if group is not None and self.groups[index] == group:
            return False
        return jaccard(grams, self.grams[index]) >= NEAR_DUPLICATE_JACCARD

    def add(self, grams: frozenset[str], group: str | None = None) -> None:
        """수락된 행만 넣어 탈락한 후보가 뒤의 유효한 후보까지 막지 않게 한다."""
        position = len(self.grams)
        self.grams.append(grams)
        self.groups.append(group)
        for gram in grams:
            self.postings.setdefault(gram, []).append(position)


@dataclass(frozen=True)
class MaterializeSettings:
    """선택 규칙을 한 값으로 묶어 실행과 원문 없는 manifest가 같은 설정을 쓰게 한다."""

    seed: int | None
    harmful_cap: int | None
    harmful_category_caps: Mapping[str, int]
    twins_per_parent: int | None

    def as_dict(self) -> dict[str, object]:
        """범주 키를 정렬해 같은 설정의 manifest가 매핑 삽입 순서에 흔들리지 않게 한다."""
        return {
            "seed": self.seed,
            "harmful_cap": self.harmful_cap,
            "harmful_category_caps": dict(sorted(self.harmful_category_caps.items())),
            "twins_per_parent": self.twins_per_parent,
            "near_duplicate_jaccard": NEAR_DUPLICATE_JACCARD,
        }


@dataclass
class Materialized:
    """학습 입력과 원문 없는 탈락 집계를 함께 두어 출력과 보고의 분모가 갈리지 않게 한다."""

    rows: list[dict[str, str]] = field(default_factory=list)
    categories: Counter[str] = field(default_factory=Counter)
    near_duplicates: int = 0
    over_cap: Counter[str] = field(default_factory=Counter)
    kinds: Counter[str] = field(default_factory=Counter)
    twins_without_parent: int = 0
    twins_over_limit: int = 0
    twins_by_parent: Counter[str] = field(default_factory=Counter)


def character_ngrams(text: str) -> frozenset[str]:
    """정규화한 글자 3-gram을 써 공백과 문장부호만 다른 표면 변형을 잡는다."""
    normalized = normalize_for_matching(text)
    if len(normalized) < NGRAM_SIZE:
        return frozenset({normalized})
    return frozenset(normalized[index : index + NGRAM_SIZE] for index in range(len(normalized) - NGRAM_SIZE + 1))


def jaccard(first: frozenset[str], second: frozenset[str]) -> float:
    """두 3-gram 집합이 함께 가진 비율로 문장 길이 차이까지 반영한다."""
    union = first | second
    return len(first & second) / len(union) if union else 1.0


def load_kept_records(input_paths: Sequence[Path]) -> dict[str, dict[str, object]]:
    """text뿐 아니라 kind와 parent_id도 이어야 twin 선택 계약을 원본 기준으로 적용할 수 있다."""
    records: dict[str, dict[str, object]] = {}
    for path in input_paths:
        append_kept_records(path, records)
    return records


def append_kept_records(path: Path, records: dict[str, dict[str, object]]) -> None:
    """같은 id가 여러 kept 파일에 있으면 어느 메타데이터가 맞는지 정할 수 없어 즉시 거절한다."""
    for position, record in enumerate(read_jsonl(path), 1):
        location = f"{path.name}:{position}"
        identifier = require_string(record, "id", location)
        require_string(record, "text", location)
        if identifier in records:
            raise ValueError(f"{location}: id {identifier!r}가 다른 입력에도 있습니다. 같은 생성 실행을 두 번 주지 않았는지 확인하세요.")
        records[identifier] = dict(record)


def load_run(run_directory: Path, file_name: str) -> list[dict[str, object]]:
    """한 실행의 merge 판정에 kept 원본을 붙이고 실행 이름으로 전역 id 충돌을 막는다."""
    path = run_directory / "merged" / file_name
    if not path.is_file():
        raise FileNotFoundError(f"{path}: 합치기 결과가 없습니다. 그 실행에서 labels merge를 먼저 실행하세요.")
    kept_records = load_kept_records(sorted(run_directory.glob("kept-*.jsonl")))
    return [joined_record(record, kept_records, run_directory.name) for record in read_jsonl(path)]


def joined_record(record: Mapping[str, object], kept_records: Mapping[str, Mapping[str, object]], run_name: str) -> dict[str, object]:
    """merge의 범주와 kept의 전체 메타데이터를 합쳐 판정과 생성 출처를 모두 잃지 않게 한다."""
    identifier = require_string(record, "id", "merged")
    if identifier not in kept_records:
        raise ValueError(f"{run_name}의 id {identifier!r}에 맞는 원문이 없습니다. 그 실행 디렉터리에 kept 파일이 있는지 확인하세요.")
    joined = dict(kept_records[identifier])
    joined.update({"id": f"{run_name}:{identifier}", "category": record.get("category")})
    return joined


def build_settings(
    seed: int | None,
    harmful_cap: int | None,
    harmful_category_caps: Mapping[str, int] | None,
    twins_per_parent: int | None,
) -> MaterializeSettings:
    """API 호출도 CLI와 같은 음수·seed 규칙을 지켜 조용히 순서 의존 결과를 만들지 않게 한다."""
    category_caps = dict(harmful_category_caps or {})
    validate_optional_cap("harmful_cap", harmful_cap)
    validate_optional_cap("twins_per_parent", twins_per_parent)
    validate_category_caps(category_caps)
    if seed is None and (harmful_cap is not None or category_caps or twins_per_parent is not None):
        raise ValueError("상한이나 twins_per_parent를 쓰려면 파일 순서가 생존 행을 결정하지 않도록 seed를 지정해야 합니다.")
    return MaterializeSettings(seed, harmful_cap, category_caps, twins_per_parent)


def validate_optional_cap(name: str, value: int | None) -> None:
    """음수나 bool을 개수로 받으면 모든 행을 뜻하는지 오류인지 모호하므로 거절한다."""
    if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 0):
        raise ValueError(f"{name}은 0 이상의 정수여야 합니다.")


def validate_category_caps(category_caps: Mapping[str, int]) -> None:
    """잘못된 범주 키와 음수 상한이 일부 범주만 뜻밖에 비우는 일을 막는다."""
    for category, cap in category_caps.items():
        if not isinstance(category, str) or not category:
            raise ValueError("harmful_category_caps의 범주는 비어 있지 않은 문자열이어야 합니다.")
        validate_optional_cap(f"harmful_category_caps[{category!r}]", cap)


def shuffle_records(records: list[dict[str, object]], seed: int | None, label: str) -> None:
    """라벨별 난수열을 분리해 한쪽 행 수 변화가 다른 쪽 선택 순서를 바꾸지 않게 한다."""
    if seed is not None:
        random.Random(f"{seed}:{label}").shuffle(records)


def materialize_harmful(records: Sequence[Mapping[str, object]], settings: MaterializeSettings) -> Materialized:
    """중복을 먼저 버리고 범주 상한을 적용해 중복 행이 유효 할당량을 소비하지 않게 한다."""
    result = Materialized()
    index = NearDuplicateIndex()
    for record in records:
        add_harmful_record(record, settings, index, result)
    return result


def add_harmful_record(record: Mapping[str, object], settings: MaterializeSettings, index: NearDuplicateIndex, result: Materialized) -> None:
    """상한 초과 행을 색인하지 않아 뒤 범주의 문장이 탈락 행 때문에 막히지 않게 한다."""
    text = str(record["text"])
    grams = character_ngrams(text)
    if index.is_near_duplicate(grams):
        result.near_duplicates += 1
        return
    category = str(record.get("category"))
    cap = settings.harmful_category_caps.get(category, settings.harmful_cap)
    if cap is not None and result.categories[category] >= cap:
        result.over_cap[category] += 1
        return
    index.add(grams)
    accept_record(record, result)


def materialize_allow(records: Sequence[Mapping[str, object]], accepted_harmful_ids: set[str], settings: MaterializeSettings) -> Materialized:
    """허용만의 색인을 써 상반 라벨 대조쌍을 보존하고, twin 제한은 살아남은 부모에만 건다."""
    result = Materialized()
    index = NearDuplicateIndex()
    for record in records:
        add_allow_record(record, accepted_harmful_ids, settings, index, result)
    return result


def add_allow_record(
    record: Mapping[str, object],
    accepted_harmful_ids: set[str],
    settings: MaterializeSettings,
    index: NearDuplicateIndex,
    result: Materialized,
) -> None:
    """부모·개수 검사를 중복 검사보다 먼저 해 탈락 twin이 색인이나 부모 할당량을 소비하지 않게 한다."""
    kind = str(record.get("kind"))
    parent_id = twin_parent_id(record) if kind == "twin" else None
    if parent_id is not None and reject_twin(parent_id, accepted_harmful_ids, settings, result):
        return
    grams = character_ngrams(str(record["text"]))
    if index.is_near_duplicate(grams, parent_id):
        result.near_duplicates += 1
        return
    index.add(grams, parent_id)
    accept_record(record, result, kind)
    if parent_id is not None:
        result.twins_by_parent[parent_id] += 1


def twin_parent_id(record: Mapping[str, object]) -> str:
    """parent_id는 이미 실행 접두사가 붙은 최종 유해 id여야 정확한 대조 부모를 가리킨다."""
    identifier = str(record.get("id"))
    return require_string(record, "parent_id", f"kept twin {identifier}")


def reject_twin(parent_id: str, accepted_harmful_ids: set[str], settings: MaterializeSettings, result: Materialized) -> bool:
    """제한을 켠 경우에만 기존 호환성을 좁혀, 고아 twin과 부모별 초과를 원인별로 센다."""
    if settings.twins_per_parent is None:
        return False
    if parent_id not in accepted_harmful_ids:
        result.twins_without_parent += 1
        return True
    if result.twins_by_parent[parent_id] >= settings.twins_per_parent:
        result.twins_over_limit += 1
        return True
    return False


def accept_record(record: Mapping[str, object], result: Materialized, kind: str | None = None) -> None:
    """학습 파일에는 두 필드만 내고 집계는 별도로 갱신해 원문이 manifest에 섞이지 않게 한다."""
    result.rows.append({"id": str(record["id"]), "text": str(record["text"])})
    result.categories[str(record.get("category"))] += 1
    if kind is not None:
        result.kinds[kind] += 1


def materialize_runs(run_directories: Sequence[Path], settings: MaterializeSettings) -> tuple[Materialized, Materialized]:
    """두 라벨을 따로 섞고 처리해 입력 수와 중복이 반대 라벨 선택에 영향을 주지 않게 한다."""
    harmful_records = load_label_records(run_directories, "accepted-harmful.jsonl")
    allow_records = load_label_records(run_directories, "accepted-allow.jsonl")
    shuffle_records(harmful_records, settings.seed, "harmful")
    shuffle_records(allow_records, settings.seed, "allow")
    harmful = materialize_harmful(harmful_records, settings)
    accepted_harmful_ids = {row["id"] for row in harmful.rows}
    return harmful, materialize_allow(allow_records, accepted_harmful_ids, settings)


def load_label_records(run_directories: Sequence[Path], file_name: str) -> list[dict[str, object]]:
    """실행 순서를 기본 순서로 보존해 seed가 없을 때 기존 출력 순서와 호환되게 한다."""
    return [record for run_directory in run_directories for record in load_run(run_directory, file_name)]


def run_materialize(
    run_directories: Sequence[Path],
    harmful_path: Path,
    allow_path: Path,
    *,
    seed: int | None = None,
    harmful_cap: int | None = None,
    harmful_category_caps: Mapping[str, int] | None = None,
    twins_per_parent: int | None = None,
) -> dict[str, object]:
    """기존 세 위치 인자는 유지하고 선택 규칙만 키워드로 받아 뜻밖의 호출 해석 변경을 막는다."""
    settings = build_settings(seed, harmful_cap, harmful_category_caps, twins_per_parent)
    manifest_path = harmful_path.with_name(f"{harmful_path.name}.manifest.json")
    ensure_outputs_absent([harmful_path, allow_path, manifest_path])
    ensure_distinct_run_names(run_directories)
    harmful, allow = materialize_runs(run_directories, settings)
    report = build_report(harmful, allow, run_directories, settings)
    publish(harmful_path, allow_path, manifest_path, harmful.rows, allow.rows, report)
    return report


def ensure_distinct_run_names(run_directories: Sequence[Path]) -> None:
    """실행 이름이 id 접두사이므로 같은 이름을 허용하면 서로 다른 원본 id가 충돌한다."""
    names = [run.name for run in run_directories]
    if len(names) != len(set(names)):
        raise ValueError("--runs에 이름이 같은 디렉터리가 두 번 있습니다. 실행 디렉터리 이름은 서로 달라야 합니다.")


def describe_inputs(paths: Sequence[Path]) -> list[dict[str, str]]:
    """원문 대신 파일 이름과 해시만 남겨 어떤 입력으로 만들었는지 내용 노출 없이 확인하게 한다."""
    return [{"file_name": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in paths]


def build_report(
    harmful: Materialized,
    allow: Materialized,
    run_directories: Sequence[Path],
    settings: MaterializeSettings,
) -> dict[str, object]:
    """선택·탈락 수와 재현 설정만 기록해 manifest가 입력 문장을 복제하지 않게 한다."""
    merged_files = merged_input_paths(run_directories)
    kept_files = [path for run in run_directories for path in sorted(run.glob("kept-*.jsonl"))]
    return {
        "harmful": harmful_report(harmful),
        "allow": allow_report(allow, harmful, settings.twins_per_parent),
        "settings": settings.as_dict(),
        "near_duplicate_jaccard": NEAR_DUPLICATE_JACCARD,
        "inputs": describe_inputs(kept_files),
        "merged": describe_inputs(merged_files),
    }


def merged_input_paths(run_directories: Sequence[Path]) -> list[Path]:
    """두 라벨 입력을 실행별 같은 순서로 해시해 기존 manifest 출처 배열과 호환되게 한다."""
    names = ("accepted-harmful.jsonl", "accepted-allow.jsonl")
    return [run / "merged" / name for run in run_directories for name in names]


def harmful_report(result: Materialized) -> dict[str, object]:
    """상한 탈락을 범주별로 보여 실제 수락 수가 계획보다 작은 이유를 구분하게 한다."""
    return {
        "rows": len(result.rows),
        "by_category": dict(sorted(result.categories.items())),
        "near_duplicates": result.near_duplicates,
        "over_cap": dict(sorted(result.over_cap.items())),
    }


def allow_report(result: Materialized, harmful: Materialized, twins_per_parent: int | None) -> dict[str, object]:
    """허용 종류와 twin 탈락 이유를 분리해 경계 행이 부모 상한에 섞이지 않게 한다."""
    report: dict[str, object] = {
        "rows": len(result.rows),
        "by_category": dict(sorted(result.categories.items())),
        "near_duplicates": result.near_duplicates,
        "by_kind": dict(sorted(result.kinds.items())),
        "twins_without_parent": result.twins_without_parent,
        "twins_over_limit": result.twins_over_limit,
    }
    if twins_per_parent is not None:
        report["parents_by_twin_count"] = twin_count_distribution(harmful, result, twins_per_parent)
    return report


def twin_count_distribution(harmful: Materialized, allow: Materialized, limit: int) -> dict[str, int]:
    """0부터 상한까지 모두 내어 twin이 하나도 없는 부모도 집계에서 사라지지 않게 한다."""
    counts = Counter(allow.twins_by_parent.get(row["id"], 0) for row in harmful.rows)
    return {str(twin_count): counts[twin_count] for twin_count in range(limit + 1)}


def publish(
    harmful_path: Path,
    allow_path: Path,
    manifest_path: Path,
    harmful: Sequence[Mapping[str, str]],
    allow: Sequence[Mapping[str, str]],
    report: Mapping[str, object],
) -> None:
    """세 파일 중 하나라도 실패하면 이번 호출의 앞선 파일을 지워 불완전한 묶음을 남기지 않는다."""
    created: list[Path] = []
    try:
        for path, rows in ((harmful_path, harmful), (allow_path, allow)):
            write_jsonl_exclusive(path, rows)
            created.append(path)
        write_json_exclusive(manifest_path, report)
    except BaseException:
        for path in created:
            path.unlink(missing_ok=True)
        raise


def nonnegative_integer(value: str) -> int:
    """음수 개수는 의미가 없으므로 argparse가 옵션 이름과 함께 명확히 실패하게 한다."""
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("0 이상의 정수여야 합니다.") from error
    if parsed < 0:
        raise argparse.ArgumentTypeError("0 이상의 정수여야 합니다.")
    return parsed


def parse_category_cap(value: str) -> tuple[str, int]:
    """CATEGORY=N 형식을 엄격히 검사해 오타 난 재정의가 기본 상한으로 조용히 대체되지 않게 한다."""
    category, separator, raw_cap = value.partition("=")
    if not separator or not category.strip() or not raw_cap.strip():
        raise argparse.ArgumentTypeError("CATEGORY=N 형식이어야 하며 CATEGORY와 N을 모두 써야 합니다.")
    try:
        cap = nonnegative_integer(raw_cap.strip())
    except argparse.ArgumentTypeError as error:
        raise argparse.ArgumentTypeError("CATEGORY=N 형식에서 N은 0 이상의 정수여야 합니다.") from error
    return category.strip(), cap


def build_parser() -> argparse.ArgumentParser:
    """선택 규칙을 명시적 옵션으로 받아 같은 실행을 manifest 설정만으로 재현할 수 있게 한다."""
    parser = argparse.ArgumentParser(prog="python -m zg_datagen.materialize", description="합의한 생성 문장을 학습 입력({id, text})으로 만든다")
    parser.add_argument("--runs", type=Path, nargs="+", required=True, help="실행 디렉터리들(각각 kept-*.jsonl과 merged/를 담음). 순서대로 받는다")
    parser.add_argument("--out-harmful", type=Path, required=True)
    parser.add_argument("--out-allow", type=Path, required=True)
    parser.add_argument("--seed", type=int, help="라벨별 선택 순서를 재현하는 시드")
    parser.add_argument("--harmful-cap", type=nonnegative_integer, help="유해 범주마다 받을 기본 최대 행 수")
    parser.add_argument("--harmful-cap-category", type=parse_category_cap, action="append", default=[], metavar="CATEGORY=N")
    parser.add_argument("--twins-per-parent", type=nonnegative_integer, help="수락된 유해 부모마다 받을 twin 최대 행 수")
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    """원문 대신 라벨별 집계와 재현 설정만 표준 출력에 내어 실행 기록을 안전하게 남긴다."""
    arguments = build_parser().parse_args(argv)
    report = run_materialize(
        arguments.runs,
        arguments.out_harmful,
        arguments.out_allow,
        seed=arguments.seed,
        harmful_cap=arguments.harmful_cap,
        harmful_category_caps=dict(arguments.harmful_cap_category),
        twins_per_parent=arguments.twins_per_parent,
    )
    keys = ("harmful", "allow", "settings")
    print(json.dumps({key: report[key] for key in keys}, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
