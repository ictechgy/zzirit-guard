import type { MessageTarget } from "../chzzk/apiClient.js";
import type { Database } from "../db/database.js";
import type { Clock } from "../time.js";

/** 메시지 숨김 장부의 상태. hidden은 숨김 성공, result_unknown은 보냈지만 치지직 처리 결과를 알 수 없음. */
export type MessageHideState = "hidden" | "result_unknown";

/**
 * 메시지 단위 숨김 장부(로드맵 2단계 계획 R4). 같은 메시지에 되돌릴 수 없는 숨김이 두 번 나가지 않게, 숨김을 보낸 결과를 메시지마다 남긴다.
 * 왜 판정 상태(verdict.status)로 보지 않나: 판정 상태는 바뀐다(숨긴 뒤 오판·제한으로 바뀌면 숨긴 흔적이 사라진다). 한 메시지에 판정이 여럿일 수도 있다.
 * 왜 결과 모름을 기한 없이 두나: 치지직이 이미 숨겼을 수 있어, 기한이 지나 다시 보내면 숨김이 겹친다. 매니저는 치지직 기본 도구로 확인·처리한다.
 * 원문은 넣지 않는다(채팅 채널·보낸 사람·보낸 시각만). 감사 기록과 같은 기간 뒤에 지운다.
 */
export interface MessageHideLedger {
  /** 메시지의 숨김 상태. 기록이 없으면 null. */
  stateOf(target: MessageTarget): MessageHideState | null;
  /** 숨김 결과를 남긴다. 한 번 hidden이 되면 result_unknown으로 되돌리지 않는다. */
  record(target: MessageTarget, state: MessageHideState): void;
  /** cutoffMs보다 오래된 기록을 지운다(보관 기한 정리). */
  deleteOlderThan(cutoffMs: number): number;
}

/**
 * SQLite 숨김 장부를 만든다.
 * @param database 서버 SQLite 연결
 * @param clock 기록 시각
 */
export function createMessageHideLedger(database: Database, clock: Clock): MessageHideLedger {
  return {
    stateOf: (target) =>
      (
        database
          .prepare("SELECT state FROM message_hide WHERE chat_channel_id = ? AND sender_channel_id = ? AND message_time = ?")
          .get(target.chatChannelId, target.senderChannelId, target.messageTime) as { state: MessageHideState } | undefined
      )?.state ?? null,
    record: (target, state) =>
      void database
        .prepare(
          `INSERT INTO message_hide (chat_channel_id, sender_channel_id, message_time, state, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (chat_channel_id, sender_channel_id, message_time) DO UPDATE SET
             state = CASE WHEN message_hide.state = 'hidden' THEN 'hidden' ELSE excluded.state END, updated_at = excluded.updated_at`,
        )
        .run(target.chatChannelId, target.senderChannelId, target.messageTime, state, clock()),
    deleteOlderThan: (cutoffMs) => database.prepare("DELETE FROM message_hide WHERE updated_at < ?").run(cutoffMs).changes,
  };
}
