import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useServerState } from "../../src/state/useServerState";
import { json } from "../helpers/stubFetch";

/** 정상 서버 상태. */
const status = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, autoHideOffReason: null, lastChatAt: null, pendingActions: 0 };

/** 테스트가 열림·닫힘을 직접 일으키는 가짜 WebSocket. 만든 소켓은 sockets에 쌓인다. */
class ControlledSocket {
  /** 만들어진 소켓 목록. */
  static sockets: ControlledSocket[] = [];
  /** 서버 메시지 수신기(RealtimeConnection이 채운다). */
  onmessage: ((event: { data: unknown }) => void) | null = null;
  /** 닫힘 수신기(RealtimeConnection이 채운다). */
  onclose: ((event: { code: number }) => void) | null = null;
  /** close()가 불렸는지: 실시간을 멈췄는지 확인하는 데 쓴다. */
  isClosed = false;
  /** @param url 열려는 주소(테스트는 쓰지 않지만 WebSocket 생성자 모양을 맞춘다) */
  constructor(readonly url: string) {
    ControlledSocket.sockets.push(this);
  }
  /** 서버가 인증된 연결에 처음 보내는 status 메시지를 흉내 낸다. */
  deliverStatus(): void {
    this.onmessage?.({ data: JSON.stringify({ type: "status", status }) });
  }
  /** 연결을 닫았다고 기록한다. */
  close(): void {
    this.isClosed = true;
  }
}

/** 호출을 세고 응답을 사람이 풀어 줄 수 있게 붙잡아 두는 fetch. */
function installHeldFetch() {
  const pending: Array<(response: Response) => void> = [];
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    calls.push(key);
    if (key === "POST /api/ws-ticket") return Promise.resolve(json(200, { ticket: "t1" }));
    return new Promise<Response>((resolve) => pending.push(resolve));
  }));
  /** 붙잡아 둔 응답을 모두 같은 응답으로 풀어 준다. */
  const releaseAll = (response: () => Response = () => json(200, [])) => {
    const waiting = pending.splice(0);
    waiting.forEach((resolve) => resolve(response()));
  };
  return { calls, releaseAll, count: (path: string) => calls.filter((call) => call === `GET ${path}`).length };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  ControlledSocket.sockets = [];
});

