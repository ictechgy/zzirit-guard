"""합의한 문장만 원문과 이어 학습 입력으로 내고, 거의 같은 문장은 하나만 남기는지 확인한다."""

from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from zg_datagen.materialize import character_ngrams, jaccard, run_materialize


def write_jsonl(path: Path, rows: list[dict[str, object]]) -> Path:
    """테스트 입력 파일을 만든다."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    return path


def merged_directory(root: Path, harmful: list[dict[str, object]], allow: list[dict[str, object]]) -> Path:
    """labels merge 출력과 같은 모양의 디렉터리."""
    write_jsonl(root / "accepted-harmful.jsonl", harmful)
    write_jsonl(root / "accepted-allow.jsonl", allow)
    return root


def read_rows(path: Path) -> list[dict[str, str]]:
    """출력 JSONL을 읽는다."""
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_joins_text_and_keeps_harmful_over_near_duplicate_allow(tmp_path: Path) -> None:
    """유해를 먼저 받아, 거의 같은 허용 문장은 버린다(같은 모양이 양쪽 라벨로 들어가 지름길이 되지 않게)."""
    kept = write_jsonl(
        tmp_path / "kept.jsonl",
        [
            {"id": "a", "text": "자리표시자 문장 하나 둘 셋"},
            {"id": "b", "text": "자리표시자 문장 하나 둘 셋!"},
            {"id": "c", "text": "전혀 다른 중립 문장"},
        ],
    )
    merged = merged_directory(
        tmp_path / "m1", [{"id": "a", "category": "threat"}], [{"id": "b", "category": "long_normal"}, {"id": "c", "category": "short_normal"}]
    )
    report = run_materialize([merged], [kept], tmp_path / "harmful.jsonl", tmp_path / "allow.jsonl")
    assert read_rows(tmp_path / "harmful.jsonl") == [{"id": "a", "text": "자리표시자 문장 하나 둘 셋"}]
    assert read_rows(tmp_path / "allow.jsonl") == [{"id": "c", "text": "전혀 다른 중립 문장"}]
    assert report["allow"] == {"rows": 1, "by_category": {"short_normal": 1}, "near_duplicates": 1}
    assert stat.S_IMODE((tmp_path / "harmful.jsonl").stat().st_mode) == 0o600
    assert "자리표시자" not in json.dumps(report, ensure_ascii=False)


def test_missing_text_duplicate_ids_and_existing_outputs_are_errors(tmp_path: Path) -> None:
    """원문 없는 id, 입력 사이 같은 id, 이미 있는 출력은 모두 오류다."""
    kept = write_jsonl(tmp_path / "kept.jsonl", [{"id": "a", "text": "중립"}])
    merged = merged_directory(tmp_path / "m1", [{"id": "zz", "category": "threat"}], [])
    with pytest.raises(ValueError, match="원문이 없습니다"):
        run_materialize([merged], [kept], tmp_path / "h.jsonl", tmp_path / "a.jsonl")
    twice = write_jsonl(tmp_path / "kept2.jsonl", [{"id": "a", "text": "중립"}])
    with pytest.raises(ValueError, match="다른 입력에도"):
        run_materialize([merged], [kept, twice], tmp_path / "h2.jsonl", tmp_path / "a2.jsonl")
    (tmp_path / "h3.jsonl").write_text("", encoding="utf-8")
    with pytest.raises(FileExistsError):
        run_materialize([merged], [kept], tmp_path / "h3.jsonl", tmp_path / "a3.jsonl")


def test_ngram_similarity_uses_matching_normalization() -> None:
    """공백·문장부호·폭 없는 문자 차이는 같은 문장으로 본다."""
    assert jaccard(character_ngrams("가나다 라마"), character_ngrams("가나다라마!​")) == 1.0
    assert jaccard(character_ngrams("가나"), character_ngrams("가나")) == 1.0
