import { describe, expect, it } from "vitest";
import { createDuplicateTracker, isTrivialMessage } from "../../src/detection/messageTraits.js";

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
