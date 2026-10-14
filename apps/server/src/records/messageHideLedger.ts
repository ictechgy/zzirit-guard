import type { MessageTarget } from "../chzzk/apiClient.js";
import type { Database } from "../db/database.js";
import type { Clock } from "../time.js";

/** 메시지 숨김 장부의 상태. hidden은 숨김 성공, result_unknown은 보냈지만 치지직 처리 결과를 알 수 없음. */
export type MessageHideState = "hidden" | "result_unknown";

/**
 * 메시지 단위 숨김 장부(로드맵 2단계 계획 R4). 같은 메시지에 되돌릴 수 없는 숨김이 두 번 나가지 않게, 숨김을 보낸 결과를 메시지마다 남긴다.
 * 왜 판정 상태(verdict.status)로 보지 않나: 판정 상태는 바뀐다(숨긴 뒤 오판·제한으로 바뀌면 숨긴 흔적이 사라진다). 한 메시지에 판정이 여럿일 수도 있다.
 * 왜 결과 모름을 기한 없이 두나: 치지직이 이미 숨겼을 수 있어, 기한이 지나 다시 보내면 숨김이 겹친다. 매니저는 치지직 기본 도구로 확인·처리한다.
 * 왜 보내기 전에 먼저 적나(sending): 보낸 뒤 결과를 적다가 DB가 실패하거나 프로세스가 죽으면 흔적이 없어 같은 숨김이 다시 나간다.
 * 먼저 적어 두면 그 뒤 무엇이 실패해도 남은 sending 행이 '결과 모름'으로 막는다(안전한 쪽으로 실패).
 * 원문은 넣지 않는다(채팅 채널·보낸 사람·보낸 시각만). 같은 메시지의 판정이 모두 지워진 뒤에 지운다(보관 기한 정리).
 */
export interface MessageHideLedger {
  /** 메시지의 숨김 상태. 기록이 없으면 null. 보내기 직전 표시(sending)만 남아 있으면 결과 모름이다(보낸 뒤 결과를 적지 못했다). */
  stateOf(target: MessageTarget): MessageHideState | null;
  /**
   * 숨김을 보내기 직전에 표시한다. 이미 기록이 있으면(막혔어야 할 메시지) 예외를 던진다.
   * 주의: 이 쓰기가 실패하면 숨김을 보내면 안 된다(흔적 없이 보내게 된다). 예외는 부르는 쪽이 받아 보내지 않는다.
   */
  markSending(target: MessageTarget): void;
  /** 숨김 결과를 남긴다. 한 번 hidden이 되면 result_unknown으로 되돌리지 않는다. */
  record(target: MessageTarget, state: MessageHideState): void;
  /** 보내지 않았거나 실패가 확실할 때 보내기 직전 표시만 지운다. 결과가 적힌 행은 건드리지 않는다. */
  releaseSending(target: MessageTarget): void;
}

/** 메시지를 가리키는 WHERE 절. 장부의 기본 키와 같아 색인으로 바로 찾는다. */
const TARGET_WHERE = "chat_channel_id = ? AND sender_channel_id = ? AND message_time = ?";

/**
 * SQLite 숨김 장부를 만든다.
 * @param database 서버 SQLite 연결
 * @param clock 기록 시각
 */
export function createMessageHideLedger(database: Database, clock: Clock): MessageHideLedger {
  const keyOf = (target: MessageTarget) => [target.chatChannelId, target.senderChannelId, target.messageTime] as const;
  return {
    stateOf: (target) => toVisibleState(database.prepare(`SELECT state FROM message_hide WHERE ${TARGET_WHERE}`).get(...keyOf(target)) as { state: string } | undefined),
    markSending: (target) =>
      void database
        .prepare("INSERT INTO message_hide (chat_channel_id, sender_channel_id, message_time, state, updated_at) VALUES (?, ?, ?, 'sending', ?)")
        .run(...keyOf(target), clock()),
    record: (target, state) =>
      void database
        .prepare(
          `INSERT INTO message_hide (chat_channel_id, sender_channel_id, message_time, state, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (chat_channel_id, sender_channel_id, message_time) DO UPDATE SET
             state = CASE WHEN message_hide.state = 'hidden' THEN 'hidden' ELSE excluded.state END, updated_at = excluded.updated_at`,
        )
        .run(...keyOf(target), state, clock()),
    releaseSending: (target) => void database.prepare(`DELETE FROM message_hide WHERE ${TARGET_WHERE} AND state = 'sending'`).run(...keyOf(target)),
  };
}

/**
 * DB의 상태를 밖에 보이는 상태로 바꾼다. sending이 남아 있으면 보낸 뒤 결과를 적지 못한 것이라 결과 모름으로 본다.
 * @param row 장부 행(없으면 undefined)
 */
function toVisibleState(row: { state: string } | undefined): MessageHideState | null {
  if (!row) return null;
  return row.state === "hidden" ? "hidden" : "result_unknown";
}
