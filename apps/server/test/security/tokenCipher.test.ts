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

describe("createTokenCipher 손상 감지", () => {
  it("본문 한 바이트가 바뀐 암호문은 복호화에 실패한다", () => {
    const cipher = createTokenCipher(randomBytes(32));
    const raw = Buffer.from(cipher.encrypt("tamper-me").slice("v1:".length), "base64");
    const lastIndex = raw.length - 1;
    raw.writeUInt8(raw.readUInt8(lastIndex) ^ 0x01, lastIndex);
    const tampered = "v1:" + raw.toString("base64");
    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it("잘린 암호문은 손상 안내 메시지로 알린다", () => {
    const cipher = createTokenCipher(randomBytes(32));
    const truncated = "v1:" + Buffer.alloc(10).toString("base64");
    expect(() => cipher.decrypt(truncated)).toThrow(/손상되었거나 잘렸습니다/);
  });
});
