/** 현재 시각(ms)을 돌려주는 함수. 테스트에서 시간을 고정하려고 주입한다. */
export type Clock = () => number;

/** 실제 시스템 시계. */
export const systemClock: Clock = () => Date.now();

/** 1분(ms). */
const MINUTE_MS = 60_000;

/**
 * 시각을 분 단위로 내림한다. minute_stat 테이블의 키로 쓴다.
 * @param timestampMs 기준 시각(ms)
 * @returns 그 분의 시작 시각(ms)
 */
export function floorToMinute(timestampMs: number): number {
  return Math.floor(timestampMs / MINUTE_MS) * MINUTE_MS;
}
