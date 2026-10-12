/**
 * 판정을 붙잡은 주체. manager는 매니저 숨기기(라우트), auto_hide는 규칙에 의한 자동 숨김(decisionHandler)이다.
 * 왜 가르나: 자동 숨김이 진행 중일 때는 매니저에게 "곧 반영된다"는 안내(409 in_progress)를, 다른 매니저와 겹쳤을 때는
 * "이미 처리 중·처리됨"(409 already_handled)을 보여 줘야 한다(N4).
 */
export type ClaimHolder = "manager" | "auto_hide";

/**
 * 지금 숨김을 보내고 있는 판정 번호 모음(S12, M10).
 * 왜 필요한가: 판정 상태는 치지직 숨김이 성공한 뒤에야 hidden이 된다. 그 사이 두 매니저가 함께 누르거나, 자동 숨김이 대기열에 있는 판정을
 * 매니저가 다시 누르면 되돌릴 수 없는 숨김이 두 번 나간다. 보내기 전에 판정을 붙잡아 한 요청만 실행기로 가게 한다.
 * 왜 DB가 아니라 메모리인가: 상태 칸에 "숨기는 중"을 미리 쓰면 서버가 그사이 죽었을 때 숨기지 않은 판정이 숨김으로 남는다.
 * 서버는 프로세스 하나이고 확인과 붙잡기 사이에 await가 없어, 메모리 Map으로도 동시 요청 중 하나만 통과한다.
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
    isClaimed: (verdictId) => holders.has(verdictId),
    holderOf: (verdictId) => holders.get(verdictId) ?? null,
  };
}
