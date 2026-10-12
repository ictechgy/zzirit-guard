import { describe, expect, it, vi } from "vitest";
import { runOneAtATime } from "../src/runOneAtATime.js";

describe("runOneAtATime(S15)", () => {
  it("앞선 실행이 끝나기 전의 호출은 건너뛰고 onSkip을 부르며, 끝난 뒤에는 다시 돈다", async () => {
    let finish: () => void = () => undefined;
    const task = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const onSkip = vi.fn();
    const run = runOneAtATime(task, onSkip);
    const first = run();
    await run();
    expect(task).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);
    finish();
    await first;
    const second = run();
    finish();
    await second;
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("작업이 던져도 오류를 그대로 전하고 다음 차례에는 다시 돈다", async () => {
    const task = vi.fn(async () => { throw new Error("실패"); });
    const run = runOneAtATime(task, vi.fn());
    await expect(run()).rejects.toThrow("실패");
    await expect(run()).rejects.toThrow("실패");
    expect(task).toHaveBeenCalledTimes(2);
  });
});

describe("runOneAtATime 연속 건너뜀 수(N5)", () => {
  it("연속으로 건너뛴 횟수를 onSkip에 넘기고, 실제로 다시 돌면 0부터 센다", async () => {
    let finish: () => void = () => undefined;
    const task = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const onSkip = vi.fn();
    const run = runOneAtATime(task, onSkip);
    const first = run();
    await run();
    await run();
    await run();
    expect(onSkip.mock.calls.map(([count]) => count)).toEqual([1, 2, 3]);
    finish();
    await first;
    const second = run();
    await run();
    expect(onSkip.mock.calls.at(-1)?.[0]).toBe(1);
    finish();
    await second;
  });
});
