"""2차 분류기 워커: kanana-safeguard-8b(mlx 4비트)로 채팅의 유해 확률과 범주를 매겨 서버에 돌려준다(스펙 §5.2 ⑤, 워커 계약 v1).

CLI 사용 예:
  export ZG_DATA_DIR="$HOME/Library/Application Support/zzirit-guard"
  uv run python -m zg_stage2.worker --model-dir "$ZG_DATA_DIR/ml/stage2/kanana-safeguard-8b-mlx-4bit"

- 소켓은 `$ZG_DATA_DIR/run/stage2.sock`이다. 모델을 다 불러오고 데운 뒤에 만든다.
- GPU(mlx)에서 직렬로 돈다. 한 요청은 1~4건이고, 서버는 1건씩 보낸다.
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

from zg_stage2.errors import PathResolutionError, Stage2Error
from zg_stage2.worker_contract import STAGE2_CATEGORIES, ItemVerdict, validate_model_identifier
from zg_stage2.worker_runtime import (
    InferenceRunner,
    WorkerSetupError,
    acquire_instance_lock,
    remove_stale_socket,
    resolve_run_directory,
    socket_path_for,
)
from zg_stage2.worker_server import WorkerHTTPServer, WorkerSettings

# 워커 이름. 소켓(`stage2.sock`)과 잠금 파일 이름에 쓴다.
WORKER_NAME = "stage2"

# 한 요청의 항목 수 상한(계약 v1). 1건씩만 받는다. 직렬 추론이라 묶어도 빨라지지 않고, 여러 건이면 한 요청이
# 서버의 2초 제한과 감시 시간(10초)을 넘길 수 있다(채팅 1건은 최대 MAX_CONTENT_TOKENS, 약 1초).
MAX_ITEMS_PER_REQUEST = 1

# 서버와 같은 데이터 디렉터리를 가리키는 환경 변수.
DATA_DIRECTORY_VARIABLE = "ZG_DATA_DIR"

# 모델 식별자 해시에서 뺄 파일. 설명 문서는 판정에 영향이 없다. 숨김 파일(.DS_Store 등)도 뺀다.
IDENTITY_EXCLUDED_NAMES = frozenset({"README.md", "LICENSE"})

# 모델 식별자에 붙이는 sha256 앞 글자 수.
MODEL_HASH_PREFIX_LENGTH = 12

# 데우기에 쓰는 문장(채팅이 아닌 고정 문장).
WARMUP_TEXTS = ("준비",)

# 사용자 오류로 끝날 때의 종료 코드(1차 워커와 같다).
USER_ERROR_EXIT_CODE = 2

LOGGER = logging.getLogger("zg_worker")


def build_argument_parser() -> argparse.ArgumentParser:
    """CLI 인자."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage2.worker", description="2차 분류기 워커(유닉스 소켓, 워커 계약 v1)")
    parser.add_argument("--model-dir", type=Path, required=True, help="kanana-safeguard-8b mlx 디렉터리(safetensors·토크나이저·채팅 템플릿)")
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


def ensure_model_directory(model_directory: Path) -> Path:
    """모델 디렉터리에 mlx_lm이 읽는 가중치(model*.safetensors)와 config.json이 있는지 확인한다.

    없는 경로를 mlx_lm에 넘기면 허브 저장소 이름으로 오해하고, 다른 이름의 safetensors(어댑터 등)만 있으면 시작 중에 실패한다.
    """
    has_weights = model_directory.is_dir() and any(model_directory.glob("model*.safetensors"))
    if not has_weights or not (model_directory / "config.json").is_file():
        raise PathResolutionError(f"{model_directory.name}에 model*.safetensors나 config.json이 없습니다. mlx 변환 결과 디렉터리인지 확인하세요.")
    return model_directory


def identity_files(model_directory: Path) -> list[Path]:
    """모델 식별자에 넣는 파일: 디렉터리의 모든 일반 파일(숨김 파일·설명 문서 제외, 이름순).

    왜 전부인가: 가중치·설정뿐 아니라 토크나이저 자산(tokenizer.json, vocab, merges, added_tokens), 채팅 템플릿도 판정을 바꾼다.
    목록을 고르면 빠뜨리기 쉽다.
    """
    return sorted(path for path in model_directory.iterdir() if path.is_file() and not path.name.startswith(".") and path.name not in IDENTITY_EXCLUDED_NAMES)


