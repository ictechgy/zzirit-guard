import type { Decision, FalsePositiveReasonCountDto, VerdictDto, VerdictStatus } from "@zzirit-guard/shared";
import type { Database } from "../db/database.js";
import type { Clock } from "../time.js";

/** 새로 저장할 판정. pass는 저장하지 않는다(최소 저장, 스펙 9장). */
export interface NewVerdict {
  channelId: string;
  chatChannelId: string;
  messageTime: number;
  senderChannelId: string;
  senderNickname: string;
  content: string;
  decision: Exclude<Decision, "pass">;
  reason: string;
  unsafeProbability?: number | null;
  category?: string | null;
}

/** 판정 저장소. */
export interface VerdictRepository {
  insert(verdict: NewVerdict): VerdictDto;
  updateStatus(id: number, status: VerdictStatus): void;
  get(id: number): (VerdictDto & { channelId: string }) | null;
  listRecent(channelId: string, sinceMs: number): VerdictDto[];
  /**
   * 오판으로 신고된 판정을 최신순(만들어진 시각, 같으면 id)으로 limit개 읽는다. 오판 검토 목록(스펙 5.5)에 쓴다.
   * 신고한 시각은 감사 기록(action false_positive)에 있다. 판정 표에는 없어 만들어진 순서로 정렬한다.
   */
  listFalsePositives(channelId: string, limit: number): VerdictDto[];
  /** 오판으로 신고된 판정을 이유(규칙 번호)별로 센다. 많은 순, 같으면 이유 순. 고칠 규칙을 고르는 데 쓴다. */
  countFalsePositivesByReason(channelId: string): FalsePositiveReasonCountDto[];
  deleteOlderThan(cutoffMs: number): number;
}

/** verdict 행. */
interface VerdictRow {
  id: number;
  channel_id: string;
  chat_channel_id: string;
  message_time: number;
  sender_channel_id: string;
  sender_nickname: string;
  content: string;
  decision: Exclude<Decision, "pass">;
  reason: string;
  status: VerdictStatus;
  created_at: number;
}

/** SQLite 기반 판정 저장소를 만든다. */
export function createVerdictRepository(database: Database, clock: Clock): VerdictRepository {
  return {
    insert: (verdict) => insertVerdict(database, verdict, clock()),
    updateStatus: (id, status) => void database.prepare("UPDATE verdict SET status = ? WHERE id = ?").run(status, id),
    get: (id) => {
      const row = database.prepare("SELECT * FROM verdict WHERE id = ?").get(id) as VerdictRow | undefined;
      return row ? { ...toDto(row), channelId: row.channel_id } : null;
    },
    listRecent: (channelId, sinceMs) =>
      (database.prepare("SELECT * FROM verdict WHERE channel_id = ? AND created_at >= ? ORDER BY id").all(channelId, sinceMs) as VerdictRow[]).map(toDto),
    listFalsePositives: (channelId, limit) =>
      (database
        .prepare("SELECT * FROM verdict WHERE channel_id = ? AND status = 'false_positive' ORDER BY created_at DESC, id DESC LIMIT ?")
        .all(channelId, limit) as VerdictRow[]).map(toDto),
    countFalsePositivesByReason: (channelId) =>
      database
        .prepare("SELECT reason, COUNT(*) AS count FROM verdict WHERE channel_id = ? AND status = 'false_positive' GROUP BY reason ORDER BY count DESC, reason")
        .all(channelId) as FalsePositiveReasonCountDto[],
    deleteOlderThan: (cutoffMs) => database.prepare("DELETE FROM verdict WHERE created_at < ?").run(cutoffMs).changes,
  };
}

/** 판정을 넣고 DTO로 돌려준다. */
function insertVerdict(database: Database, verdict: NewVerdict, now: number): VerdictDto {
  const result = database
    .prepare(
      `INSERT INTO verdict (channel_id, chat_channel_id, message_time, sender_channel_id, sender_nickname, content, decision, reason, unsafe_probability, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      verdict.channelId, verdict.chatChannelId, verdict.messageTime, verdict.senderChannelId, verdict.senderNickname,
      verdict.content, verdict.decision, verdict.reason, verdict.unsafeProbability ?? null, verdict.category ?? null, now,
    );
  const { channelId: _channelId, unsafeProbability: _probability, category: _category, ...rest } = verdict;
  return { ...rest, id: Number(result.lastInsertRowid), status: "pending", createdAt: now };
}

/** 행을 DTO로 바꾼다. */
function toDto(row: VerdictRow): VerdictDto {
  return {
    id: row.id, chatChannelId: row.chat_channel_id, messageTime: row.message_time, senderChannelId: row.sender_channel_id,
    senderNickname: row.sender_nickname, content: row.content, decision: row.decision, reason: row.reason, status: row.status, createdAt: row.created_at,
  };
}
