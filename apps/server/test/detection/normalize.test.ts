import { describe, expect, it } from "vitest";
import { normalizeForMatching, normalizeKeepingWhitespace, stripInvisibleAndFullwidth } from "../../src/detection/normalize.js";

describe("normalizeForMatching", () => {
  it.each([
    ["공백·특수문자를 지운다", "씨@발 방송 꺼라", "씨발방송꺼라"],
    ["제로폭 문자를 지운다", "씨​발", "씨발"],
    ["전각 영문을 반각 소문자로", "ＳＩＢＡＬ", "sibal"],
    ["흩어진 자모를 조합한다", "시 ㅂ ㅏ", "시바"],
    ["자음 뒤 숫자 1은 모음 ㅣ로 본다", "ㅅ1발 진짜", "시발진짜"],
    ["음절 사이에 끼운 1은 지운다", "병1신", "병신"],
    ["3번 이상 반복은 2번으로 줄인다", "ㅋㅋㅋㅋㅋㅋ", "ㅋㅋ"],
    ["자음만 있는 표기는 그대로", "ㅂㅅ같이 하네", "ㅂㅅ같이하네"],
    ["오탐 단어도 모양은 그대로 둔다(예외 단어로 처리)", "시발점", "시발점"],
    ["음절과 숫자 사이의 숫자는 그대로", "구독자 1000명", "구독자1000명"],
    ["이모티콘만 있으면 빈 문자열", "😀😀", ""],
    ["숫자 반복은 줄이지 않는다", "1000", "1000"],
    ["한글 채움 문자를 지운다", "씨\u3164발", "씨발"],
    ["반각 채움 문자도 지운다", "시\uFFA0발", "시발"],
    ["한글 방점(U+302E)을 지운다", "씨\u302E발", "씨발"],
    ["한글 겹방점(U+302F)을 지운다", "시\u302F발", "시발"],
    ["아래아(ㆍ, U+318D)를 지운다", "병\u318D신", "병신"],
    ["옛 아래아(U+119E)를 지운다", "병\u119E신", "병신"],
    ["옛 쌍아래아(U+11A2)를 지운다", "병\u11A2신", "병신"],
  ])("%s", (_name, input, expected) => {
    expect(normalizeForMatching(input)).toBe(expected);
  });
});

describe("stripInvisibleAndFullwidth", () => {
  it.each([
    ["보이지 않는 문자와 전각 영문을 바꾸고 대소문자·공백은 그대로", "ｅｖｉｌ​．Ｃｏｍ 1", "evil.Com 1"],
    ["전각 숫자와 하이픈을 반각으로", "０１０－１２３４", "010-1234"],
  ])("%s", (_name, input, expected) => {
    expect(stripInvisibleAndFullwidth(input)).toBe(expected);
  });
});

describe("normalizeKeepingWhitespace", () => {
  it.each([
    ["공백은 남기고 특수문자는 지운다", "씨@발 방송 꺼라", "씨발 방송 꺼라"],
    ["연이은 공백·줄바꿈·전각 공백은 한 칸으로 줄이고 앞뒤 공백은 자른다", "  김치\n\t 녀석들\u3000맛있다 ", "김치 녀석들 맛있다"],
    ["특수문자만 사이에 끼운 것은 붙인다", "김.치.녀", "김치녀"],
    ["글자마다 띄운 것은 띄운 채로 둔다", "김 치 녀", "김 치 녀"],
    ["나머지 단계는 normalizeForMatching과 같다", "ㅅ1발 ＳＩＢＡＬ 시이이이발", "시발 sibal 시이이발"],
    ["좁은 공백류는 공백으로 남기지 않고 붙인다(S2)", "김\u2006치\u2009녀\u200A같\u202F은\u205F말\u1680이\u2028다\u2029요 진짜", "김치녀같은말이다요 진짜"],
    ["한글 방점·아래아도 지운다", "김\u318D치\u302E녀 같\u302F은", "김치녀 같은"],
  ])("%s", (_name, input, expected) => {
    expect(normalizeKeepingWhitespace(input)).toBe(expected);
  });

  it("공백을 지우면 normalizeForMatching과 같은 결과가 된다(공백이 단어 안 처리를 바꾸지 않는 입력)", () => {
    for (const input of ["씨@발 방송 꺼라", "김치 녀석들 맛있다", "병1신 같은", "ＳＩＢＡＬ 진짜"]) {
      expect(normalizeKeepingWhitespace(input).replace(/ /g, "")).toBe(normalizeForMatching(input));
    }
  });
});
