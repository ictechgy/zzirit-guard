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
 * 금칙어 비교용 문자열을 만든다. 표시용이 아니다.
 * 순서: NFC → 제로폭 제거 → 전각→반각 → 소문자 → 허용 문자만 → 모음 대용 1 → 잡음 1 제거 → 자모 조합 → 반복 축약.
 */
export function normalizeForMatching(text: string): string {
  const cleaned = text
    .normalize("NFC")
    .replace(INVISIBLE_CHARACTERS, "")
    .replace(FULLWIDTH_ASCII, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(DISALLOWED_CHARACTERS, "");
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
