"""training_mix 모듈 테스트: 허용 문장 형식·판(version), 평가셋 겹침 차단·제외, 유해 줄이기, 학습 파일·manifest 생성."""

from __future__ import annotations

import errno
import json
import os
import stat
from pathlib import Path

import pytest

from tests.conftest import write_jsonl
from zg_stage1.chat_eval_data import OverlapFinding
from zg_stage1.data import LabeledText, describe_file_provenance, load_labeled_texts
from zg_stage1.errors import DatasetFormatError, OutputExistsError, OutputLocationError
from zg_stage1.training_mix import (
    DEFAULT_HARD_NEGATIVES_PATH,
    HARD_NEGATIVE_VERSIONS,
    OUTPUT_FILE_MODE,
    MixSettings,
    build_training_rows,
    count_binary_labels,
    describe_excluded_overlap,
    downsample_toxic,
    ensure_no_evaluation_overlap,
    exclude_evaluation_overlaps,
    hard_negative_rows,
    load_evaluation_references,
    load_generated_examples,
    load_hard_negative_version,
    load_hard_negatives,
    load_sealed_holdout_index,
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


def generated(identifier: str, text: str) -> dict:
    """생성 학습 문장 한 줄. 실제 유해 문장 대신 자리표시자만 쓴다."""
    return {"id": identifier, "text": text}


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


def eval_record(identifier: str, text: str, split: str = "holdout") -> dict:
    """봉인 제외 테스트용 평가 문장 한 줄. 원문 유출 검사를 위해 별도 id를 쓴다."""
    return {
        "id": identifier,
        "split": split,
        "label": "allow",
        "category": "long_normal",
        "family": identifier,
        "author": "model-a",
        "reviewer": "model-b",
        "text": text,
    }


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


@pytest.mark.parametrize(
    "records",
    [
        [generated("bad id", "노출되면 안 되는 자리표시자")],
        [generated("valid-id", "")],
        [generated("same-id", "첫 자리표시자"), generated("same-id", "둘째 자리표시자")],
    ],
)
def test_rejects_invalid_generated_lines_without_text(tmp_path: Path, records: list[dict]) -> None:
    """생성 파일의 id·빈 text·중복 id 오류는 위치와 해결책만 보이고 문장은 보이지 않는다."""
    path = write_jsonl(tmp_path / "generated.jsonl", records)
    with pytest.raises(DatasetFormatError) as raised:
        load_generated_examples(path)
    message = str(raised.value)
    assert "generated.jsonl:" in message and any(instruction in message for instruction in ("고치", "고유", "넣으세요"))
    assert all(record["text"] not in message for record in records if record["text"])


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
    assert not ({"generated_harmful", "generated_allow"} & manifest["inputs"].keys())
    assert "excluded_generated_overlaps" not in manifest and "sealed_holdout" not in manifest
    assert "크앙" not in json.dumps(manifest, ensure_ascii=False)
    with pytest.raises(OutputExistsError):
        main(arguments, environment={})


def test_cli_adds_generated_rows_repeats_and_provenance(tmp_path: Path, khaters_records: list[dict]) -> None:
    """생성 유해·허용 문장은 올바른 라벨과 고유 id로 반복되고, 입력별 출처와 반복 횟수가 남는다."""
    khaters = write_jsonl(tmp_path / "train.jsonl", khaters_records)
    hard = write_jsonl(tmp_path / "hn.jsonl", [hard_negative("1", "하드 네거티브 자리표시자")])
    harmful = write_jsonl(tmp_path / "harmful.jsonl", [generated("harm-1", "유해 자리표시자 알파")])
    allow = write_jsonl(tmp_path / "allow.jsonl", [generated("allow-1", "허용 자리표시자 베타")])
    out = tmp_path / "generated-mix.jsonl"
    main(
        [
            "--out",
            str(out),
            "--khaters-train",
            str(khaters),
            "--hard-negatives",
            str(hard),
            "--extra-repeat",
            "0",
            "--generated-harmful",
            str(harmful),
            "--generated-harmful-repeat",
            "2",
            "--generated-allow",
            str(allow),
            "--generated-allow-repeat",
            "3",
        ],
        environment={},
    )
    records = {record.record_id: record for record in load_labeled_texts(out)}
    assert [records[f"gh:harm-1-{copy}"].original_label for copy in range(2)] == ["offensive", "offensive"]
    assert [records[f"ga:allow-1-{copy}"].original_label for copy in range(3)] == ["normal", "normal", "normal"]
    manifest = json.loads(manifest_path_for(out).read_text(encoding="utf-8"))
    assert manifest["inputs"]["generated_harmful"] == describe_file_provenance(harmful) | {"repeat": 2}
    assert manifest["inputs"]["generated_allow"] == describe_file_provenance(allow) | {"repeat": 3}
    assert manifest["counts"] == {"normal": 5, "toxic": 6}


def test_cli_excludes_generated_evaluation_overlap_by_id(tmp_path: Path, khaters_records: list[dict], monkeypatch: pytest.MonkeyPatch) -> None:
    """공개 평가 참조와 겹친 생성 줄은 학습에서 빠지고 입력 id만 매니페스트에 남는다."""
    overlap_text = "평가 겹침 자리표시자 감마"
    references = load_evaluation_references([write_eval_set(tmp_path, overlap_text)])
    monkeypatch.setattr("zg_stage1.training_mix.load_evaluation_references", lambda: references)
    khaters = write_jsonl(tmp_path / "train.jsonl", khaters_records)
    hard = write_jsonl(tmp_path / "hn.jsonl", [hard_negative("1", "하드 네거티브 자리표시자")])
    harmful = write_jsonl(tmp_path / "harmful.jsonl", [generated("overlap-id", overlap_text), generated("kept-id", "남는 생성 자리표시자")])
    out = tmp_path / "overlap-mix.jsonl"
    main(
        [
            "--out",
            str(out),
            "--khaters-train",
            str(khaters),
            "--hard-negatives",
            str(hard),
            "--extra-repeat",
            "0",
            "--generated-harmful",
            str(harmful),
        ],
        environment={},
    )
    identifiers = {record.record_id for record in load_labeled_texts(out)}
    manifest = json.loads(manifest_path_for(out).read_text(encoding="utf-8"))
    assert "gh:overlap-id-0" not in identifiers and "gh:kept-id-0" in identifiers
    assert manifest["excluded_generated_overlaps"] == ["overlap-id"]


def test_cli_sealed_holdout_excludes_every_source_without_leaking_holdout(
    tmp_path: Path, khaters_records: list[dict], capsys: pytest.CaptureFixture[str]
) -> None:
    """봉인 겹침은 모든 출처에서 빠지되, 출력에는 학습 id와 출처별 건수만 남는다."""
    texts = [f"봉인 원문 자리표시자 {suffix}" for suffix in ("알파", "베타", "감마", "델타")]
    holdout_ids = [f"private-holdout-{index}" for index in range(4)]
    sealed = write_jsonl(tmp_path / "sealed.jsonl", [eval_record(identifier, text) for identifier, text in zip(holdout_ids, texts, strict=True)])
    khaters_records[0]["id"] = 101
    khaters_records[0]["text"] = texts[0]
    khaters = write_jsonl(tmp_path / "train.jsonl", khaters_records)
    hard = write_jsonl(tmp_path / "hn.jsonl", [hard_negative("sealed-hn", texts[1]), hard_negative("kept-hn", "남는 하드 자리표시자")])
    harmful = write_jsonl(tmp_path / "harmful.jsonl", [generated("sealed-gh", texts[2])])
    allow = write_jsonl(tmp_path / "allow.jsonl", [generated("sealed-ga", texts[3])])
    out = tmp_path / "sealed-mix.jsonl"
    main(
        [
            "--out",
            str(out),
            "--khaters-train",
            str(khaters),
            "--hard-negatives",
            str(hard),
            "--extra-repeat",
            "1",
            "--generated-harmful",
            str(harmful),
            "--generated-allow",
            str(allow),
            "--sealed-holdout",
            str(sealed),
        ],
        environment={},
    )
    manifest_text = manifest_path_for(out).read_text(encoding="utf-8")
    manifest = json.loads(manifest_text)
    captured = capsys.readouterr().out
    assert manifest["sealed_holdout"] == {
        "file_name": sealed.name,
        "sha256": describe_file_provenance(sealed)["sha256"],
        "excluded_rows": 4,
        "excluded_by_source": {"khaters": 1, "hard_negative": 1, "generated_harmful": 1, "generated_allow": 1},
        "excluded_training_ids": ["101", "hn-sealed-hn-0", "gh:sealed-gh-0", "ga:sealed-ga-0"],
    }
    assert all(secret not in manifest_text and secret not in captured for secret in holdout_ids + texts)
    assert "봉인 보류셋과 겹쳐 뺀 4줄" in captured
    assert all(identifier not in {record.record_id for record in load_labeled_texts(out)} for identifier in manifest["sealed_holdout"]["excluded_training_ids"])


def test_sealed_holdout_format_error_does_not_leak_holdout_data(tmp_path: Path) -> None:
    """봉인 파일 형식 오류에도 내부 id와 문장을 내보내지 않고 원인·수정 방향만 알린다."""
    secret_id = "private-holdout-duplicate"
    secret_texts = ["봉인 오류 자리표시자 하나", "봉인 오류 자리표시자 둘"]
    path = write_jsonl(tmp_path / "sealed.jsonl", [eval_record(secret_id, text) for text in secret_texts])
    with pytest.raises(DatasetFormatError) as raised:
        load_sealed_holdout_index(path)
    message = str(raised.value)
    assert "형식이 올바르지 않습니다" in message and "확인하세요" in message
    assert secret_id not in message and all(text not in message for text in secret_texts)


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


def write_one_row(output_path: Path) -> dict:
    """한 줄짜리 학습 파일과 manifest를 쓴다(쓰기 경로 테스트용)."""
    return write_training_outputs(output_path, [{"id": "1", "text": "가", "label": "normal"}], MixSettings(None, 1, 1), {}, [])


def test_outputs_are_private_files(tmp_path: Path) -> None:
    """학습 파일과 manifest는 만든 사용자만 읽고 쓴다(OUTPUT_FILE_MODE). 데이터 원문이 든 파일이기 때문이다."""
    output_path = tmp_path / "mix.jsonl"
    write_one_row(output_path)
    for path in (output_path, manifest_path_for(output_path)):
        assert stat.S_IMODE(path.stat().st_mode) == OUTPUT_FILE_MODE == 0o600


def test_cleanup_keeps_file_replaced_by_another_process(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """학습 파일을 넣은 뒤 누가 그 이름을 다른 파일로 바꿔 넣고 manifest 넣기가 실패하면, 바뀐 파일은 지우지 않는다."""
    output_path = tmp_path / "mix.jsonl"
    real_link = os.link

    def replace_first_then_fail(source: str | os.PathLike[str], destination: str | os.PathLike[str]) -> None:
        if Path(destination) != output_path:
            output_path.unlink()
            output_path.write_text("다른 프로세스의 파일\n", encoding="utf-8")
            raise OSError(errno.EIO, "I/O error")
        real_link(source, destination)

    monkeypatch.setattr(os, "link", replace_first_then_fail)
    with pytest.raises(OSError, match="I/O"):
        write_one_row(output_path)
    assert output_path.read_text(encoding="utf-8") == "다른 프로세스의 파일\n" and staged_or_published_files(tmp_path) == ["mix.jsonl"]


def test_unsupported_hard_link_gives_actionable_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """하드 링크를 못 만드는 파일 시스템이면 출력 위치를 바꾸라는 오류를 내고, 임시 파일을 남기지 않는다."""

    def refuse_link(source: str | os.PathLike[str], destination: str | os.PathLike[str]) -> None:
        raise OSError(errno.ENOTSUP, "Operation not supported")

    monkeypatch.setattr(os, "link", refuse_link)
    with pytest.raises(OutputLocationError, match="하드 링크"):
        write_one_row(tmp_path / "mix.jsonl")
    assert staged_or_published_files(tmp_path) == []


def test_identity_failure_removes_new_staging_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """임시 파일을 만든 직후 그 신원을 못 읽으면, 정리 목록에 넣기 전이라도 그 파일을 지우고 오류를 올린다."""

    def failing_fstat(descriptor: int) -> os.stat_result:
        raise OSError(errno.EIO, "I/O error")

    monkeypatch.setattr(os, "fstat", failing_fstat)
    with pytest.raises(OSError, match="I/O"):
        write_one_row(tmp_path / "mix.jsonl")
    assert staged_or_published_files(tmp_path) == []
