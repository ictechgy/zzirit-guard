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
  /** 주기 작업이 불린 횟수(겹침 방지 확인용). */
  calls: { recheck: 0, retention: 0, accessToken: 0 },
  /** 설정되면 해당 주기 작업이 이 Promise가 끝날 때까지 멈춘다(이전 실행이 길어진 상황). */
  recheckGate: null as Promise<void> | null,
  backupGate: null as Promise<void> | null,
  accessTokenGate: null as Promise<void> | null,
  /** 설정되면 저장된 채널 대신 이 채널을 돌려준다(토큰 선제 갱신 타이머가 돌게). */
  fakeChannel: null as { channelId: string; channelName: string } | null,
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
      return { ...real, loadChannel: () => { if (control.loadChannelError) throw control.loadChannelError; return control.fakeChannel ?? real.loadChannel(); } };
    },
  };
});
// 첫 정리·백업 타이머(5분)가 역할 재확인 타이머(5분)와 같은 시각에 돌아 stop()과 겹치지 않게, 정리·백업은 즉시 끝나는 가짜로 바꾼다.
vi.mock("../src/records/maintenance.js", () => ({
  runRetention: () => {
    control.calls.retention += 1;
    return { verdicts: 0, audits: 0, stats: 0, sessions: 0 };
  },
  runBackup: async () => {
    if (control.backupGate) await control.backupGate;
    return "backup-skipped";
  },
}));
vi.mock("../src/managers/roleRecheck.js", () => ({
  /** 실패를 흉내 내거나, 해임된 세션을 앱의 onRevoked로 알린다(앱이 그 뒤 무엇을 하는지 보려고). */
  recheckSessionRoles: async (deps: { onRevoked(revoked: Array<{ sessionId: string; managerChannelId: string }>): void }) => {
    control.calls.recheck += 1;
    if (control.recheckGate) await control.recheckGate;
    if (control.recheckError) throw control.recheckError;
    if (control.revokedOnRecheck.length > 0) deps.onRevoked(control.revokedOnRecheck);
  },
}));
vi.mock("../src/connection/tokenManager.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/connection/tokenManager.js")>();
  return {
    ...original,
    createTokenManager: (...args: Parameters<typeof original.createTokenManager>) => {
      const real = original.createTokenManager(...args);
      /** 토큰 선제 갱신이 오래 걸리는 상황을 흉내 낸다. 게이트가 없으면 실제 동작을 따른다. */
      const getAccessToken = async () => {
        control.calls.accessToken += 1;
        if (!control.accessTokenGate) return real.getAccessToken();
        await control.accessTokenGate;
        return "slow-token";
      };
      return Object.assign(Object.create(real) as typeof real, { getAccessToken });
    },
  };
});
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
  control.calls = { recheck: 0, retention: 0, accessToken: 0 };
  control.recheckGate = null;
  control.backupGate = null;
  control.accessTokenGate = null;
  control.fakeChannel = null;
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

/** 테스트가 끝낼 때까지 멈춰 있는 Promise와 그것을 끝내는 함수. */
function gate(): { promise: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe("주기 작업은 이전 실행이 끝나기 전에 겹쳐 돌지 않는다(S15, M04)", () => {
  it("역할 재확인이 길어지면 다음 차례를 건너뛰고, 끝난 뒤에는 다시 돈다", async () => {
    const slow = gate();
    control.recheckGate = slow.promise;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(control.calls.recheck).toBe(1);
    slow.open();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(control.calls.recheck).toBe(2);
  });

  it("정리·백업이 길어지면 다음 차례(첫 실행 뒤 하루 주기)를 건너뛴다", async () => {
    const slow = gate();
    control.backupGate = slow.promise;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(control.calls.retention).toBe(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(control.calls.retention).toBe(1);
    slow.open();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(control.calls.retention).toBe(2);
  });

  it("토큰 선제 갱신이 길어지면 다음 차례를 건너뛴다", async () => {
    const slow = gate();
    control.fakeChannel = { channelId: "c-timer", channelName: "채널" };
    control.database?.prepare("INSERT OR IGNORE INTO setting (channel_id) VALUES ('c-timer')").run();
    control.accessTokenGate = slow.promise;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(control.calls.accessToken).toBe(1);
    slow.open();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(control.calls.accessToken).toBe(2);
  });
});

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
    // 주기 상태 방송(status)도 함께 오므로 종류로 걸러 본다.
    expect(expired.sent.filter((event) => event.type === "session_ended")).toEqual([{ type: "session_ended", reason: "세션이 만료되었습니다. 다시 로그인하세요" }]);
    expect(expired.closedWith).toBe(4001);
    expect(active.closedWith).toBeNull();
  });
});

describe("주기 상태 방송(B19-2)", () => {
  it("20초마다 열린 화면에 status를 보내, 채팅이 없는 조용한 채널도 살아 있는 연결로 보이게 한다", async () => {
    const hub = control.hub as RealtimeHub;
    const socket = recordingSocket();
    hub.attach(socket, { id: "s1", managerChannelId: "m1", managerChannelName: "매니저", role: "STREAMING_CHAT_MANAGER", expiresAt: 0, lastRoleCheckAt: 0 });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(socket.sent.filter((event) => event.type === "status")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent.filter((event) => event.type === "status")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.sent.filter((event) => event.type === "status")).toHaveLength(2);
  });

  it("stop()이 방송 타이머도 지워, 닫힌 DB로 상태를 계산하려다 실패하지 않는다", async () => {
    await app.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errorLines.filter((line) => line.message === "상태 방송 실패")).toEqual([]);
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
