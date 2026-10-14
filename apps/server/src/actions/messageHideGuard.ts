import type { MessageTarget } from "../chzzk/apiClient.js";
import type { MessageHideLedger } from "../records/messageHideLedger.js";
import type { ActionOutcome } from "./executor.js";

/**
 * 숨김을 막은 이유. in_flight는 같은 메시지에 숨김을 보내는 중, hidden은 이미 숨김, result_unknown은 앞선 숨김의 결과를 알 수 없음.
 * 왜 가르나: 매니저 라우트가 이유마다 다른 코드(already_handled·result_unknown)와 안내를 준다.
 */
export type MessageHideBlock = "in_flight" | "hidden" | "result_unknown";

/**
 * 같은 메시지에 숨김이 두 번 나가지 않게 막는 장치(로드맵 2단계 계획 R4).
 * 왜 판정 붙잡기(VerdictClaims)만으로 부족한가: 같은 메시지에 판정이 여러 개 생길 수 있다(AI 후보와 떼도배 소급 숨김).
 * 판정마다 붙잡으면 'AI 후보를 매니저가 숨김 → 그 뒤 떼도배 발동'처럼 같은 메시지에 되돌릴 수 없는 숨김이 두 번 나간다.
 * 그래서 매니저 숨김·규칙 자동 숨김·떼도배 소급 숨김이 모두 실행기에 넘기기 전에 이 장치를 거친다.
 * - 보내는 중(in_flight)은 메모리에 둔다. 서버는 프로세스 하나이고 확인과 표시 사이에 await가 없어 동시 요청 중 하나만 통과한다.
 * - 끝난 결과(hidden·result_unknown)는 숨김 장부(DB)에 남겨, 재시작 뒤에도 막고 기한 없이 막는다.
 */
export interface MessageHideGuard {
  /**
   * 숨김을 보내기 전에 표시한다. 막힌 상태면 표시하지 않고 그 이유를 돌려준다.
   * @param target 숨길 메시지
   * @returns 보내도 되면 null, 막혔으면 이유
   */
  tryAcquire(target: MessageTarget): MessageHideBlock | null;
  /**
   * 막힐지만 본다(표시하지 않는다). 자동 숨김이 폭주 한도를 쓰기 전에 거를 때 쓴다.
   * @param target 숨길 메시지
   */
  blockOf(target: MessageTarget): MessageHideBlock | null;
  /**
   * 숨김이 끝난 뒤(또는 보내지 않기로 한 뒤) 표시를 정리한다: 성공이면 장부에 hidden, 결과를 알 수 없으면 result_unknown,
   * 그 밖(실패·취소·예외·보내지 않음)은 보내는 중 표시만 지운다.
   * @param target 숨긴 메시지
   * @param outcome 실행 결과. 보내지 않았거나 실행기가 예외로 끝났으면 null
   */
  settle(target: MessageTarget, outcome: ActionOutcome | null): void;
}

/**
 * 막기 장치를 만든다. 앱 하나에 하나만 만들어 매니저 라우트와 자동 숨김이 함께 쓴다.
 * @param ledger 숨김 장부(끝난 결과를 영구히 남긴다)
 */
export function createMessageHideGuard(ledger: MessageHideLedger): MessageHideGuard {
  const inFlight = new Set<string>();
  const blockOf = (target: MessageTarget): MessageHideBlock | null => (inFlight.has(targetKey(target)) ? "in_flight" : ledger.stateOf(target));
  return {
    blockOf,
    tryAcquire(target) {
      const blocking = blockOf(target);
      if (blocking) return blocking;
      inFlight.add(targetKey(target));
      return null;
    },
    settle(target, outcome) {
      inFlight.delete(targetKey(target));
      if (outcome?.ok) ledger.record(target, "hidden");
      else if (outcome && !outcome.ok && outcome.isResultUnknown) ledger.record(target, "result_unknown");
    },
  };
}

/**
 * 메모리 표의 열쇠: 채팅 채널·보낸 사람·보낸 시각. 숨김 API가 메시지를 가리키는 값과 같다.
 * JSON 배열로 만들어 값에 구분자가 들어 있어도 열쇠가 겹치지 않게 한다.
 * @param target 메시지
 */
function targetKey(target: MessageTarget): string {
  return JSON.stringify([target.chatChannelId, target.senderChannelId, target.messageTime]);
}
