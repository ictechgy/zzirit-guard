/**
 * 지금 숨김을 보내고 있는 판정 번호 모음(S12, M10).
 * 왜 필요한가: 판정 상태는 치지직 숨김이 성공한 뒤에야 hidden이 된다. 그 사이 두 매니저가 함께 누르거나, 자동 숨김이 대기열에 있는 판정을
 * 매니저가 다시 누르면 되돌릴 수 없는 숨김이 두 번 나간다. 보내기 전에 판정을 붙잡아 한 요청만 실행기로 가게 한다.
 * 왜 DB가 아니라 메모리인가: 상태 칸에 "숨기는 중"을 미리 쓰면 서버가 그사이 죽었을 때 숨기지 않은 판정이 숨김으로 남는다.
 * 서버는 프로세스 하나이고 확인과 붙잡기 사이에 await가 없어, 메모리 Set으로도 동시 요청 중 하나만 통과한다.
 */
export interface VerdictClaims {
  /**
   * 판정을 붙잡는다.
   * @param verdictId 판정 번호
   * @returns 붙잡았으면 true, 이미 다른 요청이 붙잡고 있으면 false
   */
  tryClaim(verdictId: number): boolean;
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
}

/** 빈 붙잡기 모음을 만든다. 앱 하나에 하나만 만들어 라우트와 자동 숨김이 함께 쓴다. */
export function createVerdictClaims(): VerdictClaims {
  const claimedIds = new Set<number>();
  return {
    tryClaim(verdictId) {
      if (claimedIds.has(verdictId)) return false;
      claimedIds.add(verdictId);
      return true;
    },
    release: (verdictId) => void claimedIds.delete(verdictId),
    isClaimed: (verdictId) => claimedIds.has(verdictId),
  };
}
