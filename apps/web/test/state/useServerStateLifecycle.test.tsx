import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeOptions } from "../../src/api/realtime";
import { STALE_CONNECTION_MS, useServerState } from "../../src/state/useServerState";
import { json } from "../helpers/stubFetch";

/** 가짜 연결 하나의 기록: 화면이 넘긴 콜백, 열림 여부, start·stop 호출 횟수. */
interface FakeConnectionRecord {
  /** 화면이 넘긴 콜백. */
  options: RealtimeOptions;
  /** 열려 있는지(stop이 false를 알릴지 정한다). */
  isOpen: boolean;
  /** start() 호출 횟수. */
  starts: number;
  /** stop() 호출 횟수. */
  stops: number;
}

/** 만들어진 가짜 연결 목록(마운트 순서대로). vi.mock 팩토리가 쓰므로 hoisted로 둔다. */
const fakes = vi.hoisted(() => ({ connections: [] as FakeConnectionRecord[] }));

vi.mock("../../src/api/realtime", () => ({
  /** 콜백을 테스트가 직접 일으킬 수 있는 가짜 RealtimeConnection. stop()은 열려 있으면 실제처럼 동기로 false를 알린다. */
  RealtimeConnection: class {
    /** 이 인스턴스의 기록. */
    readonly record: FakeConnectionRecord;
    /** @param options 화면이 넘긴 콜백 */
    constructor(options: RealtimeOptions) {
      this.record = { options, isOpen: false, starts: 0, stops: 0 };
      fakes.connections.push(this.record);
    }
    /** 시작(횟수만 센다). */
    start(): void {
      this.record.starts += 1;
    }
    /** 횟수를 세고, 열려 있었다면 실제 클래스처럼 동기로 false를 알린다. */
    stop(): void {
      this.record.stops += 1;
      if (!this.record.isOpen) return;
      this.record.isOpen = false;
      this.record.options.onConnectionChange(false);
    }
  },
}));

/**
 * document.visibilityState를 바꾸고 visibilitychange를 보낸다.
 * @param state 바꿀 값
 */
function changeVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fakes.connections.length = 0;
  Reflect.deleteProperty(document, "visibilityState");
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

describe("useServerState 화면 깨어남·네트워크 변경·조용히 죽은 연결(F3)", () => {
  it("화면이 다시 보이면 상태·후보를 한 번 다시 읽고, 숨겨질 때는 읽지 않는다", async () => {
    const statusCalls = installCountingFetch();
    renderHook(() => useServerState());
    await waitFor(() => expect(statusCalls()).toBe(1));
    act(() => changeVisibility("hidden"));
    act(() => changeVisibility("visible"));
    await waitFor(() => expect(statusCalls()).toBe(2));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(statusCalls()).toBe(2);
  });

  it("네트워크가 돌아오면(online) 상태·후보를 한 번 다시 읽는다", async () => {
    const statusCalls = installCountingFetch();
    renderHook(() => useServerState());
    await waitFor(() => expect(statusCalls()).toBe(1));
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(statusCalls()).toBe(2));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(statusCalls()).toBe(2);
  });

  it("연결됐다고 믿는 동안 STALE_CONNECTION_MS 넘게 메시지가 없으면 연결을 멈췄다 다시 시작한다", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    installCountingFetch();
    renderHook(() => useServerState());
    const record = fakes.connections[0]!;
    act(() => {
      record.isOpen = true;
      record.options.onConnectionChange(true);
    });
    expect(STALE_CONNECTION_MS).toBe(45_000);
    act(() => vi.advanceTimersByTime(30_000));
    act(() => record.options.onEvent({ type: "chat_batch", lines: [] }));
    act(() => vi.advanceTimersByTime(30_000));
    expect(record.starts).toBe(1);
    act(() => vi.advanceTimersByTime(STALE_CONNECTION_MS));
    expect(record.stops).toBe(1);
    expect(record.starts).toBe(2);
  });

  it("연결되지 않은 동안에는(재연결 대기 중) 오래 조용해도 다시 시작하지 않는다", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    installCountingFetch();
    renderHook(() => useServerState());
    act(() => vi.advanceTimersByTime(STALE_CONNECTION_MS * 3));
    expect(fakes.connections[0]!.starts).toBe(1);
    expect(fakes.connections[0]!.stops).toBe(0);
  });
});
