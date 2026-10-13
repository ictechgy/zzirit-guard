import { describe, expect, it } from "vitest";
import { createSenderActionGuard, RESTRICT_REPEAT_BLOCK_MS, RESTRICT_UNKNOWN_BLOCK_MS } from "../../src/actions/senderActionGuard.js";

/** 결과를 알 수 없는 실행 결과. */
const UNKNOWN_OUTCOME = { ok: false as const, message: "치지직 응답을 받지 못해 처리 결과를 알 수 없습니다.", isResultUnknown: true as const };

describe("SenderActionGuard(K2)", () => {
  it("보내는 중이면 같은 종류·같은 사람은 막고, 다른 종류나 다른 사람은 받는다", () => {
    const guard = createSenderActionGuard(() => 0);
    expect(guard.tryAcquire("temporary_restrict", "bad")).toBeNull();
    expect(guard.tryAcquire("temporary_restrict", "bad")).toBe("in_flight");
    expect(guard.tryAcquire("restrict", "bad")).toBeNull();
    expect(guard.tryAcquire("temporary_restrict", "other")).toBeNull();
  });

  it("성공하면 60초 동안 막고, 60초가 지나면 다시 받는다", () => {
    let now = 1_000;
    const guard = createSenderActionGuard(() => now);
    guard.tryAcquire("restrict", "bad");
    guard.settle("restrict", "bad", { ok: true, note: null });
    now += RESTRICT_REPEAT_BLOCK_MS - 1;
    expect(guard.tryAcquire("restrict", "bad")).toBe("recently_succeeded");
    now += 1;
    expect(guard.tryAcquire("restrict", "bad")).toBeNull();
  });

  it("결과를 알 수 없으면 후보 목록 기간(10분) 동안 막는다", () => {
    let now = 1_000;
    const guard = createSenderActionGuard(() => now);
    guard.tryAcquire("temporary_restrict", "bad");
    guard.settle("temporary_restrict", "bad", UNKNOWN_OUTCOME);
    expect(RESTRICT_UNKNOWN_BLOCK_MS).toBe(10 * 60 * 1000);
    now += RESTRICT_UNKNOWN_BLOCK_MS - 1;
    expect(guard.tryAcquire("temporary_restrict", "bad")).toBe("result_unknown");
    now += 1;
    expect(guard.tryAcquire("temporary_restrict", "bad")).toBeNull();
  });

  it("실패했거나 예외로 끝나(결과 없음) 보내지 않은 것이 확실하면 바로 다시 받는다", () => {
    const guard = createSenderActionGuard(() => 0);
    guard.tryAcquire("restrict", "a");
    guard.settle("restrict", "a", { ok: false, message: "치지직이 요청을 거부했습니다" });
    guard.tryAcquire("restrict", "b");
    guard.settle("restrict", "b", null);
    expect([guard.tryAcquire("restrict", "a"), guard.tryAcquire("restrict", "b")]).toEqual([null, null]);
  });
});
