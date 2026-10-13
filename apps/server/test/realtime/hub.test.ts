import type { RealtimeEvent } from "@zzirit-guard/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagerSession } from "../../src/managers/sessionStore.js";
import { createRealtimeHub, MAX_SOCKETS_PER_SESSION, MAX_SOCKETS_TOTAL, SESSION_EXPIRED_REASON, type RealtimeHub, type SocketSink } from "../../src/realtime/hub.js";

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

/**
 * 세션 예시. 만료 시각을 주지 않으면 끝없이 유효한 세션이다(허브는 보내기 전에 만료를 본다, K9).
 * @param expiresAt 세션 만료 시각(ms)
 */
function session(id: string, expiresAt = Number.MAX_SAFE_INTEGER): ManagerSession {
  return { id, managerChannelId: id, managerChannelName: id, role: "STREAMING_CHAT_MANAGER", expiresAt, lastRoleCheckAt: 0 };
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

  it("closeSessionsExcept는 목록에 없는 세션의 소켓만 이유를 보낸 뒤 4001로 닫는다(F2)", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    const expired = fakeSocket();
    const active = fakeSocket();
    const alsoExpired = fakeSocket();
    hub.attach(expired, session("s1"));
    hub.attach(active, session("s2"));
    hub.attach(alsoExpired, session("s3"));
    hub.closeSessionsExcept(new Set(["s2"]), "세션이 만료되었습니다. 다시 로그인하세요");
    expect(expired.sent).toEqual([{ type: "session_ended", reason: "세션이 만료되었습니다. 다시 로그인하세요" }]);
    expect([expired.closedWith, alsoExpired.closedWith]).toEqual([4001, 4001]);
    expect(active.sent).toEqual([]);
    expect(active.closedWith).toBeNull();
    expect(hub.connectionCount()).toBe(1);
  });

  it("closeSessionsExcept 중 send가 throw한 소켓은 1011로 닫히고 나머지 종료는 계속된다(F2)", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    const broken = fakeSocket();
    broken.send = () => {
      throw new Error("소켓 깨짐");
    };
    const expired = fakeSocket();
    hub.attach(broken, session("s1"));
    hub.attach(expired, session("s2"));
    hub.closeSessionsExcept(new Set(), "세션이 만료되었습니다. 다시 로그인하세요");
    expect(broken.closedWith).toBe(1011);
    expect(expired.closedWith).toBe(4001);
    expect(hub.connectionCount()).toBe(0);
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

  it("한 세션의 소켓은 3개까지이고, 넷째가 붙으면 그 세션의 가장 오래된 소켓을 4002로 닫는다(K8)", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    const sockets = Array.from({ length: MAX_SOCKETS_PER_SESSION + 1 }, () => fakeSocket());
    const otherSession = fakeSocket();
    hub.attach(otherSession, session("s2"));
    expect(sockets.map((socket) => hub.attach(socket, session("s1")))).toEqual([true, true, true, true]);
    expect(MAX_SOCKETS_PER_SESSION).toBe(3);
    expect(sockets.map((socket) => socket.closedWith)).toEqual([4002, null, null, null]);
    expect(otherSession.closedWith).toBeNull();
    hub.broadcast({ type: "verdict_status", verdictId: 1, status: "hidden" });
    expect(sockets.map((socket) => socket.sent.length)).toEqual([0, 1, 1, 1]);
    expect(hub.connectionCount()).toBe(4);
  });

  it("전체 소켓이 50개면 새 세션의 연결은 1013으로 닫고 붙이지 않는다(K8)", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    expect(MAX_SOCKETS_TOTAL).toBe(50);
    for (let index = 0; index < MAX_SOCKETS_TOTAL; index += 1) hub.attach(fakeSocket(), session(`s${index}`));
    const late = fakeSocket();
    expect(hub.attach(late, session("late"))).toBe(false);
    expect(late.closedWith).toBe(1013);
    expect(hub.connectionCount()).toBe(MAX_SOCKETS_TOTAL);
  });

  it("전체 상한에서도 이미 3개를 연 세션의 새 연결은 가장 오래된 것을 밀어내고 붙는다(K8)", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    const own = Array.from({ length: MAX_SOCKETS_PER_SESSION }, () => fakeSocket());
    own.forEach((socket) => hub.attach(socket, session("mine")));
    for (let index = MAX_SOCKETS_PER_SESSION; index < MAX_SOCKETS_TOTAL; index += 1) hub.attach(fakeSocket(), session(`s${index}`));
    const newest = fakeSocket();
    expect(hub.attach(newest, session("mine"))).toBe(true);
    expect([own[0]?.closedWith, newest.closedWith]).toEqual([4002, null]);
    expect(hub.connectionCount()).toBe(MAX_SOCKETS_TOTAL);
  });

  it("만료 시각이 된 세션의 소켓은 방송을 받지 않고, 만료 이유를 받은 뒤 4001로 닫힌다(K9)", () => {
    let now = 1_000;
    hub = createRealtimeHub({ flushIntervalMs: 60_000, clock: () => now });
    const expiring = fakeSocket();
    const valid = fakeSocket();
    hub.attach(expiring, session("s1", 2_000));
    hub.attach(valid, session("s2", 5_000));
    hub.broadcast({ type: "verdict_status", verdictId: 1, status: "hidden" });
    expect(expiring.sent).toHaveLength(1);
    now = 2_000;
    hub.broadcast({ type: "verdict_status", verdictId: 2, status: "hidden" });
    expect(expiring.sent.slice(1)).toEqual([{ type: "session_ended", reason: SESSION_EXPIRED_REASON }]);
    expect(expiring.closedWith).toBe(4001);
    expect(valid.sent).toHaveLength(2);
    expect(hub.connectionCount()).toBe(1);
  });

  it("채팅 묶음도 만료된 세션의 소켓에는 보내지 않는다(K9)", () => {
    let now = 1_000;
    hub = createRealtimeHub({ flushIntervalMs: 60_000, clock: () => now });
    const expiring = fakeSocket();
    hub.attach(expiring, session("s1", 2_000));
    hub.pushChatLine({ senderNickname: "n", content: "채팅", messageTime: 1, decision: "pass" });
    now = 2_001;
    hub.flush();
    expect(expiring.sent).toEqual([{ type: "session_ended", reason: SESSION_EXPIRED_REASON }]);
    expect(expiring.closedWith).toBe(4001);
  });
});
