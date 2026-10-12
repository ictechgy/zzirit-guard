"""evaluate 모듈의 요약 함수 테스트(모델 없이 점수만 넣는다): 라벨별 표시 비율, 채팅 범주 요약, 회귀 표본."""

from __future__ import annotations

import pytest

from zg_stage1.data import ChatSample, LabeledText
from zg_stage1.evaluate import (
    EvaluationInputs,
    EvaluationScores,
    build_scores_payload,
    summarize_by_label,
    summarize_chat,
    summarize_chat_group,
    summarize_regression_sample,
)


def make_record(identifier: int, label: str) -> LabeledText:
    """자리표시자 문장으로 K-HATERS 레코드를 만든다."""
    return LabeledText(record_id=str(identifier), text="가", original_label=label, binary_label=0 if label == "normal" else 1)


def make_chat(identifier: int, group: str, expected: str) -> ChatSample:
    """자리표시자 문장으로 채팅 회귀 문장을 만든다."""
    return ChatSample(sample_id=str(identifier), group=group, expected=expected, text="가")


def test_summarize_by_label_reports_flag_rates() -> None:
    """라벨별로 임계값 이상 비율을 센다(normal은 오탐률, 유해 라벨은 재현율)."""
    records = [make_record(1, "normal"), make_record(2, "normal"), make_record(3, "offensive"), make_record(4, "offensive")]
    summary = summarize_by_label([0.01, 0.6, 0.04, 0.9], records, [0.05, 0.5])
    assert summary["normal"] == {"count": 2, "is_toxic_label": False, "flagged_rate": {"0.05": 0.5, "0.5": 0.5}}
    assert summary["offensive"]["flagged_rate"] == {"0.05": 0.5, "0.5": 0.5}


def test_chat_group_without_harmful_has_no_recall() -> None:
    """유해 정답이 없는 범주(일반 채팅)는 재현율을 None으로 두고 표시 비율만 센다."""
    members = [(0.01, make_chat(1, "normal", "allow")), (0.2, make_chat(2, "normal", "allow"))]
    assert summarize_chat_group(members, 0.05) == {"count": 2, "harmful_count": 0, "recall_at_threshold": None, "flagged_rate": 0.5}


def test_summarize_chat_excludes_ambiguous_and_hides_text() -> None:
    """ambiguous는 전체 지표에서 빼고, 문장별 결과에는 id·범주·정답·점수만 넣는다(원문 없음)."""
    samples = [make_chat(1, "insult", "harmful"), make_chat(2, "normal", "allow"), make_chat(3, "spam", "ambiguous")]
    summary = summarize_chat([0.9, 0.01, 0.5], samples, 0.05)
    assert summary["labeled_count"] == 2
    assert summary["auc"] == pytest.approx(1.0)
    assert summary["by_group"]["insult"]["recall_at_threshold"] == 1.0
    assert set(summary["sentences"][0]) == {"id", "group", "expected", "score"}


def test_regression_sample_reuses_test_scores() -> None:
    """회귀 표본은 test 점수를 id로 다시 써서 요약한다(추가 추론 없음)."""
    records = [make_record(index, "normal" if index % 2 else "offensive") for index in range(10)]
    scores = [0.9 if record.binary_label else 0.1 for record in records]
    summary = summarize_regression_sample(scores, records, 0.05)
    assert summary["count"] == 10
    assert summary["auc"] == pytest.approx(1.0)
    assert len(summary["sample_ids"]) == 10


def test_validation_scores_file_keeps_full_precision() -> None:
    """validation-scores.json에는 점수를 반올림하지 않고 그대로 쓴다(임계값 선택을 다시 할 때 값이 바뀌지 않게)."""
    records = [make_record(1, "normal"), make_record(2, "offensive")]
    inputs = EvaluationInputs(test_records=records, validation_records=records, chat_samples=[], max_length=128)
    scores = EvaluationScores(test=[0.1, 0.9], validation=[0.12345678912345, 0.98765432198765], chat=[])
    report = {"model": {"directory_name": "run"}, "data": {"validation": {"file_name": "val_v2.jsonl"}}, "settings": {"limit": None}}
    payload = build_scores_payload(report, inputs, scores)
    assert payload["scores"] == [0.12345678912345, 0.98765432198765]
    assert payload["binary_labels"] == [0, 1]
