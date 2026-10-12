"""테스트 공용 도구: 작은 JSONL 파일을 임시 디렉터리에 만드는 함수.

모델 다운로드·네트워크 없이, 메모리에서 만든 몇 줄짜리 데이터로만 시험한다.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest


def write_jsonl(path: Path, records: list[dict]) -> Path:
    """records를 한 줄에 하나씩 JSON으로 써서 JSONL 파일을 만든다."""
    path.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records), encoding="utf-8")
    return path


@pytest.fixture
def khaters_records() -> list[dict]:
    """라벨 4종이 모두 들어 있는 K-HATERS 형식 레코드 6건(문장은 무해한 자리표시자)."""
    labels = ["normal", "offensive", "L1_hate", "L2_hate", "normal", "offensive"]
    return [{"id": index, "text": f"문장{index}", "label": label} for index, label in enumerate(labels)]
