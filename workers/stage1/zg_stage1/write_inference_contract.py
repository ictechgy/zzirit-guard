"""이미 끝난 학습 결과에 추론 계약(inference.json)을 써 넣는 CLI. 다시 학습하지 않는다.

사용 예: uv run python -m zg_stage1.write_inference_contract --model-dir "$ZG_DATA_DIR/ml/stage1/kcelectra-<시각>"
max_length는 --max-length가 없으면 model-card.json의 hyperparameters.max_length를 쓴다.
왜: 계약 파일이 생기기 전에 학습한 결과도 워커가 같은 방식으로 읽을 수 있게 하기 위해서다.
"""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path

from zg_stage1.arguments import positive_integer
from zg_stage1.errors import OutputExistsError, PathResolutionError, run_command_line
from zg_stage1.inference_contract import INFERENCE_CONTRACT_FILE_NAME, build_inference_contract, write_inference_contract_file
from zg_stage1.model_card import read_model_card
from zg_stage1.modeling import load_trained_tokenizer
from zg_stage1.paths import ensure_existing_directory


def build_argument_parser() -> argparse.ArgumentParser:
    """CLI 인자 정의를 만든다."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage1.write_inference_contract", description="학습 결과에 inference.json을 써 넣는다")
    parser.add_argument("--model-dir", required=True, help="train이 만든 출력 디렉터리")
    parser.add_argument("--max-length", type=positive_integer, help="최대 토큰 수(기본: model-card.json의 값)")
    parser.add_argument("--overwrite", action="store_true", help="이미 있는 inference.json을 덮어쓴다")
    return parser


def resolve_contract_max_length(explicit_max_length: int | None, model_directory: Path) -> int:
    """--max-length가 있으면 그것을, 없으면 카드의 학습 max_length를 쓴다. 둘 다 없으면 추측하지 않고 오류를 낸다."""
    if explicit_max_length is not None:
        return explicit_max_length
    card = read_model_card(model_directory) or {}
    card_max_length = card.get("hyperparameters", {}).get("max_length")
    if type(card_max_length) is not int:
        raise PathResolutionError(f"{model_directory.name}의 model-card.json에서 max_length를 찾을 수 없습니다. 학습 때 값을 --max-length로 직접 주세요.")
    return card_max_length


def main(argv: Sequence[str] | None = None) -> None:
    """토크나이저와 카드를 읽어 inference.json을 쓴다. 이미 있으면 --overwrite 없이는 거부한다."""
    arguments = build_argument_parser().parse_args(argv)
    model_directory = ensure_existing_directory(Path(arguments.model_dir).expanduser(), "모델")
    if (model_directory / INFERENCE_CONTRACT_FILE_NAME).exists() and not arguments.overwrite:
        raise OutputExistsError(f"{INFERENCE_CONTRACT_FILE_NAME}이 이미 있습니다. 바꾸려면 --overwrite를 주세요.")
    max_length = resolve_contract_max_length(arguments.max_length, model_directory)
    contract = build_inference_contract(load_trained_tokenizer(model_directory), max_length)
    contract_path = write_inference_contract_file(model_directory, contract)
    print(f"저장: {contract_path.name} (max_length={max_length}) → {model_directory}")


if __name__ == "__main__":
    run_command_line(main)
