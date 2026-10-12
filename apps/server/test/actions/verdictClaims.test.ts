import { describe, expect, it } from "vitest";
import { createVerdictClaims } from "../../src/actions/verdictClaims.js";

describe("VerdictClaims(S12)", () => {
  it("한 판정은 한 번만 붙잡을 수 있고, 놓으면 다시 붙잡을 수 있다", () => {
    const claims = createVerdictClaims();
    expect(claims.tryClaim(1)).toBe(true);
    expect(claims.tryClaim(1)).toBe(false);
    expect(claims.isClaimed(1)).toBe(true);
    expect(claims.tryClaim(2)).toBe(true);
    claims.release(1);
    expect(claims.isClaimed(1)).toBe(false);
    expect(claims.tryClaim(1)).toBe(true);
  });
});
