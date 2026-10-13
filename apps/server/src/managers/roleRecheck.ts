import { describeError, type Logger } from "../logger.js";
import type { RoleVerifier } from "./roleVerifier.js";
import type { SessionStore } from "./sessionStore.js";

/** 해임으로 지운 세션 하나. */
export interface RevokedSession {
  /** 지운 세션 ID(그 WebSocket을 닫는 데 쓴다). */
  sessionId: string;
  /** 그 세션의 매니저 채널 ID(장애 알림 구독을 지우는 데 쓴다). 세션을 지우기 전에 읽어 둔다. */
  managerChannelId: string;
}

/** recheckSessionRoles 의존성. onRevoked는 끊긴 세션의 WebSocket을 닫고 그 매니저의 푸시 구독을 지우는 데 쓴다. */
export interface RoleRecheckDeps {
  sessions: SessionStore;
  roleVerifier: RoleVerifier;
  logger: Logger;
  onRevoked(revoked: RevokedSession[]): void;
  /**
   * 장애 알림 구독을 가진 매니저 채널 ID들(중복 없음, K11).
   * 왜: 세션이 만료된 뒤 해임된 매니저는 활성 세션 목록에 없어, 세션만 보면 구독이 끝없이 남아 장애 알림을 계속 받는다.
   */
  subscriberIds(): string[];
  /** 활성 세션 없이 구독만 남은 매니저 가운데 해임이 확인된 사람들. 그 구독을 지우는 데 쓴다(K11). */
  onRevokedSubscribers(managerChannelIds: string[]): void;
}

/** 세션 재확인 한 차례의 결과. 구독 주인 확인이 이어서 쓴다. */
interface SessionRecheckResult {
  revoked: RevokedSession[];
  /** 역할을 확인한 매니저(해임 포함). 구독 주인 확인에서 다시 묻지 않는다. */
  checkedManagers: Set<string>;
  /** 역할 확인에 실패한 세션이 있었는지. 있으면 이번 차례의 구독 주인 확인을 건너뛴다. */
  hasFailure: boolean;
}

/**
 * 활성 세션의 역할을 다시 확인한다(5분마다). 치지직에서 해임된 매니저는 세션을 지우고,
 * 역할이 바뀌었으면 갱신한다. 치지직 장애로 확인을 못 하면 세션을 유지한다(모두를 끊지 않도록).
 * 이어서 세션 없이 장애 알림 구독만 남은 매니저도 확인해, 해임된 사람의 구독을 지우게 알린다(K11).
 */
export async function recheckSessionRoles(deps: RoleRecheckDeps): Promise<void> {
  const result = await recheckActiveSessions(deps);
  result.revoked.forEach(({ sessionId }) => deps.sessions.deleteById(sessionId));
  if (result.revoked.length > 0) deps.onRevoked(result.revoked);
  await recheckSubscriberRoles(deps, result);
}

/**
 * 활성 세션마다 역할을 확인한다. 실패한 세션은 유지하고 경고만 남긴다.
 * @returns 해임된 세션·확인한 매니저·실패 여부
 */
async function recheckActiveSessions(deps: RoleRecheckDeps): Promise<SessionRecheckResult> {
  const result: SessionRecheckResult = { revoked: [], checkedManagers: new Set(), hasFailure: false };
  for (const session of deps.sessions.listActive()) {
    try {
      const role = await deps.roleVerifier.roleOf(session.managerChannelId);
      result.checkedManagers.add(session.managerChannelId);
      if (!role) result.revoked.push({ sessionId: session.id, managerChannelId: session.managerChannelId });
      else if (role !== session.role) deps.sessions.updateRole(session.id, role);
    } catch (error) {
      result.hasFailure = true;
      deps.logger.warn("역할 재확인 실패, 세션을 유지합니다", { sessionManager: session.managerChannelId, error: describeError(error) });
    }
  }
  return result;
}

/**
 * 세션으로 확인하지 않은 구독 주인의 역할을 확인하고, 해임된 사람을 알린다(K11).
 * 왜 같은 확인기를 쓰나: 확인기는 관리자 목록을 5분 동안 캐시하므로, 같은 차례에 세션 확인이 받은 목록을 그대로 써서 치지직 호출이 늘지 않는다.
 * 세션 확인이 이미 실패한 차례는 건너뛴다: 목록을 못 받는 중이라 같은 실패 호출만 되풀이한다.
 * 확인에 실패하면 구독을 지우지 않는다(장애 중에 매니저의 장애 알림을 끊지 않도록). 경고는 한 번만 남긴다.
 */
async function recheckSubscriberRoles(deps: RoleRecheckDeps, sessionResult: SessionRecheckResult): Promise<void> {
  if (sessionResult.hasFailure) return;
  try {
    const unchecked = deps.subscriberIds().filter((managerChannelId) => !sessionResult.checkedManagers.has(managerChannelId));
    const revoked = await findRevokedManagers(deps.roleVerifier, unchecked);
    if (revoked.length > 0) deps.onRevokedSubscribers(revoked);
  } catch (error) {
    deps.logger.warn("장애 알림 구독 주인의 역할을 확인하지 못해 구독을 그대로 둡니다", { error: describeError(error) });
  }
}

/**
 * 매니저마다 지금 역할을 확인해, 역할이 없는(해임된) 사람만 돌려준다. 하나라도 확인에 실패하면 그대로 던진다.
 * @param roleVerifier 역할 확인기(관리자 목록 캐시를 함께 쓴다)
 * @param managerChannelIds 확인할 매니저 채널 ID들
 */
async function findRevokedManagers(roleVerifier: RoleVerifier, managerChannelIds: readonly string[]): Promise<string[]> {
  const revoked: string[] = [];
  for (const managerChannelId of managerChannelIds) if (!(await roleVerifier.roleOf(managerChannelId))) revoked.push(managerChannelId);
  return revoked;
}
