"""비공개 금칙 목록과 형태 규칙으로 공개할 수 없는 생성 후보를 원문 출력 없이 분리한다."""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from zg_datagen._io import ensure_outputs_absent, read_jsonl, require_string, write_jsonl_exclusive

LIST_FILES = {
    "sexual": "sexual.txt",
    "minor_markers": "minor-markers.txt",
    "self_harm_means": "self-harm-means.txt",
}

INITIALS = tuple("ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ")
MEDIALS = tuple("ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ")
FINALS = (
    "",
    "ㄱ",
    "ㄲ",
    "ㄳ",
    "ㄴ",
    "ㄵ",
    "ㄶ",
    "ㄷ",
    "ㄹ",
    "ㄺ",
    "ㄻ",
    "ㄼ",
    "ㄽ",
    "ㄾ",
    "ㄿ",
    "ㅀ",
    "ㅁ",
    "ㅂ",
    "ㅄ",
    "ㅅ",
    "ㅆ",
    "ㅇ",
    "ㅈ",
    "ㅊ",
    "ㅋ",
    "ㅌ",
    "ㅍ",
    "ㅎ",
)
MODERN_JAMO_SOURCE = tuple("ᄀᄁᄂᄃᄄᄅᄆᄇᄈᄉᄊᄋᄌᄍᄎᄏᄐᄑᄒ") + tuple("ᅡᅢᅣᅤᅥᅦᅧᅨᅩᅪᅫᅬᅭᅮᅯᅰᅱᅲᅳᅴᅵ") + tuple("ᆨᆩᆪᆫᆬᆭᆮᆯᆰᆱᆲᆳᆴᆵᆶᆷᆸᆹᆺᆻᆼᆽᆾᆿᇀᇁᇂ")
MODERN_JAMO = dict(zip(MODERN_JAMO_SOURCE, INITIALS + MEDIALS + FINALS[1:], strict=True))

# 아래 형태 규칙은 normalize_for_matching을 거친 문자열(글자·숫자만 남음)에 적용한다.
# 그래서 띄어쓰기·하이픈·점이 사라진 모양을 기준으로 쓴다.
NUMERIC_AGE_PATTERN = re.compile(r"(?<!\d)(?:[7-9]|1\d)(?:살|세)(?!\d)")
GRADE_PATTERN = re.compile(r"(?:초[1-6]|중[1-3]|고[1-3])(?:학년)?")
KOREAN_AGE_PATTERN = re.compile(r"(?:일곱|여덟|아홉|열(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉)?)살")
PHONE_PATTERN = re.compile(r"(?<!\d)01[016789]\d{7,8}(?!\d)")
ADDRESS_PATTERNS = (re.compile(r"\d+동\d+호"), re.compile(r"\d+번지"))


@dataclass(frozen=True)
class TermIndex:
    """일반형과 자모형을 함께 보관해 목록을 매 레코드마다 다시 정규화하지 않게 한다."""

    plain: frozenset[str]
    jamo: frozenset[str]


@dataclass(frozen=True)
class PrivateLists:
    """세 안전 목록을 명시적으로 묶어 하나라도 빠진 채 필터가 실행되지 않게 한다."""

    sexual: TermIndex
    minor_markers: TermIndex
    self_harm_means: TermIndex


def normalize_for_matching(text: str) -> str:
    """NFKC·소문자로 바꾼 뒤 글자(L*)와 숫자(N*)만 남긴다.

    왜 글자·숫자만 남기나: 공백·문장부호만 지우면 폭 없는 문자(U+200B 등, Cf)·기호(★, So)·결합 부호(M*)를
    낱말 사이에 끼워 넣는 우회가 목록 매칭을 피한다(보안 검토). 거르기는 보수적이어야 하므로 그 밖의 문자를 모두 지운다.
    """
    folded = unicodedata.normalize("NFKC", text).lower()
    return "".join(character for character in folded if unicodedata.category(character)[0] in {"L", "N"})


def decompose_to_compatibility_jamo(text: str) -> str:
    """완성형과 분리 자모를 같은 호환 자모열로 만들어 자모 분리 우회를 동일하게 비교한다."""
    output: list[str] = []
    for character in normalize_for_matching(text):
        output.extend(decompose_character(character))
    return "".join(output)


def decompose_character(character: str) -> tuple[str, ...]:
    """한글 음절만 계산식으로 풀고 다른 문자는 보존해 영문·숫자가 섞인 목록도 계속 맞게 한다."""
    code = ord(character)
    if not 0xAC00 <= code <= 0xD7A3:
        return (MODERN_JAMO.get(character, character),)
    offset = code - 0xAC00
    initial, remainder = divmod(offset, 21 * 28)
    medial, final = divmod(remainder, 28)
    pieces = (INITIALS[initial], MEDIALS[medial], FINALS[final])
    return tuple(piece for piece in pieces if piece)


def load_private_lists(directory: Path) -> PrivateLists:
    """모든 목록을 먼저 검증해 일부 안전 규칙만 적용된 결과를 정상 결과로 만들지 않게 한다."""
    loaded = {name: load_term_index(directory / file_name) for name, file_name in LIST_FILES.items()}
    return PrivateLists(loaded["sexual"], loaded["minor_markers"], loaded["self_harm_means"])


def load_term_index(path: Path) -> TermIndex:
    """누락·빈 목록을 오류로 처리해 배포 밖 비공개 자산을 실수로 빼먹은 실행을 막는다."""
    if not path.is_file():
        raise ValueError(f"{path.name}: 비공개 목록 파일이 없습니다. --lists-dir에 세 목록을 모두 두세요.")
    terms = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip() and not line.lstrip().startswith("#")]
    normalized = frozenset(normalize_for_matching(term) for term in terms if normalize_for_matching(term))
    if not normalized:
        raise ValueError(f"{path.name}: 사용할 용어가 없습니다. 주석이 아닌 용어를 한 줄에 하나씩 넣으세요.")
    return TermIndex(normalized, frozenset(decompose_to_compatibility_jamo(term) for term in normalized))


