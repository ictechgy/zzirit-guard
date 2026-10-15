"""2차 평가셋 점수 도구 테스트: 워커와 같은 분류, 완전성 검사, 실패 시 출력 부재."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from zg_stage2.errors import EvaluationFormatError
from zg_stage2.score_eval_set import main
from zg_stage2.worker import compute_model_identifier
from zg_stage2.worker_contract import ContractError, ItemVerdict


def write_jsonl(path: Path, records: list[dict]) -> Path:
    """작은 평가 JSONL을 만든다."""
    path.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records), encoding="utf-8")
    return path


@pytest.fixture
def fake_model_directory(tmp_path: Path) -> Path:
    """식별자 계산에 필요한 가중치·설정·토크나이저·템플릿 파일."""
    directory = tmp_path / "kanana-fake"
    directory.mkdir()
    (directory / "model.safetensors").write_bytes(b"weights")
    (directory / "config.json").write_text('{"model_type":"llama"}', encoding="utf-8")
    (directory / "tokenizer.json").write_text("{}", encoding="utf-8")
    (directory / "chat_template.jinja").write_text("{{ messages }}", encoding="utf-8")
    return directory


class FakeClassifier:
    """텍스트별 고정 판정을 내고 접두 fallback 수를 노출한다."""

    def __init__(self, verdicts: dict[str, ItemVerdict | BaseException], fallback_count: int = 0) -> None:
        self.verdicts = verdicts
        self.fallback_count = fallback_count

    def classify_one(self, text: str) -> ItemVerdict:
        """예외 값은 그대로 올리고 나머지는 판정으로 돌려준다."""
        result = self.verdicts[text]
        if isinstance(result, BaseException):
            raise result
        return result


def test_writes_all_scores_without_text_using_worker_identifier(tmp_path: Path, fake_model_directory: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """모든 id를 classify_one으로 판정하고 워커 식별자·접두 fallback 수만 원문 없이 쓴다."""
    eval_file = write_jsonl(
        tmp_path / "eval.jsonl",
        [{"id": "dev-1", "text": "평가 자리표시자 하나"}, {"id": "dev-2", "text": "평가 자리표시자 둘"}],
    )
    classifier = FakeClassifier(
        {
            "평가 자리표시자 하나": ItemVerdict(0.2, "S1"),
            "평가 자리표시자 둘": ItemVerdict(0.8, "S6"),
        },
        fallback_count=3,
    )
    monkeypatch.setattr("zg_stage2.score_eval_set.load_kanana", lambda directory: classifier)
    output = tmp_path / "scores.json"
    main(["--model-dir", str(fake_model_directory), "--eval-file", str(eval_file), "--output", str(output)])
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["model"] == {"directory_name": "kanana-fake", "identifier": compute_model_identifier(fake_model_directory)}
    assert report["candidate_threshold"] == 0.5 and report["prefix_fallbacks"] == 3
    assert report["scores"] == {
        "dev-1": {"unsafe_probability": 0.2, "category": "S1"},
        "dev-2": {"unsafe_probability": 0.8, "category": "S6"},
    }
    assert report["eval_file"]["name"] == "eval.jsonl" and len(report["eval_file"]["sha256"]) == 64
    assert all(text not in output.read_text(encoding="utf-8") for text in classifier.verdicts)


@pytest.mark.parametrize("error", [ContractError("bad_text"), ContractError("text_too_long")])
def test_contract_rejection_leaves_no_output(tmp_path: Path, fake_model_directory: Path, monkeypatch: pytest.MonkeyPatch, error: ContractError) -> None:
    """한 문장이라도 워커 분류가 거절하면 후보 아님으로 세지 않고 출력 파일을 만들지 않는다."""
    eval_file = write_jsonl(tmp_path / "eval.jsonl", [{"id": "dev-1", "text": "거절 자리표시자"}])
    monkeypatch.setattr("zg_stage2.score_eval_set.load_kanana", lambda directory: FakeClassifier({"거절 자리표시자": error}))
    output = tmp_path / "scores.json"
    with pytest.raises(EvaluationFormatError, match=rf"dev-1.*{error.code}"):
        main(["--model-dir", str(fake_model_directory), "--eval-file", str(eval_file), "--output", str(output)])
    assert not output.exists()


@pytest.mark.parametrize("probability", [math.nan, math.inf, -0.01, 1.01])
def test_invalid_probability_leaves_no_output(tmp_path: Path, fake_model_directory: Path, monkeypatch: pytest.MonkeyPatch, probability: float) -> None:
    """NaN·무한대·범위 밖 확률은 모델 오류로 멈추고 결과를 남기지 않는다."""
    eval_file = write_jsonl(tmp_path / "eval.jsonl", [{"id": "dev-1", "text": "확률 자리표시자"}])
    classifier = FakeClassifier({"확률 자리표시자": ItemVerdict(probability, "S1")})
    monkeypatch.setattr("zg_stage2.score_eval_set.load_kanana", lambda directory: classifier)
    output = tmp_path / "scores.json"
    with pytest.raises(EvaluationFormatError, match=r"dev-1.*unsafe_probability"):
        main(["--model-dir", str(fake_model_directory), "--eval-file", str(eval_file), "--output", str(output)])
    assert not output.exists()


def test_input_is_split_only_on_newline_not_unicode_line_separator(tmp_path: Path, fake_model_directory: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """stage1 로더와 같이 U+2028은 문장 내용으로 두고 \n만 JSONL 경계로 쓴다."""
    text = "앞\u2028뒤"
    eval_file = write_jsonl(tmp_path / "eval.jsonl", [{"id": "dev-1", "text": text}])
    monkeypatch.setattr("zg_stage2.score_eval_set.load_kanana", lambda directory: FakeClassifier({text: ItemVerdict(0.2, "S1")}))
    output = tmp_path / "scores.json"
    main(["--model-dir", str(fake_model_directory), "--eval-file", str(eval_file), "--output", str(output)])
    assert json.loads(output.read_text(encoding="utf-8"))["scores"]["dev-1"]["unsafe_probability"] == 0.2


@pytest.mark.parametrize(
    ("records", "message"),
    [
        ([{"text": "id 없음"}], "id"),
        ([{"id": "same", "text": "첫째"}, {"id": "same", "text": "둘째"}], "겹칩니다"),
    ],
)
def test_missing_or_duplicate_id_stops_before_output(
    tmp_path: Path, fake_model_directory: Path, monkeypatch: pytest.MonkeyPatch, records: list[dict], message: str
) -> None:
    """id 누락과 중복은 입력 위치를 알리고 모델을 불러오기 전에 멈춘다."""
    eval_file = write_jsonl(tmp_path / "eval.jsonl", records)
    monkeypatch.setattr("zg_stage2.score_eval_set.load_kanana", lambda directory: pytest.fail("모델을 불러오면 안 됨"))
    output = tmp_path / "scores.json"
    with pytest.raises(EvaluationFormatError, match=message):
        main(["--model-dir", str(fake_model_directory), "--eval-file", str(eval_file), "--output", str(output)])
    assert not output.exists()


def test_input_text_rejection_names_id_without_original_text(tmp_path: Path, fake_model_directory: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """입력 단계 길이 거절도 원문 대신 문장 id와 코드를 알린다."""
    original = "x" * 1001
    eval_file = write_jsonl(tmp_path / "eval.jsonl", [{"id": "dev-long", "text": original}])
    monkeypatch.setattr("zg_stage2.score_eval_set.load_kanana", lambda directory: pytest.fail("모델을 불러오면 안 됨"))
    with pytest.raises(EvaluationFormatError, match=r"dev-long.*bad_text") as caught:
        main(["--model-dir", str(fake_model_directory), "--eval-file", str(eval_file), "--output", str(tmp_path / "scores.json")])
    assert original not in str(caught.value)
