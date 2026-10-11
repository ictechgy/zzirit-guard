import { describe, expect, it } from "vitest";
import { loadEncryptionKey, type CommandRunner } from "../../src/security/keychain.js";

/** 정해진 결과를 돌려주는 가짜 security 명령. 받은 인자를 기록한다. */
function fakeRunner(result: { stdout?: string; stderr?: string; exitCode: number }, calls: string[][] = []): CommandRunner {
  return async (command, args) => {
    calls.push([command, ...args]);
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode };
  };
}

describe("loadEncryptionKey", () => {
  it("키체인의 16진수 키를 32바이트로 읽는다", async () => {
    const calls: string[][] = [];
    const key = await loadEncryptionKey("zzirit-guard", fakeRunner({ stdout: `${"ab".repeat(32)}\n`, exitCode: 0 }, calls));
    expect(key.length).toBe(32);
    expect(calls[0]).toEqual(["/usr/bin/security", "find-generic-password", "-s", "zzirit-guard", "-a", "token-encryption-key", "-w"]);
  });

  it("항목이 없으면 설정 스크립트를 안내한다", async () => {
    await expect(loadEncryptionKey("zzirit-guard", fakeRunner({ exitCode: 44 }))).rejects.toThrow(/setup-keychain\.sh/);
  });

  it("다른 실패는 원인과 함께 알린다", async () => {
    await expect(loadEncryptionKey("zzirit-guard", fakeRunner({ exitCode: 51, stderr: "locked" }))).rejects.toThrow(/locked.*잠겨/);
  });

  it("형식이 잘못된 키를 거부한다", async () => {
    await expect(loadEncryptionKey("zzirit-guard", fakeRunner({ stdout: "not-hex", exitCode: 0 }))).rejects.toThrow(/64자리/);
  });
});
