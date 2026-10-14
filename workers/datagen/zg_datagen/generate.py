"""로컬 mlx 모델로 작은 균형 묶음을 만들고 원문 없는 manifest와 함께 보안 JSONL로 저장한다."""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from zg_datagen._io import ensure_outputs_absent, read_jsonl, require_string, write_json_exclusive, write_jsonl_exclusive
from zg_datagen.prompts import (
    BOUNDARY_KINDS,
    DIRECTNESSES,
    HARMFUL_SLOTS,
    LENGTHS,
    NOISES,
    REGISTERS,
    Cell,
    build_boundary_messages,
    build_harmful_messages,
    build_twin_messages,
    balanced_axis_indices,
    cell_dict,
    iter_cells,
    messages_sha256,
)

MAX_TEXT_LENGTH = 200
DEFAULT_MAX_TOKENS = 512
MODEL_HASH_LENGTH = 12


class TextGenerator(Protocol):
    """테스트와 mlx 실행이 같은 생성 경계를 써 모델 의존성을 지연시킬 수 있게 한다."""

    def generate(self, messages: list[dict[str, str]], seed: int) -> str:
        """같은 메시지와 시드가 같은 샘플링 실행을 가리키도록 호출 단위를 드러낸다."""
        ...


class MlxTextGenerator:
    """mlx를 실제 생성 시점에만 불러 테스트 환경에 무거운 선택 의존성을 요구하지 않는다."""

    def __init__(self, model_directory: Path, max_tokens: int) -> None:
        from mlx_lm import load

        # load는 설정에 따라 (모델, 토크나이저) 또는 (모델, 토크나이저, 설정)을 돌려줘 앞의 두 개만 쓴다.
        # 가중치 해시는 run_generation이 한 번만 계산한다(4GB가 넘는 파일을 두 번 읽지 않게).
        loaded = load(str(model_directory))
        self._model, self._tokenizer = loaded[0], loaded[1]
        self._max_tokens = max_tokens

    def generate(self, messages: list[dict[str, str]], seed: int) -> str:
        """호출마다 난수 상태를 되감아 묶음 순서와 무관하게 시드 재현성을 보장한다."""
        import mlx.core as mx
        from mlx_lm import generate
        from mlx_lm.sample_utils import make_sampler

        mx.random.seed(seed)
        prompt = self._tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
        if not isinstance(prompt, str):
            raise ValueError("모델 채팅 템플릿이 문자열을 만들지 않았습니다. 올바른 instruct 모델인지 확인하세요.")
        sampler = make_sampler(temp=0.9, top_p=0.95)
        return str(generate(self._model, self._tokenizer, prompt=prompt, max_tokens=self._max_tokens, sampler=sampler, verbose=False))


@dataclass(frozen=True)
class GenerationRequest:
    """한 실행의 고정값을 모아 출력과 manifest가 같은 설정을 보게 한다."""

    kind: str
    intended: str
    count: int
    seed: int
    batch_size: int
    out: Path
    model_dir: Path
    max_tokens: int = DEFAULT_MAX_TOKENS
    input_path: Path | None = None


@dataclass
class ParseCounts:
    """모델 형식 실패를 원문 없이 집계해 파일럿의 생성 품질을 비교할 수 있게 한다."""

    requested: int = 0
    parsed: int = 0
    non_json: int = 0
    too_long: int = 0

    def as_dict(self) -> dict[str, int]:
        """manifest 직렬화가 dataclass 내부 표현에 기대지 않도록 공개 필드만 복사한다."""
        return {"requested": self.requested, "parsed": self.parsed, "non_json": self.non_json, "too_long": self.too_long}


@dataclass(frozen=True)
class PendingCall:
    """프롬프트와 결과 메타데이터를 함께 두어 여러 생성 종류가 같은 파싱·기록 경로를 쓰게 한다."""

    messages: list[dict[str, str]]
    count: int
    cell: dict[str, str]
    parent_id: str | None = None


def manifest_path_for(output_path: Path) -> Path:
    """전체 파일명 뒤에 접미사를 붙여 확장자만 다른 출력끼리 manifest를 공유하지 않게 한다."""
    return output_path.with_name(f"{output_path.name}.manifest.json")


