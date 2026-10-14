import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ServerStatus, VerdictDto } from "@zzirit-guard/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { silentLogger } from "../src/logger.js";
import { startFakeChzzk, type FakeChzzk } from "./fakes/fakeChzzk.js";
import { stage1Reply, stage2Reply, startFakeWorker, type FakeWorker } from "./fakes/fakeWorker.js";
import { buildTestConfig, newEncryptionKey } from "./helpers/appHarness.js";
import { waitFor } from "./helpers/waitFor.js";
import { waitForAsync } from "./helpers/waitForAsync.js";

let fake: FakeChzzk;
let app: App;
let dataDirectory: string;
let workers: FakeWorker[];

beforeEach(async () => {
  fake = await startFakeChzzk();
  // 짧은 /tmp 경로를 쓴다(macOS 유닉스 소켓 경로 104바이트 상한).
  dataDirectory = mkdtempSync("/tmp/zga-");
  const runDirectory = join(dataDirectory, "run");
  mkdirSync(runDirectory, { mode: 0o700 });
  workers = [
    await startFakeWorker(stage1Reply(0.9), "stage1.sock", runDirectory),
    await startFakeWorker(stage2Reply({ "은근히 나쁜 말": [0.97, "S2"], "다 끝내고 싶다": [0.95, "S6"] }), "stage2.sock", runDirectory),
  ];
  const config = { ...buildTestConfig(fake, dataDirectory), aiEnabled: true, aiRunDirectory: runDirectory };
  app = await createApp(config, { encryptionKey: newEncryptionKey(), logger: silentLogger, pushSender: async () => ({}) });
  await app.start();
});
afterEach(async () => {
  await app.stop();
  await Promise.all(workers.map((worker) => worker.close()));
  await fake.close();
  rmSync(dataDirectory, { recursive: true, force: true });
});

/** 쿠키 하나의 값을 set-cookie 헤더에서 꺼낸다. */
function cookieValue(setCookie: unknown, name: string): string | undefined {
  return new RegExp(`${name}=([^;]+)`).exec(String(setCookie))?.[1];
}

/** 스트리머로 채널을 연결하고 세션 쿠키 값을 돌려준다. */
async function connectOwner(): Promise<string> {
  const start = await app.http.inject({ method: "GET", url: "/auth/connect" });
  const state = new URL(start.headers.location as string).searchParams.get("state");
  const stateCookie = cookieValue(start.headers["set-cookie"], "zg_oauth_state");
  const callback = await app.http.inject({
    method: "GET", url: `/auth/callback?code=${fake.grantCode(fake.owner)}&state=${state}`, headers: { cookie: `zg_oauth_state=${stateCookie}` },
  });
  return cookieValue(callback.headers["set-cookie"], "zg_session") as string;
}

/** 후보 목록. */
async function candidates(rawId: string): Promise<VerdictDto[]> {
  return (await app.http.inject({ method: "GET", url: "/api/candidates", headers: { cookie: `zg_session=${rawId}` } })).json();
}

/** 채팅 이벤트. */
function chatPayload(sender: string, content: string) {
  return { channelId: fake.owner.channelId, senderChannelId: sender, chatChannelId: "chat-1", profile: { nickname: sender }, userRoleCode: "common_user", content, emojis: {}, messageTime: Date.now() };
}

describe("종단 간: AI 단계(로드맵 2단계)", () => {
  it("규칙이 통과시킨 채팅을 1차·2차 워커로 판정해 후보·도움 필요로 올리고, 상태에 워커와 모델을 보인다", async () => {
    const owner = await connectOwner();
    await waitFor(() => fake.subscribedSessionCount() === 1);
    fake.emitChat(chatPayload("viewer-1", "은근히 나쁜 말"));
    fake.emitChat(chatPayload("viewer-2", "다 끝내고 싶다"));
    fake.emitChat(chatPayload("viewer-3", "평범한 채팅"));
    await waitForAsync(async () => (await candidates(owner)).length === 2);
    const byContent = Object.fromEntries((await candidates(owner)).map((verdict) => [verdict.content, verdict]));
    expect(byContent["은근히 나쁜 말"]).toMatchObject({ decision: "candidate", reason: "ai:S2", aiProbability: 0.97, aiCategory: "S2", sure: false });
    expect(byContent["다 끝내고 싶다"]).toMatchObject({ decision: "needs_care", reason: "ai:S6" });
    const status = (await app.http.inject({ method: "GET", url: "/api/status", headers: { cookie: `zg_session=${owner}` } })).json() as ServerStatus;
    expect(status.ai).toMatchObject({ enabled: true, stage1: { state: "ok", model: "kcelectra-fake@0123456789ab" }, stage2: { state: "ok" } });
  });

  it("2차 워커가 없으면 규칙은 그대로 돌고 AI는 중지로 보인다", async () => {
    await workers[1]?.close();
    const owner = await connectOwner();
    await waitFor(() => fake.subscribedSessionCount() === 1);
    fake.emitChat(chatPayload("viewer-1", "느금마 진짜"));
    fake.emitChat(chatPayload("viewer-2", "은근히 나쁜 말"));
    await waitForAsync(async () => (await candidates(owner)).length === 1);
    await waitForAsync(async () => {
      const status = (await app.http.inject({ method: "GET", url: "/api/status", headers: { cookie: `zg_session=${owner}` } })).json() as ServerStatus;
      return status.ai.stage2.state === "down";
    });
    expect((await candidates(owner))[0]).toMatchObject({ decision: "shadow" });
  });
});
