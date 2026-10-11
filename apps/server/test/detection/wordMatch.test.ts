import { describe, expect, it } from "vitest";
import type { RuleEntry } from "../../src/detection/ruleRepository.js";
import { findFirstIntactMatch, findFirstMatch, locateExceptions, locateExceptionsKeepingWhitespace } from "../../src/detection/wordMatch.js";

/** 테스트용 규칙 항목. spacedPattern을 생략하면 공백 없는 규칙으로 본다. */
function entry(id: number, normalizedPattern: string, spacedPattern = normalizedPattern): RuleEntry {
  return { id, kind: "weak", pattern: spacedPattern, normalizedPattern, spacedPattern, createdBy: "test", createdAt: 0 };
}

/** 공백 없는 비교: 예외 단어 위치를 찾은 뒤 첫 일치 규칙의 id(없으면 null). */
function compactMatchId(text: string, exceptions: RuleEntry[], entries: RuleEntry[]): number | null {
  return findFirstMatch(locateExceptions(text, exceptions), entries)?.id ?? null;
}

/** 공백 유지 비교: 예외 단어 위치를 찾은 뒤 단어 안에 그대로 든 첫 규칙의 id(없으면 null). */
function intactMatchId(text: string, exceptions: RuleEntry[], entries: RuleEntry[]): number | null {
  return findFirstIntactMatch(locateExceptionsKeepingWhitespace(text, exceptions), entries)?.id ?? null;
}

/** 금칙어 "시발". */
const SIBAL = entry(2, "시발");
/** 예외 단어 "시발점". */
const SIBAL_POINT = entry(1, "시발점");

describe("wordMatch", () => {
  it("예외 단어 안에 든 금칙어는 버리고, 예외 단어 밖에 있는 것은 찾는다", () => {
    expect(compactMatchId("여기가시발점이야", [SIBAL_POINT], [SIBAL])).toBeNull();
    expect(compactMatchId("시발점이야시발", [SIBAL_POINT], [SIBAL])).toBe(2);
  });

  it.each(["시발점", "출시시발점발표", "시시발점발"])("'%s'의 '시발'은 모두 예외 단어 안에 있어 일치하지 않는다(F7: 앞뒤를 이어 붙이지 않는다)", (text) => {
    expect(compactMatchId(text, [SIBAL_POINT], [SIBAL])).toBeNull();
    expect(intactMatchId(text, [SIBAL_POINT], [SIBAL])).toBeNull();
  });

  it("공백을 남긴 문장에서도 예외 단어 안의 일치만 버린다(F7)", () => {
    expect(intactMatchId("출시 시발점 발표", [SIBAL_POINT], [SIBAL])).toBeNull();
  });

  it("같은 금칙어가 예외 단어 밖에도 있으면 찾는다(S4)", () => {
    const taxi = entry(3, "시발택시");
    expect(compactMatchId("시발택시발", [taxi], [SIBAL])).toBe(2);
    expect(intactMatchId("시발택시발", [taxi], [SIBAL])).toBe(2);
  });

  it("예외 단어와 일부만 겹치는 금칙어는 가려지지 않는다(S4)", () => {
    const finger = entry(4, "새끼손가락");
    const insult = entry(5, "개새끼");
    expect(compactMatchId("개새끼손가락", [finger], [insult])).toBe(5);
    expect(intactMatchId("개새끼손가락", [finger], [insult])).toBe(5);
  });

  it("공백 든 예외 단어는 공백 형태와 붙여 쓴 형태 모두 가린다(R2)", () => {
    const exception = entry(6, "짱깨집", "짱깨 집");
    expect(intactMatchId("짱깨 집 가자", [exception], [entry(7, "짱깨")])).toBeNull();
    expect(intactMatchId("짱깨집 가자", [exception], [entry(7, "짱깨")])).toBeNull();
  });

  it("빈 패턴은 금칙어로도 예외 단어로도 아무것과 일치하지 않는다", () => {
    expect(compactMatchId("아무 말", [], [entry(8, "")])).toBeNull();
    expect(compactMatchId("시발", [entry(9, "")], [SIBAL])).toBe(2);
  });

  it("목록 순서대로 첫 일치를 돌려준다", () => {
    expect(compactMatchId("ㅂㅅ같이", [], [entry(3, "병신"), entry(4, "ㅂㅅ")])).toBe(4);
  });

  it("findFirstIntactMatch는 공백을 넘는 일치를 찾지 않는다(F4)", () => {
    expect(intactMatchId("김치 녀석들", [], [entry(5, "김치녀")])).toBeNull();
    expect(intactMatchId("김치녀 같은", [], [entry(5, "김치녀")])).toBe(5);
  });

  it("findFirstIntactMatch는 공백이 든 규칙을 공백 그대로도, 붙여 쓴 것도 찾는다(F4)", () => {
    const rule = entry(6, "나쁜놈", "나쁜 놈");
    expect(intactMatchId("이 나쁜 놈아", [], [rule])).toBe(6);
    expect(intactMatchId("이 나쁜놈아", [], [rule])).toBe(6);
    expect(intactMatchId("나 쁜 놈", [], [rule])).toBeNull();
  });
});
