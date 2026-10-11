import { describe, expect, it } from "vitest";
import { normalizeForMatching, stripInvisibleAndFullwidth } from "../../src/detection/normalize.js";

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
