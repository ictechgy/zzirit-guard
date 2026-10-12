import { describe, expect, it } from "vitest";
import { createVerdictClaims } from "../../src/actions/verdictClaims.js";

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
