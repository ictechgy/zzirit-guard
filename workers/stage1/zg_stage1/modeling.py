"""토크나이저·분류 모델 불러오기, 입력 만들기, 유해 확률 계산, 저장.

torch·transformers에 기대는 코드를 이 모듈에 모은다. 학습(train.py)과 평가(evaluate.py), 나중의 워커가
같은 함수로 입력을 만들어야 학습 때와 운영 때의 점수가 어긋나지 않기 때문이다.
보안: 가중치는 safetensors만 읽고(use_safetensors=True), 원격 코드는 실행하지 않으며(trust_remote_code=False),
네트워크에 접속하지 않는다(local_files_only=True).
"""

from __future__ import annotations

import os
import random
import shutil
import tempfile
from collections.abc import Sequence
from pathlib import Path

import numpy
import torch
from tokenizers.processors import TemplateProcessing
from transformers import AutoModelForSequenceClassification, AutoTokenizer, PreTrainedModel, PreTrainedTokenizerBase

from zg_stage1.batching import build_inference_batches
from zg_stage1.errors import ModelFormatError, Stage1Error
from zg_stage1.paths import ensure_safetensors_only

# 이진 라벨 이름. config.json에 넣어 두면 워커·사람이 출력 두 칸의 뜻을 헷갈리지 않는다.
ID_TO_LABEL: dict[int, str] = {0: "normal", 1: "toxic"}

# ID_TO_LABEL의 역방향(라벨 이름 → 번호).
LABEL_TO_ID: dict[str, int] = {label: index for index, label in ID_TO_LABEL.items()}

# 라벨 이름이 없을 때 transformers가 채우는 기본 이름. 이 이름뿐이면 매핑 검사를 건너뛴다.
GENERIC_LABEL_NAMES: frozenset[str] = frozenset({"LABEL_0", "LABEL_1"})

# softmax 출력에서 '유해' 칸의 번호. 1차 점수는 이 칸의 확률이다.
TOXIC_CLASS_INDEX = 1

# --device 선택지. auto는 MPS가 되면 mps, 아니면 cpu다.
DEVICE_CHOICES: tuple[str, ...] = ("auto", "mps", "cpu")

# 추론(검증·평가) 배치 크기 기본값. 학습이 아니라서 역전파 메모리가 없어 학습 배치보다 크게 잡는다.
DEFAULT_INFERENCE_BATCH_SIZE = 128

# 모델 카드에 남기는 입력 형식 설명. 워커가 같은 형식으로 넣어야 점수가 학습 때와 같다.
INPUT_FORMAT_DESCRIPTION = "[CLS] 문장 [SEP] — 저장한 tokenizer.json의 post_processor가 붙인다"

# 토크나이저가 특수 토큰을 붙이는지 확인할 때 쓰는 아주 짧은 문장(데이터 원문이 아니다).
SPECIAL_TOKEN_PROBE_TEXT = "가"

# 최고 epoch를 저장할 때 쓰는 임시 하위 디렉터리 이름 접두사. 점으로 시작해 결과 파일과 구분한다.
STAGING_DIRECTORY_PREFIX = ".saving-"

# 임시 디렉터리에서 옮길 때 가장 마지막에 옮기는 파일. 가중치가 바뀌는 순간을 하나로 만들기 위해서다.
WEIGHTS_FILE_NAME = "model.safetensors"

# 저장한 토크나이저를 다시 불러와 비교할 고정 탐침 문장(데이터 원문이 아니다).
# 보통 문장·빈 문장·숫자와 영문 섞임·max_length(128)보다 긴 문장을 넣어 잘림까지 같게 나오는지 본다.
ROUND_TRIP_PROBE_TEXTS: tuple[str, ...] = (
    "가",
    "안녕하세요 반갑습니다",
    "",
    "ㅋㅋㅋ 진짜?? 123 abc",
    "가나다라마바사 " * 40,
)


