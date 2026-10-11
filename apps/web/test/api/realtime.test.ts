import type { RealtimeEvent } from "@zzirit-guard/shared";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/client";
import { RealtimeConnection, reconnectDelayMs, websocketUrl, type SocketLike } from "../../src/api/realtime";

/** 직접 조작하는 가짜 소켓. */
function fakeSocket(): SocketLike & { closed: boolean } {
  return { onmessage: null, onclose: null, closed: false, close() { this.closed = true; } };
}

/** 대기 중인 비동기 처리를 흘려보낸다. */
async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 서버가 연결 직후 보내는 status 메시지. */
const STATUS_MESSAGE = JSON.stringify({ type: "status", status: { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, lastChatAt: null, pendingActions: 0 } });

/** 테스트용 연결과 기록. */
function setup(issueTicket: () => Promise<string> = async () => "ticket-1") {
  const sockets: Array<SocketLike & { closed: boolean }> = [];
  const urls: string[] = [];
  const scheduled: number[] = [];
  const events: RealtimeEvent[] = [];
  const connection: { states: boolean[]; ended: string[]; rejected: number } = { states: [], ended: [], rejected: 0 };
  let pending: (() => void) | null = null;
  const realtime = new RealtimeConnection({
    issueTicket,
    openSocket: (url) => {
      urls.push(url);
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: (callback, ms) => {
      scheduled.push(ms);
      pending = callback;
    },
    onEvent: (event) => events.push(event),
    onConnectionChange: (connected) => connection.states.push(connected),
    onSessionEnded: (reason) => connection.ended.push(reason),
    onRejected: () => {
      connection.rejected += 1;
    },
  });
  /** 예약된 재연결을 실행하고 티켓 발급을 기다린다. */
  const runPending = async () => {
    pending?.();
    await flushPromises();
  };
  /** 마지막 소켓을 메시지 없이 code로 닫는다(열렸다가 서버가 바로 닫은 경우). */
  const closeWithoutMessage = (code: number) => sockets.at(-1)?.onclose?.({ code });
  return { realtime, sockets, urls, scheduled, events, connection, runPending, closeWithoutMessage };
}

describe("RealtimeConnection", () => {
  it("티켓으로 연결하고, 첫 메시지를 받아야 연결됨으로 알리며 이벤트를 넘긴다", async () => {
    const { realtime, sockets, urls, events, connection } = setup();
    realtime.start();
    await flushPromises();
    expect(urls[0]).toMatch(/\/ws\?ticket=ticket-1$/);
    expect(connection.states).toEqual([]);
    sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "verdict_status", verdictId: 1, status: "hidden" }) });
    expect(connection.states).toEqual([true]);
    expect(events).toEqual([{ type: "verdict_status", verdictId: 1, status: "hidden" }]);
  });

  it("끊기면 백오프 뒤 새 티켓으로 다시 연결한다", async () => {
    const issueTicket = vi.fn(async () => "ticket");
    const { realtime, sockets, scheduled, runPending } = setup(issueTicket);
    realtime.start();
    await flushPromises();
    sockets[0]?.onclose?.({ code: 1006 });
    expect(scheduled).toEqual([1000]);
    await runPending();
    expect(issueTicket).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
  });

  it("세션 종료 메시지가 오면 다시 연결하지 않고 그 이유를 알린다", async () => {
    const { realtime, sockets, scheduled, connection } = setup();
    realtime.start();
    await flushPromises();
    sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "session_ended", reason: "권한 해제" }) });
    sockets[0]?.onclose?.({ code: 4001 });
    expect(connection.ended).toEqual(["권한 해제"]);
    expect(scheduled).toEqual([]);
  });

  it("메시지 없이 4001로만 닫혀도 다시 연결하지 않고 로그인이 필요하다고 알린다(R-19)", async () => {
    const { realtime, sockets, scheduled, connection } = setup();
    realtime.start();
    await flushPromises();
    sockets[0]?.onclose?.({ code: 4001 });
    expect(connection.ended).toEqual(["세션이 종료되었습니다. 다시 로그인하세요."]);
    expect(scheduled).toEqual([]);
  });

  it.each([
    [new ApiError(401, "unauthorized", "로그인이 필요합니다.")],
    [new ApiError(409, "no_channel", "연결된 채널이 없습니다. 스트리머가 먼저 채널을 연결하세요.")],
  ])("티켓 발급이 %s이면 다시 연결하지 않고 서버 문구로 알린다(R-12)", async (error) => {
    const { realtime, connection, scheduled } = setup(async () => {
      throw error;
    });
    realtime.start();
    await flushPromises();
    expect(connection.ended).toEqual([error.message]);
    expect(scheduled).toEqual([]);
  });

  it("멈추면 소켓을 닫고 재연결하지 않는다", async () => {
    const { realtime, sockets, scheduled } = setup();
    realtime.start();
    await flushPromises();
    realtime.stop();
    sockets[0]?.onclose?.({ code: 1000 });
    expect(sockets[0]?.closed).toBe(true);
    expect(scheduled).toEqual([]);
  });

  it("열리기만 하고 메시지 없이 닫히면 백오프를 처음으로 되돌리지 않는다(R-6)", async () => {
    const { realtime, scheduled, runPending, closeWithoutMessage } = setup();
    realtime.start();
    await flushPromises();
    closeWithoutMessage(1006);
    await runPending();
    closeWithoutMessage(1006);
    expect(scheduled).toEqual([1000, 2000]);
  });

  it("4003으로 3번 이어서 거절되면 멈추고 알리며, start()로 다시 시작할 수 있다(R-6)", async () => {
    const issueTicket = vi.fn(async () => "ticket");
    const { realtime, scheduled, connection, runPending, closeWithoutMessage } = setup(issueTicket);
    realtime.start();
    await flushPromises();
    closeWithoutMessage(4003);
    await runPending();
    closeWithoutMessage(4003);
    await runPending();
    closeWithoutMessage(4003);
    expect(scheduled).toEqual([1000, 2000]);
    expect(connection.rejected).toBe(1);
    realtime.start();
    await flushPromises();
    expect(issueTicket).toHaveBeenCalledTimes(4);
  });

  it("메시지를 받으면 백오프와 거절 횟수를 처음부터 센다", async () => {
    const { realtime, sockets, scheduled, runPending } = setup();
    realtime.start();
    await flushPromises();
    sockets[0]?.onclose?.({ code: 1006 });
    await runPending();
    sockets[1]?.onmessage?.({ data: STATUS_MESSAGE });
    sockets[1]?.onclose?.({ code: 1006 });
    expect(scheduled).toEqual([1000, 1000]);
  });
});

describe("도우미", () => {
  it("백오프는 1초부터 30초까지", () => {
    expect([0, 1, 4, 5, 8].map(reconnectDelayMs)).toEqual([1000, 2000, 16000, 30000, 30000]);
  });

  it("http(s) 출처를 ws(s)로 바꾼다", () => {
    expect(websocketUrl("a b", "", "https://guard.example")).toBe("wss://guard.example/ws?ticket=a%20b");
    expect(websocketUrl("t", "http://localhost:8710", "https://ignored")).toBe("ws://localhost:8710/ws?ticket=t");
  });
});
