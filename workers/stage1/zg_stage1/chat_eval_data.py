"""채팅 형식 평가셋(개발셋·보류셋)을 읽고 검증하고, 봉인한 72문장 회귀 세트와 겹치지 않는지 검사한다.

왜 필요한가: 임계값·키워드·모델은 개발셋으로만 고르고, 보류셋은 설정을 고정한 뒤 한 번만 본다.
72문장은 이미 설계 판단에 쓰여 '봉인'했다(docs/ml/2026-10-14-model-strengthening-plan.md).
평가셋이 72문장이나 서로를 거의 그대로 담고 있으면 숫자가 부풀려지므로, 도구로 겹침을 막는다.
라벨 정책: docs/ml/chat-eval-policy.md. 원문은 오류 메시지·출력에 넣지 않고 id만 쓴다.

CLI 사용 예: uv run python -m zg_stage1.chat_eval_data eval_data/chat-dev-v1.jsonl eval_data/chat-holdout-v1.jsonl
"""

from __future__ import annotations

import argparse
import re
import unicodedata
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from zg_stage1.data import compute_file_sha256, iterate_nonblank_lines, load_chat_samples, parse_json_object, require_string_field
from zg_stage1.errors import DatasetFormatError, run_command_line
from zg_stage1.paths import CHAT_SAMPLES_PATH

# 봉인한 72문장 파일의 sha256. 누군가 회귀 세트를 고치면 테스트가 실패해 알아차리게 한다.
SEALED_REGRESSION_SHA256 = "b9bd48c6e1b064ec027ad4497a43cade24d608cb617f1ce4e49e0f2ac7e0fec9"

# 라벨 값. ambiguous는 정답이 없어 지표에서 뺀다.
LABELS: frozenset[str] = frozenset({"harmful", "allow", "ambiguous"})

# 유해 범주와 그중 핵심 범주(대기열이 넘쳐도 놓치면 안 되는 범주, 정책 문서).
HARMFUL_CATEGORIES: tuple[str, ...] = ("abuse", "sexual", "minors", "threat", "doxxing", "self_harm", "spam")
CRITICAL_CATEGORIES: frozenset[str] = frozenset({"sexual", "minors", "threat", "doxxing", "self_harm"})

# 허용 유형. 욕설과 모양이 비슷한 '어려운 허용'이 앞의 셋이다.
ALLOW_CATEGORIES: tuple[str, ...] = ("friendly_profanity", "game_combat", "quote_report", "number_url_like", "short_normal", "long_normal")

# 셋 이름.
SPLITS: frozenset[str] = frozenset({"dev", "holdout"})

# 거의 같은 문장으로 보는 글자 3-gram 자카드 유사도 기준. 표현만 조금 바꾼 문장을 잡기 위한 값이다(Grok 상담안).
NEAR_DUPLICATE_JACCARD = 0.5

# 3-gram을 만들 수 없을 만큼 짧은 문장은 정규화 후 완전 일치로만 비교한다.
CHARACTER_NGRAM_SIZE = 3

# 겹침 비교에서 지우는 문자: 공백·문장부호·기호. 띄어쓰기나 마침표만 다른 문장을 같은 문장으로 보기 위해서다.
OVERLAP_STRIP_PATTERN = re.compile(r"[\s\W_]+", re.UNICODE)

# 숫자 사이의 점·콜론·쉼표. 지우면 "1.5배속"과 "15배속"처럼 값이 다른 문장이 같아지므로, 지우기 전에 표시 글자로 바꿔 둔다.
NUMERIC_SEPARATOR_PATTERN = re.compile(r"(?<=\d)[.:,](?=\d)")

# 구분자마다 다른 표시 글자. 단어 문자(옛 한글 자모)라 지워지지 않고, 채팅에서 거의 쓰지 않는다. 1.5와 1:5를 구분하려고 따로 둔다.
NUMERIC_SEPARATOR_MARKS: dict[str, str] = {".": "ㆍ", ":": "ㆆ", ",": "ㆅ"}

