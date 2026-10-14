import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { MIGRATIONS, runMigrations } from "../../src/db/migrations.js";

describe("openDatabase", () => {
  it("지운 행이 파일에 남지 않게 secure_delete를 켠다(F5)", () => {
    const database = openDatabase(":memory:");
    expect(database.pragma("secure_delete", { simple: true })).toBe(1);
  });

  it("스펙 11장의 테이블을 모두 만든다", () => {
    const database = openDatabase(":memory:");
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual([
      "audit_log", "channel", "credential", "manager_session", "message_hide", "minute_stat", "push_subscription", "rule_entry", "setting", "verdict",
    ]);
  });

  it("마이그레이션을 두 번 실행해도 안전하다", () => {
    const database = openDatabase(":memory:");
    expect(() => runMigrations(database)).not.toThrow();
    expect(database.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
  });

  it("v1 DB를 v2로 올리면 규칙 번호를 그대로 두고 광고 낱말(spam)을 받는다", () => {
    const database = new BetterSqlite3(":memory:");
    database.exec(MIGRATIONS[0] as string);
    database.pragma("user_version = 1");
    const insert = database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', ?, ?, 'test', 0)");
    insert.run("strong", "가");
    insert.run("threat", "나");
    database.prepare("DELETE FROM rule_entry WHERE pattern = '가'").run();
    runMigrations(database);
    expect(database.prepare("SELECT id, kind, pattern FROM rule_entry").all()).toEqual([{ id: 2, kind: "threat", pattern: "나" }]);
    insert.run("spam", "꽁머니");
    expect(database.prepare("SELECT id FROM rule_entry WHERE kind = 'spam'").get()).toEqual({ id: 3 });
    expect(() => insert.run("unknown", "x")).toThrow(/CHECK/);
  });

  it.each([
    ["가장 큰 번호를 지운 뒤", ["가", "나", "다"], ["다"], 4],
    ["모든 규칙을 지운 뒤", ["가", "나"], ["가", "나"], 3],
    ["규칙을 한 번도 넣지 않은 채", [], [], 1],
  ])("v1→v2 마이그레이션은 %s에도 지워진 규칙 번호를 다시 쓰지 않는다", (_label, added, removed, expectedNextId) => {
    const database = new BetterSqlite3(":memory:");
    database.exec(MIGRATIONS[0] as string);
    database.pragma("user_version = 1");
    const insert = database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', ?, ?, 'test', 0)");
    added.forEach((pattern) => insert.run("weak", pattern));
    removed.forEach((pattern) => database.prepare("DELETE FROM rule_entry WHERE pattern = ?").run(pattern));
    runMigrations(database);
    expect(Number(insert.run("spam", "새규칙").lastInsertRowid)).toBe(expectedNextId);
  });

  it("v2 DB를 v3로 올리면 이미 숨긴 메시지(지금 숨김 상태이거나 숨김 성공 감사 기록이 있는 판정)를 숨김 장부로 옮긴다", () => {
    const database = new BetterSqlite3(":memory:");
    MIGRATIONS.slice(0, 2).forEach((statement) => database.exec(statement as string));
    database.pragma("user_version = 2");
    const insertVerdict = database.prepare(
      `INSERT INTO verdict (channel_id, chat_channel_id, message_time, sender_channel_id, sender_nickname, content, decision, reason, status, created_at)
       VALUES ('c1', 'chat', ?, ?, 'n', '원문', 'auto_hide', 'rule', ?, ?)`,
    );
    insertVerdict.run(1, "a", "hidden", 100);
    insertVerdict.run(1, "a", "hidden", 200);
    const restricted = Number(insertVerdict.run(2, "b", "restricted", 300).lastInsertRowid);
    const failed = Number(insertVerdict.run(3, "c", "pending", 400).lastInsertRowid);
    insertVerdict.run(4, "d", "false_positive", 500);
    const insertAudit = database.prepare(
      "INSERT INTO audit_log (channel_id, actor_type, action, verdict_id, result, created_at) VALUES ('c1', 'manager', 'hide', ?, ?, 0)",
    );
    insertAudit.run(restricted, "ok");
    insertAudit.run(failed, "error");
    runMigrations(database);
    expect(database.prepare("SELECT sender_channel_id, message_time, state, updated_at FROM message_hide ORDER BY sender_channel_id").all()).toEqual([
      { sender_channel_id: "a", message_time: 1, state: "hidden", updated_at: 200 },
      { sender_channel_id: "b", message_time: 2, state: "hidden", updated_at: 300 },
    ]);
  });

  it("알 수 없는 규칙 종류를 거부한다", () => {
    const database = openDatabase(":memory:");
    database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    const insertRule = database.prepare(
      "INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', ?, 'x', 'test', 0)",
    );
    expect(() => insertRule.run("unknown")).toThrow(/CHECK/);
    expect(() => insertRule.run("exception")).not.toThrow();
  });

  it("채널을 지우면 토큰(credential)은 함께 지워진다(F3)", () => {
    const database = openDatabase(":memory:");
    database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    database.prepare("INSERT INTO credential (channel_id, access_token_enc, refresh_token_enc, access_expires_at, refreshed_at) VALUES ('c1', 'a', 'r', 0, 0)").run();
    database.prepare("DELETE FROM channel").run();
    expect(database.prepare("SELECT COUNT(*) AS count FROM credential").get()).toEqual({ count: 0 });
  });

  it("채널을 지워도 설정과 규칙은 상시 보관이라 남는다(스펙 11장, F3)", () => {
    const database = openDatabase(":memory:");
    database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
    database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', 'strong', 'x', 'test', 0)").run();
    database.prepare("DELETE FROM channel").run();
    expect(database.prepare("SELECT COUNT(*) AS count FROM setting").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM rule_entry").get()).toEqual({ count: 1 });
  });
});
