import type { AuditEntryDto } from "@zzirit-guard/shared";
import type { Database } from "../db/database.js";
import type { Clock } from "../time.js";

/** 감사 기록 1건(원문 없음). */
export interface AuditRecord {
  channelId: string;
  actorType: "manager" | "rule" | "system";
  actorChannelId: string | null;
  action: string;
  targetSenderChannelId: string | null;
  verdictId: number | null;
  result: "ok" | "error";
  error: string | null;
}

/** 감사 기록 저장소. */
export interface AuditLog {
  record(entry: AuditRecord): void;
  list(channelId: string, limit: number, beforeId: number | null): AuditEntryDto[];
  hasEnforcedAction(channelId: string, senderChannelId: string, sinceMs: number): boolean;
  deleteOlderThan(cutoffMs: number): number;
}

/**
 * 한 번에 읽는 감사 기록 수의 범위(1~200, S19). HTTP 쿼리(auditQuerySchema)와 같은 범위를 저장소에서도 지킨다.
 * 왜: SQLite의 LIMIT -1은 무제한이라, 내부 호출자가 잘못된 값을 넘기면 표 전체를 한 번에 읽는다.
 */
const AUDIT_PAGE_LIMIT = { min: 1, max: 200 };

/** 요주의 사용자로 볼 '실제 조치' 종류. 실패한 조치는 세지 않는다. */
const ENFORCED_ACTIONS = ["hide", "temporary_restrict", "restrict"] as const;

/** audit_log 행. */
interface AuditRow {
  id: number;
  actor_type: AuditEntryDto["actorType"];
  actor_channel_id: string | null;
  action: string;
  target_sender_channel_id: string | null;
  verdict_id: number | null;
  result: "ok" | "error";
  error: string | null;
  created_at: number;
}

/** SQLite 기반 감사 기록을 만든다. */
export function createAuditLog(database: Database, clock: Clock): AuditLog {
  const enforcedQuery = database.prepare(
    `SELECT 1 FROM audit_log WHERE channel_id = ? AND target_sender_channel_id = ? AND created_at >= ? AND result = 'ok'
     AND action IN (${ENFORCED_ACTIONS.map(() => "?").join(",")}) LIMIT 1`,
  );
  return {
    record: (entry) => insertAudit(database, entry, clock()),
    list: (channelId, limit, beforeId) => listAudit(database, channelId, limit, beforeId),
    hasEnforcedAction: (channelId, senderChannelId, sinceMs) => enforcedQuery.get(channelId, senderChannelId, sinceMs, ...ENFORCED_ACTIONS) !== undefined,
    deleteOlderThan: (cutoffMs) => database.prepare("DELETE FROM audit_log WHERE created_at < ?").run(cutoffMs).changes,
  };
}

/** 기록을 넣는다. */
function insertAudit(database: Database, entry: AuditRecord, now: number): void {
  database
    .prepare(
      `INSERT INTO audit_log (channel_id, actor_type, actor_channel_id, action, target_sender_channel_id, verdict_id, result, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(entry.channelId, entry.actorType, entry.actorChannelId, entry.action, entry.targetSenderChannelId, entry.verdictId, entry.result, entry.error, now);
}

/**
 * 페이지 크기를 1~200 정수로 맞춘다. 소수는 버리고, 숫자가 아니면(NaN 등) 가장 작은 값으로 본다.
 * @param limit 호출자가 넘긴 값(믿지 않는다)
 */
function clampAuditLimit(limit: number): number {
  if (!Number.isFinite(limit)) return AUDIT_PAGE_LIMIT.min;
  return Math.min(AUDIT_PAGE_LIMIT.max, Math.max(AUDIT_PAGE_LIMIT.min, Math.trunc(limit)));
}

/** 최신순 목록. beforeId로 이어 읽는다(무한 스크롤). limit은 1~200으로 맞춘다(S19). */
function listAudit(database: Database, channelId: string, limit: number, beforeId: number | null): AuditEntryDto[] {
  const rows = database
    .prepare("SELECT * FROM audit_log WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
    .all(channelId, beforeId ?? Number.MAX_SAFE_INTEGER, clampAuditLimit(limit)) as AuditRow[];
  return rows.map((row) => ({
    id: row.id, actorType: row.actor_type, actorChannelId: row.actor_channel_id, action: row.action,
    targetSenderChannelId: row.target_sender_channel_id, verdictId: row.verdict_id, result: row.result, error: row.error, createdAt: row.created_at,
  }));
}
