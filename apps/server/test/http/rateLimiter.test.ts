import { describe, expect, it } from "vitest";
import { createTokenBucket } from "../../src/http/rateLimiter.js";

describe("TokenBucket", () => {
  it("가득 찬 상태로 시작해 크기만큼 받고, 시간이 흐른 만큼만 다시 받는다", () => {
    let now = 0;
    const bucket = createTokenBucket({ capacity: 3, refillPerMs: 1 / 1_000, clock: () => now });
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, true, false]);
    now += 999;
    expect(bucket.tryTake()).toBe(false);
    now += 1;
    expect([bucket.tryTake(), bucket.tryTake()]).toEqual([true, false]);
  });

  it("오래 쉬어도 버킷 크기보다 많이 쌓지 않는다", () => {
    let now = 0;
    const bucket = createTokenBucket({ capacity: 2, refillPerMs: 1 / 1_000, clock: () => now });
    now += 60_000;
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, false]);
  });

  it("시계가 뒤로 가도 토큰을 늘리지 않는다", () => {
    let now = 10_000;
    const bucket = createTokenBucket({ capacity: 1, refillPerMs: 1 / 1_000, clock: () => now });
    expect(bucket.tryTake()).toBe(true);
    now -= 5_000;
    expect(bucket.tryTake()).toBe(false);
  });
});