describe("useServerState", () => {
  it("조회 중에 연결이 다시 열려도 조회를 겹쳐 돌리지 않고, 끝난 뒤 한 번만 더 읽는다", async () => {
    vi.stubGlobal("WebSocket", ControlledSocket);
    const fetcher = installHeldFetch();
    const { result } = renderHook(() => useServerState());
    await waitFor(() => expect(ControlledSocket.sockets).toHaveLength(1));
    expect(fetcher.count("/api/status")).toBe(1);
    act(() => ControlledSocket.sockets[0]?.deliverStatus());
    act(() => ControlledSocket.sockets[0]?.onclose?.({ code: 1006 }));
    expect(fetcher.count("/api/status")).toBe(1);
    // 조회 중 받은 status 이벤트가 기록에 남아 있다: 두 번째 snapshot_started가 기록을 지우지 않았다는 증거.
    expect(result.current.state.replayLog?.map((event) => event.type)).toEqual(["status"]);
    await act(async () => fetcher.releaseAll());
    await waitFor(() => expect(fetcher.count("/api/status")).toBe(2));
    await act(async () => fetcher.releaseAll());
    expect(fetcher.count("/api/status")).toBe(2);
  });

  it("받은 실시간 status 이벤트 수를 센다(다른 이벤트는 세지 않는다)", async () => {
    vi.stubGlobal("WebSocket", ControlledSocket);
    installHeldFetch();
    const { result } = renderHook(() => useServerState());
    await waitFor(() => expect(ControlledSocket.sockets).toHaveLength(1));
    expect(result.current.statusEventCount()).toBe(0);
    act(() => ControlledSocket.sockets[0]?.deliverStatus());
    act(() => ControlledSocket.sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "chat_batch", lines: [] }) }));
    expect(result.current.statusEventCount()).toBe(1);
  });

  it("조회 중 reload를 여러 번 눌러도 한 번 더만 읽는다", async () => {
    vi.stubGlobal("WebSocket", ControlledSocket);
    const fetcher = installHeldFetch();
    const { result } = renderHook(() => useServerState());
    act(() => {
      result.current.reload();
      result.current.reload();
      result.current.reload();
    });
    expect(fetcher.count("/api/status")).toBe(1);
    await act(async () => fetcher.releaseAll());
    await waitFor(() => expect(fetcher.count("/api/status")).toBe(2));
  });

  it("StrictMode의 마운트→해제→마운트에서도 소켓은 하나만 열고, 해제 뒤에는 상태를 바꾸지 않는다", async () => {
    vi.stubGlobal("WebSocket", ControlledSocket);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = installHeldFetch();
    const { unmount } = renderHook(() => useServerState(), { wrapper: StrictMode });
    await waitFor(() => expect(ControlledSocket.sockets).toHaveLength(1));
    act(() => ControlledSocket.sockets[0]?.deliverStatus());
    unmount();
    const callsAfterUnmount = fetcher.calls.length;
    await act(async () => fetcher.releaseAll());
    expect(fetcher.calls).toHaveLength(callsAfterUnmount);
    expect(ControlledSocket.sockets).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("연결된 뒤 조회가 401이면 소켓을 닫고, 티켓을 다시 받지 않고, 조회기도 멈춘다(R-12)", async () => {
    vi.stubGlobal("WebSocket", ControlledSocket);
    const fetcher = installHeldFetch();
    const { result } = renderHook(() => useServerState());
    await waitFor(() => expect(ControlledSocket.sockets).toHaveLength(1));
    act(() => ControlledSocket.sockets[0]?.deliverStatus());
    expect(result.current.state.realtimeConnected).toBe(true);
    await act(async () => fetcher.releaseAll(() => json(401, { error: "unauthorized", message: "로그인이 필요합니다." })));
    await waitFor(() => expect(result.current.state.sessionEndedReason).toBe("로그인이 필요합니다."));
    expect(result.current.state.realtimeConnected).toBe(false);
    expect(ControlledSocket.sockets[0]?.isClosed).toBe(true);
    const callsAfterEnd = fetcher.calls.length;
    act(() => result.current.reload());
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(fetcher.calls).toHaveLength(callsAfterEnd);
    expect(fetcher.calls.filter((call) => call === "POST /api/ws-ticket")).toHaveLength(1);
  });

  it("조회는 200인데 티켓이 401이면 세션 종료로 알리고, 진행 중이던 조회 결과는 버린다(R-12)", async () => {
    vi.stubGlobal("WebSocket", ControlledSocket);
    const calls: string[] = [];
    const held: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${String(input)}`;
      calls.push(key);
      if (key === "POST /api/ws-ticket") return Promise.resolve(json(401, { error: "unauthorized", message: "세션이 만료되었습니다." }));
      return new Promise<Response>((resolve) => held.push(resolve));
    }));
    const { result } = renderHook(() => useServerState());
    await waitFor(() => expect(result.current.state.sessionEndedReason).toBe("세션이 만료되었습니다."));
    await act(async () => held.splice(0).forEach((resolve) => resolve(json(200, status))));
    expect(result.current.state.status).toBeNull();
    const callsAfterEnd = calls.length;
    act(() => result.current.reload());
    expect(calls).toHaveLength(callsAfterEnd);
    expect(ControlledSocket.sockets).toHaveLength(0);
  });
});

describe("useServerState 멈춘 실시간을 손으로 다시 연결(4002 뒤)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * 티켓 응답을 차례로 정하는 fetch. 정해 둔 것을 다 쓰면 정상 티켓을 준다. 조회는 모두 붙잡아 둔다(이 테스트는 실시간만 본다).
   * @param tickets 티켓 응답을 만드는 함수들(앞에서부터 쓴다)
   */
  function installTicketFetch(tickets: Array<() => Response>) {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (`${init?.method ?? "GET"} ${String(input)}` !== "POST /api/ws-ticket") return new Promise<Response>(() => undefined);
      return Promise.resolve((tickets.shift() ?? (() => json(200, { ticket: "t" })))());
    }));
  }

  /** 첫 소켓을 연결한 뒤 같은 세션의 새 연결에 밀려(4002) 멈추게 하고, 손으로 다시 연결한다. */
  async function replaceThenReconnect() {
    const hook = renderHook(() => useServerState());
    await waitFor(() => expect(ControlledSocket.sockets).toHaveLength(1));
    act(() => ControlledSocket.sockets[0]?.deliverStatus());
    act(() => ControlledSocket.sockets[0]?.onclose?.({ code: 4002 }));
    expect(hook.result.current.state.realtimeReplaced).toBe(true);
    act(() => hook.result.current.reconnect());
    expect(hook.result.current.state).toMatchObject({ realtimeReplaced: false, realtimeRejected: false });
    return hook;
  }

  it("다시 연결 뒤 티켓 429로 기다리는 동안에는 멈춤 안내가 다시 뜨지 않는다", async () => {
    vi.stubGlobal("WebSocket", ControlledSocket);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installTicketFetch([() => json(200, { ticket: "t1" }), () => json(429, { error: "rate_limited", message: "요청이 너무 많습니다." })]);
    const { result } = await replaceThenReconnect();
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(result.current.state).toMatchObject({ realtimeConnected: false, realtimeReplaced: false, realtimeRejected: false });
  });

  it("다시 연결 뒤 1013으로 닫혀 백오프하는 동안에도 멈춤 안내가 다시 뜨지 않는다", async () => {
    vi.stubGlobal("WebSocket", ControlledSocket);
    installTicketFetch([]);
    const { result } = await replaceThenReconnect();
    await waitFor(() => expect(ControlledSocket.sockets).toHaveLength(2));
    act(() => ControlledSocket.sockets[1]?.onclose?.({ code: 1013 }));
    expect(result.current.state).toMatchObject({ realtimeConnected: false, realtimeReplaced: false, realtimeRejected: false });
  });

  it("다시 연결 뒤 4003이 거듭되면 거절 안내만 남는다(밀림 안내는 함께 뜨지 않는다)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("WebSocket", ControlledSocket);
    installTicketFetch([]);
    const { result } = await replaceThenReconnect();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await waitFor(() => expect(ControlledSocket.sockets).toHaveLength(2 + attempt));
      act(() => ControlledSocket.sockets[1 + attempt]?.onclose?.({ code: 4003 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
    }
    expect(result.current.state).toMatchObject({ realtimeRejected: true, realtimeReplaced: false });
  });
});
