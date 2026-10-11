import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useBusyTask } from "../../src/api/useBusyTask";

describe("useBusyTask", () => {
  it("작업이 동기적으로 예외를 던져도 거절로 돌려주고 잠금을 푼다", async () => {
    const { result } = renderHook(() => useBusyTask());
    await act(async () => {
      await expect(result.current.run(() => { throw new Error("동기 예외"); })).rejects.toThrow("동기 예외");
    });
    expect(result.current.isBusy).toBe(false);
    let isStarted = false;
    await act(async () => { isStarted = await result.current.run(async () => undefined); });
    expect(isStarted).toBe(true);
  });
});
