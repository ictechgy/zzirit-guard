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
  /**
   * 판정 상태를 원자적으로 바꾼다: 같은 채널이고 지금 상태가 allowedFrom 중 하나일 때만 바꾼다(S12, M10).
   * 왜: "읽고 확인한 뒤 쓰기"는 그 사이 다른 요청이 상태를 바꿔도 덮어써, 숨김·제한 기록이 사라지거나 같은 조치가 두 번 기록된다.
   * @param id 판정 번호
   * @param channelId 판정이 속해야 하는 채널
   * @param status 새 상태
   * @param allowedFrom 바꿔도 되는 지금 상태 목록
   * @returns 바꿨으면 true, 조건이 맞지 않아(다른 채널·이미 처리됨·없음) 바꾸지 않았으면 false
   */
  transitionStatus(id: number, channelId: string, status: VerdictStatus, allowedFrom: readonly VerdictStatus[]): boolean;
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
    transitionStatus: (id, channelId, status, allowedFrom) => transitionVerdictStatus(database, { id, channelId, status, allowedFrom }),
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

/** transitionVerdictStatus에 넘기는 전이 한 건. 필드 뜻은 VerdictRepository.transitionStatus와 같다. */
interface StatusTransition {
  id: number;
  channelId: string;
  status: VerdictStatus;
  allowedFrom: readonly VerdictStatus[];
}

/**
 * 조건부 UPDATE 한 번으로 상태를 바꾸고 바뀐 행 수로 결과를 판단한다. 확인과 쓰기가 한 문장이라 사이에 끼어들 틈이 없다.
 * @param database 서버 SQLite 연결
 * @param transition 바꿀 판정·채널·새 상태·허용 이전 상태
 * @returns 바꿨으면 true
 */
function transitionVerdictStatus(database: Database, transition: StatusTransition): boolean {
  if (transition.allowedFrom.length === 0) return false;
  const placeholders = transition.allowedFrom.map(() => "?").join(",");
  const { changes } = database
    .prepare(`UPDATE verdict SET status = ? WHERE id = ? AND channel_id = ? AND status IN (${placeholders})`)
    .run(transition.status, transition.id, transition.channelId, ...transition.allowedFrom);
  return changes > 0;
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