# 평가셋 하나에서 ambiguous가 차지할 수 있는 최대 비율(정책 문서). 어려운 문장을 애매로 빼서 숫자를 좋게 만드는 일을 막는다.
MAX_AMBIGUOUS_FRACTION = 0.05

# 범주마다 있어야 하는 최소 채점 문장 수. 이보다 적으면 범주별 비율이 한두 문장에 좌우된다.
MIN_SCORED_PER_CATEGORY = 20


@dataclass(frozen=True)
class ChatEvalItem:
    """평가셋 한 줄. category는 유해면 유해 범주, 허용이면 허용 유형이다."""

    item_id: str
    split: str
    label: str
    category: str
    family: str
    author: str
    reviewer: str
    text: str

    @property
    def is_scored(self) -> bool:
        """지표에 들어가는 문장인지(ambiguous가 아님)."""
        return self.label != "ambiguous"


def require_choice(record: dict, field: str, choices: Iterable[str], location: str) -> str:
    """문자열 필드가 정해진 값 중 하나인지 확인하고 돌려준다."""
    value = require_string_field(record, field, location)
    if value not in choices:
        raise DatasetFormatError(f"{location}: {field} 값 {value!r}을 알 수 없습니다. {', '.join(sorted(choices))} 중 하나로 고치세요.")
    return value


def require_category(record: dict, label: str, location: str) -> str:
    """라벨에 맞는 범주인지 확인한다. 유해는 유해 범주, 허용은 허용 유형, ambiguous는 둘 중 아무거나다."""
    allowed = {"harmful": HARMFUL_CATEGORIES, "allow": ALLOW_CATEGORIES}.get(label, HARMFUL_CATEGORIES + ALLOW_CATEGORIES)
    return require_choice(record, "category", allowed, location)


def require_distinct_reviewer(author: str, reviewer: str, location: str) -> None:
    """검토자가 작성자와 다른지 확인한다. 같은 모델이 쓰고 검토하면 독립 검토가 아니기 때문이다."""
    if author == reviewer:
        raise DatasetFormatError(f"{location}: 작성자와 검토자가 같습니다. 정책대로 다른 모델이 검토한 문장만 넣으세요.")


def parse_chat_eval_item(line: str, location: str) -> ChatEvalItem:
    """평가셋 한 줄을 ChatEvalItem으로 바꾼다. 필드·값·검토자 규칙을 검증한다."""
    record = parse_json_object(line, location)
    label = require_choice(record, "label", LABELS, location)
    author = require_string_field(record, "author", location)
    reviewer = require_string_field(record, "reviewer", location)
    require_distinct_reviewer(author, reviewer, location)
    return ChatEvalItem(
        item_id=require_string_field(record, "id", location),
        split=require_choice(record, "split", SPLITS, location),
        label=label,
        category=require_category(record, label, location),
        family=require_string_field(record, "family", location),
        author=author,
        reviewer=reviewer,
        text=require_string_field(record, "text", location),
    )


def ensure_unique_item_identifiers(items: Sequence[ChatEvalItem], file_name: str) -> None:
    """한 파일 안에서 id가 겹치지 않는지 확인한다. 점수와 문장을 id로 짝짓기 때문이다."""
    duplicated = sorted(identifier for identifier, count in Counter(item.item_id for item in items).items() if count > 1)
    if duplicated:
        raise DatasetFormatError(f"{file_name}: id가 겹칩니다({', '.join(duplicated[:5])}). 겹치지 않게 다시 번호를 매기세요.")


def ensure_single_split(items: Sequence[ChatEvalItem], file_name: str) -> None:
    """한 파일에는 한 셋(dev 또는 holdout)만 들어 있어야 한다. 섞이면 보류셋을 실수로 튜닝에 쓰게 된다."""
    splits = sorted({item.split for item in items})
    if len(splits) != 1:
        raise DatasetFormatError(f"{file_name}: 한 파일에 여러 셋({', '.join(splits)})이 섞여 있습니다. 셋마다 파일을 나누세요.")


