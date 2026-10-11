import type { Clock } from "../time.js";

/** 메모리 안의 토큰 버킷. 서버 한 대·채널 한 곳인 MVP라 프로세스 안에서만 센다. */
export interface TokenBucket {
  /**
   * 토큰 하나를 쓴다.
   * @returns 남은 토큰이 있어 요청을 받아도 되면 true, 비어 있으면 false
   */
  tryTake(): boolean;
}

/** createTokenBucket 옵션. */
export interface TokenBucketOptions {
  /** 버킷 크기(한꺼번에 받을 수 있는 최대 요청 수). 처음에는 가득 찬 상태로 시작한다. */
  capacity: number;
  /** ms마다 다시 채워지는 토큰 수. 연속으로 채워 창 경계에서 한도가 두 배로 열리는 일을 막는다. */
  refillPerMs: number;
  /** 현재 시각. 테스트에서 시간을 흘려보내려고 주입한다. */
  clock: Clock;
}

/**
 * 토큰 버킷을 만든다. 시간이 지난 만큼 토큰을 연속으로 채우고, 버킷 크기를 넘지 않게 한다.
 * 왜 새 의존성을 쓰지 않나: 필요한 것은 전역 버킷 하나뿐이라 몇 줄로 충분하고, 공급망을 늘리지 않으려는 것이다.
 * @param options 버킷 크기·채움 속도·시계
 * @returns tryTake로 요청마다 토큰을 쓰는 버킷
 */
export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  let tokens = options.capacity;
  let lastRefillAt = options.clock();
  return {
    tryTake() {
      const now = options.clock();
      // 시계가 뒤로 가면(시스템 시간 조정) 채우지 않고 기준 시각만 옮긴다.
      tokens = Math.min(options.capacity, tokens + Math.max(0, now - lastRefillAt) * options.refillPerMs);
      lastRefillAt = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
