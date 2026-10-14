"""합의 문장의 대조쌍과 할당량을 보존하면서 학습 입력을 만드는지 확인한다."""

from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from zg_datagen.materialize import build_parser, character_ngrams, jaccard, run_materialize


def write_jsonl(path: Path, rows: list[dict[str, object]]) -> Path:
    """실제 문장을 노출하지 않고 자리표시자 테스트 입력만 만든다."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    return path


def kept_record(identifier: str, kind: str, text: str, parent_id: str | None = None) -> dict[str, object]:
    """종류와 부모 연결을 빠뜨린 테스트가 실제 생성 레코드 계약을 흐리지 않게 한다."""
    record: dict[str, object] = {"id": identifier, "kind": kind, "text": text}
    if parent_id is not None:
        record["parent_id"] = parent_id
    return record


def run_directory(root: Path, kept: list[dict[str, object]], harmful: list[dict[str, object]], allow: list[dict[str, object]]) -> Path:
    """한 실행의 kept 파일과 두 labels merge 출력을 같은 경로에 둔다."""
    write_jsonl(root / "kept-x.jsonl", kept)
    write_jsonl(root / "merged" / "accepted-harmful.jsonl", harmful)
    write_jsonl(root / "merged" / "accepted-allow.jsonl", allow)
    return root


def read_rows(path: Path) -> list[dict[str, str]]:
    """출력 바이트가 실제 학습 입력 두 필드만 담는지도 함께 확인하게 읽는다."""
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def output_paths(root: Path) -> tuple[Path, Path]:
    """각 호출이 배타 출력 규칙에 걸리지 않도록 독립된 결과 경로를 만든다."""
    root.mkdir(parents=True, exist_ok=True)
    return root / "harmful.jsonl", root / "allow.jsonl"


def test_cross_label_near_duplicate_survives_and_run_name_prefixes_id(tmp_path: Path) -> None:
    """상반 라벨의 가까운 문장은 대조 근거이므로 양쪽에 남기고 실행 이름으로 id 충돌을 막는다."""
    kept = [
        kept_record("a", "harmful", "자리표시자 문장 하나 둘 셋"),
        kept_record("b", "boundary", "자리표시자 문장 하나 둘 셋!"),
        kept_record("c", "boundary", "전혀 다른 중립 문장"),
    ]
    run_one = run_directory(tmp_path / "pilot", kept, [{"id": "a", "category": "threat"}], [{"id": "b", "category": "long_normal"}])
    run_two = run_directory(tmp_path / "full", kept, [], [{"id": "c", "category": "short_normal"}])
    harmful_path, allow_path = output_paths(tmp_path)
    report = run_materialize([run_one, run_two], harmful_path, allow_path)
    assert read_rows(harmful_path) == [{"id": "pilot:a", "text": "자리표시자 문장 하나 둘 셋"}]
    assert read_rows(allow_path) == [
        {"id": "pilot:b", "text": "자리표시자 문장 하나 둘 셋!"},
        {"id": "full:c", "text": "전혀 다른 중립 문장"},
    ]
    assert report["allow"] == {
        "rows": 2,
        "by_category": {"long_normal": 1, "short_normal": 1},
        "near_duplicates": 0,
        "by_kind": {"boundary": 2},
        "twins_without_parent": 0,
        "twins_over_limit": 0,
    }
    assert stat.S_IMODE(harmful_path.stat().st_mode) == 0o600


def test_twin_near_its_harmful_parent_survives(tmp_path: Path) -> None:
    """최소 편집 twin은 부모와 가까운 것이 의도이므로 라벨 사이 중복 제거로 잃지 않는다."""
    kept = [
        kept_record("parent", "harmful", "대조용 자리표시자 원문"),
        kept_record("twin", "twin", "대조용 자리표시자 원문!", "round:parent"),
    ]
    run = run_directory(
        tmp_path / "round",
        kept,
        [{"id": "parent", "category": "abuse"}],
        [{"id": "twin", "category": "short_normal"}],
    )
    harmful_path, allow_path = output_paths(tmp_path)
    run_materialize([run], harmful_path, allow_path)
    assert read_rows(allow_path) == [{"id": "round:twin", "text": "대조용 자리표시자 원문!"}]


def test_same_parent_twins_skip_each_other_but_other_parent_does_not(tmp_path: Path) -> None:
    """같은 부모의 변형 수는 보존하되 다른 부모의 같은 변형까지 중복으로 남기지는 않는다."""
    kept = [
        kept_record("parent-a", "harmful", "부모 A 자리표시자"),
        kept_record("parent-b", "harmful", "부모 B 자리표시자"),
        kept_record("twin-a1", "twin", "중립 대조 문장 하나 둘 셋", "round:parent-a"),
        kept_record("twin-a2", "twin", "중립 대조 문장 하나 둘 셋!", "round:parent-a"),
        kept_record("twin-b1", "twin", "중립 대조 문장 하나 둘 셋?", "round:parent-b"),
    ]
    run = run_directory(
        tmp_path / "round",
        kept,
        [{"id": "parent-a", "category": "abuse"}, {"id": "parent-b", "category": "threat"}],
        [{"id": identifier, "category": "short_normal"} for identifier in ("twin-a1", "twin-a2", "twin-b1")],
    )
    harmful_path, allow_path = output_paths(tmp_path)
    report = run_materialize([run], harmful_path, allow_path)
    assert [row["id"] for row in read_rows(allow_path)] == ["round:twin-a1", "round:twin-a2"]
    assert report["allow"]["near_duplicates"] == 1  # type: ignore[index]


def test_harmful_category_cap_and_override_count_dropped_rows(tmp_path: Path) -> None:
    """기본 상한과 minors 재정의가 섞여도 범주별 초과 수를 숨기지 않는다."""
    categories = ["abuse", "abuse", "abuse", "minors", "minors"]
    texts = ["사과 기차 연필", "바다 우산 시계", "구름 의자 나무", "노을 가방 종이", "호수 모자 창문"]
    kept = [kept_record(str(index), "harmful", text) for index, text in enumerate(texts)]
    harmful = [{"id": str(index), "category": category} for index, category in enumerate(categories)]
    run = run_directory(tmp_path / "round", kept, harmful, [])
    harmful_path, allow_path = output_paths(tmp_path)
    report = run_materialize([run], harmful_path, allow_path, seed=31, harmful_cap=2, harmful_category_caps={"minors": 1})
    assert report["harmful"]["by_category"] == {"abuse": 2, "minors": 1}  # type: ignore[index]
    assert report["harmful"]["over_cap"] == {"abuse": 1, "minors": 1}  # type: ignore[index]


def test_twins_of_capped_parent_are_dropped(tmp_path: Path) -> None:
    """선택되지 않은 유해 부모의 twin은 대조쌍이 아니므로 허용 단독 행으로 남기지 않는다."""
    kept = [
        kept_record("p1", "harmful", "사과 기차 연필"),
        kept_record("p2", "harmful", "바다 우산 시계"),
        kept_record("t1", "twin", "구름 의자 나무", "round:p1"),
        kept_record("t2", "twin", "노을 가방 종이", "round:p2"),
    ]
    merged_harmful = [{"id": identifier, "category": "abuse"} for identifier in ("p1", "p2")]
    merged_allow = [{"id": identifier, "category": "short_normal"} for identifier in ("t1", "t2")]
    run = run_directory(tmp_path / "round", kept, merged_harmful, merged_allow)
    harmful_path, allow_path = output_paths(tmp_path)
    report = run_materialize([run], harmful_path, allow_path, seed=5, harmful_cap=1, twins_per_parent=2)
    accepted_parent = read_rows(harmful_path)[0]["id"]
    assert len(read_rows(allow_path)) == 1
    assert kept_parent_for_output(read_rows(allow_path)[0]["id"]) == accepted_parent
    assert report["allow"]["twins_without_parent"] == 1  # type: ignore[index]


def kept_parent_for_output(identifier: str) -> str:
    """고정 fixture의 twin 번호를 부모 번호로 바꿔 어떤 부모가 선택됐는지 비교한다."""
    return identifier.replace(":t", ":p")


def test_twin_limit_refills_after_near_duplicate(tmp_path: Path) -> None:
    """앞선 twin이 다른 허용 행과 겹쳐 탈락해도 뒤 후보가 부모 할당량을 채울 수 있어야 한다."""
    kept = [
        kept_record("parent", "harmful", "부모 자리표시자"),
        kept_record("boundary", "boundary", "겹치는 중립 자리표시자"),
        kept_record("t1", "twin", "겹치는 중립 자리표시자!", "round:parent"),
        kept_record("t2", "twin", "남는 중립 대조 문장", "round:parent"),
        kept_record("t3", "twin", "남는 중립 대조 문장!", "round:parent"),
    ]
    merged_allow = [{"id": identifier, "category": "short_normal"} for identifier in ("boundary", "t1", "t2", "t3")]
    run = run_directory(tmp_path / "round", kept, [{"id": "parent", "category": "abuse"}], merged_allow)
    harmful_path, allow_path = output_paths(tmp_path)
    report = run_materialize([run], harmful_path, allow_path, seed=7, twins_per_parent=2)
    assert [row["id"] for row in read_rows(allow_path)] == ["round:boundary", "round:t2", "round:t3"]
    assert report["allow"]["near_duplicates"] == 1  # type: ignore[index]
    assert report["allow"]["twins_over_limit"] == 0  # type: ignore[index]
    assert report["allow"]["parents_by_twin_count"] == {"0": 0, "1": 0, "2": 1}  # type: ignore[index]


def test_same_seed_writes_identical_bytes(tmp_path: Path) -> None:
    """같은 seed는 목록과 manifest 순서를 함께 고정해 재실행 결과를 바이트 단위로 비교할 수 있게 한다."""
    texts = ["사과 기차 연필", "바다 우산 시계", "구름 의자 나무", "노을 가방 종이", "호수 모자 창문"]
    kept = [kept_record(str(index), "harmful", text) for index, text in enumerate(texts)]
    merged = [{"id": str(index), "category": "abuse"} for index in range(5)]
    run = run_directory(tmp_path / "round", kept, merged, [])
    first_paths = output_paths(tmp_path / "first")
    second_paths = output_paths(tmp_path / "second")
    run_materialize([run], *first_paths, seed=17, harmful_cap=3)
    run_materialize([run], *second_paths, seed=17, harmful_cap=3)
    for first, second in zip(first_paths, second_paths, strict=True):
        assert first.read_bytes() == second.read_bytes()
    first_manifest = first_paths[0].with_name(f"{first_paths[0].name}.manifest.json")
    second_manifest = second_paths[0].with_name(f"{second_paths[0].name}.manifest.json")
    assert first_manifest.read_bytes() == second_manifest.read_bytes()


@pytest.mark.parametrize("options", [{"harmful_cap": 1}, {"harmful_category_caps": {"minors": 1}}, {"twins_per_parent": 2}])
def test_selection_options_require_seed(tmp_path: Path, options: dict[str, object]) -> None:
    """선택 옵션이 파일 순서를 우연한 난수처럼 쓰지 않도록 seed 없는 호출을 거절한다."""
    run = run_directory(tmp_path / "round", [], [], [])
    harmful_path, allow_path = output_paths(tmp_path)
    with pytest.raises(ValueError, match="파일 순서.*seed"):
        run_materialize([run], harmful_path, allow_path, **options)  # type: ignore[arg-type]


@pytest.mark.parametrize("value", ["minors", "=2", "minors=no", "minors=-1"])
def test_malformed_harmful_category_cap_is_cli_error(value: str, capsys: pytest.CaptureFixture[str]) -> None:
    """오타 난 CATEGORY=N을 조용히 무시하면 계획과 다른 할당이 되므로 CLI에서 이유를 보인다."""
    with pytest.raises(SystemExit):
        build_parser().parse_args(["--runs", "run", "--out-harmful", "harmful.jsonl", "--out-allow", "allow.jsonl", "--harmful-cap-category", value])
    assert "CATEGORY=N" in capsys.readouterr().err


def test_missing_text_duplicate_id_same_run_names_and_existing_outputs_are_errors(tmp_path: Path) -> None:
    """원문 연결이 모호하거나 배타 출력을 깨는 입력은 일부 결과를 쓰기 전에 모두 거절한다."""
    missing = run_directory(tmp_path / "missing", [{"id": "a", "kind": "harmful"}], [{"id": "a", "category": "threat"}], [])
    with pytest.raises(ValueError, match="text"):
        run_materialize([missing], *output_paths(tmp_path / "missing-output"))
    duplicate = run_directory(tmp_path / "duplicate", [kept_record("a", "harmful", "중립")], [], [])
    write_jsonl(duplicate / "kept-y.jsonl", [kept_record("a", "harmful", "다른 중립")])
    with pytest.raises(ValueError, match="다른 입력"):
        run_materialize([duplicate], *output_paths(tmp_path / "duplicate-output"))
    other = run_directory(tmp_path / "nested" / "same", [kept_record("a", "harmful", "중립")], [], [])
    with pytest.raises(ValueError, match="이름이 같은"):
        run_materialize([other, other], *output_paths(tmp_path / "same-output"))
    existing_paths = output_paths(tmp_path / "existing")
    write_jsonl(existing_paths[0], [])
    with pytest.raises(FileExistsError):
        run_materialize([other], *existing_paths)


def test_twin_without_parent_id_is_error(tmp_path: Path) -> None:
    """부모 없는 twin을 일반 허용으로 낮추면 대조쌍 수가 거짓이 되므로 설정과 무관하게 거절한다."""
    run = run_directory(
        tmp_path / "round",
        [kept_record("twin", "twin", "부모 없는 중립 자리표시자")],
        [],
        [{"id": "twin", "category": "short_normal"}],
    )
    with pytest.raises(ValueError, match="parent_id"):
        run_materialize([run], *output_paths(tmp_path))


def test_report_contains_settings_but_no_input_text(tmp_path: Path) -> None:
    """재현 설정은 남기되 manifest와 표준 집계가 원문을 새 경로로 유출하지 않게 한다."""
    secret_placeholder = "보고서에 없어야 할 중립 자리표시자"
    run = run_directory(
        tmp_path / "round",
        [kept_record("a", "boundary", secret_placeholder)],
        [],
        [{"id": "a", "category": "long_normal"}],
    )
    report = run_materialize([run], *output_paths(tmp_path), seed=23)
    serialized = json.dumps(report, ensure_ascii=False)
    assert secret_placeholder not in serialized
    assert report["settings"] == {
        "seed": 23,
        "harmful_cap": None,
        "harmful_category_caps": {},
        "twins_per_parent": None,
        "near_duplicate_jaccard": 0.7,
    }


def test_ngram_similarity_uses_matching_normalization() -> None:
    """공백·문장부호·폭 없는 문자 차이는 같은 문장으로 보아 표면 변형을 중복으로 남기지 않는다."""
    assert jaccard(character_ngrams("가나다 라마"), character_ngrams("가나다라마!​")) == 1.0
    assert jaccard(character_ngrams("가나"), character_ngrams("가나")) == 1.0
