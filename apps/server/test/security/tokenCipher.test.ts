import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTokenCipher } from "../../src/security/tokenCipher.js";

describe("createTokenCipher", () => {
  it("암호화한 값을 되돌린다", () => {
    const cipher = createTokenCipher(randomBytes(32));
    const encrypted = cipher.encrypt("access-token-값");
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(encrypted).not.toContain("access-token");
    expect(cipher.decrypt(encrypted)).toBe("access-token-값");
  });

  it("같은 값도 매번 다르게 암호화한다", () => {
    const cipher = createTokenCipher(randomBytes(32));
    expect(cipher.encrypt("same")).not.toBe(cipher.encrypt("same"));
  });

  it("다른 키로는 풀 수 없다", () => {
    const encrypted = createTokenCipher(randomBytes(32)).encrypt("secret");
    expect(() => createTokenCipher(randomBytes(32)).decrypt(encrypted)).toThrow();
  });

  it("32바이트가 아닌 키를 거부한다", () => {
    expect(() => createTokenCipher(randomBytes(16))).toThrow(/32바이트/);
  });
});
