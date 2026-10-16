import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createRuleRepository, type RuleSnapshot } from "../../src/detection/ruleRepository.js";
import { MIGRATIONS, runMigrations } from "../../src/db/migrations.js";

/** 스냅숏의 비교용 공개 필드만 추려 버전별 이전 결과를 확인한다. */
function snapshotShape(snapshot: RuleSnapshot) {
  const groups = {
    strong: snapshot.strong,
    weak: snapshot.weak,
    exception: snapshot.exception,
    threat: snapshot.threat,
    keywordRoute: snapshot.keywordRoute,
    spam: snapshot.spam,
    critical: snapshot.critical,
  };
  return {
    ...Object.fromEntries(Object.entries(groups).map(([kind, rules]) => [kind, rules.map(({ id, kind: ruleKind, pattern }) => ({ id, kind: ruleKind, pattern }))])),
    allow: [...snapshot.allow].sort(),
    allowDomains: [...snapshot.allowDomains],
  };
}

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
      "INSERT INTO audit_log (channel_id, actor_type, action, verdict_id, result, created_at) VALUES ('c1', 'manager', 'hide', ?, ?, ?)",
    );
    insertAudit.run(restricted, "ok", 900);
    insertAudit.run(failed, "error", 950);
    runMigrations(database);
    expect(database.prepare("SELECT sender_channel_id, message_time, state, updated_at FROM message_hide ORDER BY sender_channel_id").all()).toEqual([
      { sender_channel_id: "a", message_time: 1, state: "hidden", updated_at: 200 },
      { sender_channel_id: "b", message_time: 2, state: "hidden", updated_at: 900 },
    ]);
  });

  it.each([
    [1, ["strong", "threat", "keyword_route", "weak"], ["strong", "keyword_route"], 4, 5],
    [2, ["strong", "threat", "keyword_route", "spam", "weak"], ["strong", "keyword_route", "spam"], 5, 6],
    [3, ["strong", "threat", "keyword_route", "spam", "weak"], ["strong", "keyword_route", "spam"], 5, 6],
  ] as const)("v%d 규칙 표를 v4로 올릴 때 실제 규칙·삭제된 번호·sqlite_sequence를 보존한다", (version, kinds, remainingKinds, expectedSequence, expectedNextId) => {
    const database = new BetterSqlite3(":memory:");
    MIGRATIONS.slice(0, version).forEach((statement) => database.exec(statement as string));
    database.pragma(`user_version = ${version}`);
    const insert = database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', ?, ?, 'test', 0)");
    kinds.forEach((kind, index) => insert.run(kind, `이전규칙${index + 1}`));
    database.prepare("DELETE FROM rule_entry WHERE id = 2").run();
    database.prepare("DELETE FROM rule_entry WHERE id = ?").run(kinds.length);
    expect(database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'rule_entry'").get()).toEqual({ seq: expectedSequence });
    expect(database.prepare("SELECT MAX(id) AS maxId FROM rule_entry").get()).toEqual({ maxId: expectedSequence - 1 });
    runMigrations(database);
    expect(database.prepare("SELECT id, kind FROM rule_entry ORDER BY id").all()).toEqual(remainingKinds.map((kind, index) => ({ id: index === 0 ? 1 : index + 2, kind })));
    expect(database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'rule_entry'").get()).toEqual({ seq: expectedSequence });
    const currentInsert = database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', ?, ?, 'test', 0)");
    expect(Number(currentInsert.run("critical", "핵심낱말").lastInsertRowid)).toBe(expectedNextId);
    expect(() => currentInsert.run("unknown", "x")).toThrow(/CHECK/);
  });

  it.each([0, 1, 2, 3])("버전 %d DB를 현재 스키마로 올린 후 seedDefaults하면 새 DB와 규칙 스냅숏이 같다", (version) => {
    const migrated = new BetterSqlite3(":memory:");
    if (version > 0) MIGRATIONS.slice(0, version).forEach((statement) => migrated.exec(statement as string));
    migrated.pragma(`user_version = ${version}`);
    runMigrations(migrated);
    migrated.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    const fresh = openDatabase(":memory:");
    fresh.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    const migratedRepository = createRuleRepository(migrated, () => 0);
    const freshRepository = createRuleRepository(fresh, () => 0);
    migratedRepository.seedDefaults("c1");
    freshRepository.seedDefaults("c1");
    expect(snapshotShape(migratedRepository.snapshot("c1"))).toEqual(snapshotShape(freshRepository.snapshot("c1")));
    expect(migrated.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(fresh.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
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