def load_chat_eval_set(path: str | Path) -> list[ChatEvalItem]:
    """평가셋 파일을 모두 읽고 검증한다. 비어 있으면 오류를 낸다."""
    file_path = Path(path)
    items = [parse_chat_eval_item(line, location) for location, line in iterate_nonblank_lines(file_path, None)]
    if not items:
        raise DatasetFormatError(f"{file_path.name}: 평가 문장이 없습니다. 경로를 확인하세요.")
    ensure_unique_item_identifiers(items, file_path.name)
    ensure_single_split(items, file_path.name)
    return items


def normalize_for_overlap(text: str) -> str:
    """겹침 비교용 정규화: NFKC(전각·호환 문자 통일), 소문자, 공백·문장부호 제거. 숫자 사이의 구분자는 남긴다.

    왜 이 정도만 하나: 판정 파이프라인의 정규화(자모 조합·숫자 치환)까지 하면 서로 다른 문장이 같아져
    겹침을 지나치게 많이 잡는다. 여기서는 '사실상 같은 문장'만 잡으면 된다.
    """
    folded = unicodedata.normalize("NFKC", text).lower()
    marked = NUMERIC_SEPARATOR_PATTERN.sub(lambda match: NUMERIC_SEPARATOR_MARKS[match.group(0)], folded)
    return OVERLAP_STRIP_PATTERN.sub("", marked)


def character_ngrams(normalized_text: str) -> frozenset[str]:
    """정규화한 문장의 글자 3-gram 집합. 3글자보다 짧으면 문장 전체 하나를 쓴다."""
    if len(normalized_text) < CHARACTER_NGRAM_SIZE:
        return frozenset({normalized_text})
    return frozenset(normalized_text[index : index + CHARACTER_NGRAM_SIZE] for index in range(len(normalized_text) - CHARACTER_NGRAM_SIZE + 1))


def jaccard_similarity(first: frozenset[str], second: frozenset[str]) -> float:
    """두 집합의 자카드 유사도. 둘 다 비면 0이다."""
    union = first | second
    return len(first & second) / len(union) if union else 0.0


@dataclass(frozen=True)
class OverlapFinding:
    """겹침 한 건. 원문 대신 id와 유사도만 담는다."""

    item_id: str
    reference_id: str
    similarity: float


@dataclass(frozen=True)
class OverlapIndex:
    """비교 대상 문장들의 정규화 결과. 같은 대상을 여러 번 비교할 때 다시 계산하지 않기 위해서다."""

    entries: tuple[tuple[str, str, frozenset[str]], ...]

    @classmethod
    def build(cls, identified_texts: Iterable[tuple[str, str]]) -> OverlapIndex:
        """(id, 원문) 목록으로 색인을 만든다. 정규화 후 빈 문장은 비교할 것이 없어 뺀다."""
        normalized = ((identifier, normalize_for_overlap(text)) for identifier, text in identified_texts)
        return cls(tuple((identifier, text, character_ngrams(text)) for identifier, text in normalized if text))

    def find_overlap(self, item_id: str, text: str) -> OverlapFinding | None:
        """한 문장이 색인의 어느 문장과 같거나 거의 같으면 가장 비슷한 것 하나를 돌려준다."""
        normalized = normalize_for_overlap(text)
        ngrams = character_ngrams(normalized)
        best: OverlapFinding | None = None
        for reference_id, reference_text, reference_ngrams in self.entries:
            similarity = 1.0 if normalized == reference_text else jaccard_similarity(ngrams, reference_ngrams)
            if similarity >= NEAR_DUPLICATE_JACCARD and (best is None or similarity > best.similarity):
                best = OverlapFinding(item_id, reference_id, round(similarity, 3))
        return best


def find_overlaps(items: Sequence[ChatEvalItem], index: OverlapIndex) -> list[OverlapFinding]:
    """평가 문장마다 색인과의 겹침을 찾는다. 정규화 후 빈 문장(기호만 있는 문장)은 건너뛴다."""
    findings = (index.find_overlap(item.item_id, item.text) for item in items if normalize_for_overlap(item.text))
    return [finding for finding in findings if finding is not None]


