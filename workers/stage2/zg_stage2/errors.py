"""운영자가 고칠 수 있는 오류 종류. 메시지에는 원인과 해결 방향을 쓰고, 채팅 원문은 넣지 않는다."""

from __future__ import annotations


class Stage2Error(Exception):
    """운영자가 고칠 수 있는 문제(경로·모델 형식)의 공통 부모."""


class PathResolutionError(Stage2Error):
    """경로를 정할 수 없거나 디렉터리가 없을 때 낸다."""


class ModelFormatError(Stage2Error):
    """모델·토크나이저가 kanana-safeguard의 약속(분류 토큰 8개가 각각 토큰 하나)과 다를 때 낸다."""


class EvaluationFormatError(Stage2Error, ValueError):
    """평가 JSONL의 형식·id가 올바르지 않을 때 낸다. 메시지에는 원문을 넣지 않는다."""


class OutputExistsError(Stage2Error):
    """앞선 평가 결과를 덮어쓰려 할 때 낸다."""
