import { describe, expect, it } from "vitest";
import { parseReplayOptions, runPaced, runReplay, summarize } from "../../src/tools/replayLoad.js";

/** 주어진 밀리초만큼 동기적으로 CPU를 붙잡는다. 이벤트 루프를 멈춰 GC·체크포인트 같은 멈춤을 흉내 낸다. */
function blockFor(milliseconds: number): void {
  const until = performance.now() + milliseconds;
  while (performance.now() < until) {
    // 바쁜 대기: 멈춤 길이를 정확히 맞추려고 일부러 아무것도 하지 않는다.
  }
}

describe("runReplay", () => {
  it("정한 속도로 합성 채팅을 흘리고 처리 시간을 잰다", async () => {
    const report = await runReplay({ ratePerSecond: 200, seconds: 0.5 });
    expect(report.messages).toBe(100);
    expect(report.p95Ms).toBeLessThan(50);
    expect(Object.values(report.decisions).reduce((sum, count) => sum + count, 0)).toBe(100);
    expect(report.decisions.candidate ?? 0).toBeGreaterThan(0);
  });

  it("도배 송신자 경로가 실제로 지나가 개인 도배 후보가 나온다", async () => {
    const report = await runReplay({ ratePerSecond: 200, seconds: 0.5 });
    expect(report.reasons["rule:personal_flood"] ?? 0).toBeGreaterThan(0);
  });
});

describe("runPaced 누락 보정", () => {
  it("한 건이 50ms 멈추면 뒤따르는 건들의 밀린 시간이 드러난다", async () => {
    const run = await runPaced(100, 2, (index) => {
      if (index === 5) blockFor(50);
    });
    const report = summarize(run, {}, {});
    expect(report.maxMs).toBeGreaterThanOrEqual(45);
    expect(report.maxLatenessMs).toBeGreaterThanOrEqual(30);
    expect(report.p95LatenessMs).toBeGreaterThan(10);
    // 처리 시간만 보면 멈춤 한 건만 튀고 나머지는 빠르게 보인다. 그래서 p95Ms는 작다.
    expect(report.p95Ms).toBeLessThan(10);
  });

  it("멈춤이 없으면 밀린 시간은 0 이상이고 음수가 없다", async () => {
    const run = await runPaced(20, 5, () => undefined);
    expect(run.latenessMs.every((value) => value >= 0)).toBe(true);
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
