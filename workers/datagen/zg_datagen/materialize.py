"""두 라벨러가 합의한 문장만 원문과 다시 이어 학습 파일 입력({id, text})으로 만든다.

왜 따로 두나: 합치기(labels merge)는 원문 없이 판정만 다루고, 학습 파일 도구(zg_stage1.training_mix)는 {id, text}만 받는다.
이 단계가 둘을 잇는다. 유해는 두 라벨러가 같은 유해 범주로 본 문장 모두(작성 의도와 범주가 달라도 유해다), 허용은 둘 다 허용으로 본
문장 모두(짝 허용·경계 허용·순화돼 허용이 된 유해 후보)다. 생성 문장끼리 거의 같은 문장은 하나만 남긴다(M2 2차 계획 3).
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from zg_datagen._io import ensure_outputs_absent, read_jsonl, require_string, write_json_exclusive, write_jsonl_exclusive
from zg_datagen.filters import normalize_for_matching

# 생성 문장끼리 이 값 이상이면 거의 같은 문장으로 보고 먼저 나온 것만 남긴다(계획 3의 0.7).
NEAR_DUPLICATE_JACCARD = 0.7
# 글자 n-gram 크기. 평가셋 겹침 검사(zg_stage1.chat_eval_data)와 같은 3-gram이다.
NGRAM_SIZE = 3


@dataclass
class NearDuplicateIndex:
    """이미 받은 문장의 3-gram 색인. 새 문장과 3-gram을 하나라도 나누는 문장만 비교해 전체 쌍 비교를 피한다."""

    grams: list[frozenset[str]] = field(default_factory=list)
    postings: dict[str, list[int]] = field(default_factory=dict)

    def is_near_duplicate(self, grams: frozenset[str]) -> bool:
        """새 문장이 받은 문장 중 하나와 자카드 0.7 이상이면 참이다."""
        candidates = {index for gram in grams for index in self.postings.get(gram, ())}
        return any(jaccard(grams, self.grams[index]) >= NEAR_DUPLICATE_JACCARD for index in candidates)

    def add(self, grams: frozenset[str]) -> None:
        """받은 문장을 색인에 넣는다."""
        position = len(self.grams)
        self.grams.append(grams)
        for gram in grams:
            self.postings.setdefault(gram, []).append(position)


def character_ngrams(text: str) -> frozenset[str]:
    """정규화한 문장의 글자 3-gram. 3글자보다 짧으면 문장 전체를 하나로 본다(짧은 문장끼리도 같으면 걸리게)."""
    normalized = normalize_for_matching(text)
    if len(normalized) < NGRAM_SIZE:
        return frozenset({normalized})
    return frozenset(normalized[index : index + NGRAM_SIZE] for index in range(len(normalized) - NGRAM_SIZE + 1))


def jaccard(first: frozenset[str], second: frozenset[str]) -> float:
    """두 3-gram 집합의 자카드 유사도."""
    union = first | second
    return len(first & second) / len(union) if union else 1.0


def load_texts(input_paths: Sequence[Path]) -> dict[str, str]:
    """생성 파일들(거르기를 통과한 kept)에서 id → 원문 표를 만든다. 같은 id가 두 번 나오면 어느 원문인지 모호해 오류다."""
    texts: dict[str, str] = {}
    for path in input_paths:
        for position, record in enumerate(read_jsonl(path), 1):
            location = f"{path.name}:{position}"
            identifier = require_string(record, "id", location)
            if identifier in texts:
                raise ValueError(f"{location}: id {identifier!r}가 다른 입력에도 있습니다. 같은 생성 실행을 두 번 주지 않았는지 확인하세요.")
            texts[identifier] = require_string(record, "text", location)
    return texts


def load_accepted(merged_directories: Sequence[Path], file_name: str) -> list[dict[str, object]]:
    """합치기 결과 디렉터리들에서 한 종류(유해·허용)의 채택 레코드를 순서대로 모은다."""
    records: list[dict[str, object]] = []
    for directory in merged_directories:
        path = directory / file_name
        if not path.is_file():
            raise FileNotFoundError(f"{path}: 합치기 결과가 없습니다. labels merge를 먼저 실행하세요.")
        records.extend(read_jsonl(path))
    return records


@dataclass
class Materialized:
    """학습 입력으로 낼 줄과 버린 수. 원문은 rows에만 있고 집계에는 넣지 않는다."""

    rows: list[dict[str, str]] = field(default_factory=list)
    categories: Counter[str] = field(default_factory=Counter)
    near_duplicates: int = 0


def materialize(records: Iterable[Mapping[str, object]], texts: Mapping[str, str], index: NearDuplicateIndex) -> Materialized:
    """채택 레코드를 원문과 잇고, 이미 받은 문장과 거의 같으면 버린다. 색인은 유해·허용이 함께 써 서로 겹치지 않게 한다."""
    result = Materialized()
    for record in records:
        identifier = require_string(record, "id", "merged")
        if identifier not in texts:
            raise ValueError(f"합치기 결과의 id {identifier!r}에 맞는 원문이 없습니다. 그 실행의 kept 파일을 --inputs에 넣으세요.")
        grams = character_ngrams(texts[identifier])
        if index.is_near_duplicate(grams):
            result.near_duplicates += 1
            continue
        index.add(grams)
        result.rows.append({"id": identifier, "text": texts[identifier]})
        result.categories[str(record.get("category"))] += 1
    return result


def describe_inputs(paths: Sequence[Path]) -> list[dict[str, str]]:
    """입력 파일 이름과 sha256(원문 없음). 어떤 생성·합치기 결과로 만든 학습 입력인지 확인하는 데 쓴다."""
    return [{"file_name": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in paths]


def run_materialize(merged_directories: Sequence[Path], input_paths: Sequence[Path], harmful_path: Path, allow_path: Path) -> dict[str, object]:
    """유해를 먼저, 허용을 나중에 이어 쓴다. 왜 유해 먼저인가: 거의 같은 두 문장이 유해·허용으로 갈리면 유해 쪽을 남겨 허용 쪽 지름길을 막는다."""
    manifest_path = harmful_path.with_name(f"{harmful_path.name}.manifest.json")
    ensure_outputs_absent([harmful_path, allow_path, manifest_path])
    texts = load_texts(input_paths)
    index = NearDuplicateIndex()
    harmful = materialize(load_accepted(merged_directories, "accepted-harmful.jsonl"), texts, index)
    allow = materialize(load_accepted(merged_directories, "accepted-allow.jsonl"), texts, index)
    report = build_report(harmful, allow, merged_directories, input_paths)
    publish(harmful_path, allow_path, manifest_path, harmful.rows, allow.rows, report)
    return report


def build_report(harmful: Materialized, allow: Materialized, merged_directories: Sequence[Path], input_paths: Sequence[Path]) -> dict[str, object]:
    """범주별 줄 수와 거의 같은 문장으로 버린 수, 입력 출처. 원문은 넣지 않는다."""
    merged_files = [directory / name for directory in merged_directories for name in ("accepted-harmful.jsonl", "accepted-allow.jsonl")]
    return {
        "harmful": {"rows": len(harmful.rows), "by_category": dict(sorted(harmful.categories.items())), "near_duplicates": harmful.near_duplicates},
        "allow": {"rows": len(allow.rows), "by_category": dict(sorted(allow.categories.items())), "near_duplicates": allow.near_duplicates},
        "near_duplicate_jaccard": NEAR_DUPLICATE_JACCARD,
        "inputs": describe_inputs(input_paths),
        "merged": describe_inputs(merged_files),
    }


def publish(
    harmful_path: Path,
    allow_path: Path,
    manifest_path: Path,
    harmful: Sequence[Mapping[str, str]],
    allow: Sequence[Mapping[str, str]],
    report: Mapping[str, object],
) -> None:
    """세 파일을 새로 쓴다. 중간에 실패하면 이번에 만든 파일만 지워, 짝이 맞지 않는 학습 입력이 남지 않게 한다."""
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


def build_parser() -> argparse.ArgumentParser:
    """합치기 결과 디렉터리들, 생성 kept 파일들, 두 출력 경로를 받는다."""
    parser = argparse.ArgumentParser(prog="python -m zg_datagen.materialize", description="합의한 생성 문장을 학습 입력({id, text})으로 만든다")
    parser.add_argument("--merged-dirs", type=Path, nargs="+", required=True, help="labels merge 출력 디렉터리들(순서대로 받는다)")
    parser.add_argument("--inputs", type=Path, nargs="+", required=True, help="그 실행들의 거르기 통과(kept) 파일")
    parser.add_argument("--out-harmful", type=Path, required=True)
    parser.add_argument("--out-allow", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    """집계만 JSON으로 출력한다(원문 없음)."""
    arguments = build_parser().parse_args(argv)
    report = run_materialize(arguments.merged_dirs, arguments.inputs, arguments.out_harmful, arguments.out_allow)
    print(json.dumps({key: report[key] for key in ("harmful", "allow")}, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