def compute_generator_identifier(model_directory: Path) -> str:
    """실제 가중치 바이트를 식별자에 넣어 같은 디렉터리 이름의 다른 변환본을 구분한다."""
    preferred = model_directory / "model.safetensors"
    weights = [preferred] if preferred.is_file() else sorted(model_directory.glob("*.safetensors"))
    if not weights:
        raise FileNotFoundError(f"{model_directory}: safetensors 가중치가 없습니다. mlx 모델 디렉터리를 확인하세요.")
    digest = hashlib.sha256()
    for path in weights:
        update_digest(digest, path)
    return f"{model_directory.name}@{digest.hexdigest()[:MODEL_HASH_LENGTH]}"


def update_digest(digest: Any, path: Path) -> None:
    """큰 가중치를 한꺼번에 메모리에 올리지 않아 생성 모델과 함께 쓸 때 메모리 압박을 피한다."""
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)


def parse_model_output(output: str, counts: ParseCounts) -> list[str]:
    """설명 줄과 잘못된 객체는 건너뛰되 원문을 오류나 로그에 넣지 않고 원인별 수만 센다."""
    texts: list[str] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        text = parse_output_line(line, counts)
        if text is not None:
            texts.append(text)
    return texts


def parse_output_line(line: str, counts: ParseCounts) -> str | None:
    """text 하나만 신뢰해 slots의 자유 형식이 생성 실행 전체를 깨뜨리지 않게 한다."""
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        counts.non_json += 1
        return None
    if not isinstance(value, dict) or not isinstance(value.get("text"), str):
        counts.non_json += 1
        return None
    return validate_generated_text(value["text"], counts)


def validate_generated_text(value: str, counts: ParseCounts) -> str | None:
    """빈 문장과 채팅 상한을 넘는 문장을 버려 뒤 단계가 모델의 장문 설명을 데이터로 오해하지 않게 한다."""
    text = value.strip()
    if not text:
        return None
    if len(text) > MAX_TEXT_LENGTH:
        counts.too_long += 1
        return None
    return text


def run_generation(request: GenerationRequest, generator: TextGenerator) -> dict[str, object]:
    """생성부터 두 파일 공개까지 한 경로로 실행해 집계와 실제 레코드가 어긋나지 않게 한다."""
    validate_request(request)
    manifest_path = manifest_path_for(request.out)
    ensure_outputs_absent([request.out, manifest_path])
    generator_id = compute_generator_identifier(request.model_dir)
    records, counts, prompt_hashes = collect_records(request, generator, generator_id)
    manifest = build_manifest(request, generator_id, counts, prompt_hashes)
    publish_generation(request.out, records, manifest)
    return manifest


def validate_request(request: GenerationRequest) -> None:
    """잘못된 묶음 크기나 종류를 모델 로드 전에 막아 비싼 실행 뒤 실패하는 일을 피한다."""
    if request.kind not in {"harmful", "twin", "boundary"}:
        raise ValueError("kind는 harmful, twin, boundary 중 하나여야 합니다.")
    if not 2 <= request.batch_size <= 4:
        raise ValueError("--batch-size는 계획대로 2~4여야 합니다.")
    if request.count < 1 or request.max_tokens < 1:
        raise ValueError("생성 개수와 --max-tokens는 1 이상이어야 합니다.")


def collect_records(request: GenerationRequest, generator: TextGenerator, generator_id: str) -> tuple[list[dict[str, object]], ParseCounts, set[str]]:
    """호출별 시드와 지시 해시를 결과에 붙여 부분 실패가 있어도 각 문장의 출처를 추적하게 한다."""
    pending_calls = list(iter_pending_calls(request))
    counts = ParseCounts(requested=sum(pending.count for pending in pending_calls))
    records: list[dict[str, object]] = []
    prompt_hashes: set[str] = set()
    for call_index, pending in enumerate(pending_calls):
        add_call_records(request, generator, generator_id, call_index, pending, records, counts, prompt_hashes)
    return records, counts, prompt_hashes


def add_call_records(
    request: GenerationRequest,
    generator: TextGenerator,
    generator_id: str,
    call_index: int,
    pending: PendingCall,
    records: list[dict[str, object]],
    counts: ParseCounts,
    prompt_hashes: set[str],
) -> None:
    """한 모델 응답에서 요청 수만 받아 과다 생성된 줄이 할당량을 조용히 넘지 않게 한다."""
    call_seed = request.seed + call_index
    prompt_hash = messages_sha256(pending.messages)
    prompt_hashes.add(prompt_hash)
    texts = parse_model_output(generator.generate(pending.messages, call_seed), counts)[: pending.count]
    for text in texts:
        records.append(build_record(request, len(records) + 1, pending, generator_id, call_seed, prompt_hash, text))
        counts.parsed += 1