def contains_term(text: str, index: TermIndex) -> bool:
    """두 정규형 중 하나라도 부분 일치하면 잡아 분리 자모와 완성형을 별도 우회 통로로 남기지 않는다."""
    plain = normalize_for_matching(text)
    jamo = decompose_to_compatibility_jamo(text)
    return any(term in plain for term in index.plain) or any(term in jamo for term in index.jamo)


def has_minor_age(text: str) -> bool:
    """목록에 넣기 어려운 나이·학년 숫자 형태를 코드로 고정해 목록 누락에 의존하지 않게 한다.

    목록 매칭과 같은 정규화를 써, 숫자와 '살' 사이에 끼운 기호·폭 없는 문자로 피하지 못하게 한다.
    """
    folded = normalize_for_matching(text)
    return any(pattern.search(folded) is not None for pattern in (NUMERIC_AGE_PATTERN, GRADE_PATTERN, KOREAN_AGE_PATTERN))


def is_pii_like(text: str) -> bool:
    """실제 값인지 확인하지 않고 전화·주소 모양 자체를 버려 개인정보가 결과에 남을 가능성을 줄인다.

    구분자(하이픈·점·공백·기호)를 지운 모양으로 보므로, 구분자를 바꿔 끼워도 같은 숫자열로 잡힌다.
    """
    folded = normalize_for_matching(text)
    return PHONE_PATTERN.search(folded) is not None or any(pattern.search(folded) is not None for pattern in ADDRESS_PATTERNS)


def detect_drop_reason(text: str, private_lists: PrivateLists) -> str | None:
    """가장 강한 복합 금지부터 한 이유를 정해 레코드 수와 이유별 집계가 중복되지 않게 한다."""
    minor = has_minor_age(text) or contains_term(text, private_lists.minor_markers)
    if minor and contains_term(text, private_lists.sexual):
        return "minor_sexual"
    if contains_term(text, private_lists.self_harm_means):
        return "self_harm_means"
    return "pii_like" if is_pii_like(text) else None


def run_filters(input_path: Path, lists_dir: Path, kept_path: Path, dropped_path: Path) -> dict[str, object]:
    """입력을 한 번 분류해 통과·탈락 파일과 집계가 같은 판정 결과를 공유하게 한다."""
    ensure_outputs_absent([kept_path, dropped_path])
    private_lists = load_private_lists(lists_dir)
    kept, dropped, by_kind = partition_records(read_jsonl(input_path), input_path, private_lists)
    publish_outputs(kept_path, dropped_path, kept, dropped)
    reasons = Counter(str(record["drop_reason"]) for record in dropped)
    return {"kept": len(kept), "dropped": len(dropped), "by_reason": dict(sorted(reasons.items())), "by_kind": by_kind}


def partition_records(
    records: Sequence[dict[str, object]], input_path: Path, private_lists: PrivateLists
) -> tuple[list[dict[str, object]], list[dict[str, object]], dict[str, dict[str, int]]]:
    """원본 객체를 복사해서 탈락 이유만 더해 입력 레코드를 호출자 모르게 바꾸지 않게 한다."""
    kept: list[dict[str, object]] = []
    dropped: list[dict[str, object]] = []
    by_kind: dict[str, dict[str, int]] = {}
    for position, record in enumerate(records, 1):
        partition_one(record, f"{input_path.name}:{position}", private_lists, kept, dropped, by_kind)
    return kept, dropped, dict(sorted(by_kind.items()))


def partition_one(
    record: Mapping[str, object],
    location: str,
    private_lists: PrivateLists,
    kept: list[dict[str, object]],
    dropped: list[dict[str, object]],
    by_kind: dict[str, dict[str, int]],
) -> None:
    """kind별 통과와 탈락을 동시에 세어 특정 생성 종류만 과도하게 잘린 문제를 원문 없이 찾게 한다."""
    text = require_string(record, "text", location)
    kind = require_string(record, "kind", location)
    reason = detect_drop_reason(text, private_lists)
    status = "dropped" if reason else "kept"
    by_kind.setdefault(kind, {"kept": 0, "dropped": 0})[status] += 1
    target = dropped if reason else kept
    target.append(dict(record) | ({"drop_reason": reason} if reason else {}))


def publish_outputs(kept_path: Path, dropped_path: Path, kept: Sequence[Mapping[str, object]], dropped: Sequence[Mapping[str, object]]) -> None:
    """둘째 파일 실패 때 첫째만 남기지 않아 다음 실행이 불완전 결과를 완성본으로 오해하지 않게 한다."""
    write_jsonl_exclusive(kept_path, kept)
    try:
        write_jsonl_exclusive(dropped_path, dropped)
    except BaseException:
        kept_path.unlink(missing_ok=True)
        raise


def build_parser() -> argparse.ArgumentParser:
    """입력·비공개 목록·두 출력을 모두 필수로 받아 안전 기본값이 경로를 추측하지 않게 한다."""
    parser = argparse.ArgumentParser(prog="python -m zg_datagen.filters", description="M2 생성 후보에 비공개 안전 필터를 적용한다")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--lists-dir", type=Path, required=True)
    parser.add_argument("--kept", type=Path, required=True)
    parser.add_argument("--dropped", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    """터미널에는 이유·종류별 수만 JSON으로 남겨 문장 원문이 셸 기록에 새지 않게 한다."""
    arguments = build_parser().parse_args(argv)
    report = run_filters(arguments.input, arguments.lists_dir, arguments.kept, arguments.dropped)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
