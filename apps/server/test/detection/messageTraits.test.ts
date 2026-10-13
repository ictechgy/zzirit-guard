import { describe, expect, it } from "vitest";
import { createDuplicateTracker, duplicateKeyOf, isTrivialMessage } from "../../src/detection/messageTraits.js";

describe("isTrivialMessage", () => {
  it.each([["ㅋㅋ", true], ["ㅎㅎ", true], ["ㄷㄷ", true], ["ㅠㅠ", true], ["", true], ["ㄴㄱㅁ", false], ["ㅋㅋ개웃기네", false]])(
    "%s → %s",
    (normalized, expected) => expect(isTrivialMessage(normalized)).toBe(expected),
  );
});

describe("DuplicateTracker", () => {
  it("10분 안에 다시 나온 문장을 중복으로 본다", () => {
    const tracker = createDuplicateTracker();
    expect(tracker.seen("안녕하세요", 0)).toBe(false);
    expect(tracker.seen("안녕하세요", 1_000)).toBe(true);
    expect(tracker.seen("안녕하세요", 700_000)).toBe(false);
  });

  it("최대 개수를 넘으면 가장 오래된 것부터 잊는다", () => {
    const tracker = createDuplicateTracker({ maxEntries: 2 });
    tracker.seen("a", 0);
    tracker.seen("b", 0);
    tracker.seen("c", 0);
    expect(tracker.seen("a", 1)).toBe(false);
  });
});

describe("DuplicateTracker 기억 정리(K16)", () => {
  it("10분이 지난 문장을 새 채팅 없이도 지운다", () => {
    const tracker = createDuplicateTracker();
    tracker.seen("첫 문장", 0);
    tracker.seen("둘째 문장", 300_000);
    tracker.pruneExpired(600_001);
    expect(tracker.retainedCount()).toBe(1);
    tracker.pruneExpired(900_001);
    expect(tracker.retainedCount()).toBe(0);
  });

  it("정리한 뒤에도 10분 안의 문장은 중복으로 본다", () => {
    const tracker = createDuplicateTracker();
    tracker.seen("안녕하세요", 0);
    tracker.pruneExpired(599_999);
    expect(tracker.seen("안녕하세요", 600_000)).toBe(true);
  });

  it("문장 대신 SHA-256 앞부분(16진수 32자)을 열쇠로 쓴다", () => {
    const key = duplicateKeyOf("전화번호 01012345678 보내줘");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain("01012345678");
    expect(duplicateKeyOf("다른 문장")).not.toBe(key);
  });
});
