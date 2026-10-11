import { describe, expect, it } from "vitest";
import type { RuleEntry } from "../../src/detection/ruleRepository.js";
import { findFirstMatch, stripExceptions } from "../../src/detection/wordMatch.js";

/** 테스트용 규칙 항목. */
function entry(id: number, normalizedPattern: string): RuleEntry {
  return { id, kind: "weak", pattern: normalizedPattern, normalizedPattern, createdBy: "test", createdAt: 0 };
}

describe("wordMatch", () => {
  it("예외 단어를 지운 뒤 금칙어를 찾는다", () => {
    const exceptions = [entry(1, "시발점")];
    expect(findFirstMatch(stripExceptions("여기가시발점이야", exceptions), [entry(2, "시발")])).toBeNull();
    expect(findFirstMatch(stripExceptions("시발점이야시발", exceptions), [entry(2, "시발")])?.id).toBe(2);
  });

  it("목록 순서대로 첫 일치를 돌려준다", () => {
    expect(findFirstMatch("ㅂㅅ같이", [entry(3, "병신"), entry(4, "ㅂㅅ")])?.id).toBe(4);
  });
});
