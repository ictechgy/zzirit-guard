import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ChzzkApiError, type TokenSet } from "../../src/chzzk/apiClient.js";
import { createCredentialStore, type CredentialStore } from "../../src/connection/credentialStore.js";
import { createTokenManager, WriteLockedError } from "../../src/connection/tokenManager.js";
import { openDatabase } from "../../src/db/database.js";
import { createTokenCipher } from "../../src/security/tokenCipher.js";
import { createFakeApi } from "../fakes/fakeApi.js";

/** 2시간(ms). 선제 갱신 기준. */
const TWO_HOURS = 2 * 60 * 60 * 1000;
/** 테스트 기준 시각. */
const NOW = 10_000_000;

/** 만료까지 남은 시간을 정해 연결된 저장소를 만든다. */
function connectedStore(expiresInMs: number): CredentialStore {
  const store = createCredentialStore(openDatabase(":memory:"), createTokenCipher(randomBytes(32)), () => NOW);
  store.saveConnection(
    { channelId: "owner-channel", channelName: "스트리머" },
    { channelId: "owner-channel", accessToken: "old-access", refreshToken: "old-refresh", accessExpiresAt: NOW + expiresInMs },
  );
  return store;
}

/** 새 토큰 쌍. */
const freshTokens: TokenSet = { accessToken: "new-access", refreshToken: "new-refresh", expiresInSeconds: 86_400 };

