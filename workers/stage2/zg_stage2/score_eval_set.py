"""채팅 평가셋 전체를 운영 워커와 같은 kanana 분류기로 채점한다.

문장 원문은 결과에 쓰지 않는다. 거절·중복·누락·잘못된 확률이 하나라도 있으면 모든 채점을 실패로 보고
출력 파일을 만들지 않는다. 완성된 JSON만 같은 디렉터리의 임시 파일에서 원자적으로 공개한다.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from zg_stage2.errors import EvaluationFormatError, OutputExistsError, Stage2Error
from zg_stage2.worker import compute_model_identifier, ensure_model_directory
from zg_stage2.worker_contract import ContractError, ItemVerdict, STAGE2_CATEGORIES, validate_identifier, validate_text, validate_verdict

CANDIDATE_THRESHOLD = 0.5
OUTPUT_FILE_MODE = 0o600


@dataclass(frozen=True)
class EvaluationItem:
    """평가 한 줄. text는 추론까지만 쓰고 결과에는 넣지 않는다."""

    item_id: str
    text: str


class EvaluationClassifier(Protocol):
    """평가가 classifier에서 쓰는 최소 표면. 무거운 mlx 모듈을 CLI 실행 전에는 불러오지 않기 위해서다."""

    fallback_count: int

    def classify_one(self, text: str) -> ItemVerdict:
        """한 문장의 워커 판정."""
        ...


def load_kanana(model_directory: Path) -> EvaluationClassifier:
    """실제로 채점할 때만 mlx 분류기를 불러온다. 도움말·입력 오류 경로는 GPU 초기화와 무관하게 동작한다."""
    from zg_stage2.classifier import load_kanana as load_classifier

    return load_classifier(model_directory)


def build_argument_parser() -> argparse.ArgumentParser:
    """CLI 인자."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage2.score_eval_set", description="kanana 워커와 같은 함수로 평가셋 전체 채점")
    parser.add_argument("--model-dir", type=Path, required=True, help="kanana-safeguard mlx 변환 모델 디렉터리")
    parser.add_argument("--eval-file", type=Path, required=True, help="id·text를 담은 평가 JSONL")
    parser.add_argument("--output", type=Path, required=True, help="새 결과 JSON 경로(기존 파일은 덮어쓰지 않음)")
    return parser


def parse_eval_line(line: str, location: str) -> EvaluationItem:
    """한 줄의 id·text를 워커 계약과 같은 제약으로 읽는다. 오류에는 위치만 넣고 원문은 숨긴다."""
    try:
        raw = json.loads(line)
    except json.JSONDecodeError as error:
        raise EvaluationFormatError(f"{location}: JSON 객체로 읽을 수 없습니다({error.msg}). 평가 JSONL을 다시 만드세요.") from error
    if not isinstance(raw, dict) or "id" not in raw:
        raise EvaluationFormatError(f"{location}: id가 없습니다. 모든 평가 줄에 고유한 문자열 id를 넣으세요.")
    try:
        identifier = validate_identifier(raw["id"])
    except ContractError as error:
        raise EvaluationFormatError(f"{location}: id 형식이 워커 계약과 다릅니다({error.code}). 안전한 고유 id로 고치세요.") from error
    try:
        text = validate_text(raw.get("text"))
    except ContractError as error:
        raise EvaluationFormatError(f"{location}: id {identifier!r}의 text가 워커 계약에서 거절됐습니다({error.code}).") from error
    return EvaluationItem(identifier, text)


def load_eval_items(path: Path) -> list[EvaluationItem]:
    """빈 줄을 제외한 모든 평가 줄을 읽고 id 완전성을 확인한다."""
    located = [
        (f"{path.name}:{number}", parse_eval_line(line, f"{path.name}:{number}"))
        for number, line in enumerate(path.read_text(encoding="utf-8").split("\n"), start=1)
        if line.strip()
    ]
    if not located:
        raise EvaluationFormatError(f"{path.name}: 평가 문장이 없습니다. id·text JSONL 경로를 확인하세요.")
    first_locations: dict[str, str] = {}
    for location, item in located:
        first = first_locations.setdefault(item.item_id, location)
        if first != location:
            raise EvaluationFormatError(f"{location}: id {item.item_id!r}가 {first}와 겹칩니다. 평가 id를 고유하게 고치세요.")
    return [item for _location, item in located]


