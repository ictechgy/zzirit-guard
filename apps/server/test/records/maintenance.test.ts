import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createSessionStore } from "../../src/managers/sessionStore.js";
import { createAuditLog } from "../../src/records/auditLog.js";
import { runBackup, runRetention } from "../../src/records/maintenance.js";
import { createVerdictRepository } from "../../src/records/verdictRepository.js";

/** 하루(ms). */
const DAY = 24 * 60 * 60 * 1000;
/** 테스트가 만든 임시 디렉터리. afterEach에서 지운다. */
const temporaryDirectories: string[] = [];

/** 테스트용 임시 디렉터리를 만든다(OS 임시 폴더 아래 고유 이름). */
function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "zg-backup-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("runRetention", () => {
  it("원문은 30일, 감사 기록·통계는 180일이 지나면 지운다", () => {
    let now = 0;
    const database = openDatabase(":memory:");
    database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
    const verdicts = createVerdictRepository(database, () => now);
    const auditLog = createAuditLog(database, () => now);
    const sessions = createSessionStore(database, () => now);
    const verdict = { channelId: "c1", chatChannelId: "x", messageTime: 0, senderChannelId: "s", senderNickname: "n", content: "c", decision: "candidate" as const, reason: "r" };
    verdicts.insert(verdict);
    auditLog.record({ channelId: "c1", actorType: "rule", actorChannelId: null, action: "hide", targetSenderChannelId: "s", verdictId: null, result: "ok", error: null });
    database.prepare("INSERT INTO minute_stat (channel_id, minute, received) VALUES ('c1', 0, 1)").run();
    sessions.create({ channelId: "m", channelName: "m", role: "STREAMING_CHAT_MANAGER" });
    now = 31 * DAY;
    verdicts.insert(verdict);
    expect(runRetention({ database, verdicts, auditLog, sessions, clock: () => now })).toEqual({ verdicts: 1, audits: 0, stats: 0, sessions: 1 });
    now = 181 * DAY;
    expect(runRetention({ database, verdicts, auditLog, sessions, clock: () => now })).toMatchObject({ audits: 1, stats: 1 });
  });

  it("정리 뒤 WAL을 비워, 지운 원문이 WAL 파일에 남지 않게 한다(F5)", () => {
    const path = join(makeTemporaryDirectory(), "zzirit-guard.sqlite");
    let now = 0;
    const database = openDatabase(path);
    database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
    const verdicts = createVerdictRepository(database, () => now);
    const auditLog = createAuditLog(database, () => now);
    const sessions = createSessionStore(database, () => now);
    verdicts.insert({ channelId: "c1", chatChannelId: "x", messageTime: 0, senderChannelId: "s", senderNickname: "n", content: "지워야 할 원문", decision: "candidate", reason: "r" });
    now = 31 * DAY;
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    expect(runRetention({ database, verdicts, auditLog, sessions, clock: () => now })).toMatchObject({ verdicts: 1 });
    expect(statSync(`${path}-wal`).size).toBe(0);
    database.close();
  });

  it("앞 단계가 던져도 WAL 체크포인트는 돌아, 이미 지운 원문이 WAL 파일에 남지 않는다(S8, M07)", () => {
    const path = join(makeTemporaryDirectory(), "zzirit-guard.sqlite");
    let now = 0;
    const database = openDatabase(path);
    database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
    const verdicts = createVerdictRepository(database, () => now);
    const auditLog = createAuditLog(database, () => now);
    const sessions = { ...createSessionStore(database, () => now), deleteExpired: () => { throw new Error("세션 정리 실패"); } };
    verdicts.insert({ channelId: "c1", chatChannelId: "x", messageTime: 0, senderChannelId: "s", senderNickname: "n", content: "지워야 할 원문", decision: "candidate", reason: "r" });
    now = 31 * DAY;
    expect(() => runRetention({ database, verdicts, auditLog, sessions, clock: () => now })).toThrow("세션 정리 실패");
    expect(verdicts.listRecent("c1", 0)).toEqual([]);
    expect(statSync(`${path}-wal`).size).toBe(0);
    database.close();
  });

  it.each([
    ["0", [0], 30],
    ["음수", [-5], 30],
    ["정수가 아닌 값", [7.5], 30],
    ["잘못된 값과 올바른 값이 섞이면 올바른 값 중 가장 짧은 것", [0, 7], 7],
  ])("DB의 원문 보관 기간이 잘못됐을 때(%s) 전체 삭제하지 않고 올바른 값, 없으면 기본값을 쓴다(S8, X26)", (_label, contentDays, expectedDays) => {
    let now = 0;
    const database = openDatabase(":memory:");
    contentDays.forEach((days, index) => {
      database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES (?, '채널', 0)").run(`c${index}`);
      database.prepare("INSERT INTO setting (channel_id, retention_days_content) VALUES (?, ?)").run(`c${index}`, days);
    });
    const verdicts = createVerdictRepository(database, () => now);
    const auditLog = createAuditLog(database, () => now);
    const sessions = createSessionStore(database, () => now);
    const verdict = { channelId: "c0", chatChannelId: "x", messageTime: 0, senderChannelId: "s", senderNickname: "n", content: "c", decision: "candidate" as const, reason: "r" };
    verdicts.insert(verdict);
    now = (expectedDays - 1) * DAY;
    expect(runRetention({ database, verdicts, auditLog, sessions, clock: () => now })).toMatchObject({ verdicts: 0 });
    now = (expectedDays + 1) * DAY;
    expect(runRetention({ database, verdicts, auditLog, sessions, clock: () => now })).toMatchObject({ verdicts: 1 });
  });

  it("DB의 감사 보관 기간이 0이면 감사 기록을 전체 삭제하지 않고 기본값(180일)으로 본다(S8, X26)", () => {
    const now = 10 * DAY;
    const database = openDatabase(":memory:");
    database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    database.prepare("INSERT INTO setting (channel_id, retention_days_audit) VALUES ('c1', 0)").run();
    const verdicts = createVerdictRepository(database, () => now);
    const auditLog = createAuditLog(database, () => now - DAY);
    const sessions = createSessionStore(database, () => now);
    auditLog.record({ channelId: "c1", actorType: "rule", actorChannelId: null, action: "hide", targetSenderChannelId: "s", verdictId: null, result: "ok", error: null });
    expect(runRetention({ database, verdicts, auditLog, sessions, clock: () => now })).toMatchObject({ audits: 0 });
  });

  it("채널 설정의 보관 기간(7일)을 따른다", () => {
    let now = 100 * DAY;
    const database = openDatabase(":memory:");
    database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    database.prepare("INSERT INTO setting (channel_id, retention_days_content) VALUES ('c1', 7)").run();
    const verdicts = createVerdictRepository(database, () => now);
    const auditLog = createAuditLog(database, () => now);
    const sessions = createSessionStore(database, () => now);
    const verdict = { channelId: "c1", chatChannelId: "x", messageTime: 0, senderChannelId: "s", senderNickname: "n", content: "c", decision: "candidate" as const, reason: "r" };
    verdicts.insert(verdict);
    now = 100 * DAY + 8 * DAY;
    verdicts.insert(verdict);
    expect(runRetention({ database, verdicts, auditLog, sessions, clock: () => now })).toMatchObject({ verdicts: 1 });
  });

  it("설정 행이 여러 개면 가장 짧은 보관 기간을 따른다(R3)", () => {
    let now = 0;
    const database = openDatabase(":memory:");
    database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('old', '옛 채널', 0), ('c1', '채널', 0)").run();
    database.prepare("INSERT INTO setting (channel_id, retention_days_content, retention_days_audit) VALUES ('old', 365, 365)").run();
    database.prepare("INSERT INTO setting (channel_id, retention_days_content, retention_days_audit) VALUES ('c1', 30, 30)").run();
    const verdicts = createVerdictRepository(database, () => now);
    const auditLog = createAuditLog(database, () => now);
    const sessions = createSessionStore(database, () => now);
    verdicts.insert({ channelId: "c1", chatChannelId: "x", messageTime: 0, senderChannelId: "s", senderNickname: "n", content: "c", decision: "candidate", reason: "r" });
    auditLog.record({ channelId: "c1", actorType: "rule", actorChannelId: null, action: "hide", targetSenderChannelId: "s", verdictId: null, result: "ok", error: null });
    now = 40 * DAY;
    expect(runRetention({ database, verdicts, auditLog, sessions, clock: () => now })).toMatchObject({ verdicts: 1, audits: 1 });
  });

  it("보관 기한과 정확히 같은 시각의 행은 남기고, 1ms 이전 행은 지운다", () => {
    const now = 400 * DAY;
    const database = openDatabase(":memory:");
    database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
    const insertVerdictAt = (createdAt: number) =>
      database.prepare(
        "INSERT INTO verdict (channel_id, chat_channel_id, message_time, sender_channel_id, sender_nickname, content, decision, reason, created_at) VALUES ('c1', 'x', 0, 's', 'n', 'c', 'candidate', 'r', ?)",
      ).run(createdAt);
    const insertAuditAt = (createdAt: number) =>
      database.prepare(
        "INSERT INTO audit_log (channel_id, actor_type, action, result, created_at) VALUES ('c1', 'rule', 'hide', 'ok', ?)",
      ).run(createdAt);
    insertVerdictAt(now - 30 * DAY);
    insertVerdictAt(now - 30 * DAY - 1);
    insertAuditAt(now - 180 * DAY);
    insertAuditAt(now - 180 * DAY - 1);
    const verdicts = createVerdictRepository(database, () => now);
    const auditLog = createAuditLog(database, () => now);
    const sessions = createSessionStore(database, () => now);
    expect(runRetention({ database, verdicts, auditLog, sessions, clock: () => now })).toMatchObject({ verdicts: 1, audits: 1 });
    expect(database.prepare("SELECT created_at FROM verdict").all()).toEqual([{ created_at: now - 30 * DAY }]);
    expect(database.prepare("SELECT created_at FROM audit_log").all()).toEqual([{ created_at: now - 180 * DAY }]);
  });
});

