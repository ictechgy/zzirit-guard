"""1차 분류기 워커: 학습한 KcELECTRA로 채팅의 유해 확률을 매겨 서버에 돌려준다(스펙 §5.2 ④, 워커 계약 v1).

CLI 사용 예:
  export ZG_DATA_DIR="$HOME/Library/Application Support/zzirit-guard"
  uv run python -m zg_stage1.worker --model-dir "$ZG_DATA_DIR/ml/stage1/<학습 결과>"

- 소켓은 `$ZG_DATA_DIR/run/stage1.sock`이다. 모델을 다 불러오고 데운 뒤에 만든다.
- CPU에서 돈다. GPU는 2차(kanana)가 쓴다. 스레드 수는 --threads(기본 6)로 정한다.
- 학습 결과의 inference.json(추론 계약)대로 max_length를 쓴다. 계약이 없으면 시작하지 않는다.
- 로그에는 건수와 지연만 남긴다. 채팅 원문은 남기지 않는다.
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import os
import signal
import sys
import threading
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

import torch

from zg_stage1.arguments import positive_integer
from zg_stage1.errors import ModelFormatError, PathResolutionError, Stage1Error
from zg_stage1.inference_contract import REGENERATE_HINT, read_inference_contract
from zg_stage1.modeling import load_trained_classifier, load_trained_tokenizer, score_texts
from zg_stage1.paths import DATA_DIRECTORY_VARIABLE, ensure_existing_directory, ensure_safetensors_only
from zg_stage1.worker_contract import STAGE1_CATEGORIES, ItemVerdict, validate_model_identifier
from zg_stage1.worker_runtime import (
    InferenceRunner,
    WorkerSetupError,
    acquire_instance_lock,
    remove_stale_socket,
    resolve_run_directory,
    socket_path_for,
)
from zg_stage1.worker_server import WorkerHTTPServer, WorkerSettings

# 워커 이름. 소켓(`stage1.sock`)과 잠금 파일 이름에 쓴다.
WORKER_NAME = "stage1"

# 한 요청의 항목 수 상한(계약 v1). 서버는 16건씩 보낸다.
MAX_ITEMS_PER_REQUEST = 32

# 모델 순전파 묶음 크기. 처리량을 잰 조건(16건 묶음)과 같다.
INFERENCE_BATCH_SIZE = 16

# PyTorch CPU 스레드 기본값. 맥 미니 12코어에서 서버(Node)와 2차 몫을 남긴다.
DEFAULT_THREADS = 6

# 모델 식별자에 붙이는 가중치 sha256 앞 글자 수.
MODEL_HASH_PREFIX_LENGTH = 12

# 모델 식별자 해시에 가중치와 함께 넣는 파일. 토크나이저·설정·추론 계약이 바뀌어도 점수가 달라지므로 같이 본다.
IDENTITY_FILE_NAMES = ("config.json", "tokenizer.json", "tokenizer_config.json", "inference.json")

# 데우기에 쓰는 문장(채팅이 아닌 고정 문장).
WARMUP_TEXTS = ("준비",)

# 사용자 오류로 끝날 때의 종료 코드(학습 CLI와 같다).
USER_ERROR_EXIT_CODE = 2

LOGGER = logging.getLogger("zg_worker")


def build_argument_parser() -> argparse.ArgumentParser:
    """CLI 인자."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage1.worker", description="1차 분류기 워커(유닉스 소켓, 워커 계약 v1)")
    parser.add_argument("--model-dir", type=Path, required=True, help="학습 결과 디렉터리(inference.json·safetensors가 있는 곳)")
    parser.add_argument("--threads", type=positive_integer, default=DEFAULT_THREADS, help=f"PyTorch CPU 스레드 수(기본 {DEFAULT_THREADS})")
    parser.add_argument("--data-dir", type=Path, help=f"데이터 디렉터리(기본: ${DATA_DIRECTORY_VARIABLE}). 소켓은 그 아래 run/에 만든다")
    return parser


def resolve_data_directory(explicit_path: Path | None, environment: Mapping[str, str]) -> Path:
    """데이터 디렉터리: 인자 → 환경 변수 순서. 둘 다 없으면 오류다(서버와 같은 디렉터리여야 소켓을 찾는다)."""
    if explicit_path is not None:
        return explicit_path
    value = environment.get(DATA_DIRECTORY_VARIABLE)
    if not value:
        raise PathResolutionError(f"--data-dir이나 {DATA_DIRECTORY_VARIABLE}을 주세요. 서버와 같은 데이터 디렉터리여야 합니다.")
    return Path(value)


def identity_files(model_directory: Path) -> list[Path]:
    """모델 식별자에 넣는 파일: 가중치 전부와, 있으면 설정·토크나이저·추론 계약(이름순)."""
    extras = [model_directory / name for name in IDENTITY_FILE_NAMES if (model_directory / name).is_file()]
    return sorted(ensure_safetensors_only(model_directory) + extras)


def compute_model_identifier(model_directory: Path) -> str:
    """모델 식별자 `<디렉터리 이름>@<sha256 앞 12자>`. 가중치·토크나이저·설정 중 하나만 바뀌어도 서버가 알아채고 점수 캐시를 비우게 한다."""
    digest = hashlib.sha256()
    for path in identity_files(model_directory):
        digest.update(path.name.encode("utf-8") + b"\0")
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
    return validate_model_identifier(f"{model_directory.name}@{digest.hexdigest()[:MODEL_HASH_PREFIX_LENGTH]}")


