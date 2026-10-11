import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { toSocketSink } from "../../src/http/server.js";
import { createHttpHarness, mutatingHeaders, ORIGIN } from "../helpers/httpHarness.js";

let harness: Awaited<ReturnType<typeof createHttpHarness>>;
beforeEach(async () => {
  harness = await createHttpHarness();
});
afterEach(async () => harness.close());

/** 예시 후보 판정을 넣는다. */
function insertCandidate() {
  return harness.verdicts.insert({
    channelId: "c1", chatChannelId: "chat-1", messageTime: 5, senderChannelId: "bad", senderNickname: "악플러",
    content: "나쁜 말", decision: "candidate", reason: "rule:weak:1",
  });
}

describe("인증과 요청 출처", () => {
  it("로그인하지 않으면 401", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized", message: "로그인이 필요합니다." });
  });

  it("내 역할과 권한을 돌려준다", async () => {
    const rawId = harness.login("STREAMING_CHANNEL_OWNER");
    const response = await harness.app.inject({ method: "GET", url: "/api/me", headers: { cookie: `zg_session=${rawId}` } });
    expect(response.json()).toMatchObject({ role: "STREAMING_CHANNEL_OWNER", permissions: expect.arrayContaining(["connect_channel"]) });
  });

  it("표식 헤더가 없거나 다른 출처의 상태 변경 요청은 403", async () => {
    const rawId = harness.login("STREAMING_CHANNEL_OWNER");
    const noMarker = await harness.app.inject({ method: "POST", url: "/api/auto-hide", headers: { cookie: `zg_session=${rawId}` }, payload: { enabled: true } });
    expect(noMarker.statusCode).toBe(403);
    const foreign = await harness.app.inject({ method: "POST", url: "/api/auto-hide", headers: { ...mutatingHeaders(rawId), origin: "https://evil.example" }, payload: { enabled: true } });
    expect(foreign.statusCode).toBe(403);
  });

  it("보안 헤더를 붙인다", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/me" });
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("자동 숨김 스위치 권한", () => {
  it("채팅 운영자는 끌 수만 있고, 채널 관리자는 켤 수 있다", async () => {
    const chatManager = harness.login("STREAMING_CHAT_MANAGER");
    const enable = await harness.app.inject({ method: "POST", url: "/api/auto-hide", headers: mutatingHeaders(chatManager), payload: { enabled: true } });
    expect(enable.statusCode).toBe(403);
    const disable = await harness.app.inject({ method: "POST", url: "/api/auto-hide", headers: mutatingHeaders(chatManager), payload: { enabled: false } });
    expect(disable.statusCode).toBe(200);
    const channelManager = harness.login("STREAMING_CHANNEL_MANAGER");
    const enabledByManager = await harness.app.inject({ method: "POST", url: "/api/auto-hide", headers: mutatingHeaders(channelManager), payload: { enabled: true } });
    expect(enabledByManager.json()).toEqual({ enabled: true });
    expect(harness.services.autoHide.isEnabled("c1")).toBe(true);
  });
});

describe("판정 조치", () => {
  it("숨김을 실행기로 보낸다", async () => {
    const verdict = insertCandidate();
    const rawId = harness.login("STREAMING_CHAT_MANAGER");
    const response = await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/hide`, headers: mutatingHeaders(rawId) });
    expect(response.json()).toEqual({ ok: true, note: null });
    expect(harness.submit).toHaveBeenCalledWith(
      "c1",
      { kind: "hide", target: { chatChannelId: "chat-1", messageTime: 5, senderChannelId: "bad" }, verdictId: verdict.id },
      { type: "manager", channelId: "STREAMING_CHAT_MANAGER-id" },
    );
  });

  it("치지직이 실패하면 502와 이유를 준다", async () => {
    harness.submit.mockResolvedValueOnce({ ok: false, message: "치지직 호출 한도를 넘었습니다. 잠시 뒤 다시 시도하세요." });
    const verdict = insertCandidate();
    const response = await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/hide`, headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")) });
    expect(response.statusCode).toBe(502);
    expect(response.json().message).toMatch(/호출 한도/);
  });

  it("없는 판정은 404", async () => {
    const response = await harness.app.inject({ method: "POST", url: "/api/verdicts/999/ignore", headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")) });
    expect(response.statusCode).toBe(404);
  });

  it("오판 신고는 상태를 바꾸고 감사 기록을 남긴다", async () => {
    const verdict = insertCandidate();
    await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/false-positive`, headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")) });
    expect(harness.verdicts.get(verdict.id)?.status).toBe("false_positive");
    expect(harness.auditLog.list("c1", 1, null)[0]).toMatchObject({ action: "false_positive", verdictId: verdict.id });
  });
});

describe("규칙·감사 기록", () => {
  it("잘못된 규칙은 400과 이유를 준다", async () => {
    const response = await harness.app.inject({ method: "POST", url: "/api/rules", headers: mutatingHeaders(harness.login("STREAMING_CHANNEL_MANAGER")), payload: { kind: "weak", pattern: "!!!" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/규칙이 비었습니다/);
  });

  it("감사 기록은 채팅 운영자에게 보이지 않는다", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/audit", headers: { cookie: `zg_session=${harness.login("STREAMING_CHAT_MANAGER")}` } });
    expect(response.statusCode).toBe(403);
  });
});

describe("로그인 콜백", () => {
  it("실패하면 이유를 담아 첫 화면으로 보낸다", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/auth/callback?code=c&state=s" });
    expect(response.statusCode).toBe(302);
    expect(decodeURIComponent(response.headers.location as string)).toBe("/?loginError=이 채널의 매니저가 아닙니다.");
  });

  it("성공하면 HttpOnly·Secure·SameSite=Lax 쿠키를 준다", async () => {
    await harness.close();
    harness = await createHttpHarness({
      complete: async () => ({ rawId: "raw-session", session: { id: "h", managerChannelId: "m", managerChannelName: "m", role: "STREAMING_CHAT_MANAGER", expiresAt: 0, lastRoleCheckAt: 0 } }),
    });
    const response = await harness.app.inject({ method: "GET", url: "/auth/callback?code=c&state=s" });
    expect(response.headers.location).toBe("/");
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toMatch(/^zg_session=raw-session;/);
    for (const attribute of [/;\s*HttpOnly/i, /;\s*Secure/i, /;\s*SameSite=Lax/i, /;\s*Path=\//i]) expect(cookie).toMatch(attribute);
  });
});

describe("WebSocket", () => {
  it("티켓으로 연결해 방송을 받는다", async () => {
    const rawId = harness.login("STREAMING_CHAT_MANAGER");
    const ticketResponse = await harness.app.inject({ method: "POST", url: "/api/ws-ticket", headers: mutatingHeaders(rawId) });
    const socket = await harness.app.injectWS(`/ws?ticket=${ticketResponse.json().ticket}`, { headers: { origin: ORIGIN } });
    const received = new Promise<string>((resolve) =>
      socket.on("message", (data) => {
        const text = String(data);
        if (text.includes("verdict_status")) resolve(text);
      }),
    );
    harness.hub.broadcast({ type: "verdict_status", verdictId: 1, status: "hidden" });
    expect(JSON.parse(await received)).toEqual({ type: "verdict_status", verdictId: 1, status: "hidden" });
    socket.terminate();
  });

  it("치지직에서 해임된 매니저는 티켓을 받지 못하고 세션이 지워진다", async () => {
    const rawId = harness.login("STREAMING_CHAT_MANAGER");
    harness.services.verifyRole = async () => null;
    const response = await harness.app.inject({ method: "POST", url: "/api/ws-ticket", headers: mutatingHeaders(rawId) });
    expect(response.statusCode).toBe(401);
    expect(harness.sessions.get(rawId)).toBeNull();
  });

  it("잘못된 티켓은 4003으로 닫는다", async () => {
    // injectWS는 핸드셰이크 직후 서버가 닫으면 열림 이벤트를 놓쳐 멈추므로, 실제 로컬 포트에서 ws 클라이언트로 확인한다.
    const address = await harness.app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}/ws?ticket=wrong`, { headers: { origin: ORIGIN } });
    const code = await new Promise<number>((resolve) => socket.on("close", (closeCode) => resolve(closeCode)));
    expect(code).toBe(4003);
  });
});

describe("푸시 구독 입력", () => {
  const validKeys = { p256dh: "key", auth: "auth" };

  it("허용된 푸시 서비스 주소는 등록된다", async () => {
    const response = await harness.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")), payload: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: validKeys } });
    expect(response.json()).toEqual({ ok: true });
  });

  it("허용 목록에 없는 주소는 400과 이유를 준다", async () => {
    const response = await harness.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")), payload: { endpoint: "http://127.0.0.1/x", keys: validKeys } });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toEqual(expect.any(String));
  });

  it("너무 긴 주소는 400", async () => {
    const endpoint = `https://fcm.googleapis.com/${"a".repeat(2100)}`;
    const headers = mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER"));
    const subscribe = await harness.app.inject({ method: "POST", url: "/api/push/subscriptions", headers, payload: { endpoint, keys: validKeys } });
    expect(subscribe.statusCode).toBe(400);
    const remove = await harness.app.inject({ method: "DELETE", url: "/api/push/subscriptions", headers, payload: { endpoint } });
    expect(remove.statusCode).toBe(400);
  });

  it("너무 긴 키는 400", async () => {
    const response = await harness.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")), payload: { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "k".repeat(257), auth: "a" } } });
    expect(response.statusCode).toBe(400);
  });
});

describe("toSocketSink", () => {
  it("ws 소켓의 bufferedAmount와 readyState를 그때그때 읽어 준다", () => {
    const fake = { readyState: 1, bufferedAmount: 0 };
    const sink = toSocketSink(fake as unknown as WebSocket);
    fake.bufferedAmount = 2_000_000;
    fake.readyState = 2;
    expect(sink.bufferedAmount).toBe(2_000_000);
    expect(sink.readyState).toBe(2);
  });
});