def find_internal_duplicates(items: Sequence[ChatEvalItem]) -> list[OverlapFinding]:
    """한 셋 안에서 같거나 거의 같은 문장을 찾는다. 뒤에 나온 문장마다 앞의 문장 중 가장 비슷한 것 하나를 보고한다.

    왜: 한 틀에 낱말만 바꾼 문장이 여러 번 세어지면 범주별 비율이 그 틀 하나에 치우친다. 셋 사이 검사와 같은 기준을 쓴다.
    """
    findings: list[OverlapFinding] = []
    for position, item in enumerate(items):
        earlier = OverlapIndex.build((other.item_id, other.text) for other in items[:position])
        finding = earlier.find_overlap(item.item_id, item.text) if normalize_for_overlap(item.text) else None
        if finding is not None:
            findings.append(finding)
    return findings


def find_family_conflicts(item_sets: Sequence[Sequence[ChatEvalItem]]) -> list[OverlapFinding]:
    """같은 작성자의 같은 상황 계열이 두 셋에 걸쳐 있는지 찾는다(정책: 같은 계열은 같은 셋에).

    왜 작성자까지 묶나: 계열 이름은 작성 모델이 붙여서, 다른 모델이 우연히 같은 이름을 쓴 것은 같은 상황이라는 뜻이 아니다.
    """
    first_by_family: dict[tuple[str, str], ChatEvalItem] = {}
    findings: list[OverlapFinding] = []
    for items in item_sets:
        for item in items:
            first = first_by_family.setdefault((item.author, item.family), item)
            if first.split != item.split:
                findings.append(OverlapFinding(item.item_id, first.item_id, 1.0))
    return findings


def ensure_ambiguous_limit(items: Sequence[ChatEvalItem], file_name: str) -> None:
    """ambiguous 비율이 정책 상한(5%)을 넘지 않는지 확인한다."""
    ambiguous_count = sum(1 for item in items if not item.is_scored)
    if ambiguous_count > MAX_AMBIGUOUS_FRACTION * len(items):
        raise DatasetFormatError(f"{file_name}: ambiguous가 {ambiguous_count}/{len(items)}건으로 5%를 넘습니다. 정책으로 판정해 라벨을 붙이거나 문장을 빼세요.")


def ensure_category_coverage(items: Sequence[ChatEvalItem], file_name: str) -> None:
    """모든 유해 범주와 허용 유형에 채점 문장이 최소 수 이상 있는지 확인한다.

    왜: 범주가 빠지면 가중 전달률과 핵심 범주 재현율이 그 범주 없이 계산돼 실제보다 좋게 보인다.
    """
    counts = Counter(item.category for item in items if item.is_scored)
    short = [f"{category}({counts[category]})" for category in HARMFUL_CATEGORIES + ALLOW_CATEGORIES if counts[category] < MIN_SCORED_PER_CATEGORY]
    if short:
        raise DatasetFormatError(f"{file_name}: 채점 문장이 {MIN_SCORED_PER_CATEGORY}건보다 적은 범주가 있습니다: {', '.join(short)}. 문장을 더 넣으세요.")


def load_sealed_regression_index(path: Path = CHAT_SAMPLES_PATH) -> OverlapIndex:
    """봉인한 72문장으로 겹침 색인을 만든다. id는 'sealed:<번호>'로 표시한다."""
    return OverlapIndex.build((f"sealed:{sample.sample_id}", sample.text) for sample in load_chat_samples(path))


def describe_counts(items: Sequence[ChatEvalItem]) -> list[str]:
    """라벨·범주별 건수 표(원문 없음)."""
    counts = Counter((item.label, item.category) for item in items)
    return [f"  {label:9} {category:18} {count}" for (label, category), count in sorted(counts.items())]


