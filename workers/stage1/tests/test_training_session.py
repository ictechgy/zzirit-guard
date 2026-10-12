"""TrainingSession 테스트(모델 없이 가짜 점수): 최고 epoch·조기 종료는 반올림하지 않은 AUC로 비교한다."""

from __future__ import annotations

import argparse
import random
from pathlib import Path
from types import SimpleNamespace

import pytest

from zg_stage1 import modeling, train

# 정상·유해 각 200건(쌍 40,000개). AUC 눈금이 0.000025라 소수 4자리 반올림으로는 구분되지 않는 차이를 만들 수 있다.
CLASS_SIZE = 200


def make_scores(beaten_negatives_per_positive: list[int]) -> list[float]:
    """유해 i번째가 정상 몇 건보다 높은지로 점수를 만든다. 정상은 (j+0.5)/1000, 유해는 이긴 수/1000 위치에 둔다."""
    negative_scores = [(index + 0.5) / 1000 for index in range(CLASS_SIZE)]
    positive_scores = [beaten / 1000 for beaten in beaten_negatives_per_positive]
    return negative_scores + positive_scores


def make_session(tmp_path: Path, epochs: int = 3, patience: int = 2) -> train.TrainingSession:
    """검증과 카드 기록만 실제로 돌고 나머지는 가짜인 세션을 만든다."""
    labels = [0] * CLASS_SIZE + [1] * CLASS_SIZE
    arguments = argparse.Namespace(epochs=epochs, early_stop_patience=patience, max_steps=0, max_length=128)
    paths = train.TrainingPaths(tmp_path / "base", tmp_path / "train.jsonl", tmp_path / "val.jsonl", tmp_path)
    return train.TrainingSession(
        arguments=arguments,
        paths=paths,
        device="cpu",
        tokenizer=SimpleNamespace(pad_token_id=3),
        model=None,
        train_split=None,
        validation_split=train.EncodedSplit(token_lists=[[1, 2]] * len(labels), labels=labels, label_counts={}),
        optimizer=None,
        scheduler=None,
        progress=train.TrainingProgress(total_steps=10),
        model_card={"epochs": []},
        random_generator=random.Random(0),
    )


def test_summarize_validation_keeps_unrounded_auc() -> None:
    """검증 요약은 비교용 AUC를 반올림하지 않고, 표시용 값만 4자리로 반올림한다."""
    scores = make_scores([150] * (CLASS_SIZE - 1) + [151])
    labels = [0] * CLASS_SIZE + [1] * CLASS_SIZE
    outcome = train.summarize_validation(scores, labels)
    assert outcome.unrounded_auc == pytest.approx(0.750025, abs=1e-12)
    assert outcome.display_metrics["auc"] == 0.75


def test_best_epoch_uses_unrounded_auc(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """반올림하면 같은 0.75인 두 epoch 중, 실제로 더 높은 둘째 epoch를 최고로 고르고 저장한다."""
    epoch_scores = iter([make_scores([150] * CLASS_SIZE), make_scores([150] * (CLASS_SIZE - 1) + [151])])
    monkeypatch.setattr(modeling, "predict_toxic_probabilities", lambda *arguments, **keywords: next(epoch_scores))
    session = make_session(tmp_path)
    saved_epochs: list[int] = []
    session.save_best_model = lambda: saved_epochs.append(len(session.model_card["epochs"]) + 1)  # type: ignore[method-assign]
    session.finish_epoch(1, mean_loss=0.5)
    session.finish_epoch(2, mean_loss=0.4)
    assert saved_epochs == [1, 2]
    assert (session.progress.best_epoch, session.progress.epochs_without_improvement) == (2, 0)
    assert session.model_card["chosen_epoch"] == 2


def test_early_stop_counts_unrounded_drops(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """반올림하면 같아 보이는 아주 작은 하락도 '개선 없음'으로 센다."""
    epoch_scores = iter([make_scores([150] * (CLASS_SIZE - 1) + [151]), make_scores([150] * CLASS_SIZE)])
    monkeypatch.setattr(modeling, "predict_toxic_probabilities", lambda *arguments, **keywords: next(epoch_scores))
    session = make_session(tmp_path)
    session.save_best_model = lambda: None  # type: ignore[method-assign]
    session.finish_epoch(1, mean_loss=0.5)
    session.finish_epoch(2, mean_loss=0.4)
    assert (session.progress.best_epoch, session.progress.epochs_without_improvement) == (1, 1)
