import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
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
});
