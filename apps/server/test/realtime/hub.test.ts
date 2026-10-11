import type { RealtimeEvent } from "@zzirit-guard/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagerSession } from "../../src/managers/sessionStore.js";
import { createRealtimeHub, type RealtimeHub, type SocketSink } from "../../src/realtime/hub.js";

let hub: RealtimeHub;
afterEach(() => hub.stop());

/** 받은 메시지를 모으는 가짜 소켓. */
function fakeSocket(readyState = 1) {
  const sent: RealtimeEvent[] = [];
  let closeListener: () => void = () => undefined;
  const socket: SocketSink & { sent: RealtimeEvent[]; closedWith: number | null; fireClose(): void } = {
    readyState, sent, closedWith: null,
    send: (data) => void sent.push(JSON.parse(data) as RealtimeEvent),
    close: (code) => void (socket.closedWith = code ?? null),
    on: (_event, listener) => void (closeListener = listener),
    fireClose: () => closeListener(),
  };
  return socket;
}

/** 세션 예시. */
function session(id: string): ManagerSession {
  return { id, managerChannelId: id, managerChannelName: id, role: "STREAMING_CHAT_MANAGER", expiresAt: 0, lastRoleCheckAt: 0 };
}

describe("RealtimeHub", () => {
  it("열린 소켓에만 방송하고, 닫힌 소켓은 목록에서 뺀다", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    const open = fakeSocket();
    const closing = fakeSocket(2);
    const stillOpen = fakeSocket();
    hub.attach(open, session("s1"));
    hub.attach(closing, session("s2"));
    hub.attach(stillOpen, session("s3"));
    hub.broadcast({ type: "verdict_status", verdictId: 1, status: "hidden" });
    expect(open.sent).toHaveLength(1);
    expect(closing.sent).toHaveLength(0);
    open.fireClose();
    expect(hub.connectionCount()).toBe(1);
  });

  it("채팅 줄을 모아 한 번에 보내고, 넘치면 최신 것만 남긴다", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000, maxLinesPerFlush: 2 });
    const socket = fakeSocket();
    hub.attach(socket, session("s1"));
    for (const content of ["a", "b", "c"]) hub.pushChatLine({ senderNickname: "n", content, messageTime: 1, decision: "pass" });
    hub.flush();
    hub.flush();
    expect(socket.sent).toEqual([{ type: "chat_batch", lines: [expect.objectContaining({ content: "b" }), expect.objectContaining({ content: "c" })] }]);
  });

  it("끊을 세션에는 이유를 보낸 뒤 닫는다", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    const target = fakeSocket();
    const other = fakeSocket();
    hub.attach(target, session("s1"));
    hub.attach(other, session("s2"));
    hub.closeSessions(["s1"], "매니저 권한이 해제되었습니다");
    expect(target.sent).toEqual([{ type: "session_ended", reason: "매니저 권한이 해제되었습니다" }]);
    expect(target.closedWith).toBe(4001);
    expect(other.closedWith).toBeNull();
  });

  it("한 소켓의 send가 throw해도 나머지 소켓은 받고, 실패한 소켓은 목록에서 뺀다", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    const broken = fakeSocket();
    broken.send = () => { throw new Error("socket is dead"); };
    const healthy = fakeSocket();
    hub.attach(broken, session("s1"));
    hub.attach(healthy, session("s2"));
    hub.broadcast({ type: "verdict_status", verdictId: 1, status: "hidden" });
    expect(healthy.sent).toHaveLength(1);
    expect(broken.closedWith).toBe(1011);
    expect(hub.connectionCount()).toBe(1);
  });

  it("세션 종료 전송 중 send가 throw해도 다른 세션 종료는 계속 진행된다", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    const broken = fakeSocket();
    broken.send = () => { throw new Error("socket is dead"); };
    const target = fakeSocket();
    hub.attach(broken, session("s1"));
    hub.attach(target, session("s2"));
    hub.closeSessions(["s1", "s2"], "권한 해제");
    expect(target.sent).toEqual([{ type: "session_ended", reason: "권한 해제" }]);
    expect(target.closedWith).toBe(4001);
    expect(broken.closedWith).toBe(1011);
    expect(hub.connectionCount()).toBe(0);
  });

  it("세션 종료 중 첫 소켓의 close가 throw해도 다음 소켓은 종료되고 함수는 throw하지 않는다", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    const first = fakeSocket();
    let firstCloseAttempted = false;
    first.close = () => { firstCloseAttempted = true; throw new Error("close failed"); };
    const second = fakeSocket();
    hub.attach(first, session("s1"));
    hub.attach(second, session("s2"));
    expect(() => hub.closeSessions(["s1", "s2"], "권한 해제")).not.toThrow();
    expect(firstCloseAttempted).toBe(true);
    expect(second.sent).toEqual([{ type: "session_ended", reason: "권한 해제" }]);
    expect(second.closedWith).toBe(4001);
    expect(hub.connectionCount()).toBe(0);
  });

  it("stop 중 한 소켓의 close가 throw해도 나머지를 모두 닫고 목록을 비운다", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    const broken = fakeSocket();
    let brokenCloseAttempted = false;
    broken.close = () => { brokenCloseAttempted = true; throw new Error("close failed"); };
    const healthy = fakeSocket();
    hub.attach(broken, session("s1"));
    hub.attach(healthy, session("s2"));
    expect(() => hub.stop()).not.toThrow();
    expect(brokenCloseAttempted).toBe(true);
    expect(healthy.closedWith).toBe(1001);
    expect(hub.connectionCount()).toBe(0);
  });

  it("전송 실패로 끊는 중 close가 throw해도 소켓은 목록에서 빠진다", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    const broken = fakeSocket();
    broken.send = () => { throw new Error("socket is dead"); };
    broken.close = () => { throw new Error("close failed"); };
    const healthy = fakeSocket();
    hub.attach(broken, session("s1"));
    hub.attach(healthy, session("s2"));
    expect(() => hub.broadcast({ type: "verdict_status", verdictId: 1, status: "hidden" })).not.toThrow();
    expect(healthy.sent).toHaveLength(1);
    expect(hub.connectionCount()).toBe(1);
  });

  it("stop 이후 attach한 소켓은 1001로 닫히고 목록에 들어가지 않는다", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    hub.stop();
    const late = fakeSocket();
    hub.attach(late, session("s1"));
    expect(late.closedWith).toBe(1001);
    expect(hub.connectionCount()).toBe(0);
  });

  it("이미 닫힌 상태로 attach한 소켓은 세지 않는다", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    hub.attach(fakeSocket(3), session("s1"));
    expect(hub.connectionCount()).toBe(0);
  });

  it("보내지 못한 데이터가 1MB를 넘는 소켓은 끊고, 나머지는 계속 받는다", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    const slow = fakeSocket();
    slow.bufferedAmount = 1024 * 1024 + 1;
    const healthy = fakeSocket();
    hub.attach(slow, session("s1"));
    hub.attach(healthy, session("s2"));
    hub.broadcast({ type: "verdict_status", verdictId: 1, status: "hidden" });
    expect(slow.sent).toHaveLength(0);
    expect(slow.closedWith).toBe(1011);
    expect(healthy.sent).toHaveLength(1);
    expect(hub.connectionCount()).toBe(1);
  });
});
