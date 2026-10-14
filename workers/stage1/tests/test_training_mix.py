"""training_mix 모듈 테스트: 허용 문장 형식·판(version), 평가셋 겹침 차단·제외, 유해 줄이기, 학습 파일·manifest 생성."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from tests.conftest import write_jsonl
from zg_stage1.data import LabeledText, load_labeled_texts
from zg_stage1.errors import DatasetFormatError, OutputExistsError, OutputLocationError
from zg_stage1.chat_eval_data import OverlapFinding
from zg_stage1.training_mix import (
    DEFAULT_HARD_NEGATIVES_PATH,
    HARD_NEGATIVE_VERSIONS,
    MixSettings,
    build_training_rows,
    count_binary_labels,
    describe_excluded_overlap,
    downsample_toxic,
    ensure_no_evaluation_overlap,
    exclude_evaluation_overlaps,
    hard_negative_rows,
    load_evaluation_references,
    load_hard_negative_version,
    load_hard_negatives,
    main,
    manifest_path_for,
    write_training_outputs,
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


def write_eval_set(tmp_path: Path, text: str) -> Path:
    """문장 하나짜리 개발셋 파일."""
    record = {"id": "d1", "split": "dev", "label": "allow", "category": "long_normal", "family": "x", "author": "a", "reviewer": "b", "text": text}
    return write_jsonl(tmp_path / "dev.jsonl", [record])


def test_blocks_overlap_with_evaluation_sets(tmp_path: Path) -> None:
    """평가셋 문장과 같은 학습 문장은 막는다. 겹치지 않는 문장은 통과한다."""
    references = load_evaluation_references([write_eval_set(tmp_path, "오늘 방송 몇시까지")])
    items = load_hard_negatives(write_jsonl(tmp_path / "hn.jsonl", [hard_negative("1", "오늘 방송 몇 시까지?")]))
    with pytest.raises(DatasetFormatError, match="평가셋과 겹칩니다"):
        ensure_no_evaluation_overlap(items, references)
    clean = load_hard_negatives(write_jsonl(tmp_path / "ok.jsonl", [hard_negative("2", "저녁 메뉴 추천해 주세요")]))
    ensure_no_evaluation_overlap(clean, references)


def test_excludes_khaters_rows_that_overlap_evaluation_sets(tmp_path: Path) -> None:
    """K-HATERS에서 평가 문장과 같은 줄은 빼고, 뺀 줄의 id와 평가 문장 id를 돌려준다. 순서는 지킨다."""
    references = load_evaluation_references([write_eval_set(tmp_path, "오늘 방송 몇시까지")])
    texts = [("1", "전혀 다른 문장이다", "normal"), ("2", "오늘 방송 몇 시까지!!", "normal"), ("3", "또 다른 문장", "offensive")]
    records = [LabeledText(identifier, text, label, 0 if label == "normal" else 1) for identifier, text, label in texts]
    kept, excluded = exclude_evaluation_overlaps(records, references)
    assert [record.record_id for record in kept] == ["1", "3"]
    assert [(finding.item_id, finding.reference_id) for finding in excluded] == [("2", "d1")]


@pytest.mark.parametrize("version_name", sorted(HARD_NEGATIVE_VERSIONS))
def test_committed_hard_negative_versions_load_and_do_not_overlap(version_name: str) -> None:
    """저장소 허용 문장의 각 판은 기록한 줄 수·sha256과 맞고, 개발셋·보류셋·72문장과 겹치지 않는다."""
    items = load_hard_negative_version(version_name)
    assert len(items) == HARD_NEGATIVE_VERSIONS[version_name].line_count
    ensure_no_evaluation_overlap(items, load_evaluation_references())


def test_hard_negative_version_detects_edited_prefix(tmp_path: Path) -> None:
    """판의 앞쪽 줄이 바뀌면 오류다. 그 판으로 학습한 모델을 다시 만들 수 없게 되기 때문이다."""
    lines = DEFAULT_HARD_NEGATIVES_PATH.read_text(encoding="utf-8").splitlines(keepends=True)
    edited = write_jsonl(tmp_path / "hn.jsonl", [hard_negative("x", "바꾼 첫 줄")])
    edited.write_text(edited.read_text(encoding="utf-8") + "".join(lines[1:]), encoding="utf-8")
    with pytest.raises(DatasetFormatError, match="sha256"):
        load_hard_negative_version("v1", edited)


def test_downsample_none_keeps_khaters_ratio() -> None:
    """유해 비율 목표가 없으면 그대로 둔다."""
    records = [labeled("1", "normal"), labeled("2", "offensive"), labeled("3", "offensive")]
    assert downsample_toxic(records, None, seed=1) == records


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
    manifest = json.loads(manifest_path_for(out).read_text(encoding="utf-8"))
    assert manifest["settings"]["extra_repeat"] == 2 and manifest["counts"]["normal"] + manifest["counts"]["toxic"] == len(records)
    assert manifest["excluded_khaters_overlaps"] == [] and "version" not in manifest["inputs"]["hard_negatives"]
    assert "크앙" not in json.dumps(manifest, ensure_ascii=False)
    with pytest.raises(OutputExistsError):
        main(arguments, environment={})


def test_cli_uses_committed_version_by_default(tmp_path: Path, khaters_records: list[dict]) -> None:
    """--hard-negatives가 없으면 저장소 파일의 v1을 쓰고, manifest에 판과 그 sha256을 남긴다. 유해 비율은 그대로다."""
    khaters = write_jsonl(tmp_path / "train.jsonl", khaters_records)
    out = tmp_path / "train-default.jsonl"
    main(["--out", str(out), "--khaters-train", str(khaters), "--extra-repeat", "1"], environment={})
    manifest = json.loads(manifest_path_for(out).read_text(encoding="utf-8"))
    assert manifest["inputs"]["hard_negatives"]["version"] == "v1"
    assert manifest["inputs"]["hard_negatives"]["selected_sha256"] == HARD_NEGATIVE_VERSIONS["v1"].sha256
    assert manifest["settings"]["toxic_fraction"] is None
    assert manifest["counts"] == {"normal": 2 + HARD_NEGATIVE_VERSIONS["v1"].line_count, "toxic": 4}


def test_cli_refuses_existing_manifest(tmp_path: Path, khaters_records: list[dict]) -> None:
    """학습 파일이 없어도 manifest가 이미 있으면 거부한다. 확장자만 다른 학습 파일은 manifest를 따로 쓴다."""
    khaters = write_jsonl(tmp_path / "train.jsonl", khaters_records)
    hard = write_jsonl(tmp_path / "hn.jsonl", [hard_negative("1", "테스트용 첫째 문장 크앙")])
    out = tmp_path / "mix.jsonl"
    manifest_path_for(out).write_text("{}", encoding="utf-8")
    with pytest.raises(OutputExistsError):
        main(["--out", str(out), "--khaters-train", str(khaters), "--hard-negatives", str(hard)], environment={})
    other = tmp_path / "mix.data"
    main(["--out", str(other), "--khaters-train", str(khaters), "--hard-negatives", str(hard)], environment={})
    assert manifest_path_for(other).exists() and manifest_path_for(out).read_text(encoding="utf-8") == "{}"


def test_cli_refuses_output_inside_repository(tmp_path: Path, khaters_records: list[dict]) -> None:
    """학습 파일(데이터 원문)을 저장소 안에 쓰지 않는다."""
    khaters = write_jsonl(tmp_path / "train.jsonl", khaters_records)
    hard = write_jsonl(tmp_path / "hn.jsonl", [hard_negative("1", "테스트용 첫째 문장 크앙")])
    inside = Path(__file__).resolve().parent / "should-not-exist.jsonl"
    with pytest.raises(OutputLocationError):
        main(["--out", str(inside), "--khaters-train", str(khaters), "--hard-negatives", str(hard)], environment={})
    assert not inside.exists()


def test_manifest_keeps_safe_ids_and_hashes_others() -> None:
    """뺀 K-HATERS 줄의 id는 짧은 영숫자면 그대로, 문장·경로 모양이면 sha256 앞 16자로 적는다. 평가 문장 id는 그대로다."""
    path_shaped = "/Users/<사용자>/train.jsonl"
    findings = [OverlapFinding("12391", "dev-0491", 1.0), OverlapFinding("감사합니다 정말", "d1", 0.9), OverlapFinding(path_shaped, "d2", 1.0)]
    described = [describe_excluded_overlap(finding) for finding in findings]
    assert described[0] == {"item_id": "12391", "reference_id": "dev-0491", "similarity": 1.0}
    assert all(record["item_id"].startswith("sha256:") and len(record["item_id"]) == 23 for record in described[1:])
    assert "감사" not in json.dumps(described, ensure_ascii=False) and "Users" not in json.dumps(described)


def staged_or_published_files(directory: Path) -> list[str]:
    """디렉터리에 남은 파일 이름(정렬)."""
    return sorted(path.name for path in directory.iterdir())


def test_failure_between_publishes_removes_both_outputs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """학습 파일을 넣은 뒤 manifest를 넣다 실패하면, 이번에 만든 학습 파일과 임시 파일을 모두 지우고 오류를 올린다."""
    real_link = os.link
    calls: list[str] = []

    def link_then_fail(source: str | os.PathLike[str], destination: str | os.PathLike[str]) -> None:
        calls.append(str(destination))
        if len(calls) == 2:
            raise OSError(28, "No space left on device")
        real_link(source, destination)

    monkeypatch.setattr(os, "link", link_then_fail)
    with pytest.raises(OSError, match="No space"):
        write_training_outputs(tmp_path / "mix.jsonl", [{"id": "1", "text": "가", "label": "normal"}], MixSettings(None, 1, 1), {}, [])
    assert len(calls) == 2 and staged_or_published_files(tmp_path) == []


def test_publish_does_not_overwrite_existing_output(tmp_path: Path) -> None:
    """시작할 때 확인한 뒤에 같은 이름의 학습 파일이 생겨도 덮어쓰지 않는다. 그 파일은 그대로 두고 이번 실행의 파일만 지운다."""
    existing = tmp_path / "mix.jsonl"
    existing.write_text("앞선 학습 파일\n", encoding="utf-8")
    with pytest.raises(FileExistsError):
        write_training_outputs(existing, [{"id": "1", "text": "가", "label": "normal"}], MixSettings(None, 1, 1), {}, [])
    assert existing.read_text(encoding="utf-8") == "앞선 학습 파일\n" and staged_or_published_files(tmp_path) == ["mix.jsonl"]
