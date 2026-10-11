/**
 * 글자 사이에 끼워 필터를 피하는 데 쓰는 보이지 않는 문자를 지운다.
 * 제로폭·서식 문자(U+00AD, U+200B~U+200F, U+2060~U+2064, U+FEFF)와 한글 채움 문자(U+115F, U+1160, U+3164)·반각 채움 문자(U+FFA0)를 포함한다.
 * 한글 채움 문자는 Script=Hangul이라 아래 DISALLOWED_CHARACTERS에서 남으므로 여기서 먼저 지워야 한다.
 */
const INVISIBLE_CHARACTERS = /[\u00AD\u115F\u1160\u200B-\u200F\u2060-\u2064\u3164\uFEFF\uFFA0]/g;
/** 전각 ASCII 영역(！~～). 반각으로 바꾼다. */
const FULLWIDTH_ASCII = /[！-～]/g;
/** 남길 문자: 한글(음절·자모), 영문 소문자, 숫자, 그리고 모음 대용으로 쓰는 '|'. */
const DISALLOWED_CHARACTERS = /[^\p{Script=Hangul}a-z0-9|]/gu;
/** normalizeKeepingWhitespace용: DISALLOWED_CHARACTERS와 같되 공백 문자(\s)도 남긴다. 단어 경계를 보존하려는 것이다. */
const DISALLOWED_CHARACTERS_EXCEPT_WHITESPACE = /[^\p{Script=Hangul}a-z0-9|\s]/gu;
/** 연이은 공백 문자(줄바꿈·전각 공백 포함). 한 칸으로 줄여 공백 개수에 따라 일치가 갈리지 않게 한다. */
const WHITESPACE_RUN = /\s+/g;
/**
 * 한글 방점(U+302E·U+302F)과 아래아(ㆍ, U+318D). Script=Hangul이라 DISALLOWED_CHARACTERS에서 남는데, 화면에서는 작은 점으로만 보여
 * 금칙어 글자 사이에 끼워 넣는 우회("김치〮녀")에 쓰인다. 두 비교용 정규화 모두에서 지운다.
 */
const HANGUL_DOT_MARKS = /[\u302E\u302F\u318D]/g;
/**
 * 좁은 공백류(U+1680, U+2006~U+200A, U+2028, U+2029, U+202F, U+205F). \s에 들어 있어 공백 유지 형태에서 공백 한 칸이 되는데,
 * 화면에서는 거의 붙어 보여 글자 사이에 끼우면 금칙어 강이 "단어를 걸친 일치"로 보여 자동 숨김이 후보로 낮아진다(S2).
 * 그래서 공백 유지 형태에서도 공백으로 보지 않고 지운다. 공백 없는 형태에서는 원래부터 DISALLOWED_CHARACTERS가 지운다.
 */
const NARROW_SPACES = /[\u1680\u2006-\u200A\u2028\u2029\u202F\u205F]/g;
/** 자음 자모 바로 뒤의 1·l·|은 모음 'ㅣ'로 쓰인 것이다(예: ㅅ1발). */
const VOWEL_LOOKALIKE_AFTER_CONSONANT = /(?<=[ㄱ-ㅎ])[1l|]/g;
/** 두 음절 사이에 끼운 1·l·|은 채워 넣은 잡음이다(예: 병1신). */
const FILLER_BETWEEN_SYLLABLES = /(?<=[가-힣])[1l|]+(?=[가-힣])/g;
/**
 * 같은 글자 3번 이상 반복을 2번으로 줄인다(예: ㅋㅋㅋ, 시이이발).
 * 숫자(0-9)는 제외한다. 숫자는 뜻을 담으므로 "1000명"의 000을 줄이면 의미가 바뀐다.
 */
const REPEATED_CHARACTERS = /([^0-9])\1{2,}/gu;

/** 초성 순서(유니코드 음절 조합 공식의 순서). */
const CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
/** 중성 순서. */
const JUNGSEONG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
/** 종성 순서. 0번(받침 없음) 자리는 비워 둔다. */
const JONGSEONG = "\u0000ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";

/**
 * 보이지 않는 문자를 지우고 전각 ASCII를 반각으로 바꾼다. 소문자화·글자 제거는 하지 않는다.
 * 채팅 UI는 이런 문자를 건너뛰고 링크·번호로 그려 주므로, 패턴 검사 전에 같은 모양으로 맞춰야 우회를 막는다.
 * 순서: NFC → 보이지 않는 문자 제거 → 전각→반각.
 */
export function stripInvisibleAndFullwidth(text: string): string {
  return text
    .normalize("NFC")
    .replace(INVISIBLE_CHARACTERS, "")
    .replace(FULLWIDTH_ASCII, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0));
}

/**
 * 금칙어 비교용 문자열을 만든다. 표시용이 아니다.
 * 순서: NFC → 제로폭 제거 → 전각→반각 → 소문자 → 한글 방점·아래아 제거 → 허용 문자만 → 모음 대용 1 → 잡음 1 제거 → 자모 조합 → 반복 축약.
 */
