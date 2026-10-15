"""모델 카드(model-card.json) 만들기: 출처(sha256)·하이퍼파라미터·라이브러리 버전·epoch별 지표·라이선스.

왜: 미세조정 가중치는 배포하지 않고 운영자마다 직접 학습한다(스펙 §17). 그래서 '어떤 기반 모델·데이터·설정으로
만든 가중치인가'를 가중치 옆에 남겨야 결과를 비교하고 재현할 수 있다.
주의: 카드에는 전체 경로를 넣지 않는다(파일·디렉터리 이름만). 공유할 때 로컬 사용자 경로가 새지 않게 하기 위해서다.
"""

from __future__ import annotations

import json
import os
import platform
from datetime import UTC, datetime
from importlib import metadata
from pathlib import Path

from zg_stage1.errors import ModelFormatError

# 모델 카드 파일 이름. 가중치와 같은 디렉터리에 둔다.
MODEL_CARD_FILE_NAME = "model-card.json"

# 카드 형식 버전. 필드를 바꾸면 올려서, 읽는 쪽(워커·평가)이 형식을 구분하게 한다.
MODEL_CARD_SCHEMA_VERSION = 1

# 학습이 끝났을 때만 카드에 쓰는 상태 값. running·interrupted 카드 옆의 가중치는 중간 체크포인트다.
COMPLETED_STATUS = "completed"

# 버전을 기록할 라이브러리. 같은 시드라도 라이브러리가 바뀌면 결과가 달라질 수 있어 함께 남긴다.
TRACKED_LIBRARIES: tuple[str, ...] = ("torch", "transformers", "tokenizers", "safetensors", "numpy", "huggingface-hub")

# 기반 모델의 공식 저장소. README의 hf download 명령과 같다.
BASE_MODEL_REPOSITORY = "beomi/KcELECTRA-base"

# README가 고정하는 기반 모델 리비전(2026-10-12 확인, safetensors 추가 커밋). main이 바뀌어도 같은 파일을 받게 한다.
BASE_MODEL_REVISION = "681201a097b8120e6dd2a2e63a3e13d338736f88"

# 학습 데이터의 공식 저장소.
DATASET_REPOSITORY = "humane-lab/K-HATERS"

# README가 고정하는 데이터 리비전(2026-10-12 확인).
DATASET_REVISION = "b96dc29e056eda8e658d740444b8baf95e226cee"

# 위 리비전에서 받은 파일의 sha256. 다르면 학습은 계속하되 카드에 '다름'으로 남긴다(다른 리비전일 수 있음).
REFERENCE_SHA256: dict[str, str] = {
    "model.safetensors": "dc015d95afa81351e096dfadf95771eeafee3ec0a90709e9cb569c11797fd889",
    "train_v2.jsonl": "3039eb0970ee2d3c67ee46f7bea94e3c559dcdc2ff5cce44c7d58b429035d07a",
    "val_v2.jsonl": "e6788561038c8aa1c0f8ecbc94a1c6a1aedb5ec9703d1bab6250c81d4097864d",
    "test_v2.jsonl": "d5c29d7cedce60f28ee14f5a8372d9f1d6698dc591408b408cd2e65ee1a86b5e",
}

# 라이선스와 출처 표기. 가중치를 배포하지 않더라도, 카드만 보고 의무를 알 수 있게 함께 적는다.
LICENSE_NOTES: dict[str, object] = {
    "base_model": {
        "name": BASE_MODEL_REPOSITORY,
        "license": "MIT",
        "copyright_holder": "Junbum Lee (beomi)",
        "citation": "Junbum Lee. KcELECTRA: Korean comments ELECTRA. GitHub repository, 2021. https://github.com/Beomi/KcELECTRA",
        "obligation": "가중치를 배포하면 KcELECTRA의 MIT 저작권 고지와 라이선스 전문을 함께 넣는다.",
    },
    "training_data": {
        "name": DATASET_REPOSITORY,
        "license": "CC-BY-4.0",
        "license_url": "https://creativecommons.org/licenses/by/4.0/",
        "attribution": (
            "Chaewon Park, Suhwan Kim, Kyubyong Park, Kunwoo Park. K-HATERS: A Hate Speech Detection Corpus in Korean "
            "with Target-Specific Ratings. Findings of EMNLP 2023. https://huggingface.co/datasets/humane-lab/K-HATERS"
        ),
        "changes": "라벨 4종(normal·offensive·L1_hate·L2_hate)을 이진(normal=0, 그 밖=1)으로 바꿔 미세조정에 썼다.",
    },
    "redistribution": (
        "Do not redistribute without attribution. 찌리릿 가드는 이 가중치를 배포하지 않는다(스펙 §17). "
        "배포하게 되면 K-HATERS(CC-BY 4.0) 출처·변경 사항과 KcELECTRA(MIT) 저작권 고지를 함께 표기한다."
    ),
}


