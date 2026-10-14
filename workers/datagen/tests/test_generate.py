"""모델 없이 생성 파이프라인의 파싱·식별자·출력 안전성을 확인한다."""

from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from zg_datagen.generate import GenerationRequest, run_generation


class FakeGenerator:
    """고정 응답으로 외부 모델 변동 없이 파싱 경계를 검증한다."""

    def generate(self, messages: list[dict[str, str]], seed: int) -> str:
        """정상 두 줄과 잡음·과장 길이를 섞어 모든 분기를 한 호출에서 지난다."""
        del messages, seed
        return "\n".join(["안내문", '{"slots": {}, "text": "  중립 후보 가  "}', '{"text": "중립 후보 나"}', '{"text": "' + ("가" * 201) + '"}'])


def make_model(directory: Path) -> Path:
    """가중치 바이트만으로 생성기 식별자를 재현할 수 있게 최소 모델 디렉터리를 만든다."""
    directory.mkdir()
    (directory / "model.safetensors").write_bytes(b"weights")
    return directory


def test_generation_parses_counts_ids_manifest_and_modes(tmp_path: Path) -> None:
    """원문이 아닌 집계만 manifest에 남고 결과 두 파일이 개인 권한으로 생성돼야 한다."""
    out = tmp_path / "generated.jsonl"
    request = GenerationRequest("harmful", "threat", 2, 17, 2, out, make_model(tmp_path / "model"))
    summary = run_generation(request, FakeGenerator())
    rows = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    manifest = json.loads((tmp_path / "generated.jsonl.manifest.json").read_text(encoding="utf-8"))
    assert [row["id"] for row in rows] == ["gh-threat-00001", "gh-threat-00002"]
    assert summary["counts"] == manifest["counts"] == {"requested": 2, "parsed": 2, "non_json": 1, "too_long": 1}
    assert "text" not in manifest
    for path in (out, tmp_path / "generated.jsonl.manifest.json"):
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_generation_refuses_to_overwrite(tmp_path: Path) -> None:
    """기존 민감 데이터를 조용히 바꾸면 재현성을 잃으므로 출력 하나라도 있으면 시작하지 않는다."""
    out = tmp_path / "generated.jsonl"
    out.write_text("보존", encoding="utf-8")
    request = GenerationRequest("boundary", "quote_report", 1, 1, 2, out, make_model(tmp_path / "model"))
    with pytest.raises(FileExistsError):
        run_generation(request, FakeGenerator())
    assert out.read_text(encoding="utf-8") == "보존"


def test_twins_keep_parent_ids_and_boundary_uses_kind_id(tmp_path: Path) -> None:
    """대조쌍의 부모 연결과 경계 유형이 id에 남아야 원문을 보지 않고도 후속 할당을 감사할 수 있다."""
    model = make_model(tmp_path / "model")
    parents = tmp_path / "parents.jsonl"
    cell = {"category": "threat", "situation": "neutral", "length": "short", "register": "반말", "directness": "직접", "noise": "없음"}
    parent_rows = [
        {"id": "parent-a", "kind": "harmful", "intended": "threat", "cell": cell, "text": "중립 부모 가"},
        {"id": "parent-b", "kind": "harmful", "intended": "threat", "cell": cell, "text": "중립 부모 나"},
    ]
    parents.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in parent_rows) + "\n", encoding="utf-8")
    twin_out = tmp_path / "twins.jsonl"
    twin_request = GenerationRequest("twin", "twin", 3, 5, 2, twin_out, model, input_path=parents)
    twin_manifest = run_generation(twin_request, FakeGenerator())
    twins = [json.loads(line) for line in twin_out.read_text(encoding="utf-8").splitlines()]
    assert [row["id"] for row in twins] == [f"gt-{index:05d}" for index in range(1, 7)]
    assert [row["parent_id"] for row in twins] == ["parent-a"] * 3 + ["parent-b"] * 3
    twin_counts = twin_manifest["counts"]
    assert isinstance(twin_counts, dict)
    assert twin_counts["requested"] == 6

    boundary_out = tmp_path / "boundary.jsonl"
    boundary_request = GenerationRequest("boundary", "quote_report", 2, 9, 2, boundary_out, model)
    run_generation(boundary_request, FakeGenerator())
    boundary = json.loads(boundary_out.read_text(encoding="utf-8").splitlines()[0])
    assert boundary["id"] == "gb-quote_report-00001" and boundary["intended"] == "quote_report"
