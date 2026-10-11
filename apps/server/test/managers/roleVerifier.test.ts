import { describe, expect, it } from "vitest";
import type { ChzzkApi } from "../../src/chzzk/apiClient.js";
import type { CredentialStore } from "../../src/connection/credentialStore.js";
import type { TokenManager } from "../../src/connection/tokenManager.js";
import { silentLogger } from "../../src/logger.js";
import { createRoleVerifier, MAX_STALE_ROLES_MS } from "../../src/managers/roleVerifier.js";

/** 관리자 목록 호출이 실패할 수 있는 검증기를 만든다. */
function setup() {
  const state = { now: 0, failing: false };
  const api = {
    getStreamingRoles: async () => {
      if (state.failing) throw new Error("down");
      return [{ managerChannelId: "m1", managerChannelName: "매니저", userRole: "STREAMING_CHAT_MANAGER" }];
    },
  } as unknown as ChzzkApi;
  const tokenManager = { getAccessToken: async () => "token" } as unknown as TokenManager;
  const credentialStore = { loadChannel: () => ({ channelId: "owner", channelName: "스트리머" }) } as unknown as CredentialStore;
  const verifier = createRoleVerifier({ api, tokenManager, credentialStore, clock: () => state.now, logger: silentLogger, cacheMs: 1000 });
  return { state, verifier };
}

describe("RoleVerifier 오래된 캐시 기한", () => {
  it("갱신 실패 시 30분 이내면 이전 목록을 쓴다", async () => {
    const { state, verifier } = setup();
    await expect(verifier.roleOf("m1")).resolves.toBe("STREAMING_CHAT_MANAGER");
    state.failing = true;
    state.now = MAX_STALE_ROLES_MS;
    await expect(verifier.roleOf("m1")).resolves.toBe("STREAMING_CHAT_MANAGER");
  });

  it("30분을 넘기면 거부하되 소유자는 그대로 통과한다", async () => {
    const { state, verifier } = setup();
    await verifier.roleOf("m1");
    state.failing = true;
    state.now = MAX_STALE_ROLES_MS + 1;
    await expect(verifier.roleOf("m1")).rejects.toThrow(/확인하지 못했습니다/);
    await expect(verifier.roleOf("owner")).resolves.toBe("STREAMING_CHANNEL_OWNER");
  });
});