def read_required_max_length(model_directory: Path) -> int:
    """추론 계약의 max_length. 계약이 없으면 학습 때와 다른 길이로 채점할 수 있어 시작하지 않는다."""
    contract = read_inference_contract(model_directory)
    if contract is None:
        raise ModelFormatError(f"{model_directory.name}에 inference.json이 없습니다. {REGENERATE_HINT}")
    return int(contract["max_length"])


def load_scorer(model_directory: Path, threads: int) -> Callable[[Sequence[str]], list[ItemVerdict]]:
    """모델을 CPU에 불러와 '문장 목록 → 판정 목록' 함수를 만든다. 추론 스레드에서만 부른다."""
    max_length = read_required_max_length(model_directory)
    torch.set_num_threads(threads)
    model = load_trained_classifier(model_directory)
    model.eval()
    tokenizer = load_trained_tokenizer(model_directory)

    def score(texts: Sequence[str]) -> list[ItemVerdict]:
        """문장마다 유해 확률을 매긴다. 1차라 범주는 없다."""
        return [ItemVerdict(probability, None) for probability in score_texts(model, tokenizer, texts, "cpu", max_length, INFERENCE_BATCH_SIZE)]

    return score


def stop_on_terminate(server: WorkerHTTPServer) -> None:
    """SIGTERM·SIGINT를 받으면 서버를 멈춘다. serve_forever가 도는 스레드에서 shutdown을 부르면 멈춰 버려 다른 스레드에서 부른다."""

    def request_shutdown(signal_number: int, frame: object) -> None:
        LOGGER.info("종료 신호(%d)를 받아 워커를 멈춥니다.", signal_number)
        threading.Thread(target=server.shutdown, name="shutdown", daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)


def serve_until_stopped(socket_path: Path, settings: WorkerSettings, on_ready: Callable[[WorkerHTTPServer], None]) -> None:
    """소켓을 만들고 멈출 때까지 받는다. 끝나면 소켓 파일을 지운다(다음 시작 때 남은 소켓으로 헷갈리지 않게).

    on_ready: 소켓을 만든 직후 서버를 받는 함수. CLI는 종료 신호 처리기를 걸고, 테스트는 서버를 붙잡아 나중에 멈춘다.
    """
    server = WorkerHTTPServer(socket_path, settings)
    on_ready(server)
    LOGGER.info("워커 준비 완료: 모델 %s, 소켓 %s", settings.model, socket_path.name)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        socket_path.unlink(missing_ok=True)


def build_warmed_scorer(model_directory: Path, threads: int) -> Callable[[Sequence[str]], list[ItemVerdict]]:
    """모델을 불러와 한 번 데운 점수 함수. 추론 스레드 안에서 불러, 모델을 만든 스레드가 계속 쓰게 한다."""
    scorer = load_scorer(model_directory, threads)
    scorer(list(WARMUP_TEXTS))
    return scorer


def serve_model(model_directory: Path, threads: int, socket_path: Path, on_ready: Callable[[WorkerHTTPServer], None]) -> None:
    """모델 식별자를 계산하고, 추론 스레드에서 모델을 준비한 뒤 소켓을 연다. 끝나면 추론 스레드를 멈춘다."""
    model = compute_model_identifier(model_directory)
    runner = InferenceRunner(lambda: build_warmed_scorer(model_directory, threads))
    runner.start()
    try:
        serve_until_stopped(socket_path, WorkerSettings(model, MAX_ITEMS_PER_REQUEST, runner, STAGE1_CATEGORIES), on_ready)
    finally:
        runner.stop()


def start_worker(arguments: argparse.Namespace, environment: Mapping[str, str], on_ready: Callable[[WorkerHTTPServer], None] = stop_on_terminate) -> None:
    """잠금 → 남은 소켓 정리 → 모델 불러오기·데우기 → 소켓 순서로 시작한다.

    소켓 경로 길이는 모델을 불러오기 전에 확인한다. 앞선 인스턴스가 남긴 소켓은 잠금을 잡은 직후 지운다.
    그래서 준비가 끝나기 전에는 소켓이 없고, 서버는 "연결 안 됨"으로 본다. 잠금은 소켓을 지운 뒤에 푼다.
    """
    model_directory = ensure_existing_directory(arguments.model_dir, "1차 분류기 학습 결과")
    run_directory = resolve_run_directory(resolve_data_directory(arguments.data_dir, environment))
    socket_path = socket_path_for(run_directory, WORKER_NAME)
    lock_file = acquire_instance_lock(run_directory, WORKER_NAME)
    try:
        remove_stale_socket(socket_path)
        serve_model(model_directory, arguments.threads, socket_path, on_ready)
    finally:
        lock_file.close()


def configure_logging() -> None:
    """표준 오류로 로그를 남긴다(launchd가 로그 파일로 보낸다)."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stderr)


def main(argv: Sequence[str] | None = None, environment: Mapping[str, str] | None = None) -> None:
    """워커를 띄운다. 환경 문제는 traceback 없이 원인과 해결 방향만 보이고 종료 코드 2로 끝낸다."""
    configure_logging()
    arguments = build_argument_parser().parse_args(argv)
    try:
        start_worker(arguments, os.environ if environment is None else environment)
    except (Stage1Error, WorkerSetupError) as error:
        print(f"오류: {error}", file=sys.stderr)
        raise SystemExit(USER_ERROR_EXIT_CODE) from error


if __name__ == "__main__":
    main()
