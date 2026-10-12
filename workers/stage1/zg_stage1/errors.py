"""사용자가 고칠 수 있는 오류 종류와, CLI에서 그 오류를 보여 주는 방법.

왜 따로 두나: 경로·데이터·설정 문제는 traceback 대신 "원인과 해결 방향"만 보여 주는 편이 운영자에게 낫다.
반면 코드 버그는 traceback을 그대로 올려 개발자가 원인을 찾게 한다. 이 둘을 예외 종류로 구분한다.
"""

from __future__ import annotations

import sys
from collections.abc import Callable
from pathlib import Path

# 사용자 오류로 끝날 때의 종료 코드. argparse가 잘못된 인자에 쓰는 값(2)과 맞춰 스크립트에서 구분하기 쉽게 한다.
USER_ERROR_EXIT_CODE = 2


class Stage1Error(Exception):
    """운영자가 고칠 수 있는 문제(경로·데이터·설정·출력 충돌)의 공통 부모.

    메시지에는 원인과 해결 방향을 함께 쓴다. 데이터 원문(댓글·채팅)은 절대 넣지 않는다.
    """


class PathResolutionError(Stage1Error):
    """입력 경로를 정할 수 없거나 파일·디렉터리가 없을 때 낸다."""


class OutputExistsError(Stage1Error):
    """출력 위치가 이미 있어 덮어쓰기를 거부할 때 낸다. 앞선 학습 결과를 실수로 지우지 않기 위해서다."""


class OutputLocationError(Stage1Error):
    """출력 위치가 허용되지 않을 때 낸다(예: 저장소 안). 가중치·평가 결과가 실수로 커밋되지 않게 하기 위해서다."""


class UnsafeWeightsError(Stage1Error):
    """가중치가 safetensors가 아니거나(pickle 형식) 없을 때 낸다. pickle은 읽을 때 임의 코드를 실행할 수 있다."""


class DatasetFormatError(Stage1Error, ValueError):
    """데이터 파일 형식·라벨이 기대와 다를 때 낸다. 메시지에는 파일·줄 위치만 넣고 원문은 넣지 않는다."""


class MetricError(Stage1Error, ValueError):
    """지표를 계산할 수 없는 입력(예: 한 클래스만 있음)일 때 낸다."""


class ModelFormatError(Stage1Error):
    """불러온 모델·토크나이저가 학습 때의 약속(라벨 2개, [CLS]·[SEP] 감싸기)과 다를 때 낸다."""


def describe_failure(error: BaseException) -> str:
    """모델 카드에 남길 실패 설명을 만든다.

    Stage1Error는 원인과 해결 방향을 담도록 쓴 메시지라 그대로 남기되, 홈 경로는 ~로 가린다(카드를 공유할 때 사용자 이름이
    새지 않게). 그 밖의 예외는 메시지에 무엇이 들어 있을지 몰라(데이터 조각 등) 종류 이름만 남긴다.
    """
    error_type = type(error).__name__
    if not isinstance(error, Stage1Error):
        return error_type
    return f"{error_type}: {str(error).replace(str(Path.home()), '~')}"


def run_command_line(entry_point: Callable[[], None]) -> None:
    """CLI 진입점을 실행하고, 사용자 오류는 traceback 없이 메시지만 stderr에 출력한 뒤 종료 코드 2로 끝낸다.

    entry_point: 인자 없이 부르는 실제 main 함수.
    주의: Stage1Error가 아닌 예외는 잡지 않는다. 버그를 사용자 오류처럼 숨기지 않기 위해서다.
    """
    try:
        entry_point()
    except Stage1Error as error:
        print(f"오류: {error}", file=sys.stderr)
        raise SystemExit(USER_ERROR_EXIT_CODE) from error