def utc_timestamp() -> str:
    """현재 시각을 UTC ISO 8601(초 단위) 문자열로 돌려준다. 시간대가 다른 기기에서도 순서를 비교하기 위해 UTC로 쓴다."""
    return datetime.now(UTC).isoformat(timespec="seconds")


def collect_library_versions() -> dict[str, str]:
    """파이썬과 주요 라이브러리 버전을 모은다. 설치되지 않은 것은 'not installed'로 남긴다(숨기지 않는다)."""
    versions = {"python": platform.python_version()}
    for library_name in TRACKED_LIBRARIES:
        try:
            versions[library_name] = metadata.version(library_name)
        except metadata.PackageNotFoundError:
            versions[library_name] = "not installed"
    return versions


def annotate_reference_match(provenance: dict) -> dict:
    """파일 출처 정보에 고정 리비전의 sha256과 같은지(matches_reference)를 덧붙인다.

    기준값이 없는 파일이면 None이다. 다르다고 학습을 막지는 않는다(운영자가 다른 리비전을 일부러 쓸 수 있어서다).
    """
    reference = REFERENCE_SHA256.get(provenance["file_name"])
    return {**provenance, "matches_reference": None if reference is None else provenance["sha256"] == reference}


def build_initial_model_card(base_model: dict, training_data: dict, hyperparameters: dict, device: str, input_format: str) -> dict:
    """학습을 시작할 때의 모델 카드를 만든다. epoch 결과와 종료 정보는 학습 중에 채운다.

    base_model: 기반 모델 디렉터리 이름과 가중치 출처. training_data: train·validation 파일 출처.
    hyperparameters: 학습 설정(시드 포함). device: 학습 장치. input_format: 토크나이저 입력 형식 설명.
    """
    return {
        "schema_version": MODEL_CARD_SCHEMA_VERSION,
        "status": "running",
        "task": "zzirit-guard stage-1 binary toxicity sieve (normal=0, toxic=1)",
        "base_model": {**base_model, "repository": BASE_MODEL_REPOSITORY, "pinned_revision": BASE_MODEL_REVISION},
        "training_data": {**training_data, "repository": DATASET_REPOSITORY, "pinned_revision": DATASET_REVISION},
        "label_mapping": {"normal": 0, "offensive": 1, "L1_hate": 1, "L2_hate": 1},
        "input_format": input_format,
        "hyperparameters": hyperparameters,
        "device": device,
        "libraries": collect_library_versions(),
        "epochs": [],
        "chosen_epoch": None,
        "best_validation_auc": None,
        "stop_reason": None,
        "started_at": utc_timestamp(),
        "finished_at": None,
        "licenses": LICENSE_NOTES,
    }


def write_json_atomically(path: Path, payload: dict) -> None:
    """JSON을 임시 파일에 쓴 뒤 이름을 바꿔 넣는다.

    왜: 학습 도중 중단되어도 카드가 반쯤 쓰인 깨진 파일로 남지 않게 하기 위해서다(os.replace는 원자적이다).
    """
    temporary_path = path.with_name(f".{path.name}.tmp")
    temporary_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary_path, path)


def read_model_card(model_directory: Path) -> dict | None:
    """모델 디렉터리의 카드를 읽는다. 없으면 None이다(카드 없이 만든 디렉터리도 평가는 할 수 있게)."""
    card_path = model_directory / MODEL_CARD_FILE_NAME
    if not card_path.is_file():
        return None
    try:
        return json.loads(card_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ModelFormatError(
            f"{MODEL_CARD_FILE_NAME}을 JSON으로 읽을 수 없습니다({error.msg}). 학습이 중간에 끊겼는지 확인하고, 필요하면 다시 학습하세요."
        ) from error


def require_completed_training(card: dict | None, directory_name: str) -> None:
    """카드가 있으면 학습이 끝난 모델인지 확인한다. 끝나지 않았으면 ModelFormatError로 멈춘다.

    card: read_model_card의 결과. directory_name: 오류 메시지에 쓸 모델 디렉터리 이름.
    왜: 학습 도구는 epoch마다 최고 가중치와 카드를 다시 쓴다. 학습 중에 평가하면 중간 체크포인트를 재서
    최종 모델과 다른 모델로 판정하게 된다(M2 3차에서 실제로 났다). 카드가 없는 디렉터리는 지금처럼 평가를 허용한다.
    """
    if card is None:
        return
    status = card.get("status") if isinstance(card, dict) else None
    if status != COMPLETED_STATUS:
        raise ModelFormatError(
            f"{directory_name}의 학습이 끝나지 않았습니다(model-card.json status={status!r}). "
            "학습이 끝나 status가 completed가 된 뒤 평가하세요. 중간 체크포인트는 최종 모델과 다를 수 있습니다."
        )
