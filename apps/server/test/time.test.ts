import { describe, expect, it } from "vitest";
import { floorToMinute } from "../src/time.js";

describe("floorToMinute", () => {
  it("분 단위로 내림한다", () => {
    expect(floorToMinute(125_999)).toBe(120_000);
    expect(floorToMinute(120_000)).toBe(120_000);
  });
});
