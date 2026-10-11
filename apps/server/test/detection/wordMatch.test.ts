import { describe, expect, it } from "vitest";
import type { RuleEntry } from "../../src/detection/ruleRepository.js";
import { findFirstIntactMatch, findFirstMatch, stripExceptions } from "../../src/detection/wordMatch.js";

/** 테스트용 규칙 항목. spacedPattern을 생략하면 공백 없는 규칙으로 본다. */
function entry(id: number, normalizedPattern: string, spacedPattern = normalizedPattern): RuleEntry {
  return { id, kind: "weak", pattern: spacedPattern, normalizedPattern, spacedPattern, createdBy: "test", createdAt: 0 };
}

describe("wordMatch", () => {
  it("예외 단어를 지운 뒤 금칙어를 찾는다", () => {
    const exceptions = [entry(1, "시발점")];
    expect(findFirstMatch(stripExceptions("여기가시발점이야", exceptions), [entry(2, "시발")])).toBeNull();
    expect(findFirstMatch(stripExceptions("시발점이야시발", exceptions), [entry(2, "시발")])?.id).toBe(2);
  });

  it("예외 단어를 지운 자리의 앞뒤를 이어 붙여 새 금칙어를 만들지 않는다(F7)", () => {
    const exceptions = [entry(1, "시발점")];
    expect(findFirstMatch(stripExceptions("시시발점발", exceptions), [entry(2, "시발")])).toBeNull();
    expect(findFirstMatch(stripExceptions("출시시발점발표", exceptions), [entry(2, "시발")])).toBeNull();
    expect(findFirstIntactMatch(stripExceptions("출시 시발점 발표", exceptions), [entry(2, "시발")])).toBeNull();
  });

  it("목록 순서대로 첫 일치를 돌려준다", () => {
    expect(findFirstMatch("ㅂㅅ같이", [entry(3, "병신"), entry(4, "ㅂㅅ")])?.id).toBe(4);
  });

  it("findFirstIntactMatch는 공백을 넘는 일치를 찾지 않는다(F4)", () => {
    expect(findFirstIntactMatch("김치 녀석들", [entry(5, "김치녀")])).toBeNull();
    expect(findFirstIntactMatch("김치녀 같은", [entry(5, "김치녀")])?.id).toBe(5);
  });

  it("findFirstIntactMatch는 공백이 든 규칙을 공백 그대로도, 붙여 쓴 것도 찾는다(F4)", () => {
    const rule = entry(6, "나쁜놈", "나쁜 놈");
    expect(findFirstIntactMatch("이 나쁜 놈아", [rule])?.id).toBe(6);
    expect(findFirstIntactMatch("이 나쁜놈아", [rule])?.id).toBe(6);
    expect(findFirstIntactMatch("나 쁜 놈", [rule])).toBeNull();
  });
});
