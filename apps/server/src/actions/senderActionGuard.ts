import { CANDIDATE_WINDOW_MS } from "../http/constants.js";
import type { Clock } from "../time.js";
import type { ActionOutcome } from "./executor.js";

/** 같은 사람에게 거듭 보내면 안 되는 사람 단위 제재 종류(K2). 해제(unrestrict)는 겹쳐도 해가 없어 넣지 않는다. */
export type SenderActionKind = "temporary_restrict" | "restrict";

/**
 * 제재를 막은 이유. in_flight는 다른 요청이 보내는 중, recently_succeeded는 방금 성공, result_unknown은 앞선 요청의 결과를 알 수 없음.
 * 왜 가르나: 라우트가 이유마다 다른 코드(already_handled·result_unknown)와 안내 문구를 준다.
 */
export type SenderActionBlock = "in_flight" | "recently_succeeded" | "result_unknown";

/**
 * 성공한 제재를 같은 사람에게 다시 보내지 않는 기간(60초, K2).
 * 왜 60초인가: 치지직 임시 제한의 지속 시간이 문서에 없어, 화면이 결과를 모를 때 같은 버튼을 붙잡는 시간(60초)과 맞춘다.
 */
export const RESTRICT_REPEAT_BLOCK_MS = 60_000;

/**
 * 결과를 알 수 없는 제재를 같은 사람에게 다시 보내지 않는 기간. 후보 목록 기간(10분)과 같다(K2).
 * 왜: 후보 카드가 보이는 동안은 매니저가 같은 사람을 다시 제한하려 할 수 있어, 서버가 다시 보내지 않고 치지직에서 확인하라고 안내한다.
 */
export const RESTRICT_UNKNOWN_BLOCK_MS = CANDIDATE_WINDOW_MS;

/**
 * 같은 사람에게 같은 제재가 겹쳐 나가지 않게 막는 메모리 표(K2).
 * 왜 필요한가: 판정 붙잡기(VerdictClaims)는 숨김만 막아, 두 매니저가 함께 누르거나 결과를 모르는 채 다시 누르면 되돌릴 수 없는 제한이 두 번 나간다.
 * 왜 메모리인가: 서버는 프로세스 하나이고 확인과 표시 사이에 await가 없어 동시 요청 중 하나만 통과한다. 서버를 다시 시작하면 표는 비워진다.
 */
export interface SenderActionGuard {
  /**
   * 제재를 보내기 전에 표시한다. 막힌 상태면 표시하지 않고 그 이유를 돌려준다.
   * @param kind 제재 종류
   * @param senderChannelId 대상 사용자 채널 ID
   * @returns 보내도 되면 null, 막혔으면 이유
   */
  tryAcquire(kind: SenderActionKind, senderChannelId: string): SenderActionBlock | null;
  /**
   * 제재가 끝난 뒤 결과에 맞게 표시를 바꾼다: 성공이면 60초, 결과를 알 수 없으면 10분 동안 막고, 그 밖(실패·예외)은 지운다.
   * @param kind 제재 종류
   * @param senderChannelId 대상 사용자 채널 ID
   * @param outcome 실행 결과. 실행기가 예외로 끝나 결과가 없으면 null
   */
  settle(kind: SenderActionKind, senderChannelId: string, outcome: ActionOutcome | null): void;
  /**
   * 끝난 제재의 막기(방금 성공·결과 모름)를 지운다. 보내는 중인 표시는 그대로 둔다(K2b).
   * 왜: 활동 제한 해제가 성공하면 그 사람은 지금 제한되지 않은 것이 확실하므로, 매니저가 60초를 기다리지 않고 바로 다시 제한할 수 있어야 한다.
   * 왜 보내는 중은 두나: 지우면 같은 사람에게 같은 제재가 동시에 두 번 나갈 수 있다. 보내는 중인 제재는 끝날 때 settle이 표시를 다시 정한다.
   * @param kind 제재 종류
   * @param senderChannelId 대상 사용자 채널 ID
   */
  clearSettled(kind: SenderActionKind, senderChannelId: string): void;
}

/** 표의 한 칸. 보내는 중이면 기한이 없고, 끝난 뒤의 막기는 until(ms)까지다. */
type GuardEntry = { state: "in_flight" } | { state: "recently_succeeded" | "result_unknown"; until: number };

/**
 * 빈 막기 표를 만든다. 앱 하나에 하나만 만들어 두 제재 라우트가 함께 쓴다.
 * @param clock 막기 기한을 재는 시계(테스트에서 시간을 움직이려고 주입한다)
 */
export function createSenderActionGuard(clock: Clock): SenderActionGuard {
  const entries = new Map<string, GuardEntry>();
  return {
    tryAcquire(kind, senderChannelId) {
      removeExpired(entries, clock());
      const blocking = entries.get(guardKey(kind, senderChannelId));
      if (blocking) return blocking.state;
      entries.set(guardKey(kind, senderChannelId), { state: "in_flight" });
      return null;
    },
    settle(kind, senderChannelId, outcome) {
      const next = settledEntry(outcome, clock());
      if (next) entries.set(guardKey(kind, senderChannelId), next);
      else entries.delete(guardKey(kind, senderChannelId));
    },
    clearSettled(kind, senderChannelId) {
      const key = guardKey(kind, senderChannelId);
      if (entries.get(key)?.state !== "in_flight") entries.delete(key);
    },
  };
}

/**
 * 끝난 제재의 다음 표시를 정한다. 보내지 않은 것이 확실한 실패·예외는 null(지운다)이라 바로 다시 보낼 수 있다.
 * @param outcome 실행 결과(예외면 null)
 * @param now 지금 시각(ms)
 */
function settledEntry(outcome: ActionOutcome | null, now: number): GuardEntry | null {
  if (outcome?.ok) return { state: "recently_succeeded", until: now + RESTRICT_REPEAT_BLOCK_MS };
  if (outcome && !outcome.ok && outcome.isResultUnknown) return { state: "result_unknown", until: now + RESTRICT_UNKNOWN_BLOCK_MS };
  return null;
}

/**
 * 기한이 지난 칸을 지운다. 왜 매번 훑나: 표에는 최근 10분의 제재만 남아 작고, 타이머 없이도 메모리가 계속 늘지 않는다.
 * @param entries 막기 표
 * @param now 지금 시각(ms)
 */
function removeExpired(entries: Map<string, GuardEntry>, now: number): void {
  for (const [key, entry] of entries) {
    if (entry.state !== "in_flight" && entry.until <= now) entries.delete(key);
  }
}

/**
 * 표의 열쇠. 종류는 닫힌 목록이라 앞에 두면 사용자 ID에 ':'가 있어도 열쇠가 겹치지 않는다.
 * @param kind 제재 종류
 * @param senderChannelId 대상 사용자 채널 ID
 */
function guardKey(kind: SenderActionKind, senderChannelId: string): string {
  return `${kind}:${senderChannelId}`;
}
