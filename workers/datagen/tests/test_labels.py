"""블라인드 묶음과 이중 라벨 합의가 작성 의도를 새지 않고 정해진 판정만 받는지 확인한다."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from zg_datagen.labels import cohens_kappa, make_batches, merge_labels


def write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    """테스트 입력을 읽기 쉽게 만들되 제품 출력 경로와는 분리한다."""
    path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")


def test_batches_hide_kind_and_intended(tmp_path: Path) -> None:
    """라벨러가 생성 의도를 보면 그 값을 답으로 베낄 수 있으므로 문장과 임시 id만 공개한다."""
    source = tmp_path / "source.jsonl"
    write_jsonl(source, [{"id": "x", "kind": "harmful", "intended": "threat", "text": "중립 자리표시자"}])
    out = tmp_path / "batches"
    make_batches([source], 7, 100, out)
    visible = json.loads((out / "batch-001.jsonl").read_text(encoding="utf-8"))
    private = json.loads((out / "key.jsonl").read_text(encoding="utf-8"))
    assert visible == {"lid": "L00001", "text": "중립 자리표시자"}
    assert private == {"lid": "L00001", "id": "x", "kind": "harmful", "intended": "threat"}


def test_merge_agreement_logic_and_metrics(tmp_path: Path) -> None:
    """유해 범주까지 같은 항목과 허용 합의만 받고 나머지는 이유별로 보류해야 한다."""
    key = tmp_path / "key.jsonl"
    write_jsonl(
        key,
        [
            {"lid": "L00001", "id": "a", "kind": "harmful", "intended": "threat"},
            {"lid": "L00002", "id": "b", "kind": "harmful", "intended": "sexual"},
            {"lid": "L00003", "id": "c", "kind": "twin", "intended": "twin"},
            {"lid": "L00004", "id": "d", "kind": "boundary", "intended": "quote_report"},
        ],
    )
    a_dir, b_dir = tmp_path / "a", tmp_path / "b"
    a_dir.mkdir()
    b_dir.mkdir()
    write_jsonl(
        a_dir / "labels.jsonl",
        [
            {"lid": "L00001", "label": "harmful", "category": "threat"},
            {"lid": "L00002", "label": "harmful", "category": "sexual"},
            {"lid": "L00003", "label": "allow", "category": "short_normal"},
            {"lid": "L00004", "label": "ambiguous", "category": None},
        ],
    )
    write_jsonl(
        b_dir / "labels.jsonl",
        [
            {"lid": "L00001", "label": "harmful", "category": "threat"},
            {"lid": "L00002", "label": "allow", "category": "long_normal"},
            {"lid": "L00003", "label": "allow", "category": "long_normal"},
            {"lid": "L00004", "label": "allow", "category": "quote_report"},
        ],
    )
    out = tmp_path / "merged"
    report = merge_labels(key, a_dir, b_dir, out)
    assert len((out / "accepted-harmful.jsonl").read_text(encoding="utf-8").splitlines()) == 1
    allow = json.loads((out / "accepted-allow.jsonl").read_text(encoding="utf-8"))
    assert allow["category"] == "short_normal" and allow["labeler_b_category"] == "long_normal"
    reasons = [json.loads(line)["reason"] for line in (out / "rejected.jsonl").read_text(encoding="utf-8").splitlines()]
    assert reasons == ["disagree_label", "ambiguous"]
    false_accept = report["false_accept_rate"]
    assert isinstance(false_accept, dict)
    assert false_accept["sexual"] == 1.0


def test_kappa_matches_hand_calculation() -> None:
    """우연 일치 보정이 빠진 단순 일치율로 바뀌지 않도록 작은 수기로 계산 가능한 값을 고정한다."""
    assert cohens_kappa([True, True, False, False], [True, False, True, False]) == pytest.approx(0.0)


def test_label_validation_rejects_duplicates(tmp_path: Path) -> None:
    """한 lid를 두 번 판정하면 누락된 다른 lid를 가릴 수 있으므로 합치기 전에 거부한다."""
    key = tmp_path / "key.jsonl"
    write_jsonl(key, [{"lid": "L00001", "id": "a", "kind": "harmful", "intended": "threat"}])
    for name in ("a", "b"):
        directory = tmp_path / name
        directory.mkdir()
        write_jsonl(directory / "labels.jsonl", [{"lid": "L00001", "label": "allow", "category": "short_normal"}] * (2 if name == "a" else 1))
    with pytest.raises(ValueError, match="두 번"):
        merge_labels(key, tmp_path / "a", tmp_path / "b", tmp_path / "out")
