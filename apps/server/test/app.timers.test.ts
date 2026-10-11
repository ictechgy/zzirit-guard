import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/database.js";

/** 목으로 제어하는 실패 스위치와 열린 DB 기록. vi.hoisted로 목 팩토리보다 먼저 만든다. */
const control = vi.hoisted(() => ({
  flushError: null as Error | null,
  recheckError: null as Error | null,
  database: null as Database | null,
}));

vi.mock("../src/records/minuteStats.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/records/minuteStats.js")>();
  return {
    ...original,
    createMinuteStats: (...args: Parameters<typeof original.createMinuteStats>) => {
      const real = original.createMinuteStats(...args);
      return { ...real, flush: () => { if (control.flushError) throw control.flushError; real.flush(); } };
    },
  };
});
vi.mock("../src/managers/roleRecheck.js", () => ({
  recheckSessionRoles: async () => { if (control.recheckError) throw control.recheckError; },
}));
vi.mock("../src/db/database.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/db/database.js")>();
  return { ...original, openDatabase: (path: string) => (control.database = original.openDatabase(path)) };
});

const { createApp } = await import("../src/app.js");
const { startFakeChzzk } = await import("./fakes/fakeChzzk.js");
const { buildTestConfig, cleanupDataDirectories, createDataDirectory, newEncryptionKey } = await import("./helpers/appHarness.js");

type FakeChzzk = Awaited<ReturnType<typeof startFakeChzzk>>;
type App = Awaited<ReturnType<typeof createApp>>;

/** 오류 로그의 (메시지, 상세)를 모은다. */
let errorLines: Array<{ message: string; details?: Record<string, unknown> }>;
let fake: FakeChzzk;
let app: App;

beforeEach(async () => {
  control.flushError = null;
  control.recheckError = null;
  errorLines = [];
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  fake = await startFakeChzzk();
  const logger = { info: () => undefined, warn: () => undefined, error: (message: string, details?: Record<string, unknown>) => void errorLines.push({ message, ...(details ? { details } : {}) }) };
  app = await createApp(buildTestConfig(fake, createDataDirectory()), { encryptionKey: newEncryptionKey(), logger, pushSender: async () => ({}) });
  await app.start();
});
afterEach(async () => {
  vi.useRealTimers();
  await app.stop();
  await fake.close();
  cleanupDataDirectories();
});

describe("주기 작업 오류는 프로세스를 죽이지 않고 로그로 남는다", () => {
  it("통계 저장 실패를 로그로 남기고 다음 주기에 다시 시도한다", async () => {
    control.flushError = new Error("디스크 가득 참");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errorLines).toEqual([{ message: "통계 저장 실패", details: { error: "Error: 디스크 가득 참" } }]);
    control.flushError = null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errorLines).toHaveLength(1);
  });

  it("역할 재확인 실패를 로그로 남긴다", async () => {
    control.recheckError = new Error("치지직 장애");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(errorLines.filter((line) => line.message === "역할 재확인 실패")).toEqual([{ message: "역할 재확인 실패", details: { error: "Error: 치지직 장애" } }]);
  });
});

describe("stop()은 한 단계가 실패해도 끝까지 종료한다", () => {
  it("통계 저장이 실패해도 예외 없이 끝나고 데이터베이스를 닫는다", async () => {
    control.flushError = new Error("디스크 가득 참");
    await expect(app.stop()).resolves.toBeUndefined();
    expect(errorLines.some((line) => line.message.startsWith("종료 단계 실패: 통계 저장"))).toBe(true);
    expect(control.database?.open).toBe(false);
  });
});
