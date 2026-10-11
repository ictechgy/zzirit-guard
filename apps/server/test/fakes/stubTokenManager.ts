import type { TokenManager } from "../../src/connection/tokenManager.js";

/** 항상 같은 토큰을 주는 가짜 토큰 관리자. 필요한 메서드만 덮어쓴다. */
export function stubTokenManager(overrides: Partial<TokenManager> = {}): TokenManager {
  return {
    getAccessToken: async () => "owner-token",
    forceRefresh: async () => "owner-token-refreshed",
    isWriteLocked: () => false,
    accessExpiresAt: () => null,
    adoptCredential: () => undefined,
    disconnect: () => undefined,
    onLockChange: () => undefined,
    ...overrides,
  };
}
