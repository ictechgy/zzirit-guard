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
}

/**
 * 활성 세션의 역할을 다시 확인한다(5분마다). 치지직에서 해임된 매니저는 세션을 지우고,
 * 역할이 바뀌었으면 갱신한다. 치지직 장애로 확인을 못 하면 세션을 유지한다(모두를 끊지 않도록).
 */
export async function recheckSessionRoles(deps: RoleRecheckDeps): Promise<void> {
  const revoked: RevokedSession[] = [];
  for (const session of deps.sessions.listActive()) {
    try {
      const role = await deps.roleVerifier.roleOf(session.managerChannelId);
      if (!role) revoked.push({ sessionId: session.id, managerChannelId: session.managerChannelId });
      else if (role !== session.role) deps.sessions.updateRole(session.id, role);
    } catch (error) {
      deps.logger.warn("역할 재확인 실패, 세션을 유지합니다", { sessionManager: session.managerChannelId, error: describeError(error) });
    }
  }
  revoked.forEach(({ sessionId }) => deps.sessions.deleteById(sessionId));
  if (revoked.length > 0) deps.onRevoked(revoked);
}
