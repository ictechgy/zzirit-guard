import type { ActionOutcome } from "./executor.js";

/**
 * 판정을 붙잡은 주체. manager는 매니저 숨기기(라우트), auto_hide는 규칙에 의한 자동 숨김(decisionHandler)이다.
 * unknown은 숨김을 보냈지만 치지직 처리 결과를 알 수 없는 판정이다(K1). 이미 숨겨졌을 수 있어 놓지 않고 붙잡아 둔다.
 * 왜 가르나: 자동 숨김이 진행 중일 때는 매니저에게 "곧 반영된다"는 안내(409 in_progress)를, 다른 매니저와 겹쳤을 때는
 * "이미 처리 중·처리됨"(409 already_handled)을, 결과를 모를 때는 치지직에서 확인하라는 안내(409 result_unknown)를 보여 줘야 한다(N4, K1).
 */
export type ClaimHolder = "manager" | "auto_hide" | "unknown";

/**
 * 지금 숨김을 보내고 있거나, 보냈지만 결과를 알 수 없는 판정 번호 모음(S12, M10, K1).
 * 왜 필요한가: 판정 상태는 치지직 숨김이 성공한 뒤에야 hidden이 된다. 그 사이 두 매니저가 함께 누르거나, 자동 숨김이 대기열에 있는 판정을
 * 매니저가 다시 누르면 되돌릴 수 없는 숨김이 두 번 나간다. 보내기 전에 판정을 붙잡아 한 요청만 실행기로 가게 한다.
 * 왜 DB가 아니라 메모리인가: 상태 칸에 "숨기는 중"을 미리 쓰면 서버가 그사이 죽었을 때 숨기지 않은 판정이 숨김으로 남는다.
 * 서버는 프로세스 하나이고 확인과 붙잡기 사이에 await가 없어, 메모리 Map으로도 동시 요청 중 하나만 통과한다.
 * 주의: 결과를 알 수 없는 붙잡기(unknown)도 메모리에만 있어, 서버를 다시 시작하면 사라지고 그 판정은 다시 숨길 수 있게 된다.
 */
export interface VerdictClaims {
  /**
   * 판정을 붙잡는다.
   * @param verdictId 판정 번호
   * @param holder 붙잡는 주체
   * @returns 붙잡았으면 true, 이미 다른 요청이 붙잡고 있으면 false
   */
  tryClaim(verdictId: number, holder: ClaimHolder): boolean;
  /**
   * 붙잡은 판정을 놓는다. 붙잡지 않은 번호면 아무것도 하지 않는다.
   * @param verdictId 판정 번호
   */
  release(verdictId: number): void;
  /**
   * 붙잡은 판정을 놓지 않고 결과를 알 수 없음(unknown)으로 바꾼다(K1).
   * 왜: 치지직이 이미 숨겼을 수 있어, 놓으면 다른 매니저나 같은 화면이 같은 메시지에 숨김을 다시 보낸다.
   * @param verdictId 판정 번호
   */
  markResultUnknown(verdictId: number): void;
  /**
   * 판정이 붙잡혀 있는지 본다. 숨기는 중에는 무시로 바꾸지 못하게 할 때 쓴다.
   * @param verdictId 판정 번호
   */
  isClaimed(verdictId: number): boolean;
  /**
   * 판정을 붙잡은 주체를 돌려준다. 붙잡혀 있지 않으면 null.
   * @param verdictId 판정 번호
   */
  holderOf(verdictId: number): ClaimHolder | null;
}

/** 빈 붙잡기 모음을 만든다. 앱 하나에 하나만 만들어 라우트와 자동 숨김이 함께 쓴다. */
export function createVerdictClaims(): VerdictClaims {
  const holders = new Map<number, ClaimHolder>();
  return {
    tryClaim(verdictId, holder) {
      if (holders.has(verdictId)) return false;
      holders.set(verdictId, holder);
      return true;
    },
    release: (verdictId) => void holders.delete(verdictId),
    markResultUnknown: (verdictId) => void holders.set(verdictId, "unknown"),
    isClaimed: (verdictId) => holders.has(verdictId),
    holderOf: (verdictId) => holders.get(verdictId) ?? null,
  };
}

/**
 * 숨김이 끝난 뒤 붙잡기를 정리한다. 결과를 알 수 없으면 놓지 않고 unknown으로 바꾸고, 그 밖(성공·실패·취소·예외)은 놓는다(K1).
 * 왜 한 곳에 두나: 매니저 숨기기(라우트)와 자동 숨김(decisionHandler)이 같은 규칙을 따라야, 어느 쪽에서 결과를 몰라도 숨김이 다시 나가지 않는다.
 * @param claims 붙잡기 모음
 * @param verdictId 판정 번호
 * @param outcome 실행 결과. 실행기가 예외로 끝나 결과가 없으면 null(놓는다)
 */
export function settleHideClaim(claims: VerdictClaims, verdictId: number, outcome: ActionOutcome | null): void {
  if (outcome && !outcome.ok && outcome.isResultUnknown) claims.markResultUnknown(verdictId);
  else claims.release(verdictId);
}
