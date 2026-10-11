import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrations.js";

describe("openDatabase", () => {
  it("스펙 11장의 테이블을 모두 만든다", () => {
    const database = openDatabase(":memory:");
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual([
      "audit_log", "channel", "credential", "manager_session", "minute_stat", "push_subscription", "rule_entry", "setting", "verdict",
    ]);
  });

  it("마이그레이션을 두 번 실행해도 안전하다", () => {
    const database = openDatabase(":memory:");
    expect(() => runMigrations(database)).not.toThrow();
    expect(database.pragma("user_version", { simple: true })).toBe(1);
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