def build_record(
    request: GenerationRequest,
    index: int,
    pending: PendingCall,
    generator_id: str,
    call_seed: int,
    prompt_hash: str,
    text: str,
) -> dict[str, object]:
    """종류별 id 외의 출처 필드를 같은 모양으로 고정해 후속 필터와 블라인드 배치가 단순해지게 한다."""
    record: dict[str, object] = {
        "id": record_id(request, index),
        "kind": request.kind,
        "intended": request.intended,
        "cell": pending.cell,
        "generator": generator_id,
        "seed": call_seed,
        "prompt_sha256": prompt_hash,
        "text": text,
    }
    if pending.parent_id is not None:
        record["parent_id"] = pending.parent_id
    return record


def record_id(request: GenerationRequest, index: int) -> str:
    """종류와 의도를 id에 넣어 원문 없이도 실행 결과를 구분하고 부모 쌍을 찾을 수 있게 한다."""
    prefixes = {"harmful": f"gh-{request.intended}", "twin": "gt", "boundary": f"gb-{request.intended}"}
    return f"{prefixes[request.kind]}-{index:05d}"


def iter_pending_calls(request: GenerationRequest) -> Iterator[PendingCall]:
    """종류별 프롬프트 구성만 분기하고 생성·파싱·기록 규칙은 하나로 유지한다."""
    if request.kind == "harmful":
        yield from harmful_calls(request)
    elif request.kind == "boundary":
        yield from boundary_calls(request)
    else:
        yield from twin_calls(request)


def harmful_calls(request: GenerationRequest) -> Iterator[PendingCall]:
    """연속 호출마다 다음 셀을 써 작은 묶음 단위의 스타일 균형을 유지한다."""
    cells = itertools.cycle(iter_cells(request.intended))
    for count in split_counts(request.count, request.batch_size):
        cell = next(cells)
        yield PendingCall(build_harmful_messages(cell, count), count, cell_dict(cell))


def boundary_calls(request: GenerationRequest) -> Iterator[PendingCall]:
    """경계 허용도 같은 스타일 축을 순회해 특정 말투만 허용으로 학습되는 일을 줄인다."""
    cells = itertools.cycle(iter_boundary_cells(request.intended))
    for count in split_counts(request.count, request.batch_size):
        cell = next(cells)
        yield PendingCall(build_boundary_messages(request.intended, cell, count), count, cell_dict(cell))


def iter_boundary_cells(kind: str) -> Iterator[Cell]:
    """유해 상황 이름 없이 스타일 완전 조합만 써 경계 유형 자체를 상황 값으로 기록한다."""
    if kind not in BOUNDARY_KINDS:
        raise ValueError(f"알 수 없는 경계 유형 {kind!r}입니다. {', '.join(sorted(BOUNDARY_KINDS))} 중 하나를 쓰세요.")
    total = len(LENGTHS) * len(REGISTERS) * len(DIRECTNESSES) * len(NOISES)
    for index in range(total):
        _, length, register, directness, noise = balanced_axis_indices(index, 1)
        yield Cell("boundary", kind, LENGTHS[length], REGISTERS[register], DIRECTNESSES[directness], NOISES[noise])


def twin_calls(request: GenerationRequest) -> Iterator[PendingCall]:
    """부모마다 별도 프롬프트를 써 서로 다른 원문이 한 응답에서 섞여 부모 연결을 잃지 않게 한다."""
    if request.input_path is None:
        raise ValueError("twins 생성에는 --input이 필요합니다. 유해 생성 JSONL 경로를 주세요.")
    parents = read_jsonl(request.input_path)
    for position, parent in enumerate(parents, 1):
        yield from twin_parent_calls(parent, position, request)


def twin_parent_calls(parent: Mapping[str, object], position: int, request: GenerationRequest) -> Iterator[PendingCall]:
    """부모 셀의 길이와 말투를 이어받아 최소 편집 대조쌍의 스타일 차이를 막는다."""
    location = f"{request.input_path.name if request.input_path else 'input'}:{position}"
    parent_id = require_string(parent, "id", location)
    text = require_string(parent, "text", location)
    cell = require_cell(parent.get("cell"), location)
    for count in split_counts(request.count, request.batch_size):
        messages = build_twin_messages(text, count, cell["register"], cell["length"])
        yield PendingCall(messages, count, cell, parent_id)


