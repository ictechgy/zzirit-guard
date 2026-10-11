import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import type { Logger } from "../src/logger.js";
import { startFakeChzzk, type FakeChzzk } from "./fakes/fakeChzzk.js";
import { buildTestConfig, cleanupDataDirectories, createDataDirectory, newEncryptionKey } from "./helpers/appHarness.js";
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
    const first = await createApp(buildTestConfig(fake, dataDirectory), { encryptionKey, logger: createRecordingLogger().logger, pushSender: async () => ({}) });
    apps.push(first);
    await first.start();
    const start = await first.http.inject({ method: "GET", url: "/auth/connect" });
    const state = new URL(start.headers.location as string).searchParams.get("state");
    const stateCookie = /zg_oauth_state=([^;]+)/.exec(String(start.headers["set-cookie"]))?.[1];
    await first.http.inject({ method: "GET", url: `/auth/callback?code=${fake.grantCode(fake.owner)}&state=${state}`, headers: { cookie: `zg_oauth_state=${stateCookie}` } });
    await waitFor(() => fake?.subscribedSessionCount() === 1);
    await first.stop();
    apps = [];
    await waitFor(() => fake?.subscribedSessionCount() === 0);
    const sessionCallsBefore = fake.calls.filter((call) => call.path.startsWith("/open/v1/sessions")).length;

    const recording = createRecordingLogger();
    const second = await createApp(buildTestConfig(fake, dataDirectory, "other-channel"), { encryptionKey, logger: recording.logger, pushSender: async () => ({}) });
    apps.push(second);
    await second.start();

    expect(second.status()).toMatchObject({ channelConnected: false, chatConnected: false });
    expect(fake.subscribedSessionCount()).toBe(0);
    expect(fake.calls.filter((call) => call.path.startsWith("/open/v1/sessions")).length).toBe(sessionCallsBefore);
    expect(fake.calls.some((call) => call.path.includes("revoke"))).toBe(false);
    const errorLine = recording.lines.find((line) => line.level === "error" && line.message.includes("ZG_CHANNEL_ID"));
    expect(errorLine?.details).toMatchObject({ storedChannelId: fake.owner.channelId, configuredChannelId: "other-channel" });
    expect(JSON.stringify(recording.lines)).not.toMatch(/access|refresh|token/i);
  });
});
