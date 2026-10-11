import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeEvent } from "@zzirit-guard/shared";
import type { Database } from "../src/db/database.js";
import type { RealtimeHub, SocketSink } from "../src/realtime/hub.js";

/** 목으로 제어하는 실패 스위치와 열린 DB 기록. vi.hoisted로 목 팩토리보다 먼저 만든다. */
const control = vi.hoisted(() => ({
  flushError: null as Error | null,
  recheckError: null as Error | null,
  loadChannelError: null as Error | null,
  database: null as Database | null,
  hub: null as RealtimeHub | null,
  /** 다음 역할 재확인이 해임했다고 알릴 세션(세션 ID와 매니저 채널 ID). */
  revokedOnRecheck: [] as Array<{ sessionId: string; managerChannelId: string }>,
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
vi.mock("../src/connection/credentialStore.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/connection/credentialStore.js")>();
  return {
    ...original,
    createCredentialStore: (...args: Parameters<typeof original.createCredentialStore>) => {
      const real = original.createCredentialStore(...args);
      return { ...real, loadChannel: () => { if (control.loadChannelError) throw control.loadChannelError; return real.loadChannel(); } };
    },
  };
});
// 첫 정리·백업 타이머(5분)가 역할 재확인 타이머(5분)와 같은 시각에 돌아 stop()과 겹치지 않게, 정리·백업은 즉시 끝나는 가짜로 바꾼다.
vi.mock("../src/records/maintenance.js", () => ({
  runRetention: () => ({ verdicts: 0, audits: 0, stats: 0, sessions: 0 }),
  runBackup: async () => "backup-skipped",
}));
vi.mock("../src/managers/roleRecheck.js", () => ({
  /** 실패를 흉내 내거나, 해임된 세션을 앱의 onRevoked로 알린다(앱이 그 뒤 무엇을 하는지 보려고). */
  recheckSessionRoles: async (deps: { onRevoked(revoked: Array<{ sessionId: string; managerChannelId: string }>): void }) => {
    if (control.recheckError) throw control.recheckError;
    if (control.revokedOnRecheck.length > 0) deps.onRevoked(control.revokedOnRecheck);
  },
}));
vi.mock("../src/db/database.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/db/database.js")>();
  return { ...original, openDatabase: (path: string) => (control.database = original.openDatabase(path)) };
});
// 앱이 만든 실제 허브를 붙잡아, 테스트에서 가짜 소켓을 붙이고 역할 재확인 주기 뒤의 종료를 확인한다.
vi.mock("../src/realtime/hub.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/realtime/hub.js")>();
  return { ...original, createRealtimeHub: (...args: Parameters<typeof original.createRealtimeHub>) => (control.hub = original.createRealtimeHub(...args)) };
});

const { createApp } = await import("../src/app.js");
const { startFakeChzzk } = await import("./fakes/fakeChzzk.js");
const { buildTestConfig, cleanupDataDirectories, createDataDirectory, newEncryptionKey } = await import("./helpers/appHarness.js");

type FakeChzzk = Awaited<ReturnType<typeof startFakeChzzk>>;
type App = Awaited<ReturnType<typeof createApp>>;

/** 오류 로그의 (메시지, 상세)를 모은다. */
let errorLines: Array<{ message: string; details?: Record<string, unknown> }>;
/** 경고 로그. */
let warnLines: Array<{ message: string; details?: Record<string, unknown> }>;
let fake: FakeChzzk;
let app: App;