describe("runBackup", () => {
  it("백업 파일을 만들고 최근 7개만 남긴다", async () => {
    const directory = makeTemporaryDirectory();
    const database = openDatabase(":memory:");
    for (let day = 0; day < 9; day += 1) await runBackup(database, directory, () => Date.UTC(2026, 9, 1 + day));
    const files = readdirSync(directory).sort();
    expect(files).toHaveLength(7);
    expect(files[0]).toBe("zzirit-guard-20261003-000000.sqlite");
  });

  it("다른 로컬 사용자가 읽지 못하게 백업 파일은 0600, 디렉터리는 0700으로 만든다(R28)", async () => {
    const directory = join(makeTemporaryDirectory(), "backups");
    // 이미 0755로 존재하는 디렉터리도 0700으로 고쳐지는지 확인하려고 mode를 직접 지정한다(mkdir의 mode는 기존 디렉터리에 무시된다).
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);
    const database = openDatabase(":memory:");
    const path = await runBackup(database, directory, () => Date.UTC(2026, 9, 11));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it("백업이 실패하면 백업 이름과 부분 파일을 남기지 않고 원래 오류를 던진다", async () => {
    const directory = makeTemporaryDirectory();
    const database = openDatabase(":memory:");
    database.close();
    await expect(runBackup(database, directory, () => Date.UTC(2026, 9, 11))).rejects.toThrow();
    const files = readdirSync(directory);
    expect(files.filter((name) => name.endsWith(".sqlite"))).toHaveLength(0);
    expect(files.filter((name) => name.endsWith(".partial"))).toHaveLength(0);
  });

  it("백업 도중 실패해 부분 파일이 생겨도 남기지 않고 원래 오류를 던진다", async () => {
    const directory = makeTemporaryDirectory();
    // 실제 SQLite 백업이 중간에 실패한 상황을 흉내 낸다: 파일을 쓴 뒤 거절한다.
    const partialWritingDatabase = {
      backup: async (path: string) => {
        writeFileSync(path, "partial");
        throw new Error("디스크 가득 참");
      },
    } as unknown as Parameters<typeof runBackup>[0];
    await expect(runBackup(partialWritingDatabase, directory, () => Date.UTC(2026, 9, 11))).rejects.toThrow("디스크 가득 참");
    expect(readdirSync(directory)).toEqual([]);
  });

  it("이전 실행이 죽어 남은 부분 파일(.partial)을 시작할 때 지운다(F5)", async () => {
    const directory = makeTemporaryDirectory();
    const stale = join(directory, "zzirit-guard-20261010-000000.sqlite.partial");
    writeFileSync(stale, "원문이 든 미완성 백업");
    writeFileSync(join(directory, "other.partial"), "");
    const database = openDatabase(":memory:");
    await runBackup(database, directory, () => Date.UTC(2026, 9, 11));
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(directory, "other.partial"))).toBe(true);
  });

  it("방금 만든 백업은 보존 개수 정리에서 지우지 않는다(미래 시각 백업이 있어도)", async () => {
    const directory = makeTemporaryDirectory();
    writeFileSync(join(directory, "zzirit-guard-20990101-000000.sqlite"), "");
    writeFileSync(join(directory, "zzirit-guard-20990102-000000.sqlite"), "");
    const database = openDatabase(":memory:");
    const path = await runBackup(database, directory, () => Date.UTC(2026, 9, 11), 2);
    expect(existsSync(path)).toBe(true);
  });

  it("보존 개수가 0이어도 방금 만든 백업 1개는 남긴다", async () => {
    const directory = makeTemporaryDirectory();
    const database = openDatabase(":memory:");
    const path = await runBackup(database, directory, () => Date.UTC(2026, 9, 11), 0);
    expect(existsSync(path)).toBe(true);
  });

  it("백업 형식이 아닌 파일은 정리 때 건드리지 않는다", async () => {
    const directory = makeTemporaryDirectory();
    writeFileSync(join(directory, "notes.txt"), "");
    writeFileSync(join(directory, "zzirit-guard-x.sqlite"), "");
    const database = openDatabase(":memory:");
    for (let day = 0; day < 3; day += 1) await runBackup(database, directory, () => Date.UTC(2026, 9, 1 + day), 1);
    const files = readdirSync(directory).sort();
    expect(files).toContain("notes.txt");
    expect(files).toContain("zzirit-guard-x.sqlite");
  });
});
