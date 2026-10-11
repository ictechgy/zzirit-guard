import type { ManagerRole } from "@zzirit-guard/shared";
import type { ChzzkApi, StreamingRole } from "../chzzk/apiClient.js";
import type { CredentialStore } from "../connection/credentialStore.js";
import type { TokenManager } from "../connection/tokenManager.js";
import { describeError, type Logger } from "../logger.js";
import type { Clock } from "../time.js";
import { toManagerRole } from "./permissions.js";

/** 치지직 계정이 이 채널에서 어떤 역할인지 확인한다. */
export interface RoleVerifier {
  roleOf(channelId: string): Promise<ManagerRole | null>;
  invalidate(): void;
}

/** createRoleVerifier 의존성. */
export interface RoleVerifierDeps {
  api: ChzzkApi;
  tokenManager: TokenManager;
  credentialStore: CredentialStore;
  clock: Clock;
  logger: Logger;
  cacheMs?: number;
}

/** 관리자 목록 캐시 기본값(5분, 스펙 7장). */
const DEFAULT_CACHE_MS = 5 * 60 * 1000;

/** 역할 확인기를 만든다. */
export function createRoleVerifier(deps: RoleVerifierDeps): RoleVerifier {
  let cache: { fetchedAt: number; roles: StreamingRole[] } | null = null;
  const cacheMs = deps.cacheMs ?? DEFAULT_CACHE_MS;

  /** 캐시가 신선하면 쓰고, 아니면 스트리머 토큰으로 다시 받는다. 받기에 실패하면 오래된 캐시라도 쓴다. */
  async function loadRoles(): Promise<StreamingRole[]> {
    if (cache && deps.clock() - cache.fetchedAt < cacheMs) return cache.roles;
    try {
      cache = { fetchedAt: deps.clock(), roles: await deps.api.getStreamingRoles(await deps.tokenManager.getAccessToken()) };
      return cache.roles;
    } catch (error) {
      if (!cache) throw new Error(`치지직 관리자 목록을 확인하지 못했습니다(${describeError(error)}). 잠시 뒤 다시 시도하세요.`, { cause: error });
      deps.logger.warn("관리자 목록 갱신 실패, 이전 목록을 씁니다", { error: describeError(error) });
      return cache.roles;
    }
  }

  return {
    async roleOf(channelId) {
      const channel = deps.credentialStore.loadChannel();
      if (!channel) return null;
      if (channel.channelId === channelId) return "STREAMING_CHANNEL_OWNER";
      const match = (await loadRoles()).find((role) => role.managerChannelId === channelId);
      return match ? toManagerRole(match.userRole) : null;
    },
    invalidate: () => {
      cache = null;
    },
  };
}
