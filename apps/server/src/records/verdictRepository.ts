import type { AiCategory, Decision, FalsePositiveReasonCountDto, VerdictDto, VerdictStatus } from "@zzirit-guard/shared";
import type { MessageTarget } from "../chzzk/apiClient.js";
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
  /** AI(2차) 유해 확률. 규칙 판정이면 비운다. */
  unsafeProbability?: number | null;
  /** AI(2차) 범주. 규칙 판정이면 비운다. */
  category?: AiCategory | null;
  /** 결과가 나온 때의 '확실' 임계값 이상이었는지. 규칙 판정이면 비운다(false). */
  sure?: boolean;
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
  /**
   * 같은 메시지(채널·채팅 채널·보낸 사람·보낸 시각)의 판정이 이미 있는지 본다.
   * 왜: AI 결과는 늦게 오므로, 그 사이 떼도배 소급 숨김 등으로 판정이 생긴 메시지에 후보를 또 만들지 않기 위해서다.
   */
  existsForMessage(channelId: string, target: MessageTarget): boolean;
  /** 같은 메시지에 숨김이 끝난(hidden) 판정이 있는지 본다. 서버를 다시 시작해도 같은 메시지를 두 번 숨기지 않기 위해서다. */
  isMessageHidden(target: MessageTarget): boolean;
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
  unsafe_probability: number | null;
  category: string | null;
  sure: number;
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
    existsForMessage: (channelId, target) =>
      database
        .prepare("SELECT 1 FROM verdict WHERE channel_id = ? AND chat_channel_id = ? AND sender_channel_id = ? AND message_time = ? LIMIT 1")
        .get(channelId, target.chatChannelId, target.senderChannelId, target.messageTime) !== undefined,
    isMessageHidden: (target) =>
      database
        .prepare("SELECT 1 FROM verdict WHERE chat_channel_id = ? AND sender_channel_id = ? AND message_time = ? AND status = 'hidden' LIMIT 1")
        .get(target.chatChannelId, target.senderChannelId, target.messageTime) !== undefined,
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

/**
 * 판정을 넣고 DTO로 돌려준다. 넣은 값으로 행을 만들어 toDto 하나로 바꾼다.
 * 왜: 기록 직후 알림(WebSocket)과 나중의 목록·단건 조회(REST)가 같은 변환을 거쳐야 AI 칸이 어긋나지 않는다.
 */
function insertVerdict(database: Database, verdict: NewVerdict, now: number): VerdictDto {
  const row: Omit<VerdictRow, "id"> = {
    channel_id: verdict.channelId, chat_channel_id: verdict.chatChannelId, message_time: verdict.messageTime,
    sender_channel_id: verdict.senderChannelId, sender_nickname: verdict.senderNickname, content: verdict.content,
    decision: verdict.decision, reason: verdict.reason, status: "pending", created_at: now,
    unsafe_probability: verdict.unsafeProbability ?? null, category: verdict.category ?? null, sure: verdict.sure ? 1 : 0,
  };
  const result = database
    .prepare(
      `INSERT INTO verdict (channel_id, chat_channel_id, message_time, sender_channel_id, sender_nickname, content, decision, reason, unsafe_probability, category, sure, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.channel_id, row.chat_channel_id, row.message_time, row.sender_channel_id, row.sender_nickname,
      row.content, row.decision, row.reason, row.unsafe_probability, row.category, row.sure, now,
    );
  return toDto({ ...row, id: Number(result.lastInsertRowid) });
}

/** AI 범주 값. 저장된 값이 S1~S7이 아니면(손으로 고친 DB 등) null로 본다. */
const AI_CATEGORIES: ReadonlySet<string> = new Set(["S1", "S2", "S3", "S4", "S5", "S6", "S7"]);

/** 행을 DTO로 바꾼다. 기록 직후 알림과 조회가 모두 이 함수를 거친다. */
function toDto(row: VerdictRow): VerdictDto {
  return {
    id: row.id, chatChannelId: row.chat_channel_id, messageTime: row.message_time, senderChannelId: row.sender_channel_id,
    senderNickname: row.sender_nickname, content: row.content, decision: row.decision, reason: row.reason, status: row.status, createdAt: row.created_at,
    aiProbability: row.unsafe_probability, aiCategory: row.category !== null && AI_CATEGORIES.has(row.category) ? (row.category as AiCategory) : null,
    sure: row.sure === 1,
  };
}
