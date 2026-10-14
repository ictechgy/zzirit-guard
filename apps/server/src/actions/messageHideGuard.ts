import type { MessageTarget } from "../chzzk/apiClient.js";
import { CANDIDATE_WINDOW_MS } from "../http/constants.js";
import type { Clock } from "../time.js";
import type { ActionOutcome } from "./executor.js";

/**
 * 숨김을 막은 이유. in_flight는 같은 메시지에 숨김을 보내는 중, hidden은 이미 숨김, result_unknown은 앞선 숨김의 결과를 알 수 없음.
 * 왜 가르나: 매니저 라우트가 이유마다 다른 코드(already_handled·result_unknown)와 안내를 준다.
 */
export type MessageHideBlock = "in_flight" | "hidden" | "result_unknown";

/**
 * 성공한 숨김을 같은 메시지에 다시 보내지 않게 기억하는 기간. 후보 목록 기간(10분)의 세 배로 넉넉히 둔다.
 * 그 뒤에는 DB의 hidden 판정(isHiddenInDatabase)이 막는다.
 */
export const HIDDEN_MEMORY_MS = 3 * CANDIDATE_WINDOW_MS;

/** 결과를 알 수 없는 숨김을 같은 메시지에 다시 보내지 않는 기간. 후보 목록 기간(10분)과 같다. */
export const HIDE_UNKNOWN_BLOCK_MS = CANDIDATE_WINDOW_MS;

/**
 * 같은 메시지에 숨김이 두 번 나가지 않게 막는 메모리 표(로드맵 2단계 계획 R4).
 * 왜 판정 붙잡기(VerdictClaims)만으로 부족한가: 같은 메시지에 판정이 여러 개 생길 수 있다(AI 후보와 떼도배 소급 숨김).
 * 판정마다 붙잡으면 'AI 후보를 매니저가 숨김 → 그 뒤 떼도배 발동'처럼 같은 메시지에 되돌릴 수 없는 숨김이 두 번 나간다.
 * 그래서 매니저 숨김·규칙 자동 숨김·떼도배 소급 숨김이 모두 실행기에 넘기기 전에 이 표를 거친다.
 * 왜 메모리인가: 서버는 프로세스 하나이고 확인과 표시 사이에 await가 없어 동시 요청 중 하나만 통과한다. 재시작 뒤에는 DB의 hidden 판정이 막는다.
 */
export interface MessageHideGuard {
  /**
   * 숨김을 보내기 전에 표시한다. 막힌 상태면 표시하지 않고 그 이유를 돌려준다.
   * @param target 숨길 메시지
   * @returns 보내도 되면 null, 막혔으면 이유
   */
  tryAcquire(target: MessageTarget): MessageHideBlock | null;
  /**
   * 막힐지만 본다(표시하지 않는다). 떼도배 소급 숨김이 폭주 한도를 쓰기 전에 거를 때 쓴다.
   * @param target 숨길 메시지
   */
  blockOf(target: MessageTarget): MessageHideBlock | null;
  /**
   * 숨김이 끝난 뒤 결과에 맞게 표시를 바꾼다: 성공이면 hidden, 결과를 알 수 없으면 result_unknown, 그 밖(실패·취소·예외)은 지운다.
   * @param target 숨긴 메시지
   * @param outcome 실행 결과. 실행기가 예외로 끝나 결과가 없으면 null
   */
  settle(target: MessageTarget, outcome: ActionOutcome | null): void;
}

/** 표의 한 칸. 보내는 중이면 기한이 없고, 끝난 뒤의 막기는 until(ms)까지다. */
type GuardEntry = { state: "in_flight" } | { state: "hidden" | "result_unknown"; until: number };

/**
 * 빈 막기 표를 만든다. 앱 하나에 하나만 만들어 매니저 라우트와 자동 숨김이 함께 쓴다.
 * @param clock 막기 기한을 재는 시계
 * @param isHiddenInDatabase 같은 메시지에 숨김이 끝난 판정이 DB에 있는지(재시작 뒤에도 막기 위해서다)
 */
export function createMessageHideGuard(clock: Clock, isHiddenInDatabase: (target: MessageTarget) => boolean): MessageHideGuard {
  const entries = new Map<string, GuardEntry>();
  const blockOf = (target: MessageTarget): MessageHideBlock | null => {
    removeExpired(entries, clock());
    return entries.get(targetKey(target))?.state ?? (isHiddenInDatabase(target) ? "hidden" : null);
  };
  return {
    blockOf,
    tryAcquire(target) {
      const blocking = blockOf(target);
      if (blocking) return blocking;
      entries.set(targetKey(target), { state: "in_flight" });
      return null;
    },
    settle(target, outcome) {
      const next = settledEntry(outcome, clock());
      if (next) entries.set(targetKey(target), next);
      else entries.delete(targetKey(target));
    },
  };
}

/**
 * 끝난 숨김의 다음 표시를 정한다. 보내지 않은 것이 확실한 실패·취소·예외는 null(지운다)이라 다시 숨길 수 있다.
 * @param outcome 실행 결과(예외면 null)
 * @param now 지금 시각(ms)
 */
function settledEntry(outcome: ActionOutcome | null, now: number): GuardEntry | null {
  if (outcome?.ok) return { state: "hidden", until: now + HIDDEN_MEMORY_MS };
  if (outcome && !outcome.ok && outcome.isResultUnknown) return { state: "result_unknown", until: now + HIDE_UNKNOWN_BLOCK_MS };
  return null;
}

/**
 * 기한이 지난 칸을 지운다. 표에는 최근 30분의 숨김만 남아 작고, 타이머 없이도 메모리가 계속 늘지 않는다.
 * @param entries 막기 표
 * @param now 지금 시각(ms)
 */
function removeExpired(entries: Map<string, GuardEntry>, now: number): void {
  for (const [key, entry] of entries) {
    if (entry.state !== "in_flight" && entry.until <= now) entries.delete(key);
  }
}

/**
 * 표의 열쇠: 채팅 채널·보낸 사람·보낸 시각. 숨김 API가 메시지를 가리키는 값과 같다.
 * JSON 배열로 만들어 값에 구분자가 들어 있어도 열쇠가 겹치지 않게 한다.
 * @param target 메시지
 */
function targetKey(target: MessageTarget): string {
  return JSON.stringify([target.chatChannelId, target.senderChannelId, target.messageTime]);
}
