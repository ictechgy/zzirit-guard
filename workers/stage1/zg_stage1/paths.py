"""입력·출력 경로 정하기와 파일 안전 검사(덮어쓰기 거부, safetensors만 허용).

경로는 저장소에 적지 않는다. 명령행 인자 → ZG_ML_DIR → ZG_DATA_DIR/ml 순서로 정한다.
왜: 운영자마다 자료 위치가 다르고, 저장소에 로컬 사용자 경로가 들어가면 공개 저장소에서 개인정보가 샌다.
torch를 불러오지 않는 가벼운 모듈이라 단위 테스트가 빠르다.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime
from pathlib import Path

from zg_stage1.errors import OutputExistsError, OutputLocationError, PathResolutionError, UnsafeWeightsError

# ML 자료(기반 모델·데이터·학습 결과)의 최상위 디렉터리를 직접 가리키는 환경 변수.
ML_DIRECTORY_VARIABLE = "ZG_ML_DIR"

# 서버가 쓰는 데이터 디렉터리 환경 변수(운영 안내서와 같은 이름). ML 자료는 그 아래 ml/에 둔다.
DATA_DIRECTORY_VARIABLE = "ZG_DATA_DIR"

# ZG_DATA_DIR 아래에서 ML 자료가 있는 하위 디렉터리 이름.
ML_SUBDIRECTORY_NAME = "ml"

# ML 디렉터리 기준 기반 모델(beomi/KcELECTRA-base) 위치.
BASE_MODEL_RELATIVE_PATH = Path("base") / "kcelectra-base"

# ML 디렉터리 기준 K-HATERS 위치.
KHATERS_RELATIVE_PATH = Path("data") / "k-haters"

# K-HATERS 학습 파일 이름(공식 저장소의 v2 파일 이름 그대로).
KHATERS_TRAIN_FILE_NAME = "train_v2.jsonl"

# K-HATERS 검증 파일 이름. epoch 선택과 임계값 선택에 쓴다.
KHATERS_VALIDATION_FILE_NAME = "val_v2.jsonl"

# K-HATERS 시험 파일 이름. 최종 평가에만 쓴다(학습·선택에 쓰지 않는다).
KHATERS_TEST_FILE_NAME = "test_v2.jsonl"

# ML 디렉터리 기준 1차 분류기 학습 결과를 모으는 위치.
STAGE1_OUTPUT_RELATIVE_PATH = Path("stage1")

# 저장소 최상위. 이 파일 위치(workers/stage1/zg_stage1/)에서 세 단계 위다. 사용자 경로를 적지 않기 위해 계산한다.
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]

# 저장소 안의 채팅 회귀 문장(스펙 §13). --chat-file을 주지 않으면 이 파일을 쓴다.
CHAT_SAMPLES_PATH = REPOSITORY_ROOT / "docs" / "spikes" / "2026-10-11-guard-models" / "chat_samples.jsonl"

# pickle 기반 가중치 파일 확장자. 읽는 순간 임의 코드를 실행할 수 있어 거부한다.
PICKLE_WEIGHT_SUFFIXES: frozenset[str] = frozenset({".bin", ".pt", ".pth", ".pkl", ".pickle", ".ckpt"})

# 허용하는 가중치 파일 확장자.
SAFETENSORS_SUFFIX = ".safetensors"


def resolve_ml_directory(explicit_path: str | None, environment: Mapping[str, str]) -> Path:
    """ML 자료 디렉터리를 정한다. 우선순위: --ml-dir → ZG_ML_DIR → ZG_DATA_DIR/ml.

    environment: 환경 변수(테스트에서 바꿔 넣을 수 있게 인자로 받는다).
    주의: 셋 다 없으면 추측하지 않고 오류를 낸다. 엉뚱한 위치에 학습 결과를 쓰지 않기 위해서다.
    """
    if explicit_path:
        return Path(explicit_path).expanduser()
    if environment.get(ML_DIRECTORY_VARIABLE):
        return Path(environment[ML_DIRECTORY_VARIABLE]).expanduser()
    if environment.get(DATA_DIRECTORY_VARIABLE):
        return Path(environment[DATA_DIRECTORY_VARIABLE]).expanduser() / ML_SUBDIRECTORY_NAME
    raise PathResolutionError(
        f"ML 자료 위치를 정할 수 없습니다. --ml-dir를 주거나 {ML_DIRECTORY_VARIABLE} 또는 {DATA_DIRECTORY_VARIABLE} 환경 변수를 "
        f'설정하세요(예: export {DATA_DIRECTORY_VARIABLE}="$HOME/Library/Application Support/zzirit-guard").'
    )


def choose_path(explicit_path: str | None, default_factory: Callable[[], Path]) -> Path:
    """명시한 경로가 있으면 그것을, 없으면 default_factory()가 만든 기본 경로를 쓴다.

    왜 함수로 늦게 계산하나: 경로를 모두 인자로 준 경우에는 환경 변수가 없어도 오류가 나지 않게 하기 위해서다.
    """
    return Path(explicit_path).expanduser() if explicit_path else default_factory()


def ensure_existing_file(path: Path, description: str) -> Path:
    """파일이 있는지 확인한다. 없으면 받는 방법을 알려 주는 오류를 낸다."""
    if not path.is_file():
        raise PathResolutionError(
            f"{description} 파일이 없습니다: {path}. workers/stage1/README.md의 'hf download' 절차로 받았는지, 경로 인자가 맞는지 확인하세요."
        )
    return path


def ensure_existing_directory(path: Path, description: str) -> Path:
    """디렉터리가 있는지 확인한다. 없으면 받는 방법을 알려 주는 오류를 낸다."""
    if not path.is_dir():
        raise PathResolutionError(
            f"{description} 디렉터리가 없습니다: {path}. workers/stage1/README.md의 'hf download' 절차로 받았는지, 경로 인자가 맞는지 확인하세요."
        )
    return path


def ensure_output_is_new(path: Path) -> Path:
    """출력 위치가 아직 없는지 확인한다(만들지는 않는다).

    왜: 무거운 모델을 불러오기 전에 충돌을 알려, 몇 분을 기다린 뒤에야 실패하는 일을 막기 위해서다.
    """
    if path.exists():
        raise OutputExistsError(
            f"출력 위치가 이미 있습니다: {path}. 앞선 결과를 지키려고 덮어쓰지 않습니다. 다른 --out-dir를 주거나, 필요 없으면 직접 지운 뒤 다시 실행하세요."
        )
    return path


def ensure_outside_repository(path: Path, repository_root: Path = REPOSITORY_ROOT) -> Path:
    """출력 위치가 저장소 밖인지 확인한다. 상대 경로·심볼릭 링크는 실제 위치로 풀어 비교한다.

    왜: 미세조정 가중치·평가 결과는 저장소에 넣지 않는다(스펙 §17). 저장소 안에 쓰면 .gitignore를 빠져나가거나
    `git add -A` 한 번으로 커밋될 수 있다.
    """
    if path.resolve().is_relative_to(repository_root.resolve()):
        raise OutputLocationError(
            f"출력 위치가 저장소 안입니다: {path}. 가중치는 저장소에 넣지 않으므로 저장소 밖(예: $ZG_DATA_DIR/ml/stage1/)을 --out-dir로 주세요."
        )
    return path


def create_new_output_directory(path: Path) -> Path:
    """출력 디렉터리를 새로 만든다. 이미 있으면 덮어쓰지 않고 오류를 낸다.

    왜: 앞서 학습한 가중치·모델 카드를 지우거나, 다른 실행의 파일과 섞지 않기 위해서다.
    부모 디렉터리는 필요하면 만든다. 마지막 mkdir은 exist_ok=False라서 동시에 실행돼도 한쪽만 성공한다.
    """
    ensure_output_is_new(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.mkdir()
    except FileExistsError as error:
        raise OutputExistsError(f"출력 위치가 방금 다른 실행에서 만들어졌습니다: {path}. 다른 --out-dir를 주세요.") from error
    return path


def default_training_output_directory(ml_directory: Path, started_at: datetime) -> Path:
    """학습 결과 기본 위치를 만든다: <ML 디렉터리>/stage1/kcelectra-YYYYMMDD-HHMMSS.

    시각을 이름에 넣는 이유는, 기본값만 써도 실행마다 새 디렉터리가 생겨 덮어쓰기 거부에 걸리지 않게 하기 위해서다.
    """
    return ml_directory / STAGE1_OUTPUT_RELATIVE_PATH / f"kcelectra-{started_at:%Y%m%d-%H%M%S}"


def ensure_safetensors_only(model_directory: Path) -> list[Path]:
    """모델 디렉터리의 가중치가 safetensors로만 되어 있는지 확인하고, safetensors 파일 목록을 돌려준다.

    왜: pickle 기반(.bin 등) 가중치는 읽는 순간 임의 코드를 실행할 수 있다. 같은 폴더에 섞여 있으면
    어느 쪽을 읽었는지도 모호해지므로, 하나라도 있으면 거부한다.
    """
    ensure_existing_directory(model_directory, "모델")
    pickle_files = sorted(path.name for path in model_directory.iterdir() if path.suffix in PICKLE_WEIGHT_SUFFIXES)
    if pickle_files:
        raise UnsafeWeightsError(
            f"{model_directory}에 pickle 형식 가중치({', '.join(pickle_files)})가 있습니다. 보안상 읽지 않습니다. "
            "그 파일을 지우고 model.safetensors만 남기세요(README의 --include 목록대로 받으면 .bin은 받지 않습니다)."
        )
    weight_files = sorted(model_directory.glob(f"*{SAFETENSORS_SUFFIX}"))
    if not weight_files:
        raise UnsafeWeightsError(f"{model_directory}에 safetensors 가중치가 없습니다. model.safetensors를 받았는지 확인하세요.")
    return weight_files
