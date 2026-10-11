import { describe, expect, it } from "vitest";
import { parseReplayOptions, runReplay } from "../../src/tools/replayLoad.js";

describe("runReplay", () => {
  it("정한 속도로 합성 채팅을 흘리고 처리 시간을 잰다", async () => {
    const report = await runReplay({ ratePerSecond: 200, seconds: 0.5 });
    expect(report.messages).toBe(100);
    expect(report.p95Ms).toBeLessThan(50);
    expect(Object.values(report.decisions).reduce((sum, count) => sum + count, 0)).toBe(100);
    expect(report.decisions.candidate ?? 0).toBeGreaterThan(0);
  });
});

describe("parseReplayOptions", () => {
  it("--rate와 --seconds를 숫자로 바꾼다", () => {
    expect(parseReplayOptions({ rate: "100", seconds: "10" })).toEqual({ ratePerSecond: 100, seconds: 10 });
  });

  it("값이 없거나 숫자가 아니거나 0 이하면 원인을 담은 오류를 던진다", () => {
    expect(() => parseReplayOptions({ rate: undefined, seconds: "10" })).toThrow(/--rate/);
    expect(() => parseReplayOptions({ rate: "abc", seconds: "10" })).toThrow(/--rate.*숫자/);
    expect(() => parseReplayOptions({ rate: "100", seconds: "0" })).toThrow(/--seconds.*0보다/);
    expect(() => parseReplayOptions({ rate: "-5", seconds: "10" })).toThrow(/--rate.*0보다/);
    expect(() => parseReplayOptions({ rate: "Infinity", seconds: "10" })).toThrow(/--rate.*유한/);
  });

  it("반올림하면 메시지가 0건이 되는 조합도 거절한다", () => {
    expect(() => parseReplayOptions({ rate: "0.1", seconds: "1" })).toThrow(/메시지가 0건/);
  });
});