def resolve_device(requested_device: str) -> str:
    """사용할 장치를 정한다. auto면 MPS가 되면 mps, 아니면 cpu다.

    주의: mps를 직접 골랐는데 쓸 수 없으면 조용히 cpu로 바꾸지 않고 오류를 낸다. 학습 시간이 몇 배 늘어나는 것을
    모르고 기다리지 않게 하기 위해서다.
    """
    is_mps_available = torch.backends.mps.is_available()
    if requested_device == "auto":
        return "mps" if is_mps_available else "cpu"
    if requested_device == "mps" and not is_mps_available:
        raise Stage1Error("MPS(애플 GPU)를 쓸 수 없습니다. Apple Silicon 맥인지 확인하거나 --device cpu로 실행하세요.")
    return requested_device


def set_global_seed(seed: int) -> None:
    """파이썬·numpy·torch(CPU·MPS 포함) 난수 시드를 고정한다.

    주의: MPS의 일부 연산은 비결정적이라, 같은 시드여도 손실·점수가 소수점 아래에서 조금 다를 수 있다.
    """
    random.seed(seed)
    numpy.random.seed(seed)
    torch.manual_seed(seed)


def install_special_token_template(tokenizer: PreTrainedTokenizerBase) -> None:
    """토크나이저가 문장마다 [CLS] … [SEP]을 붙이도록 후처리 규칙을 넣는다.

    왜: beomi/KcELECTRA-base 현재 리비전(v2023 BBPE)의 tokenizer.json에는 후처리 규칙이 없어 특수 토큰이 붙지 않는다.
    ELECTRA 분류 헤드는 첫 위치(원래 [CLS] 자리)의 벡터로 판정하므로 [CLS]를 맨 앞에 둔다. 빈 문장도 [CLS][SEP]가 되어
    길이 0 입력이 생기지 않는다. 이 규칙은 저장한 tokenizer.json에 들어가므로, 워커는 저장된 토크나이저만 쓰면 된다.
    """
    cls_token, separator_token = tokenizer.cls_token, tokenizer.sep_token
    tokenizer.backend_tokenizer.post_processor = TemplateProcessing(
        single=f"{cls_token} $A {separator_token}",
        pair=f"{cls_token} $A {separator_token} $B:1 {separator_token}:1",
        special_tokens=[(cls_token, tokenizer.cls_token_id), (separator_token, tokenizer.sep_token_id)],
    )


def ensure_tokenizer_wraps_special_tokens(tokenizer: PreTrainedTokenizerBase) -> None:
    """토크나이저가 [CLS] … [SEP]으로 감싸는지 확인한다.

    아니면 학습 때와 입력이 달라 점수가 어긋나므로 오류를 낸다(예: 기반 모델 디렉터리를 평가에 잘못 넘긴 경우).
    """
    token_ids = tokenizer(SPECIAL_TOKEN_PROBE_TEXT)["input_ids"]
    if not token_ids or token_ids[0] != tokenizer.cls_token_id or token_ids[-1] != tokenizer.sep_token_id:
        raise ModelFormatError("토크나이저가 [CLS] … [SEP]으로 감싸지 않습니다. 이 패키지의 train으로 만든 디렉터리를 --model-dir로 주세요.")


def load_tokenizer(model_directory: Path) -> PreTrainedTokenizerBase:
    """로컬 디렉터리에서 토크나이저를 불러온다. 네트워크에 접속하지 않고 원격 코드를 실행하지 않는다."""
    return AutoTokenizer.from_pretrained(str(model_directory), local_files_only=True, trust_remote_code=False)


def load_base_tokenizer(model_directory: Path) -> PreTrainedTokenizerBase:
    """기반 모델의 토크나이저를 불러와 [CLS]·[SEP] 후처리 규칙을 넣는다(학습 시작 때 쓴다)."""
    tokenizer = load_tokenizer(model_directory)
    install_special_token_template(tokenizer)
    ensure_tokenizer_wraps_special_tokens(tokenizer)
    return tokenizer


