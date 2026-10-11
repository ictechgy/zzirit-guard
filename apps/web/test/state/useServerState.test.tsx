import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useServerState } from "../../src/state/useServerState";
import { json } from "../helpers/stubFetch";

/** 정상 서버 상태. */
const status = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, lastChatAt: null, pendingActions: 0 };

/** 테스트가 열림·닫힘을 직접 일으키는 가짜 WebSocket. 만든 소켓은 sockets에 쌓인다. */
class ControlledSocket {
  /** 만들어진 소켓 목록. */
  static sockets: ControlledSocket[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    ControlledSocket.sockets.push(this);
  }
  /** 서버가 인증된 연결에 처음 보내는 status 메시지를 흉내 낸다. */
  deliverStatus(): void {
    this.onmessage?.({ data: JSON.stringify({ type: "status", status }) });
  }
  close(): void {}
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
  /** 붙잡아 둔 응답을 모두 풀어 준다(status·candidates 순서와 무관하게 URL로 구분). */
  const releaseAll = () => {
    const waiting = pending.splice(0);
    waiting.forEach((resolve) => resolve(json(200, [])));
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

  it("후보 조회가 401이면 실시간을 멈추고 서버 문구로 세션 종료를 알린다(R-12)", async () => {
    vi.stubGlobal("WebSocket", ControlledSocket);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${String(input)}`;
      if (key === "POST /api/ws-ticket") return json(200, { ticket: "t1" });
      return json(401, { error: "unauthorized", message: "로그인이 필요합니다." });
    }));
    const { result } = renderHook(() => useServerState());
    await waitFor(() => expect(result.current.state.sessionEndedReason).toBe("로그인이 필요합니다."));
    expect(result.current.state.realtimeConnected).toBe(false);
  });
});
