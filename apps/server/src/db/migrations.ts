import type { Database } from "./database.js";

/**
 * 스키마 버전별 SQL. 배열 순서가 곧 버전이다(PRAGMA user_version).
 * 한 번 배포한 항목은 고치지 말고 새 항목을 뒤에 추가한다.
 * setting·rule_entry는 스펙 11장에서 상시 보관이라 channel 외래키를 두지 않는다. 연결 해제(DELETE FROM channel)가
 * 매니저가 다듬은 규칙·설정까지 cascade로 지우지 않게 하려는 것이다. 토큰(credential)만 채널과 함께 지워진다.
 */
export const MIGRATIONS: readonly string[] = [
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
  // v2: 규칙 종류에 광고 낱말(spam)을 더한다. SQLite는 CHECK 제약을 고칠 수 없어 표를 새로 만들어 옮긴다.
  // id를 그대로 옮겨 판정 이유(rule:<종류>:<번호>)와 감사 기록이 가리키는 규칙 번호가 바뀌지 않게 한다.
  // 옛 표의 AUTOINCREMENT 값(sqlite_sequence)도 옮긴다. 남은 가장 큰 id만 이어 쓰면, 지워진 규칙 번호를 새 규칙이 다시 받아
  // 예전 판정 이유가 엉뚱한 규칙을 가리키게 되기 때문이다.
  `
  CREATE TEMP TABLE rule_entry_sequence AS SELECT seq FROM sqlite_sequence WHERE name = 'rule_entry';
  CREATE TABLE rule_entry_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('strong','weak','exception','allow','allow_domain','threat','keyword_route','spam')),
    pattern TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (channel_id, kind, pattern)
  );
  INSERT INTO rule_entry_v2 (id, channel_id, kind, pattern, created_by, created_at)
    SELECT id, channel_id, kind, pattern, created_by, created_at FROM rule_entry;
  DROP TABLE rule_entry;
  ALTER TABLE rule_entry_v2 RENAME TO rule_entry;
  DELETE FROM sqlite_sequence WHERE name IN ('rule_entry', 'rule_entry_v2');
  INSERT INTO sqlite_sequence (name, seq)
    SELECT 'rule_entry', MAX(seq) FROM (
      SELECT seq FROM rule_entry_sequence UNION ALL SELECT MAX(id) AS seq FROM rule_entry
    ) WHERE seq IS NOT NULL HAVING COUNT(*) > 0;
  DROP TABLE rule_entry_sequence;
  `,
  // v3: AI 단계(로드맵 2단계). AI가 보지 못한 건수(장애·시간 초과·너무 긴 문장 등)를 과부하(stage2_dropped)와 나눠 센다.
  // '확실' 배지는 결과가 나온 때의 임계값으로 정해 저장한다(나중에 임계값을 바꿔도 이미 올린 배지가 바뀌지 않게).
  // 같은 메시지의 판정을 찾는 색인: AI 결과를 기록하기 전 겹침 확인에 쓴다.
  // 메시지 숨김 장부: 같은 메시지에 숨김이 두 번 나가지 않게 숨김 결과(성공·결과 모름)를 메시지마다 남긴다(원문 없음).
  // sending은 보내기 직전 표시다(결과를 적기 전에 죽거나 DB가 실패하면 결과 모름으로 본다).
  // 이미 숨긴 메시지를 옮겨 적는다: 지금 숨김 상태인 판정과, 숨김 성공 감사 기록이 가리키는 판정(숨긴 뒤 오판·제한으로 바뀐 것).
  // 옮기지 않으면 올린 직후 치지직이 같은 메시지를 다시 보낼 때 되돌릴 수 없는 숨김이 또 나간다.
  `
  ALTER TABLE minute_stat ADD COLUMN ai_unchecked INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE verdict ADD COLUMN sure INTEGER NOT NULL DEFAULT 0 CHECK (sure IN (0, 1));
  CREATE INDEX verdict_message ON verdict (channel_id, chat_channel_id, sender_channel_id, message_time);
  CREATE TABLE message_hide (
    chat_channel_id TEXT NOT NULL,
    sender_channel_id TEXT NOT NULL,
    message_time INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('sending','hidden','result_unknown')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chat_channel_id, sender_channel_id, message_time)
  );
  CREATE INDEX message_hide_updated ON message_hide (updated_at);
  INSERT INTO message_hide (chat_channel_id, sender_channel_id, message_time, state, updated_at)
    SELECT chat_channel_id, sender_channel_id, message_time, 'hidden', MAX(created_at) FROM (
      SELECT chat_channel_id, sender_channel_id, message_time, created_at FROM verdict WHERE status = 'hidden'
      UNION ALL
      SELECT verdict.chat_channel_id, verdict.sender_channel_id, verdict.message_time, verdict.created_at
        FROM audit_log JOIN verdict ON verdict.id = audit_log.verdict_id
        WHERE audit_log.action = 'hide' AND audit_log.result = 'ok'
    ) GROUP BY chat_channel_id, sender_channel_id, message_time;
  `,
];

/**
 * 아직 적용하지 않은 마이그레이션을 순서대로 적용한다.
 * 버전마다 트랜잭션으로 묶어, 중간에 실패해도 반쯤 바뀐 스키마가 남지 않게 한다.
 */
export function runMigrations(database: Database): void {
  const currentVersion = database.pragma("user_version", { simple: true }) as number;
  for (let index = currentVersion; index < MIGRATIONS.length; index += 1) {
    const statement = MIGRATIONS[index] as string;
    database.transaction(() => {
      database.exec(statement);
      database.pragma(`user_version = ${index + 1}`);
    })();
  }
}