describe("TokenManager", () => {
  it("만료가 멀면 갱신하지 않는다", async () => {
    const refreshToken = vi.fn();
    const manager = createTokenManager({ store: connectedStore(TWO_HOURS * 3), api: createFakeApi({ refreshToken }), clock: () => NOW });
    expect(await manager.getAccessToken()).toBe("old-access");
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("만료 2시간 전이면 갱신하고, 저장한 새 토큰을 쓴다", async () => {
    const store = connectedStore(TWO_HOURS - 1);
    const manager = createTokenManager({ store, api: createFakeApi({ refreshToken: async () => freshTokens }), clock: () => NOW });
    expect(await manager.getAccessToken()).toBe("new-access");
    expect(store.loadCredential()).toMatchObject({ refreshToken: "new-refresh", accessExpiresAt: NOW + 86_400_000 });
  });

  it("동시에 불러도 갱신은 한 번만 한다(refresh token은 일회용)", async () => {
    const refreshToken = vi.fn(async () => freshTokens);
    const manager = createTokenManager({ store: connectedStore(0), api: createFakeApi({ refreshToken }), clock: () => NOW });
    const tokens = await Promise.all([manager.getAccessToken(), manager.getAccessToken(), manager.getAccessToken()]);
    expect(tokens).toEqual(["new-access", "new-access", "new-access"]);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it("갱신이 401이면 쓰기를 잠그고 알린다", async () => {
    const listener = vi.fn();
    const api = createFakeApi({ refreshToken: async () => { throw new ChzzkApiError(401, "INVALID_TOKEN", "/auth/v1/token"); } });
    const manager = createTokenManager({ store: connectedStore(0), api, clock: () => NOW });
    manager.onLockChange(listener);
    await expect(manager.getAccessToken()).rejects.toBeInstanceOf(WriteLockedError);
    expect(manager.isWriteLocked()).toBe(true);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it("새 토큰 저장에 실패하면 쓰기를 잠근다(옛 refresh token은 이미 무효)", async () => {
    const store = connectedStore(0);
    store.saveCredential = () => { throw new Error("disk full"); };
    const manager = createTokenManager({ store, api: createFakeApi({ refreshToken: async () => freshTokens }), clock: () => NOW });
    await expect(manager.getAccessToken()).rejects.toThrow(/저장하지 못해.*disk full/);
    expect(manager.isWriteLocked()).toBe(true);
  });

  it("네트워크 오류여도 아직 유효한 토큰은 계속 쓰고 오류를 기록한다", async () => {
    const reportError = vi.fn();
    const error = new TypeError("fetch failed");
    const api = createFakeApi({ refreshToken: async () => { throw error; } });
    const manager = createTokenManager({ store: connectedStore(TWO_HOURS - 1), api, clock: () => NOW, reportError });
    expect(await manager.getAccessToken()).toBe("old-access");
    expect(manager.isWriteLocked()).toBe(false);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(String), error);
  });

  it("갱신이 502 등 일시 오류면 유효한 옛 토큰을 쓰고 오류를 기록한다", async () => {
    const reportError = vi.fn();
    const error = new ChzzkApiError(502, "UNEXPECTED_RESPONSE", "/auth/v1/token");
    const api = createFakeApi({ refreshToken: async () => { throw error; } });
    const manager = createTokenManager({ store: connectedStore(TWO_HOURS - 1), api, clock: () => NOW, reportError });
    expect(await manager.getAccessToken()).toBe("old-access");
    expect(manager.isWriteLocked()).toBe(false);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(String), error);
  });

  it("만료된 토큰에서 일시 오류가 나면 옛 토큰 대신 그 오류를 던진다", async () => {
    const reportError = vi.fn();
    const error = new ChzzkApiError(502, "UNEXPECTED_RESPONSE", "/auth/v1/token");
    const api = createFakeApi({ refreshToken: async () => { throw error; } });
    const manager = createTokenManager({ store: connectedStore(-1), api, clock: () => NOW, reportError });
    await expect(manager.getAccessToken()).rejects.toBe(error);
    expect(manager.isWriteLocked()).toBe(false);
  });

  it("갱신 중 강제 갱신을 부르면 진행 중인 갱신에 합류한다", async () => {
    let release!: (tokens: TokenSet) => void;
    const refreshToken = vi.fn(() => new Promise<TokenSet>((resolve) => { release = resolve; }));
    const manager = createTokenManager({ store: connectedStore(0), api: createFakeApi({ refreshToken }), clock: () => NOW });
    const first = manager.getAccessToken();
    const forced = manager.forceRefresh();
    release(freshTokens);
    expect(await Promise.all([first, forced])).toEqual(["new-access", "new-access"]);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it("연결 해제는 토큰을 지우고 잠그며, 이후 요청은 WriteLockedError를 받는다", async () => {
    const store = connectedStore(TWO_HOURS * 3);
    const manager = createTokenManager({ store, api: createFakeApi({}), clock: () => NOW });
    manager.disconnect();
    expect(manager.isWriteLocked()).toBe(true);
    expect(store.loadCredential()).toBeNull();
    await expect(manager.getAccessToken()).rejects.toBeInstanceOf(WriteLockedError);
  });

  it("잠긴 뒤에는 갱신을 다시 부르지 않고 WriteLockedError를 던진다", async () => {
    const refreshToken = vi.fn(async (): Promise<TokenSet> => { throw new ChzzkApiError(401, "INVALID_TOKEN", "/auth/v1/token"); });
    const manager = createTokenManager({ store: connectedStore(0), api: createFakeApi({ refreshToken }), clock: () => NOW });
    await manager.getAccessToken().catch(() => undefined);
    await expect(manager.getAccessToken()).rejects.toBeInstanceOf(WriteLockedError);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it("잠금 리스너가 던져도 WriteLockedError와 다음 리스너 호출은 유지된다", async () => {
    const reportError = vi.fn();
    const next = vi.fn();
    const api = createFakeApi({ refreshToken: async () => { throw new ChzzkApiError(401, "INVALID_TOKEN", "/auth/v1/token"); } });
    const manager = createTokenManager({ store: connectedStore(0), api, clock: () => NOW, reportError });
    manager.onLockChange(() => { throw new Error("listener boom"); });
    manager.onLockChange(next);
    await expect(manager.getAccessToken()).rejects.toBeInstanceOf(WriteLockedError);
    expect(next).toHaveBeenCalledWith(true);
    expect(reportError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "listener boom" }));
  });

  it("새 연결을 받으면 잠금을 푼다", async () => {
    const api = createFakeApi({ refreshToken: async () => { throw new ChzzkApiError(401, "INVALID_TOKEN", "/auth/v1/token"); } });
    const store = connectedStore(0);
    const manager = createTokenManager({ store, api, clock: () => NOW });
    await manager.getAccessToken().catch(() => undefined);
    manager.adoptCredential(
      { channelId: "owner-channel", channelName: "스트리머" },
      { channelId: "owner-channel", accessToken: "relinked", refreshToken: "r2", accessExpiresAt: NOW + TWO_HOURS * 10 },
    );
    expect(manager.isWriteLocked()).toBe(false);
    expect(await manager.getAccessToken()).toBe("relinked");
  });

  it("연결이 없으면 원인을 알려 준다", async () => {
    const store = createCredentialStore(openDatabase(":memory:"), createTokenCipher(randomBytes(32)), () => NOW);
    const manager = createTokenManager({ store, api: createFakeApi({}), clock: () => NOW });
    await expect(manager.getAccessToken()).rejects.toThrow(/스트리머가 먼저 연결/);
  });
});

describe("TokenManager 연결 세대(S7, M06): 진행 중 갱신은 adoptCredential·disconnect 뒤의 상태를 바꾸지 않는다", () => {
  /** 다시 연결해 받은 새 토큰. */
  const adopted = { channelId: "owner-channel", accessToken: "adopted-access", refreshToken: "adopted-refresh", accessExpiresAt: NOW + TWO_HOURS * 10 };
  /** 다시 연결한 채널. */
  const channel = { channelId: "owner-channel", channelName: "스트리머" };

  /** 결과를 테스트가 정하는 갱신 API. */
  function controlledRefresh() {
    const pending: Array<{ resolve(tokens: TokenSet): void; reject(error: unknown): void }> = [];
    const refreshToken = vi.fn((_refreshToken: string) => new Promise<TokenSet>((resolve, reject) => void pending.push({ resolve, reject })));
    return { refreshToken, pending };
  }

  it("다시 연결한 뒤 늦게 온 갱신 성공은 새 토큰을 덮어쓰지 않는다", async () => {
    const { refreshToken, pending } = controlledRefresh();
    const store = connectedStore(0);
    const manager = createTokenManager({ store, api: createFakeApi({ refreshToken }), clock: () => NOW });
    const stale = manager.getAccessToken();
    manager.adoptCredential(channel, adopted);
    pending[0]?.resolve(freshTokens);
    await expect(stale).rejects.toBeInstanceOf(WriteLockedError);
    expect(store.loadCredential()).toMatchObject({ accessToken: "adopted-access", refreshToken: "adopted-refresh" });
    expect(await manager.getAccessToken()).toBe("adopted-access");
  });

  it("다시 연결한 뒤 늦게 온 갱신 401은 새 연결을 잠그지 않는다", async () => {
    const { refreshToken, pending } = controlledRefresh();
    const listener = vi.fn();
    const manager = createTokenManager({ store: connectedStore(0), api: createFakeApi({ refreshToken }), clock: () => NOW });
    manager.onLockChange(listener);
    const stale = manager.getAccessToken();
    manager.adoptCredential(channel, adopted);
    pending[0]?.reject(new ChzzkApiError(401, "INVALID_TOKEN", "/auth/v1/token"));
    await expect(stale).rejects.toBeInstanceOf(WriteLockedError);
    expect(manager.isWriteLocked()).toBe(false);
    expect(listener).not.toHaveBeenCalledWith(true);
  });

  it("연결을 해제한 뒤 늦게 온 갱신 성공은 저장하지 않고, 일시 오류여도 옛 토큰을 내주지 않는다", async () => {
    const { refreshToken, pending } = controlledRefresh();
    const store = connectedStore(TWO_HOURS - 1);
    const manager = createTokenManager({ store, api: createFakeApi({ refreshToken }), clock: () => NOW, reportError: () => undefined });
    const succeeded = manager.getAccessToken();
    manager.disconnect();
    pending[0]?.resolve(freshTokens);
    await expect(succeeded).rejects.toBeInstanceOf(WriteLockedError);
    expect(store.loadCredential()).toBeNull();

    const relinked = connectedStore(TWO_HOURS - 1);
    const second = createTokenManager({ store: relinked, api: createFakeApi({ refreshToken }), clock: () => NOW, reportError: () => undefined });
    const failed = second.getAccessToken();
    second.disconnect();
    pending[1]?.reject(new TypeError("fetch failed"));
    await expect(failed).rejects.toBeInstanceOf(WriteLockedError);
  });

  it("다시 연결한 뒤의 갱신은 옛 연결의 진행 중 갱신에 합류하지 않고 새 refresh token으로 갱신한다", async () => {
    const { refreshToken, pending } = controlledRefresh();
    const manager = createTokenManager({ store: connectedStore(0), api: createFakeApi({ refreshToken }), clock: () => NOW });
    const stale = manager.getAccessToken().catch(() => "stale");
    manager.adoptCredential(channel, { ...adopted, accessExpiresAt: NOW });
    const current = manager.getAccessToken();
    expect(refreshToken.mock.calls.map(([token]) => token)).toEqual(["old-refresh", "adopted-refresh"]);
    pending[1]?.resolve(freshTokens);
    pending[0]?.resolve({ ...freshTokens, accessToken: "late-access" });
    expect(await current).toBe("new-access");
    expect(await stale).toBe("stale");
  });
});
