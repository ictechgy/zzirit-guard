import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import type { Logger } from "../src/logger.js";
import { startFakeChzzk, type FakeChzzk } from "./fakes/fakeChzzk.js";
import { buildTestConfig, cleanupDataDirectories, countPushSubscriptions, createDataDirectory, newEncryptionKey, ORIGIN } from "./helpers/appHarness.js";
import { waitFor } from "./helpers/waitFor.js";

/** 기록한 로그 한 줄. */
interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  details?: Record<string, unknown>;
}

/** 로그를 배열에 모으는 기록기(테스트에서 로그 내용을 검사한다). */
function createRecordingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const write = (level: LogLine["level"]) => (message: string, details?: Record<string, unknown>) => void lines.push({ level, message, ...(details ? { details } : {}) });
  return { logger: { info: write("info"), warn: write("warn"), error: write("error") }, lines };
}

let fake: FakeChzzk | undefined;
let apps: App[] = [];

afterEach(async () => {
  for (const app of apps) await app.stop();
  apps = [];
  await fake?.close();
  fake = undefined;
  cleanupDataDirectories();
});

describe("시작 안전장치: 저장된 채널이 설정과 다를 때", () => {
  it("수신기를 시작하지 않고 연결을 해제하며 세션을 지우고 안내 로그를 남긴다", async () => {
    fake = await startFakeChzzk();
    const dataDirectory = createDataDirectory();
    const encryptionKey = newEncryptionKey();
    const recording = createRecordingLogger();
    const first = await createApp(buildTestConfig(fake, dataDirectory), { encryptionKey, logger: recording.logger, pushSender: async () => ({}) });
    apps.push(first);
    await first.start();
    const start = await first.http.inject({ method: "GET", url: "/auth/connect" });
    const state = new URL(start.headers.location as string).searchParams.get("state");
    const stateCookie = /zg_oauth_state=([^;]+)/.exec(String(start.headers["set-cookie"]))?.[1];
    expect((first.http.server.address() as AddressInfo).address).toBe("127.0.0.1");
    const callback = await first.http.inject({ method: "GET", url: `/auth/callback?code=${fake.grantCode(fake.owner)}&state=${state}`, headers: { cookie: `zg_oauth_state=${stateCookie}` } });
    const sessionCookie = /zg_session=([^;]+)/.exec(String(callback.headers["set-cookie"]))?.[1] as string;
    const meBefore = await first.http.inject({ method: "GET", url: "/api/me", headers: { cookie: `zg_session=${sessionCookie}` } });
    expect(meBefore.statusCode).toBe(200);
    const pushHeaders = { cookie: `zg_session=${sessionCookie}`, origin: ORIGIN, "x-zzirit-request": "1" };
    const pushPayload = { endpoint: "https://fcm.googleapis.com/fcm/send/owner-phone", keys: { p256dh: "p256dh-value", auth: "auth-value" } };
    expect((await first.http.inject({ method: "POST", url: "/api/push/subscriptions", headers: pushHeaders, payload: pushPayload })).statusCode).toBe(200);
    await waitFor(() => fake?.subscribedSessionCount() === 1);
    await first.stop();
    apps = [];
    await waitFor(() => fake?.subscribedSessionCount() === 0);
    const sessionCallsBefore = fake.calls.filter((call) => call.path.startsWith("/open/v1/sessions")).length;

    const second = await createApp(buildTestConfig(fake, dataDirectory, "other-channel"), { encryptionKey, logger: recording.logger, pushSender: async () => ({}) });
    apps.push(second);
    await second.start();

    const meAfter = await second.http.inject({ method: "GET", url: "/api/me", headers: { cookie: `zg_session=${sessionCookie}` } });
    expect(meAfter.statusCode).toBe(401);
    expect(second.status()).toMatchObject({ channelConnected: false, chatConnected: false });
    // 저장된 채널이 바뀌면 옛 채널 매니저의 장애 알림 구독도 지운다(K11).
    expect(countPushSubscriptions(dataDirectory)).toBe(0);
    expect(fake.subscribedSessionCount()).toBe(0);
    expect(fake.calls.filter((call) => call.path.startsWith("/open/v1/sessions")).length).toBe(sessionCallsBefore);
    expect(fake.calls.some((call) => call.path.includes("revoke"))).toBe(false);
    const errorLine = recording.lines.find((line) => line.level === "error" && line.message.includes("ZG_CHANNEL_ID"));
    expect(errorLine?.details).toMatchObject({ storedChannelId: fake.owner.channelId, configuredChannelId: "other-channel" });
    const issuedTokens = fake.calls.map((call) => call.token).filter((token): token is string => token !== null);
    expect(issuedTokens.length).toBeGreaterThan(0);
    const loggedText = JSON.stringify(recording.lines);
    issuedTokens.forEach((token) => expect(loggedText).not.toContain(token));
  });
});