def load_trained_tokenizer(model_directory: Path) -> PreTrainedTokenizerBase:
    """학습 결과의 토크나이저를 불러오고, 학습 때와 같은 입력 형식인지 확인한다(평가·워커가 쓴다)."""
    tokenizer = load_tokenizer(model_directory)
    ensure_tokenizer_wraps_special_tokens(tokenizer)
    return tokenizer


def verify_saved_tokenizer_round_trip(tokenizer: PreTrainedTokenizerBase, model_directory: Path, max_length: int) -> None:
    """저장한 토크나이저를 다시 불러와, 고정 탐침 문장의 토큰 ID가 메모리의 토크나이저와 같은지 확인한다.

    왜: 워커는 저장된 토크나이저만 쓴다. 저장 과정에서 [CLS]·[SEP] 규칙이나 어휘가 바뀌면 학습 때와 다른 입력으로
    점수를 내게 되는데, 겉으로는 드러나지 않는다. 그래서 저장 직후에 확인하고, 다르면 학습을 멈춘다.
    max_length: 학습 때의 최대 토큰 수(잘림 동작까지 같은지 본다).
    """
    reloaded = load_trained_tokenizer(model_directory)
    expected = encode_texts(tokenizer, ROUND_TRIP_PROBE_TEXTS, max_length)
    actual = encode_texts(reloaded, ROUND_TRIP_PROBE_TEXTS, max_length)
    mismatched = [index for index, (left, right) in enumerate(zip(expected, actual, strict=True)) if left != right]
    if mismatched:
        raise ModelFormatError(
            f"다시 불러온 토크나이저의 토큰이 학습 중인 토크나이저와 다릅니다(탐침 {mismatched}번). "
            "transformers·tokenizers 버전이 uv.lock과 같은지 확인하고 다시 학습하세요."
        )


def ensure_label_mapping_matches(model: PreTrainedModel) -> None:
    """config의 라벨 이름이 학습 때 저장한 {0: normal, 1: toxic}과 정확히 같은지 확인한다.

    왜: 점수는 항상 1번 칸을 유해로 읽는다. 0번이 toxic인 모델이면 모든 점수가 뒤집히는데 겉으로는 드러나지 않는다.
    이름이 없는 모델(transformers 기본값 LABEL_0·LABEL_1)은 뜻을 알 수 없어 통과시킨다. 이 패키지의 train이 항상
    ID_TO_LABEL·LABEL_TO_ID를 config에 저장하므로 기존 학습 결과는 모두 이 검사를 통과한다.
    """
    id_to_label = {int(index): label for index, label in (model.config.id2label or {}).items()}
    if set(id_to_label.values()) == GENERIC_LABEL_NAMES:
        return
    if id_to_label != ID_TO_LABEL or {str(label): int(index) for label, index in (model.config.label2id or {}).items()} != LABEL_TO_ID:
        raise ModelFormatError(
            f"모델 config의 라벨 매핑 {id_to_label}이 기대값 {ID_TO_LABEL}과 다릅니다. 1번 칸이 toxic이 아니면 점수가 뒤집힙니다. "
            "이 패키지의 train으로 만든 디렉터리를 --model-dir로 주세요."
        )


def ensure_binary_classifier(model: PreTrainedModel) -> None:
    """출력이 2칸(정상·유해)이고 라벨 매핑이 약속과 같은 분류 모델인지 확인한다. 아니면 점수 뜻이 달라지므로 오류를 낸다."""
    if model.config.num_labels != len(ID_TO_LABEL):
        raise ModelFormatError(f"분류 출력이 {model.config.num_labels}칸입니다. 2칸(normal·toxic) 모델이어야 합니다. --model-dir를 확인하세요.")
    ensure_label_mapping_matches(model)


def load_classifier(model_directory: Path, **config_overrides: object) -> PreTrainedModel:
    """로컬 디렉터리에서 분류 모델을 fp32로 불러온다. safetensors만 읽고 원격 코드는 실행하지 않는다.

    config_overrides: 라벨 수·라벨 이름처럼 config를 덮어쓸 값(기반 모델에 새 헤드를 붙일 때 쓴다).
    """
    ensure_safetensors_only(model_directory)
    model = AutoModelForSequenceClassification.from_pretrained(
        str(model_directory),
        use_safetensors=True,
        trust_remote_code=False,
        local_files_only=True,
        dtype=torch.float32,
        **config_overrides,
    )
    ensure_binary_classifier(model)
    return model


