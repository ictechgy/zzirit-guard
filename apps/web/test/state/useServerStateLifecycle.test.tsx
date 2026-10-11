import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeOptions } from "../../src/api/realtime";
import { useServerState } from "../../src/state/useServerState";
import { json } from "../helpers/stubFetch";

/** 만들어진 가짜 연결 목록(마운트 순서대로). vi.mock 팩토리가 쓰므로 hoisted로 둔다. */
const fakes = vi.hoisted(() => ({ connections: [] as Array<{ options: RealtimeOptions; isOpen: boolean }> }));

vi.mock("../../src/api/realtime", () => ({
  /** 콜백을 테스트가 직접 일으킬 수 있는 가짜 RealtimeConnection. stop()은 열려 있으면 실제처럼 동기로 false를 알린다. */
  RealtimeConnection: class {
    /** 이 인스턴스의 기록. */
    readonly record: { options: RealtimeOptions; isOpen: boolean };
    /** @param options 화면이 넘긴 콜백 */
    constructor(options: RealtimeOptions) {
      this.record = { options, isOpen: false };
      fakes.connections.push(this.record);
    }
    /** 시작(아무 일도 하지 않는다). */
    start(): void {}
    /** 열려 있었다면 실제 클래스처럼 동기로 false를 알린다. */
    stop(): void {
      if (!this.record.isOpen) return;
      this.record.isOpen = false;
      this.record.options.onConnectionChange(false);
    }
  },
}));

/** 상태·후보 조회 횟수를 세는 fetch. 즉시 성공한다. */
function installCountingFetch(): () => number {
  let statusCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/status") {
      statusCalls += 1;
      return json(200, { channelConnected: true });
    }
    return json(200, []);
  }));
  return () => statusCalls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  fakes.connections.length = 0;
});

describe("useServerState 연결 콜백", () => {
  it("연결이 두 번째로 다시 열려도 상태·후보를 다시 읽는다(R-3)", async () => {
    const statusCalls = installCountingFetch();
    renderHook(() => useServerState());
    await waitFor(() => expect(statusCalls()).toBe(1));
    const options = fakes.connections[0]!.options;
    for (const expected of [2, 3]) {
      await act(async () => {
        options.onConnectionChange(true);
        options.onConnectionChange(false);
      });
      await waitFor(() => expect(statusCalls()).toBe(expected));
    }
  });

  it("같은 값의 연결 알림이 거듭 와도 조회는 한 번만 더 한다", async () => {
    const statusCalls = installCountingFetch();
    renderHook(() => useServerState());
    await waitFor(() => expect(statusCalls()).toBe(1));
    const options = fakes.connections[0]!.options;
    await act(async () => {
      options.onConnectionChange(true);
      options.onConnectionChange(true);
      options.onConnectionChange(true);
    });
    await waitFor(() => expect(statusCalls()).toBe(2));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(statusCalls()).toBe(2);
  });

  it("StrictMode에서 해제된 첫 묶음이 나중에 알려도 살아 있는 상태를 바꾸지 못한다", async () => {
    installCountingFetch();
    const { result } = renderHook(() => useServerState(), { wrapper: StrictMode });
    expect(fakes.connections.length).toBeGreaterThanOrEqual(2);
    const disposed = fakes.connections[0]!.options;
    act(() => {
      disposed.onConnectionChange(true);
      disposed.onSessionEnded("옛 묶음의 종료");
      disposed.onRejected();
    });
    expect(result.current.state.realtimeConnected).toBe(false);
    expect(result.current.state.sessionEndedReason).toBeNull();
    expect(result.current.state.realtimeRejected).toBe(false);
  });

  it("정리 중 동기로 오는 false가 해제 뒤 상태를 건드리지 않고 반복돼도 안전하다", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    installCountingFetch();
    const { unmount } = renderHook(() => useServerState());
    const record = fakes.connections[0]!;
    act(() => {
      record.isOpen = true;
      record.options.onConnectionChange(true);
    });
    unmount();
    record.options.onConnectionChange(false);
    record.options.onConnectionChange(false);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
