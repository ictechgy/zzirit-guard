import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { silentLogger } from "../src/logger.js";
import { startFakeChzzk, type FakeChzzk } from "./fakes/fakeChzzk.js";
import { buildTestConfig, cleanupDataDirectories, countPushSubscriptions, createDataDirectory, newEncryptionKey, ORIGIN } from "./helpers/appHarness.js";
import { waitFor } from "./helpers/waitFor.js";

let fake: FakeChzzk;
let app: App;
/** 이 테스트 앱의 데이터 디렉터리(DB 파일을 직접 읽어 구독이 지워졌는지 본다). */
let dataDirectory: string;
/** 보낸 푸시 본문(JSON 문자열). */
let sentPayloads: string[];

beforeEach(async () => {
  sentPayloads = [];
  fake = await startFakeChzzk();
  dataDirectory = createDataDirectory();
  app = await createApp(buildTestConfig(fake, dataDirectory), {
    encryptionKey: newEncryptionKey(), logger: silentLogger,
    pushSender: async (_subscription, payload) => {
      sentPayloads.push(payload);
      return {};
    },
  });
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

/** 스트리머로 채널을 연결하고 세션 쿠키 값을 돌려준다(시작 응답의 state 쿠키를 콜백에 싣는다). */
async function connectOwner(): Promise<string> {
  const start = await app.http.inject({ method: "GET", url: "/auth/connect" });
  const state = new URL(start.headers.location as string).searchParams.get("state");
  const stateCookie = cookieValue(start.headers["set-cookie"], "zg_oauth_state");
  const callback = await app.http.inject({ method: "GET", url: `/auth/callback?code=${fake.grantCode(fake.owner)}&state=${state}`, headers: { cookie: `zg_oauth_state=${stateCookie}` } });
  return cookieValue(callback.headers["set-cookie"], "zg_session") as string;
}

describe("채널 연결 해제와 장애 알림(F10)", () => {
  it("스트리머가 연결을 해제하면 '토큰을 갱신하지 못해' 푸시를 보내지 않는다(일부러 끊은 것이다)", async () => {
    const owner = await connectOwner();
    await waitFor(() => fake.subscribedSessionCount() === 1);
    const headers = { cookie: `zg_session=${owner}`, origin: ORIGIN, "x-zzirit-request": "1" };
    const subscribe = await app.http.inject({
      method: "POST", url: "/api/push/subscriptions", headers,
      payload: { endpoint: "https://fcm.googleapis.com/fcm/send/other-manager", keys: { p256dh: "p256dh-value", auth: "auth-value" } },
    });
    expect(subscribe.statusCode).toBe(200);
    expect((await app.http.inject({ method: "POST", url: "/api/channel/disconnect", headers })).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.status()).toMatchObject({ channelConnected: false, writeLocked: true });
    expect(sentPayloads).toEqual([]);
  });

  it("스트리머가 연결을 해제하면 모든 장애 알림 구독을 지운다(K11)", async () => {
    const owner = await connectOwner();
    const headers = { cookie: `zg_session=${owner}`, origin: ORIGIN, "x-zzirit-request": "1" };
    const keys = { p256dh: "p256dh-value", auth: "auth-value" };
    for (const name of ["owner-phone", "manager-phone"]) {
      await app.http.inject({ method: "POST", url: "/api/push/subscriptions", headers, payload: { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys } });
    }
    expect(countPushSubscriptions(dataDirectory)).toBe(2);
    expect((await app.http.inject({ method: "POST", url: "/api/channel/disconnect", headers })).statusCode).toBe(200);
    expect(countPushSubscriptions(dataDirectory)).toBe(0);
  });
});