export function normalizeForMatching(text: string): string {
  return finishMatchingNormalization(prepareForMatching(text).replace(DISALLOWED_CHARACTERS, ""));
}

/**
 * normalizeForMatching과 같은 단계를 거치되 공백만 지우지 않는다. 연이은 공백은 한 칸으로 줄이고 앞뒤 공백은 자른다.
 * 왜: 공백을 모두 지운 문장에서는 "김치 녀석들"처럼 단어를 걸친 우연한 일치가 생긴다. 되돌릴 수 없는 자동 숨김은
 * 단어 안에 그대로 든 금칙어 강에만 쓰고, 공백을 지워야만 걸리는 것은 후보로 낮추려고 이 형태와 비교한다(F4).
 * '|'·잡음 1을 지운 뒤 생긴 연속 공백도 한 칸으로 다시 줄인다("나쁜 | 놈" → "나쁜 놈", R2).
 * 좁은 공백류(NARROW_SPACES)는 공백으로 보지 않고 지운다(S2).
 * 주의: 글자마다 띄운 우회("김 치 녀")는 이 형태에서 걸리지 않으므로, 공백 없는 형태와 함께 써야 후보로라도 잡힌다.
 * @param text 채팅 원문
 * @returns 공백이 한 칸씩 남은 비교용 문자열(표시용이 아니다)
 */
export function normalizeKeepingWhitespace(text: string): string {
  const cleaned = prepareForMatching(text).replace(NARROW_SPACES, "").replace(DISALLOWED_CHARACTERS_EXCEPT_WHITESPACE, "");
  return finishMatchingNormalization(cleaned.replace(WHITESPACE_RUN, " ").trim()).replace(WHITESPACE_RUN, " ").trim();
}

/**
 * 두 비교용 정규화의 공통 앞 단계: 보이지 않는 문자 제거·전각→반각 → 소문자 → 한글 방점·아래아 제거.
 * 왜 stripInvisibleAndFullwidth에 넣지 않나: 그 함수는 링크·전화번호 검사도 쓰는데, 방점은 링크·번호 모양과 관계가 없어 금칙어 비교에서만 지운다.
 * @param text 채팅 원문
 * @returns 허용 문자 거르기 전의 비교용 문자열
 */
function prepareForMatching(text: string): string {
  return stripInvisibleAndFullwidth(text).toLowerCase().replace(HANGUL_DOT_MARKS, "");
}

/**
 * 허용 문자만 남긴 뒤의 공통 단계: 모음 대용 1 → 잡음 1 제거 → '|' 제거 → 자모 조합 → 반복 축약.
 * 두 정규화가 같은 단계를 쓰게 해, 공백 처리 말고는 결과가 갈리지 않게 한다.
 * @param cleaned 허용 문자만 남긴 소문자 문자열
 */
function finishMatchingNormalization(cleaned: string): string {
  const withVowels = cleaned.replace(VOWEL_LOOKALIKE_AFTER_CONSONANT, "ㅣ").replace(FILLER_BETWEEN_SYLLABLES, "").replace(/\|/g, "");
  return composeJamo(withVowels).replace(REPEATED_CHARACTERS, "$1$1");
}

/** 낱자 자모(초성+중성[+종성])를 완성 음절로 합친다. 예: "ㅂㅏ" → "바". */
function composeJamo(text: string): string {
  const characters = [...text];
  let result = "";
  let index = 0;
  while (index < characters.length) {
    const [piece, consumed] = composeAt(characters, index);
    result += piece;
    index += consumed;
  }
  return result;
}

/** index 위치에서 음절 하나를 만들 수 있으면 만들고, 소비한 글자 수를 함께 돌려준다. */
function composeAt(characters: readonly string[], index: number): [string, number] {
  const initial = tableIndex(CHOSEONG, characters[index]);
  const medial = tableIndex(JUNGSEONG, characters[index + 1]);
  if (initial < 0 || medial < 0) return [characters[index] as string, 1];
  const final = finalIndex(characters, index + 2);
  const syllable = String.fromCharCode(0xac00 + (initial * 21 + medial) * 28 + final);
  return [syllable, final > 0 ? 3 : 2];
}

/** 받침으로 쓸 수 있는 자음이고 뒤에 모음이 오지 않을 때만 받침으로 본다(뒤에 모음이 오면 다음 음절의 초성). */
function finalIndex(characters: readonly string[], index: number): number {
  const candidate = tableIndex(JONGSEONG, characters[index]);
  if (candidate <= 0) return 0;
  return tableIndex(JUNGSEONG, characters[index + 1]) >= 0 ? 0 : candidate;
}

/** 표에서 글자의 위치. 글자가 없으면 -1(빈 문자열 indexOf가 0을 주는 함정을 피한다). */
function tableIndex(table: string, character: string | undefined): number {
  return character ? table.indexOf(character) : -1;
}
