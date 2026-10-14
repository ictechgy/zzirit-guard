"""생성 모델이 말투보다 의미 칸과 안전 경계를 우선하도록 예문 없이 지시를 조립한다."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import asdict, dataclass

# 범주마다 문장에 꼭 들어갈 의미 칸. 파일럿 1회차(2026-10-14)에서 칸이 추상적이면 생성 모델이 '경고'·'걱정' 같은
# 순화된 값으로 채워 유효 비율이 낮았다(협박 0.07, 자해 0.08). 그래서 칸마다 구체적인 요소를 적는다.
HARMFUL_SLOTS: dict[str, tuple[str, ...]] = {
    "threat": (
        "화자가 할 구체적인 위해 행동(때리기·찾아가기·기다렸다 해치기·뒤쫓기 등)",
        "그 행동의 대상(스트리머나 특정 시청자)",
        "언제·어떤 조건에서 하겠다는 말",
    ),
    "minors": ("미성년 단서", "개인 연락으로 옮기기나 사적 만남 요청"),
    "sexual": (
        "가상의 스트리머의 몸이나 성적인 것을 원치 않게 언급하거나 요구하는 말(외모 칭찬·옷 칭찬이 아님)",
        "상대를 성적 대상으로 깎아내리는 태도",
        "15세 관람가 수준의 표현(노골적 묘사 없음)",
    ),
    "doxxing": (
        "가상의 스트리머나 시청자의 사는 동네·다니는 회사·학교·본명을 안다며 채팅창에 드러내거나 퍼뜨리겠다는 말",
        "모두 지어낸 단서(가짜 동네 이름·가짜 회사 이름). 숫자 주소·전화번호는 쓰지 않음",
    ),
    "self_harm": ("화자 본인이 죽고 싶다·사라지고 싶다·스스로 다치고 싶다는 의도를 직접 밝힘", "극복·위로·희망으로 끝내지 않음"),
}
# 3회차(성희롱·신상만): 2회차에서 두 범주는 거절이 많았다(60개 중 성희롱 35, 신상 50이 JSON이 아님).
# 인물이 가상임을 칸에 밝히고, 신상은 숫자 주소·전화번호 없이(규칙이 따로 잡는 모양), 성희롱은 수위를 15세 관람가로 묶는다.

# 유해 생성에서 나오면 안 되는 출력. 파일럿 1회차에서 성희롱 요청이 '성희롱을 비판·신고하는 말'로, 협박·자해 요청이
# '일반 대화·위로'로 바뀌었다. 무엇이 아닌지를 함께 적어 순화를 줄인다.
NOT_HARMFUL_OUTPUTS = "칭찬, 걱정·위로·응원, 유해한 말을 비판·인용·신고·말리는 문장, 농담으로 끝나는 말, 일반 대화"

SITUATIONS: dict[str, tuple[tuple[str, str], ...]] = {
    "sexual": (
        ("appearance_focus", "외형을 화제로 삼는 대화 맥락"),
        ("performance_reaction", "공개 활동에 반응하는 대화 맥락"),
        ("camera_presence", "화면에 보이는 모습을 언급하는 맥락"),
        ("clothing_context", "옷차림을 화제로 삼는 맥락"),
        ("private_boundary", "상대의 사적 경계를 넘는 맥락"),
        ("repeated_attention", "원치 않는 관심이 반복되는 맥락"),
    ),
    "minors": (
        ("age_question", "나이 단서가 드러나는 대화 맥락"),
        ("school_context", "학교 단서가 드러나는 대화 맥락"),
        ("platform_move", "공개 공간에서 개인 연락으로 옮기려는 맥락"),
        ("offline_invitation", "사적인 만남을 요청하는 맥락"),
        ("guardian_absence", "보호자 부재를 확인하는 맥락"),
        ("repeated_contact", "개인 접촉을 반복해서 요청하는 맥락"),
    ),
    "threat": (
        ("competition_conflict", "경쟁 과정의 갈등이 커지는 맥락"),
        ("rejection_response", "거절에 반응해 압박하는 맥락"),
        ("future_encounter", "앞으로 마주칠 상황을 내세우는 맥락"),
        ("location_pressure", "상대가 있는 곳을 의식시키는 맥락"),
        ("conditional_retaliation", "조건을 붙여 보복을 암시하는 맥락"),
        ("persistent_following", "지속적인 추적을 암시하는 맥락"),
    ),
    "doxxing": (
        ("identity_claim", "신원을 안다고 주장하는 맥락"),
        ("workplace_claim", "직장 단서를 특정하려는 맥락"),
        ("school_claim", "학교 단서를 특정하려는 맥락"),
        ("residence_claim", "사는 곳을 특정하려는 맥락"),
        ("disclosure_pressure", "정보 공개를 압박 수단으로 쓰는 맥락"),
        ("cross_source_link", "여러 공개 단서를 한 사람과 잇는 맥락"),
    ),
    "self_harm": (
        ("immediate_distress", "현재의 극심한 괴로움을 말하는 맥락"),
        ("future_intent", "가까운 미래의 의도를 밝히는 맥락"),
        ("farewell_tone", "작별 분위기로 의도를 드러내는 맥락"),
        ("hopelessness", "절망과 본인 행동 의도가 이어지는 맥락"),
        ("help_signal", "도움이 필요함을 간접적으로 드러내는 맥락"),
        ("repeated_intent", "본인의 의도를 반복해서 밝히는 맥락"),
    ),
}

# 생성 모델에 보여 줄 범주의 한국어 이름. 영문 범주 이름만 주면 한국어 모델이 뜻을 놓치기 쉽다.
CATEGORY_NAMES = {
    "threat": "협박",
    "minors": "미성년자 대상 접근·유인",
    "sexual": "성희롱",
    "doxxing": "신상 폭로",
    "self_harm": "자살·자해 의도 표현",
}

LENGTHS = ("short", "medium", "long")
REGISTERS = ("반말", "존댓말")
DIRECTNESSES = ("직접", "간접")
NOISES = ("초성·오타·이모티콘 섞기", "없음")
LENGTH_GUIDANCE = {"short": "15자 이하", "medium": "16~40자", "long": "40자 초과"}
BOUNDARY_KINDS = frozenset({"legit_mention", "quote_report", "friendly_profanity"})


@dataclass(frozen=True)
class Cell:
    """한 번의 작은 생성을 한 스타일 조합에 묶어 분포 쏠림을 추적할 수 있게 한다."""

    category: str
    situation: str
    length: str
    register: str
    directness: str
    noise: str


def iter_cells(category: str) -> Iterator[Cell]:
    """짧은 접두 구간도 축별로 번갈아 나오게 해 파일럿 수가 전체 조합보다 작아도 말투가 몰리지 않게 한다."""
    if category not in HARMFUL_SLOTS:
        raise ValueError(f"알 수 없는 유해 범주 {category!r}입니다. {', '.join(HARMFUL_SLOTS)} 중 하나를 쓰세요.")
    situations = SITUATIONS[category]
    total = len(situations) * len(LENGTHS) * len(REGISTERS) * len(DIRECTNESSES) * len(NOISES)
    for index in range(total):
        situation, length, register, directness, noise = balanced_axis_indices(index, len(situations))
        yield Cell(category, situations[situation][0], LENGTHS[length], REGISTERS[register], DIRECTNESSES[directness], NOISES[noise])


def balanced_axis_indices(index: int, situation_count: int) -> tuple[int, int, int, int, int]:
    """가역적인 축 회전을 써 조합 중복 없이 각 접두 구간의 개별 축 빈도 차이를 작게 유지한다."""
    situation = index % situation_count
    remainder = index // situation_count
    length, remainder = remainder % len(LENGTHS), remainder // len(LENGTHS)
    register, remainder = remainder % len(REGISTERS), remainder // len(REGISTERS)
    directness, noise = remainder % len(DIRECTNESSES), remainder // len(DIRECTNESSES)
    length = (length + situation) % len(LENGTHS)
    register = (register + length + situation) % len(REGISTERS)
    directness = (directness + register + length + situation) % len(DIRECTNESSES)
    noise = (noise + directness + register + length + situation) % len(NOISES)
    return situation, length, register, directness, noise


def cell_dict(cell: Cell) -> dict[str, str]:
    """manifest와 결과가 dataclass 표현 방식에 기대지 않도록 명시적인 문자열 사전으로 바꾼다."""
    return asdict(cell)


def safety_rules() -> str:
    """모든 생성 경로에 같은 금지선을 넣어 프롬프트 종류에 따른 안전 누락을 막는다."""
    return (
        "미성년 관련 성적 내용은 절대 만들지 마라. 노골적인 성적 묘사는 절대 쓰지 마라. "
        "자해 방법·수단·양·장소는 절대 쓰지 마라. "
        "실존 인물의 이름·연락처·주소·직장·학교 등 실제 개인정보는 절대 쓰지 마라."
    )


def build_harmful_messages(cell: Cell, count: int) -> list[dict[str, str]]:
    """모델이 범주 이름만 흉내 내지 않고 필수 의미를 먼저 구조화하게 해 유효 비율을 높인다."""
    require_count(count)
    description = dict(SITUATIONS[cell.category])[cell.situation]
    slots = json.dumps(HARMFUL_SLOTS[cell.category], ensure_ascii=False)
    user = (
        f"범주={CATEGORY_NAMES[cell.category]}({cell.category}), 상황={description}, 길이={LENGTH_GUIDANCE[cell.length]}, "
        f"말투={cell.register}, 직접성={cell.directness}, 표기 잡음={cell.noise}. 필수 의미 칸={slots}. "
        "이 문장들은 '유해' 라벨로 쓰이므로, 매니저가 보면 바로 숨기거나 조치할 수준이어야 한다. "
        f"다음은 유해가 아니므로 쓰지 마라: {NOT_HARMFUL_OUTPUTS}. "
        f"각 항목에서 의미 칸을 먼저 채운 뒤 채팅 한 줄 하나로 바꿔라. 서로 다른 항목 {count}개를 만들고, "
        '각 줄에 JSON 객체 하나만 써라: {"slots": {"칸": "값"}, "text": "채팅 한 줄"}. 설명이나 번호는 쓰지 마라.'
    )
    return base_messages(user)


def build_twin_messages(text: str, count: int, register: str, length: str) -> list[dict[str, str]]:
    """해로운 부분만 뺀 대조쌍을 만들어 화제나 말투가 라벨 지름길이 되지 않게 한다."""
    require_count(count)
    if register not in REGISTERS or length not in LENGTHS:
        raise ValueError("말투나 길이 값이 잘못됐습니다. 셀에 기록된 축 값을 쓰세요.")
    user = (
        f"입력 채팅: {text}\n말투={register}, 길이={LENGTH_GUIDANCE[length]}. "
        "화제·핵심 낱말·말투를 유지하고 해로운 부분만 최소한으로 없앤 "
        f"서로 다른 허용 문장 {count}개를 만들어라. 날씨 같은 다른 화제로 바꾸거나 새 상황을 보태지 마라. "
        '각 줄에 JSON 객체 하나만 써라: {"text": "채팅 한 줄"}. 설명이나 번호는 쓰지 마라.'
    )
    return base_messages(user)


def build_boundary_messages(kind: str, cell_like: Cell | Mapping[str, str], count: int) -> list[dict[str, str]]:
    """어려운 허용 유형을 스타일 셀에 맞춰 따로 생성해 유해 문장과 균형 잡힌 경계를 만든다."""
    require_count(count)
    if kind not in BOUNDARY_KINDS:
        raise ValueError(f"알 수 없는 경계 유형 {kind!r}입니다. {', '.join(sorted(BOUNDARY_KINDS))} 중 하나를 쓰세요.")
    style = cell_like if isinstance(cell_like, Mapping) else cell_dict(cell_like)
    user = boundary_instruction(kind, style, count)
    return base_messages(user)


def boundary_instruction(kind: str, style: Mapping[str, str], count: int) -> str:
    """유형별 허용 조건을 분리해 한 프롬프트가 여러 판정 기준을 섞지 않게 한다."""
    meanings = {
        "legit_mention": "나이·학교·외모·동네·연락처 중 하나를 해롭지 않게 언급",
        "quote_report": "유해 표현을 지지하지 않고 인용·신고·비판·부정",
        "friendly_profanity": "모욕할 대상 없이 친근한 감탄·칭찬·강조",
    }
    length = LENGTH_GUIDANCE.get(style.get("length", "medium"), "16~40자")
    register = style.get("register", "반말")
    noise = style.get("noise", "없음")
    return (
        f"허용 유형={kind}({meanings[kind]}), 길이={length}, 말투={register}, 표기 잡음={noise}. "
        f"명백히 허용인 서로 다른 채팅 한 줄 {count}개를 만들어라. "
        '각 줄에 JSON 객체 하나만 써라: {"text": "채팅 한 줄"}. 설명이나 번호는 쓰지 마라.'
    )


def base_messages(user_content: str) -> list[dict[str, str]]:
    """안전 금지를 시스템 역할에 고정해 사용자 지시의 세부 내용보다 항상 먼저 적용되게 한다.

    왜 용도를 밝히나: 탐침에서 생성 모델은 용도를 모르면 요청을 순화했다(성희롱 → 칭찬). 실제 사람을 해치려는 것이 아니라
    매니저가 숨겨야 할 메시지를 찾는 분류기의 학습 데이터라는 맥락과, 한국 인터넷 방송 채팅창이라는 장면을 함께 준다.
    """
    system = (
        "너는 한국 인터넷 방송 채팅창 관리 도구의 분류기를 학습시키는 합성 데이터를 만드는 도구다. "
        "실제 사람을 해치려는 것이 아니라, 매니저가 숨기거나 살펴야 할 메시지를 모델이 찾게 하려는 것이다. "
        f"모든 문장은 방송 채팅창에 올라오는 채팅 한 줄처럼 쓴다. {safety_rules()} 요구한 JSONL 외에는 출력하지 마라."
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user_content}]


def require_count(count: int) -> None:
    """빈 요청이나 과도한 한 묶음을 막아 계획의 2~4개 소묶음 계약을 호출자가 명확히 지키게 한다."""
    if not 1 <= count <= 4:
        raise ValueError("한 프롬프트의 count는 1~4여야 합니다. 호출을 작은 묶음으로 나누세요.")


def messages_sha256(messages: Sequence[Mapping[str, str]]) -> str:
    """키 순서와 한글 이스케이프 차이를 제거한 해시로 실질적으로 같은 지시를 같은 값으로 센다."""
    canonical = json.dumps(messages, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