def ensure_sealed_regression_unchanged() -> None:
    """봉인한 72문장 파일이 바뀌지 않았는지 확인한다. 바뀌었으면 겹침 검사의 기준이 흔들려 결과를 믿을 수 없다."""
    if compute_file_sha256(CHAT_SAMPLES_PATH) != SEALED_REGRESSION_SHA256:
        raise DatasetFormatError("봉인한 72문장 파일이 바뀌었습니다. 회귀 세트는 고치지 않습니다. git으로 원래 내용을 되돌리세요.")


def raise_if_overlapping(findings: Sequence[OverlapFinding]) -> None:
    """겹침이 있으면 id 목록(최대 20건)을 담아 오류를 낸다. 원문은 넣지 않는다."""
    if findings:
        listing = ", ".join(f"{finding.item_id}~{finding.reference_id}({finding.similarity})" for finding in findings[:20])
        raise DatasetFormatError(f"겹치는 문장 {len(findings)}건: {listing}. 해당 문장을 빼거나 다시 쓰세요.")


def load_validated_eval_set(path: Path) -> list[ChatEvalItem]:
    """평가에 쓸 셋 하나를 읽고, 봉인 확인·애매 비율·범주 구성·72문장 겹침·셋 안 중복을 모두 검사한다.

    왜 평가 도구도 검사하나: 검사 CLI를 건너뛰고 72문장을 베낀 파일로 바로 평가하면 그럴듯한 결과가 나오기 때문이다.
    두 셋 사이의 겹침과 계열 검사는 두 파일이 다 있어야 해서 검사 CLI와 저장소 테스트가 맡는다.
    """
    ensure_sealed_regression_unchanged()
    items = load_chat_eval_set(path)
    ensure_ambiguous_limit(items, path.name)
    ensure_category_coverage(items, path.name)
    raise_if_overlapping(find_overlaps(items, load_sealed_regression_index()) + find_internal_duplicates(items))
    return items


def find_cross_set_overlaps(item_sets: Sequence[Sequence[ChatEvalItem]]) -> list[OverlapFinding]:
    """서로 다른 셋 사이의 같거나 거의 같은 문장."""
    findings: list[OverlapFinding] = []
    for position, items in enumerate(item_sets):
        for other_items in item_sets[position + 1 :]:
            findings += find_overlaps(items, OverlapIndex.build((item.item_id, item.text) for item in other_items))
    return findings


def ensure_distinct_splits(item_sets: Sequence[Sequence[ChatEvalItem]]) -> None:
    """여러 파일을 함께 검사할 때 같은 셋(예: 개발셋 두 개)이 두 번 오면 오류다. 개발셋과 보류셋을 짝지어 보는 검사이기 때문이다."""
    splits = [items[0].split for items in item_sets]
    if len(splits) != len(set(splits)):
        raise DatasetFormatError(f"같은 셋이 두 번 들어왔습니다({', '.join(splits)}). 개발셋과 보류셋을 한 개씩 주세요.")


def check_eval_files(paths: Sequence[Path]) -> list[OverlapFinding]:
    """평가셋 파일들을 각각 검증하고(load_validated_eval_set), 셋 사이의 겹침과 계열 충돌을 모은다. 건수 요약을 출력한다."""
    item_sets = [load_validated_eval_set(path) for path in paths]
    ensure_distinct_splits(item_sets)
    for path, items in zip(paths, item_sets, strict=True):
        print(f"{path.name}: {len(items)}건({items[0].split})")
        print("\n".join(describe_counts(items)))
    return find_cross_set_overlaps(item_sets) + find_family_conflicts(item_sets)


def main(argv: Sequence[str] | None = None) -> None:
    """평가셋을 검증하고 겹침이 있으면 id 목록과 함께 오류로 끝낸다."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage1.chat_eval_data", description="채팅 평가셋 검증·겹침 검사")
    parser.add_argument("files", type=Path, nargs="+", help="평가셋 JSONL 파일(개발셋·보류셋)")
    arguments = parser.parse_args(argv)
    raise_if_overlapping(check_eval_files(arguments.files))
    print("겹침 없음")


if __name__ == "__main__":
    run_command_line(main)
