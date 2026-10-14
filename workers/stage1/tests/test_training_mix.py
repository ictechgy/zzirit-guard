"""training_mix 모듈 테스트: 허용 문장 형식, 평가셋 겹침 차단, 유해 줄이기, 학습 파일·manifest 생성."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.conftest import write_jsonl
from zg_stage1.data import LabeledText, load_labeled_texts
from zg_stage1.errors import DatasetFormatError, OutputExistsError, OutputLocationError
from zg_stage1.training_mix import (
    MixSettings,
    build_training_rows,
    count_binary_labels,
    downsample_toxic,
    ensure_no_evaluation_overlap,
    hard_negative_rows,
    load_hard_negatives,
    main,
)


def hard_negative(identifier: str, text: str, **overrides: str) -> dict:
    """학습용 허용 문장 한 줄(작성자≠검토자)."""
    record = {"id": identifier, "label": "allow", "category": "friendly_profanity", "family": "fp-test", "author": "model-a", "reviewer": "model-b"}
    record["text"] = text
    record.update(overrides)
    return record


def labeled(identifier: str, label: str) -> LabeledText:
    """K-HATERS 레코드(문장은 자리표시자)."""
    return LabeledText(identifier, f"문장{identifier}", label, 0 if label == "normal" else 1)


def test_loads_hard_negatives(tmp_path: Path) -> None:
    """올바른 줄을 읽는다."""
    path = write_jsonl(tmp_path / "hn.jsonl", [hard_negative("1", "와 개잘하네"), hard_negative("2", "적팀 다 잡자", category="game_combat")])
    assert [(item.item_id, item.category) for item in load_hard_negatives(path)] == [("1", "friendly_profanity"), ("2", "game_combat")]


@pytest.mark.parametrize(
    ("overrides", "message"),
    [({"label": "harmful"}, "allow여야"), ({"category": "abuse"}, "허용 유형"), ({"reviewer": "model-a"}, "작성자와 검토자")],
)
def test_rejects_invalid_hard_negatives(tmp_path: Path, overrides: dict, message: str) -> None:
    """유해 라벨, 허용 유형이 아닌 범주, 같은 작성자·검토자는 오류다."""
    path = write_jsonl(tmp_path / "hn.jsonl", [hard_negative("1", "문장", **overrides)])
    with pytest.raises(DatasetFormatError, match=message):
        load_hard_negatives(path)


def test_rejects_duplicate_ids(tmp_path: Path) -> None:
    """id가 겹치면 오류다."""
    path = write_jsonl(tmp_path / "hn.jsonl", [hard_negative("1", "가나다"), hard_negative("1", "라마바")])
    with pytest.raises(DatasetFormatError, match="id가 겹칩니다"):
        load_hard_negatives(path)


def test_blocks_overlap_with_evaluation_sets(tmp_path: Path) -> None:
    """평가셋 문장과 같은 학습 문장은 막는다. 겹치지 않는 문장은 통과한다."""
    eval_record = {"id": "d1", "split": "dev", "label": "allow", "category": "long_normal", "family": "x", "author": "a", "reviewer": "b"}
    eval_path = write_jsonl(tmp_path / "dev.jsonl", [eval_record | {"text": "오늘 방송 몇시까지"}])
    items = load_hard_negatives(write_jsonl(tmp_path / "hn.jsonl", [hard_negative("1", "오늘 방송 몇 시까지?")]))
    with pytest.raises(DatasetFormatError, match="평가셋과 겹칩니다"):
        ensure_no_evaluation_overlap(items, [eval_path])
    clean = load_hard_negatives(write_jsonl(tmp_path / "ok.jsonl", [hard_negative("2", "저녁 메뉴 추천해 주세요")]))
    ensure_no_evaluation_overlap(clean, [eval_path])


def test_committed_hard_negatives_do_not_overlap_evaluation_sets() -> None:
    """저장소의 학습용 허용 문장은 개발셋·보류셋·72문장과 겹치지 않는다."""
    from zg_stage1.training_mix import DEFAULT_HARD_NEGATIVES_PATH

    ensure_no_evaluation_overlap(load_hard_negatives(DEFAULT_HARD_NEGATIVES_PATH))


def test_downsample_toxic_keeps_all_normals_and_order() -> None:
    """정상 2건·유해 6건에서 유해 비율 0.5면 유해 2건만 남기고, 원래 순서를 지킨다."""
    labels = ["offensive", "normal", "L1_hate", "L2_hate", "normal", "offensive", "offensive", "L2_hate"]
    records = [labeled(str(index), label) for index, label in enumerate(labels)]
    kept = downsample_toxic(records, 0.5, seed=1)
    assert count_binary_labels([{"label": record.original_label} for record in kept]) == {"normal": 2, "toxic": 2}
    assert [int(record.record_id) for record in kept] == sorted(int(record.record_id) for record in kept)
    assert downsample_toxic(records, 0.5, seed=1) == kept


def test_downsample_does_not_add_toxic() -> None:
    """이미 목표보다 유해가 적으면 그대로 둔다."""
    records = [labeled("1", "normal"), labeled("2", "normal"), labeled("3", "offensive")]
    assert downsample_toxic(records, 0.5, seed=1) == records


def test_hard_negative_rows_repeat_with_unique_ids(tmp_path: Path) -> None:
    """반복마다 id가 다르고 라벨은 normal이다."""
    items = load_hard_negatives(write_jsonl(tmp_path / "hn.jsonl", [hard_negative("1", "가나다")]))
    rows = hard_negative_rows(items, 2)
    assert [row["id"] for row in rows] == ["hn-1-0", "hn-1-1"] and {row["label"] for row in rows} == {"normal"}
    assert hard_negative_rows(items, 0) == []


def test_build_training_rows_appends_hard_negatives(tmp_path: Path) -> None:
    """K-HATERS(유해를 줄인 것) 뒤에 허용 문장이 붙는다."""
    items = load_hard_negatives(write_jsonl(tmp_path / "hn.jsonl", [hard_negative("1", "가나다")]))
    records = [labeled("1", "normal"), labeled("2", "offensive"), labeled("3", "offensive")]
    rows = build_training_rows(records, items, MixSettings(toxic_fraction=0.5, extra_repeat=1, seed=1))
    assert count_binary_labels(rows) == {"normal": 2, "toxic": 1}
    assert rows[-1]["id"] == "hn-1-0"


def test_cli_writes_training_file_and_manifest(tmp_path: Path, khaters_records: list[dict]) -> None:
    """CLI는 K-HATERS 형식의 학습 파일과 manifest를 쓰고, 학습 로더로 다시 읽힌다. 같은 경로는 덮어쓰지 않는다."""
    khaters = write_jsonl(tmp_path / "train.jsonl", khaters_records)
    hard_records = [hard_negative("1", "테스트용 첫째 문장 크앙"), hard_negative("2", "테스트용 둘째 문장 뿌잉", category="game_combat")]
    hard = write_jsonl(tmp_path / "hn.jsonl", hard_records)
    out = tmp_path / "mix" / "train-mix.jsonl"
    arguments = ["--out", str(out), "--khaters-train", str(khaters), "--hard-negatives", str(hard), "--extra-repeat", "2"]
    main(arguments, environment={})
    records = load_labeled_texts(out)
    assert sum(1 for record in records if record.record_id.startswith("hn-")) == 4
    manifest = json.loads(out.with_suffix(".manifest.json").read_text(encoding="utf-8"))
    assert manifest["settings"]["extra_repeat"] == 2 and manifest["counts"]["normal"] + manifest["counts"]["toxic"] == len(records)
    assert "크앙" not in json.dumps(manifest, ensure_ascii=False)
    with pytest.raises(OutputExistsError):
        main(arguments, environment={})


def test_cli_refuses_output_inside_repository(tmp_path: Path, khaters_records: list[dict]) -> None:
    """학습 파일(데이터 원문)을 저장소 안에 쓰지 않는다."""
    khaters = write_jsonl(tmp_path / "train.jsonl", khaters_records)
    hard = write_jsonl(tmp_path / "hn.jsonl", [hard_negative("1", "테스트용 첫째 문장 크앙")])
    inside = Path(__file__).resolve().parent / "should-not-exist.jsonl"
    with pytest.raises(OutputLocationError):
        main(["--out", str(inside), "--khaters-train", str(khaters), "--hard-negatives", str(hard)], environment={})
    assert not inside.exists()