beforeEach(async () => {
  control.flushError = null;
  control.recheckError = null;
  control.loadChannelError = null;
  control.revokedOnRecheck = [];
  errorLines = [];
  warnLines = [];
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  fake = await startFakeChzzk();
  const logger = { info: () => undefined, warn: (message: string, details?: Record<string, unknown>) => void warnLines.push({ message, ...(details ? { details } : {}) }), error: (message: string, details?: Record<string, unknown>) => void errorLines.push({ message, ...(details ? { details } : {}) }) };
  app = await createApp(buildTestConfig(fake, createDataDirectory()), { encryptionKey: newEncryptionKey(), logger, pushSender: async () => ({}) });
  await app.start();
});
afterEach(async () => {
  await app.stop();
  vi.useRealTimers();
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

/** 받은 이벤트와 닫기 코드를 모으는 가짜 소켓. */
function recordingSocket() {
  const socket: SocketSink & { sent: RealtimeEvent[]; closedWith: number | null } = {
    readyState: 1, sent: [], closedWith: null,
    send: (data) => void socket.sent.push(JSON.parse(data) as RealtimeEvent),
    close: (code) => void (socket.closedWith = code ?? null),
    on: () => undefined,
  };
  return socket;
}

describe("만료된 세션의 소켓 종료(F2)", () => {
  it("역할 재확인 주기마다 활성 목록에 없는 세션의 소켓을 닫고, 활성 세션의 소켓은 둔다", async () => {
    const hub = control.hub as RealtimeHub;
    control.database?.prepare("INSERT INTO manager_session (id, manager_channel_id, manager_channel_name, role, expires_at, last_role_check_at) VALUES ('active', 'm1', '매니저', 'STREAMING_CHAT_MANAGER', ?, 0)").run(Date.now() + 60 * 60_000);
    const expired = recordingSocket();
    const active = recordingSocket();
    hub.attach(expired, { id: "expired", managerChannelId: "m2", managerChannelName: "매니저2", role: "STREAMING_CHAT_MANAGER", expiresAt: 0, lastRoleCheckAt: 0 });
    hub.attach(active, { id: "active", managerChannelId: "m1", managerChannelName: "매니저", role: "STREAMING_CHAT_MANAGER", expiresAt: 0, lastRoleCheckAt: 0 });
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(expired.closedWith).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(expired.sent).toEqual([{ type: "session_ended", reason: "세션이 만료되었습니다. 다시 로그인하세요" }]);
    expect(expired.closedWith).toBe(4001);
    expect(active.closedWith).toBeNull();
  });
});

describe("해임된 매니저의 장애 알림 구독(F10)", () => {
  it("역할 재확인이 해임한 매니저의 푸시 구독을 지우고, 다른 매니저의 구독은 둔다", async () => {
    const insert = control.database?.prepare("INSERT INTO push_subscription (manager_channel_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, 'p', 'a', 0)");
    insert?.run("revoked-manager", "https://fcm.googleapis.com/fcm/send/revoked");
    insert?.run("kept-manager", "https://fcm.googleapis.com/fcm/send/kept");
    control.revokedOnRecheck = [{ sessionId: "revoked-session", managerChannelId: "revoked-manager" }];
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const owners = control.database?.prepare("SELECT manager_channel_id AS owner FROM push_subscription").all() as Array<{ owner: string }>;
    expect(owners.map((row) => row.owner)).toEqual(["kept-manager"]);
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

describe("토큰 선제 갱신 타이머", () => {
  it("연결 조회가 실패해도 처리되지 않은 거부 없이 경고 로그로 남긴다", async () => {
    control.loadChannelError = new Error("DB 읽기 실패");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(warnLines).toEqual([{ message: "토큰 선제 갱신 실패", details: { error: "Error: DB 읽기 실패" } }]);
  });
});

describe("start()와 stop()은 여러 번 불러도 안전하다", () => {
  it("stop()을 두 번 불러도 닫힌 DB에 통계를 저장하려 하지 않는다", async () => {
    await app.stop();
    await app.stop();
    expect(errorLines).toEqual([]);
  });

  it("start()를 두 번 불러도 listen을 다시 호출하지 않는다", async () => {
    const listen = vi.spyOn(app.http, "listen");
    await expect(app.start()).resolves.toBeUndefined();
    expect(listen).not.toHaveBeenCalled();
  });

  it("stop() 뒤의 start()는 이유를 담은 오류를 던진다", async () => {
    await app.stop();
    await expect(app.start()).rejects.toThrow("이미 종료된 서버입니다");
  });
});