def load_base_classifier(model_directory: Path) -> PreTrainedModel:
    """기반 모델(ELECTRA 판별기)에 새 2라벨 분류 헤드를 붙여 불러온다.

    불러올 때 classifier.* 가 MISSING, discriminator_predictions.* 가 UNEXPECTED로 표시되는 것은 정상이다
    (판별기 헤드를 버리고 분류 헤드를 새로 만들기 때문이다).
    """
    return load_classifier(model_directory, num_labels=len(ID_TO_LABEL), id2label=ID_TO_LABEL, label2id=LABEL_TO_ID)


def load_trained_classifier(model_directory: Path) -> PreTrainedModel:
    """학습 결과 디렉터리의 분류 모델을 불러온다."""
    return load_classifier(model_directory)


def move_model_to_device(model: PreTrainedModel, device: str) -> PreTrainedModel:
    """모델을 장치로 옮기고 같은 모델을 돌려준다.

    왜 함수로 감싸나: transformers 5의 PreTrainedModel.to 타입 표기가 self를 잃어 mypy가 str 인자를 오류로 본다.
    실제 동작에는 문제가 없으므로, 타입 검사 예외를 이 한곳에만 둔다.
    """
    return model.to(device)  # type: ignore[arg-type]


def encode_texts(tokenizer: PreTrainedTokenizerBase, texts: Sequence[str], max_length: int) -> list[list[int]]:
    """문장을 토큰 ID 목록으로 바꾼다(패딩 없이, [CLS]·[SEP] 포함, max_length로 자름).

    학습 전에 한 번에 바꿔 두는 이유는, 스텝마다 토큰화하는 비용을 없애기 위해서다.
    """
    if not texts:
        return []
    return tokenizer(list(texts), truncation=True, max_length=max_length)["input_ids"]


def collate_batch(token_lists: Sequence[Sequence[int]], batch_indices: Sequence[int], pad_token_id: int) -> dict[str, torch.Tensor]:
    """배치 안에서 가장 긴 문장에 맞춰 오른쪽을 패딩하고 attention_mask를 만든다(CPU 텐서).

    반환: {"input_ids": (배치, 길이), "attention_mask": (배치, 길이)}.
    """
    longest_length = max(len(token_lists[index]) for index in batch_indices)
    input_ids = torch.full((len(batch_indices), longest_length), pad_token_id, dtype=torch.long)
    attention_mask = torch.zeros((len(batch_indices), longest_length), dtype=torch.long)
    for row, index in enumerate(batch_indices):
        tokens = token_lists[index]
        input_ids[row, : len(tokens)] = torch.tensor(tokens, dtype=torch.long)
        attention_mask[row, : len(tokens)] = 1
    return {"input_ids": input_ids, "attention_mask": attention_mask}


def move_batch_to_device(batch: dict[str, torch.Tensor], device: str) -> dict[str, torch.Tensor]:
    """배치 텐서를 모두 같은 장치로 옮긴다."""
    return {name: tensor.to(device) for name, tensor in batch.items()}


def compute_toxic_probabilities(logits: torch.Tensor) -> list[float]:
    """로짓을 softmax로 바꿔 '유해' 칸 확률만 꺼낸다. fp32로 올려 계산해 반올림 오차를 줄인다."""
    return torch.softmax(logits.float(), dim=-1)[:, TOXIC_CLASS_INDEX].tolist()