def compute_file_sha256(path: Path) -> str:
    """큰 모델·평가 파일도 한 번에 메모리에 올리지 않고 sha256을 계산한다."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def score_items(classifier: EvaluationClassifier, items: Sequence[EvaluationItem]) -> dict[str, dict]:
    """한 줄씩 classify_one을 부르고 매번 워커 응답 계약을 검증한다."""
    scores: dict[str, dict] = {}
    for item in items:
        try:
            verdict = classifier.classify_one(item.text)
            validate_verdict(verdict, STAGE2_CATEGORIES)
        except (ContractError, ValueError) as error:
            reason = error.code if isinstance(error, ContractError) else str(error)
            raise EvaluationFormatError(f"id {item.item_id!r}: 2차 판정을 받지 못했습니다({reason}).") from error
        scores[item.item_id] = {"unsafe_probability": float(verdict.unsafe_probability), "category": verdict.category}
    return scores


def created_at() -> str:
    """기기 시간대와 무관한 UTC 시각."""
    return datetime.now(UTC).isoformat(timespec="seconds")


def ensure_output_absent(path: Path) -> None:
    """앞선 2차 점수 파일은 덮어쓰지 않는다."""
    if path.exists():
        raise OutputExistsError(f"{path.name}이 이미 있습니다. 앞선 2차 평가 점수를 지키려고 덮어쓰지 않습니다. 다른 --output을 주세요.")


def write_json_without_overwrite(path: Path, payload: dict) -> None:
    """같은 디렉터리의 완성된 임시 파일을 하드 링크로 한 번에 공개한다.

    하드 링크는 목적지가 이미 있으면 실패하므로, 사전 검사 뒤 생긴 파일도 덮어쓰지 않는다.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, OUTPUT_FILE_MODE)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
        try:
            os.link(temporary, path)
        except FileExistsError as error:
            raise OutputExistsError(f"{path.name}이 쓰는 동안 생겼습니다. 앞선 파일을 지키려고 덮어쓰지 않았습니다.") from error
    finally:
        temporary.unlink(missing_ok=True)


def build_report(model_directory: Path, eval_file: Path, classifier: EvaluationClassifier, scores: dict[str, dict]) -> dict:
    """원문 없이 모델·입력 지문과 모든 id별 판정을 만든다."""
    return {
        "model": {"directory_name": model_directory.name, "identifier": compute_model_identifier(model_directory)},
        "eval_file": {"name": eval_file.name, "sha256": compute_file_sha256(eval_file)},
        "candidate_threshold": CANDIDATE_THRESHOLD,
        "scores": scores,
        "prefix_fallbacks": classifier.fallback_count,
        "created_at": created_at(),
    }


def main(argv: Sequence[str] | None = None) -> None:
    """완전한 입력만 분류하고 모든 결과가 유효한 뒤에만 새 출력 파일을 공개한다."""
    arguments = build_argument_parser().parse_args(argv)
    ensure_output_absent(arguments.output)
    items = load_eval_items(arguments.eval_file)
    model_directory = ensure_model_directory(arguments.model_dir)
    classifier = load_kanana(model_directory)
    scores = score_items(classifier, items)
    write_json_without_overwrite(arguments.output, build_report(model_directory, arguments.eval_file, classifier, scores))
    print(f"평가 {len(items)}줄, 접두 fallback {classifier.fallback_count}건 → {arguments.output.name}")


def run_command_line() -> None:
    """입력·거절·모델 출력 오류를 원문 없는 한 줄로 알리고 0이 아닌 코드로 끝낸다."""
    try:
        main()
    except (Stage2Error, ContractError, ValueError) as error:
        message = error.code if isinstance(error, ContractError) else str(error)
        print(f"오류: {message}", file=sys.stderr)
        raise SystemExit(2) from error


if __name__ == "__main__":
    run_command_line()
