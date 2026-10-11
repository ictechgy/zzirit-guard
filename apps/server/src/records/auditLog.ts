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

/** 최신순 목록. beforeId로 이어 읽는다(무한 스크롤). */
function listAudit(database: Database, channelId: string, limit: number, beforeId: number | null): AuditEntryDto[] {
  const rows = database
    .prepare("SELECT * FROM audit_log WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
    .all(channelId, beforeId ?? Number.MAX_SAFE_INTEGER, limit) as AuditRow[];
  return rows.map((row) => ({
    id: row.id, actorType: row.actor_type, actorChannelId: row.actor_channel_id, action: row.action,
    targetSenderChannelId: row.target_sender_channel_id, verdictId: row.verdict_id, result: row.result, error: row.error, createdAt: row.created_at,
  }));
}
