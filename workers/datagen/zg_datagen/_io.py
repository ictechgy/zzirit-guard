"""민감한 생성 문장을 덮어쓰거나 넓은 권한으로 남기지 않기 위한 공통 입출력 경계다."""

from __future__ import annotations

import json
import os
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

OUTPUT_MODE = 0o600


def ensure_outputs_absent(paths: Sequence[Path]) -> None:
    """기존 결과가 하나라도 있으면 전체 작업을 막아 서로 다른 실행이 섞이지 않게 한다."""
    existing = next((path for path in paths if path.exists()), None)
    if existing is not None:
        raise FileExistsError(f"{existing}: 출력이 이미 있습니다. 기존 결과를 보존하고 새 경로를 지정하세요.")
    missing_parent = next((path.parent for path in paths if not path.parent.is_dir()), None)
    if missing_parent is not None:
        raise FileNotFoundError(f"{missing_parent}: 출력 디렉터리가 없습니다. 디렉터리를 먼저 만드세요.")


def write_text_exclusive(path: Path, content: str) -> None:
    """배타 생성과 0600 권한을 함께 적용해 검사와 쓰기 사이의 덮어쓰기 경쟁을 막는다."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, OUTPUT_MODE)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def jsonl_text(records: Iterable[Mapping[str, object]]) -> str:
    """한 줄 단위 복구가 가능하도록 JSON 객체를 개행으로 구분하고 마지막 개행도 고정한다."""
    lines = [json.dumps(record, ensure_ascii=False, sort_keys=True) for record in records]
    return "" if not lines else "\n".join(lines) + "\n"


def write_jsonl_exclusive(path: Path, records: Iterable[Mapping[str, object]]) -> None:
    """민감한 레코드가 기본 파일 생성 권한을 따르지 않도록 보안 쓰기 함수를 한곳에서 쓴다."""
    write_text_exclusive(path, jsonl_text(records))


def write_json_exclusive(path: Path, value: Mapping[str, object]) -> None:
    """집계 파일도 실행 출처를 드러낼 수 있어 데이터 파일과 같은 권한과 덮어쓰기 규칙을 쓴다."""
    write_text_exclusive(path, json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    """줄 번호만 든 오류를 내어 잘못된 입력은 찾되 민감한 문장 자체는 오류에 노출하지 않는다."""
    if not path.is_file():
        raise FileNotFoundError(f"{path}: 입력 파일이 없습니다. 경로를 확인하세요.")
    records: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if line.strip():
                records.append(parse_object(line, path, line_number))
    return records


def parse_object(line: str, path: Path, line_number: int) -> dict[str, Any]:
    """객체가 아닌 JSON은 필드 검증을 우회하므로 입력 위치만 알리고 즉시 거부한다."""
    try:
        value = json.loads(line)
    except json.JSONDecodeError as error:
        raise ValueError(f"{path.name}:{line_number}: JSON 객체가 아닙니다. 한 줄에 객체 하나로 고치세요.") from error
    if not isinstance(value, dict):
        raise ValueError(f"{path.name}:{line_number}: JSON 객체가 아닙니다. 한 줄에 객체 하나로 고치세요.")
    return value


def require_string(record: Mapping[str, object], field: str, location: str) -> str:
    """빈 문자열은 식별과 판정을 망가뜨리므로 경계에서 구체적인 필드 이름으로 거부한다."""
    value = record.get(field)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{location}: {field}는 비어 있지 않은 문자열이어야 합니다. 입력을 고치세요.")
    return value