def require_cell(value: object, location: str) -> dict[str, str]:
    """부모 스타일이 없으면 임의 보정하지 않고 재생성을 요구해 쌍의 통제 변수를 지킨다."""
    if not isinstance(value, dict) or any(not isinstance(key, str) or not isinstance(item, str) for key, item in value.items()):
        raise ValueError(f"{location}: cell이 문자열 사전이 아닙니다. harmful 생성 출력을 입력으로 쓰세요.")
    if value.get("register") not in REGISTERS or value.get("length") not in LENGTHS:
        raise ValueError(f"{location}: cell의 register나 length가 잘못됐습니다. 생성 출력을 확인하세요.")
    return dict(value)


def split_counts(total: int, batch_size: int) -> Iterator[int]:
    """마지막 묶음만 작게 만들어 요청 총합을 넘기지 않으면서 계획의 작은 생성 단위를 지킨다."""
    remaining = total
    while remaining:
        count = min(batch_size, remaining)
        yield count
        remaining -= count


def build_manifest(request: GenerationRequest, generator_id: str, counts: ParseCounts, prompt_hashes: set[str]) -> dict[str, object]:
    """문장을 넣지 않은 실행 집계만 공개해 생성 품질과 재현 출처를 안전하게 감사하게 한다."""
    return {
        "generator": generator_id,
        "base_seed": request.seed,
        "counts": counts.as_dict(),
        "distinct_prompt_hashes": len(prompt_hashes),
        "created_at": datetime.now(UTC).isoformat(),
    }


def publish_generation(output_path: Path, records: Sequence[Mapping[str, object]], manifest: Mapping[str, object]) -> None:
    """manifest 쓰기가 실패하면 이번 실행의 데이터 파일만 지워 반쪽 결과가 다음 실행을 막지 않게 한다."""
    manifest_path = manifest_path_for(output_path)
    write_jsonl_exclusive(output_path, records)
    try:
        write_json_exclusive(manifest_path, manifest)
    except BaseException:
        output_path.unlink(missing_ok=True)
        raise


def build_parser() -> argparse.ArgumentParser:
    """생성 종류별 필수 인자를 분리해 서로 의미가 다른 count 옵션의 오사용을 막는다."""
    parser = argparse.ArgumentParser(prog="python -m zg_datagen.generate", description="M2 생성 후보를 로컬 mlx 모델로 만든다")
    subparsers = parser.add_subparsers(dest="command", required=True)
    harmful = subparsers.add_parser("harmful")
    add_common_arguments(harmful)
    harmful.add_argument("--category", choices=tuple(HARMFUL_SLOTS), required=True)
    harmful.add_argument("--count", type=int, required=True)
    twins = subparsers.add_parser("twins")
    add_common_arguments(twins)
    twins.add_argument("--input", type=Path, required=True)
    twins.add_argument("--per-item", type=int, required=True)
    boundary = subparsers.add_parser("boundary")
    add_common_arguments(boundary)
    boundary.add_argument("--kind", choices=sorted(BOUNDARY_KINDS), required=True)
    boundary.add_argument("--count", type=int, required=True)
    return parser


def add_common_arguments(parser: argparse.ArgumentParser) -> None:
    """세 하위 명령이 같은 샘플링·출력 계약을 쓰도록 공통 옵션을 한곳에서 정의한다."""
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--batch-size", type=int, choices=range(2, 5), default=3)
    parser.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    parser.add_argument("--out", type=Path, required=True)


def request_from_args(arguments: argparse.Namespace) -> GenerationRequest:
    """CLI 이름을 내부의 단일 요청 모양으로 바꿔 실행 경로가 argparse 세부에 묶이지 않게 한다."""
    if arguments.command == "harmful":
        return GenerationRequest(
            "harmful",
            arguments.category,
            arguments.count,
            arguments.seed,
            arguments.batch_size,
            arguments.out,
            arguments.model_dir,
            arguments.max_tokens,
        )
    if arguments.command == "boundary":
        return GenerationRequest(
            "boundary",
            arguments.kind,
            arguments.count,
            arguments.seed,
            arguments.batch_size,
            arguments.out,
            arguments.model_dir,
            arguments.max_tokens,
        )
    return GenerationRequest(
        "twin",
        "twin",
        arguments.per_item,
        arguments.seed,
        arguments.batch_size,
        arguments.out,
        arguments.model_dir,
        arguments.max_tokens,
        arguments.input,
    )


def main(argv: Sequence[str] | None = None) -> None:
    """성공 시 원문 없는 manifest JSON만 출력해 터미널 기록에 생성 문장이 남지 않게 한다."""
    request = request_from_args(build_parser().parse_args(argv))
    validate_request(request)
    generator = MlxTextGenerator(request.model_dir, request.max_tokens)
    print(json.dumps(run_generation(request, generator), ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
