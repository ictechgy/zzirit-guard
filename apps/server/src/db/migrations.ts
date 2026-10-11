import type { Database } from "./database.js";

/**
 * 스키마 버전별 SQL. 배열 순서가 곧 버전이다(PRAGMA user_version).
 * 한 번 배포한 항목은 고치지 말고 새 항목을 뒤에 추가한다.
 * setting·rule_entry는 스펙 11장에서 상시 보관이라 channel 외래키를 두지 않는다. 연결 해제(DELETE FROM channel)가
 * 매니저가 다듬은 규칙·설정까지 cascade로 지우지 않게 하려는 것이다. 토큰(credential)만 채널과 함께 지워진다.
 */
const migrations: readonly string[] = [
  `
  CREATE TABLE channel (
    channel_id TEXT PRIMARY KEY,
    channel_name TEXT NOT NULL,
    connected_at INTEGER NOT NULL
  );
  CREATE TABLE credential (
    channel_id TEXT PRIMARY KEY REFERENCES channel(channel_id) ON DELETE CASCADE,
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT NOT NULL,
    access_expires_at INTEGER NOT NULL,
    refreshed_at INTEGER NOT NULL
  );
  CREATE TABLE setting (
    channel_id TEXT NOT NULL PRIMARY KEY,
    auto_hide_enabled INTEGER NOT NULL DEFAULT 0,
    stage1_threshold REAL NOT NULL DEFAULT 0.05,
    candidate_threshold REAL NOT NULL DEFAULT 0.5,
    sure_threshold REAL NOT NULL DEFAULT 0.99,
    breaker_per_minute INTEGER NOT NULL DEFAULT 60,
    retention_days_content INTEGER NOT NULL DEFAULT 30,
    retention_days_audit INTEGER NOT NULL DEFAULT 180
  );
  CREATE TABLE rule_entry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('strong','weak','exception','allow','allow_domain','threat','keyword_route')),
    pattern TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (channel_id, kind, pattern)
  );
  CREATE TABLE verdict (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    chat_channel_id TEXT NOT NULL,
    message_time INTEGER NOT NULL,
    sender_channel_id TEXT NOT NULL,
    sender_nickname TEXT NOT NULL,
    content TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('auto_hide','shadow','candidate','needs_care')),
    reason TEXT NOT NULL,
    unsafe_probability REAL,
    category TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','hidden','ignored','restricted','false_positive')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX verdict_channel_created ON verdict (channel_id, created_at);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('manager','rule','system')),
    actor_channel_id TEXT,
    action TEXT NOT NULL,
    target_sender_channel_id TEXT,
    verdict_id INTEGER,
    result TEXT NOT NULL CHECK (result IN ('ok','error')),
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX audit_target ON audit_log (channel_id, target_sender_channel_id, created_at);
  CREATE INDEX audit_created ON audit_log (created_at);
  CREATE TABLE minute_stat (
    channel_id TEXT NOT NULL,
    minute INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    deduplicated INTEGER NOT NULL DEFAULT 0,
    stage1_forwarded INTEGER NOT NULL DEFAULT 0,
    stage2_done INTEGER NOT NULL DEFAULT 0,
    stage2_dropped INTEGER NOT NULL DEFAULT 0,
    candidates INTEGER NOT NULL DEFAULT 0,
    auto_hidden INTEGER NOT NULL DEFAULT 0,
    shadow INTEGER NOT NULL DEFAULT 0,
    invalid_events INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, minute)
  );
  CREATE TABLE manager_session (
    id TEXT PRIMARY KEY,
    manager_channel_id TEXT NOT NULL,
    manager_channel_name TEXT NOT NULL,
    role TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    last_role_check_at INTEGER NOT NULL
  );
  CREATE TABLE push_subscription (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manager_channel_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
];

/**
 * 아직 적용하지 않은 마이그레이션을 순서대로 적용한다.
 * 버전마다 트랜잭션으로 묶어, 중간에 실패해도 반쯤 바뀐 스키마가 남지 않게 한다.
 */
export function runMigrations(database: Database): void {
  const currentVersion = database.pragma("user_version", { simple: true }) as number;
  for (let index = currentVersion; index < migrations.length; index += 1) {
    const statement = migrations[index] as string;
    database.transaction(() => {
      database.exec(statement);
      database.pragma(`user_version = ${index + 1}`);
    })();
  }
}