@torch.no_grad()
def predict_toxic_probabilities(
    model: PreTrainedModel,
    token_lists: Sequence[Sequence[int]],
    pad_token_id: int,
    device: str,
    batch_size: int = DEFAULT_INFERENCE_BATCH_SIZE,
) -> list[float]:
    """문장별 유해 확률을 입력 순서대로 돌려준다. 길이순으로 묶어 계산한 뒤 제자리에 놓는다.

    모델의 train/eval 상태는 호출 전으로 되돌린다(학습 중 검증에서 불러도 안전하게).
    """
    was_training = model.training
    model.eval()
    probabilities = [0.0] * len(token_lists)
    for batch_indices in build_inference_batches([len(tokens) for tokens in token_lists], batch_size):
        batch = move_batch_to_device(collate_batch(token_lists, batch_indices, pad_token_id), device)
        for index, probability in zip(batch_indices, compute_toxic_probabilities(model(**batch).logits), strict=True):
            probabilities[index] = probability
    model.train(was_training)
    return probabilities


def score_texts(
    model: PreTrainedModel,
    tokenizer: PreTrainedTokenizerBase,
    texts: Sequence[str],
    device: str,
    max_length: int,
    batch_size: int = DEFAULT_INFERENCE_BATCH_SIZE,
) -> list[float]:
    """문장 목록의 유해 확률을 계산한다(토큰화 + 예측)."""
    token_lists = encode_texts(tokenizer, texts, max_length)
    return predict_toxic_probabilities(model, token_lists, tokenizer.pad_token_id, device, batch_size)


def copy_state_to_cpu(model: PreTrainedModel) -> dict[str, torch.Tensor]:
    """현재 가중치를 CPU 사본으로 뜬다. 실수 텐서는 fp32로 맞춘다.

    왜: 최고 epoch를 저장할 때 학습 장치(MPS)의 텐서를 직접 직렬화하지 않고, 저장 형식을 fp32로 확정하기 위해서다.
    """
    return {
        name: tensor.detach().to("cpu", dtype=torch.float32 if tensor.is_floating_point() else tensor.dtype, copy=True)
        for name, tensor in model.state_dict().items()
    }


def save_classifier(model: PreTrainedModel, tokenizer: PreTrainedTokenizerBase, state_dict: dict[str, torch.Tensor], output_directory: Path) -> None:
    """가중치(safetensors)·config·토크나이저를 output_directory에 바로 저장한다.

    주의: 중간에 끊기면 반쯤 쓴 파일이 남으므로 학습 결과에는 save_classifier_atomically를 쓴다.
    이 함수는 그 안에서 임시 디렉터리에 쓰는 단계로만 쓴다.
    """
    model.save_pretrained(str(output_directory), state_dict=state_dict)
    tokenizer.save_pretrained(str(output_directory))


def move_staged_files(staging_directory: Path, output_directory: Path) -> None:
    """임시 디렉터리의 파일을 출력 디렉터리로 하나씩 os.replace로 옮긴다. 가중치 파일은 맨 마지막에 옮긴다.

    os.replace는 같은 파일 시스템 안에서 원자적이라, 출력 디렉터리의 각 파일은 '이전 것' 아니면 '새 것'이다.
    """
    staged_files = sorted(staging_directory.iterdir(), key=lambda path: (path.name == WEIGHTS_FILE_NAME, path.name))
    for staged_file in staged_files:
        os.replace(staged_file, output_directory / staged_file.name)


def save_classifier_atomically(model: PreTrainedModel, tokenizer: PreTrainedTokenizerBase, state_dict: dict[str, torch.Tensor], output_directory: Path) -> None:
    """출력 디렉터리 안의 임시 하위 디렉터리에 먼저 저장한 뒤 파일을 옮겨 넣는다.

    왜: 저장 도중 중단(디스크 부족·강제 종료)되면 반쯤 쓴 model.safetensors가 '최고 epoch'로 남을 수 있다.
    임시 디렉터리는 성공·실패와 관계없이 지운다. 저장 중 난 예외는 삼키지 않고 그대로 올린다.
    """
    staging_directory = Path(tempfile.mkdtemp(prefix=STAGING_DIRECTORY_PREFIX, dir=output_directory))
    try:
        save_classifier(model, tokenizer, state_dict, staging_directory)
        move_staged_files(staging_directory, output_directory)
    finally:
        shutil.rmtree(staging_directory)