def compute_model_identifier(model_directory: Path) -> str:
    """모델 식별자 `<디렉터리 이름>@<sha256 앞 12자>`. 모델 파일 중 하나만 바뀌어도 서버가 알아채고 캐시를 비우게 한다."""
    digest = hashlib.sha256()
    for path in identity_files(model_directory):
        digest.update(path.name.encode("utf-8") + b"\0")
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
    return validate_model_identifier(f"{model_directory.name}@{digest.hexdigest()[:MODEL_HASH_PREFIX_LENGTH]}")


def build_warmed_kanana(model_directory: Path) -> Callable[[Sequence[str]], list[ItemVerdict]]:
    """kanana를 불러와 한 번 데운 판정 함수. 추론 스레드 안에서 불러, 모델을 만든 스레드가 계속 쓰게 한다(mlx)."""
    from zg_stage2.classifier import load_kanana  # mlx는 무거워서 실제로 쓸 때 불러온다(테스트는 가짜 판정 함수를 쓴다)

    classifier = load_kanana(model_directory)
    classifier.classify(list(WARMUP_TEXTS))
    return classifier.classify


def stop_on_terminate(server: WorkerHTTPServer) -> None:
    """SIGTERM·SIGINT를 받으면 서버를 멈춘다. serve_forever가 도는 스레드에서 shutdown을 부르면 멈춰 버려 다른 스레드에서 부른다."""

    def request_shutdown(signal_number: int, frame: object) -> None:
        LOGGER.info("종료 신호(%d)를 받아 워커를 멈춥니다.", signal_number)
        threading.Thread(target=server.shutdown, name="shutdown", daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)


def serve_until_stopped(socket_path: Path, settings: WorkerSettings, on_ready: Callable[[WorkerHTTPServer], None]) -> None:
    """소켓을 만들고 멈출 때까지 받는다. 끝나면 소켓 파일을 지운다.

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


def serve_model(
    model: str, build_infer: Callable[[], Callable[[Sequence[str]], list]], socket_path: Path, on_ready: Callable[[WorkerHTTPServer], None]
) -> None:
    """추론 스레드에서 모델을 준비한 뒤 소켓을 연다. 끝나면 추론 스레드를 멈춘다."""
    runner = InferenceRunner(build_infer)
    runner.start()
    try:
        serve_until_stopped(socket_path, WorkerSettings(model, MAX_ITEMS_PER_REQUEST, runner, STAGE2_CATEGORIES), on_ready)
    finally:
        runner.stop()


def start_worker(
    arguments: argparse.Namespace,
    environment: Mapping[str, str],
    on_ready: Callable[[WorkerHTTPServer], None] = stop_on_terminate,
    build_infer: Callable[[Path], Callable[[Sequence[str]], list]] = build_warmed_kanana,
) -> None:
    """잠금 → 남은 소켓 정리 → 모델 불러오기·데우기 → 소켓 순서로 시작한다(1차 워커와 같은 순서).

    build_infer: 모델 디렉터리 → 판정 함수. 테스트는 mlx 없이 가짜 판정 함수를 넣는다.
    """
    model_directory = ensure_model_directory(arguments.model_dir)
    run_directory = resolve_run_directory(resolve_data_directory(arguments.data_dir, environment))
    socket_path = socket_path_for(run_directory, WORKER_NAME)
    lock_file = acquire_instance_lock(run_directory, WORKER_NAME)
    try:
        remove_stale_socket(socket_path)
        model = compute_model_identifier(model_directory)
        serve_model(model, lambda: build_infer(model_directory), socket_path, on_ready)
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
    except (Stage2Error, WorkerSetupError) as error:
        print(f"오류: {error}", file=sys.stderr)
        raise SystemExit(USER_ERROR_EXIT_CODE) from error


if __name__ == "__main__":
    main()
