import { describe, expect, it } from "vitest";
import { createVerdictClaims, settleHideClaim } from "../../src/actions/verdictClaims.js";

describe("VerdictClaims(S12)", () => {
  it("한 판정은 한 번만 붙잡을 수 있고, 놓으면 다시 붙잡을 수 있다", () => {
    const claims = createVerdictClaims();
    expect(claims.tryClaim(1, "manager")).toBe(true);
    expect(claims.tryClaim(1, "manager")).toBe(false);
    expect(claims.isClaimed(1)).toBe(true);
    expect(claims.tryClaim(2, "auto_hide")).toBe(true);
    claims.release(1);
    expect(claims.isClaimed(1)).toBe(false);
    expect(claims.tryClaim(1, "manager")).toBe(true);
  });
});

describe("VerdictClaims 붙잡은 주체(N4)", () => {
  it("누가 붙잡았는지 알려 주고, 놓으면 null이다", () => {
    const claims = createVerdictClaims();
    claims.tryClaim(1, "auto_hide");
    claims.tryClaim(2, "manager");
    expect([claims.holderOf(1), claims.holderOf(2), claims.holderOf(3)]).toEqual(["auto_hide", "manager", null]);
    claims.release(1);
    expect(claims.holderOf(1)).toBeNull();
  });
});

describe("VerdictClaims 결과를 알 수 없는 숨김(K1)", () => {
  it("결과를 알 수 없으면 놓지 않고 unknown으로 바꿔, 다시 붙잡지 못하게 한다", () => {
    const claims = createVerdictClaims();
    claims.tryClaim(1, "manager");
    settleHideClaim(claims, 1, { ok: false, message: "결과를 알 수 없음", isResultUnknown: true });
    expect(claims.holderOf(1)).toBe("unknown");
    expect(claims.tryClaim(1, "manager")).toBe(false);
  });

  it("성공·실패·예외(결과 없음)로 끝나면 놓는다", () => {
    const claims = createVerdictClaims();
    [1, 2, 3].forEach((verdictId) => claims.tryClaim(verdictId, "auto_hide"));
    settleHideClaim(claims, 1, { ok: true, note: null });
    settleHideClaim(claims, 2, { ok: false, message: "치지직 서버 오류" });
    settleHideClaim(claims, 3, null);
    expect([1, 2, 3].map((verdictId) => claims.isClaimed(verdictId))).toEqual([false, false, false]);
  });
});
