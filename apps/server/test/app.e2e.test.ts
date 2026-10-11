import type { VerdictDto } from "@zzirit-guard/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { silentLogger } from "../src/logger.js";
import { startFakeChzzk, type FakeChzzk } from "./fakes/fakeChzzk.js";
import { buildTestConfig, cleanupDataDirectories, createDataDirectory, newEncryptionKey, ORIGIN } from "./helpers/appHarness.js";
import { waitFor } from "./helpers/waitFor.js";
import { waitForAsync } from "./helpers/waitForAsync.js";

let fake: FakeChzzk;
let app: App;

beforeEach(async () => {
  fake = await startFakeChzzk();
  app = await createApp(buildTestConfig(fake, createDataDirectory()), { encryptionKey: newEncryptionKey(), logger: silentLogger, pushSender: async () => ({}) });
  await app.start();
});
afterEach(async () => {
  await app.stop();
  await fake.close();
  cleanupDataDirectories();
});

/** 쿠키 하나의 값을 set-cookie 헤더에서 꺼낸다. */
function cookieValue(setCookie: unknown, name: string): string | undefined {
  return new RegExp(`${name}=([^;]+)`).exec(String(setCookie))?.[1];
}

/** OAuth 흐름을 가짜 치지직 코드로 끝내고 세션 쿠키 값을 돌려준다. 콜백에는 시작 응답의 state 쿠키를 실어 보낸다. */
async function signIn(path: "/auth/connect" | "/auth/login", user: { channelId: string; channelName: string }): Promise<string> {
  const start = await app.http.inject({ method: "GET", url: path });
  const state = new URL(start.headers.location as string).searchParams.get("state");
  const stateCookie = cookieValue(start.headers["set-cookie"], "zg_oauth_state");
  const callback = await app.http.inject({
    method: "GET", url: `/auth/callback?code=${fake.grantCode(user)}&state=${state}`, headers: { cookie: `zg_oauth_state=${stateCookie}` },
  });
  expect(callback.headers.location).toBe("/");
  return cookieValue(callback.headers["set-cookie"], "zg_session") as string;
}

/** 후보 목록을 읽는다. */
async function candidates(rawId: string): Promise<VerdictDto[]> {
  return (await app.http.inject({ method: "GET", url: "/api/candidates", headers: { cookie: `zg_session=${rawId}` } })).json();
}

/** 문서 형식의 채팅 이벤트. */
function chatPayload(sender: string, content: string) {
  return { channelId: fake.owner.channelId, senderChannelId: sender, chatChannelId: "chat-1", profile: { nickname: sender }, userRoleCode: "common_user", content, emojis: {}, messageTime: Date.now() };
}

describe("종단 간: 연결 → 섀도 → 자동 숨김 → 매니저 권한", () => {
  it("전체 흐름이 동작한다", async () => {
    const owner = await signIn("/auth/connect", fake.owner);
    await waitFor(() => fake.subscribedSessionCount() === 1);

    fake.emitChat(chatPayload("viewer-1", "홍어들은 다 이래"));
    await waitForAsync(async () => (await candidates(owner)).length === 1);
    expect((await candidates(owner))[0]).toMatchObject({ decision: "shadow", senderChannelId: "viewer-1" });
    expect(fake.calls.some((call) => call.path === "/open/v1/chats/blind-message")).toBe(false);

    const headers = { cookie: `zg_session=${owner}`, origin: ORIGIN, "x-zzirit-request": "1" };
    expect((await app.http.inject({ method: "POST", url: "/api/auto-hide", headers, payload: { enabled: true } })).statusCode).toBe(200);
    fake.emitChat(chatPayload("viewer-2", "느금마 ㅋㅋ"));
    await waitForAsync(async () => (await candidates(owner)).some((verdict) => verdict.senderChannelId === "viewer-2" && verdict.status === "hidden"));
    expect(fake.calls.find((call) => call.path === "/open/v1/chats/blind-message")?.body).toMatchObject({ senderChannelId: "viewer-2", chatChannelId: "chat-1" });

    fake.streamingRoles.push({ managerChannelId: "manager-1", managerChannelName: "매니저1", userRole: "STREAMING_CHAT_MANAGER" });
    const manager = await signIn("/auth/login", { channelId: "manager-1", channelName: "매니저1" });
    const managerHeaders = { cookie: `zg_session=${manager}`, origin: ORIGIN, "x-zzirit-request": "1" };
    expect((await app.http.inject({ method: "POST", url: "/api/auto-hide", headers: managerHeaders, payload: { enabled: true } })).statusCode).toBe(403);
    expect((await app.http.inject({ method: "POST", url: "/api/auto-hide", headers: managerHeaders, payload: { enabled: false } })).statusCode).toBe(200);
    expect(app.status()).toMatchObject({ channelConnected: true, chatConnected: true, autoHideEnabled: false });
  });

  it("채널 연결을 해제했다가 다시 연결해도 규칙·설정은 남고 기본 규칙은 중복되지 않으며 스위치는 꺼진다(F3)", async () => {
    const owner = await signIn("/auth/connect", fake.owner);
    // 채팅 소켓이 열리는 도중에 해제하면 이 테스트의 범위가 아닌 소켓 종료 경합이 섞이므로, 구독까지 기다린다.
    await waitFor(() => fake.subscribedSessionCount() === 1);
    const headers = { cookie: `zg_session=${owner}`, origin: ORIGIN, "x-zzirit-request": "1" };
    const defaultRuleCount = (await app.http.inject({ method: "GET", url: "/api/rules", headers })).json<unknown[]>().length;
    expect((await app.http.inject({ method: "POST", url: "/api/rules", headers, payload: { kind: "strong", pattern: "커스텀금칙어" } })).statusCode).toBe(200);
    expect((await app.http.inject({ method: "PUT", url: "/api/settings", headers, payload: { breakerPerMinute: 30 } })).statusCode).toBe(200);
    expect((await app.http.inject({ method: "POST", url: "/api/auto-hide", headers, payload: { enabled: true } })).statusCode).toBe(200);
    expect((await app.http.inject({ method: "POST", url: "/api/channel/disconnect", headers })).statusCode).toBe(200);
    expect(app.status().channelConnected).toBe(false);
    await waitFor(() => fake.subscribedSessionCount() === 0);

    const ownerAgain = await signIn("/auth/connect", fake.owner);
    await waitFor(() => fake.subscribedSessionCount() === 1);
    const headersAgain = { cookie: `zg_session=${ownerAgain}`, origin: ORIGIN, "x-zzirit-request": "1" };
    const rules = (await app.http.inject({ method: "GET", url: "/api/rules", headers: headersAgain })).json<Array<{ pattern: string }>>();
    expect(rules).toHaveLength(defaultRuleCount + 1);
    expect(rules.some((rule) => rule.pattern === "커스텀금칙어")).toBe(true);
    expect((await app.http.inject({ method: "GET", url: "/api/settings", headers: headersAgain })).json()).toMatchObject({ breakerPerMinute: 30 });
    expect(app.status()).toMatchObject({ channelConnected: true, autoHideEnabled: false });
  });

  it("state 쿠키 없이 콜백을 호출하면 연결되지 않는다", async () => {
    const start = await app.http.inject({ method: "GET", url: "/auth/connect" });
    const state = new URL(start.headers.location as string).searchParams.get("state");
    const callback = await app.http.inject({ method: "GET", url: `/auth/callback?code=${fake.grantCode(fake.owner)}&state=${state}` });
    expect(callback.headers.location).toContain("loginError");
    expect(app.status().channelConnected).toBe(false);
  });
});
