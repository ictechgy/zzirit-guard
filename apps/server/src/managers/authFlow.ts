import { randomBytes } from "node:crypto";
import type { ChzzkApi, ChzzkUser, TokenSet } from "../chzzk/apiClient.js";
import type { AppConfig } from "../config.js";
import type { CredentialStore } from "../connection/credentialStore.js";
import type { TokenManager } from "../connection/tokenManager.js";
import type { RuleRepository } from "../detection/ruleRepository.js";
import type { Clock } from "../time.js";
import type { RoleVerifier } from "./roleVerifier.js";
import type { ManagerSession, SessionStore } from "./sessionStore.js";

/** 로그인·연결 실패. 메시지를 로그인 화면에 그대로 보여 준다. */
export class AuthError extends Error {
  override readonly name = "AuthError";
}

/** connect: 스트리머 채널 연결, login: 매니저(또는 스트리머) 로그인. */
export type AuthPurpose = "connect" | "login";

/** 치지직 앱 설정의 "로그인 리디렉션 URL"에 publicOrigin + 이 경로를 등록해야 한다. */
export const CALLBACK_PATH = "/auth/callback";

/** OAuth state 유효 기간(10분). */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * 메모리에 둘 수 있는 대기 중 OAuth state의 최대 개수.
 * /auth/login과 /auth/connect는 인증 없이 열려 있고 호출 횟수 제한도 없어서, 상한이 없으면
 * 10분 TTL 안에 반복 호출만으로 메모리가 끝없이 늘 수 있다. 넘으면 가장 오래된 state부터 버린다.
 */
export const MAX_PENDING_STATES = 1000;

/** createAuthFlow 의존성. */
export interface AuthFlowDeps {
  config: Pick<AppConfig, "chzzkClientId" | "chzzkAuthorizeUrl" | "publicOrigin" | "channelId">;
  api: ChzzkApi;
  tokenManager: TokenManager;
  credentialStore: CredentialStore;
  roleVerifier: RoleVerifier;
  sessions: SessionStore;
  rules: RuleRepository;
  clock: Clock;
  onChannelConnected(): void;
}

/** 치지직 OAuth로 채널을 연결하고 매니저를 로그인시킨다. */
export interface AuthFlow {
  authorizeUrl(purpose: AuthPurpose): string;
  complete(code: string, state: string): Promise<{ session: ManagerSession; rawId: string }>;
}

/** 인증 흐름을 만든다. state는 메모리에 두고 한 번 쓰면 지운다(재사용·위조 방지). */
export function createAuthFlow(deps: AuthFlowDeps): AuthFlow {
  const states = new Map<string, { purpose: AuthPurpose; createdAt: number }>();
  return {
    authorizeUrl: (purpose) => buildAuthorizeUrl(deps, states, purpose),
    async complete(code, state) {
      const purpose = takeState(states, state, deps.clock());
      const tokens = await deps.api.exchangeCode(code, state);
      const user = await deps.api.getMe(tokens.accessToken);
      return purpose === "connect" ? connectChannel(deps, user, tokens) : login(deps, user, tokens);
    },
  };
}

/** 치지직 인증 페이지 주소를 만든다. */
function buildAuthorizeUrl(deps: AuthFlowDeps, states: Map<string, { purpose: AuthPurpose; createdAt: number }>, purpose: AuthPurpose): string {
  const now = deps.clock();
  for (const [key, entry] of states) if (now - entry.createdAt > STATE_TTL_MS) states.delete(key);
  const state = randomBytes(16).toString("base64url");
  while (states.size >= MAX_PENDING_STATES) {
    const oldestKey = states.keys().next().value;
    if (oldestKey === undefined) break;
    states.delete(oldestKey);
  }
  states.set(state, { purpose, createdAt: now });
  const url = new URL(deps.config.chzzkAuthorizeUrl);
  url.searchParams.set("clientId", deps.config.chzzkClientId);
  url.searchParams.set("redirectUri", deps.config.publicOrigin + CALLBACK_PATH);
  url.searchParams.set("state", state);
  return url.toString();
}

/** state를 꺼내고 지운다. 없거나 만료됐으면 AuthError. */
function takeState(states: Map<string, { purpose: AuthPurpose; createdAt: number }>, state: string, now: number): AuthPurpose {
  const entry = states.get(state);
  states.delete(state);
  if (!entry || now - entry.createdAt > STATE_TTL_MS) throw new AuthError("로그인 요청이 만료되었거나 잘못되었습니다. 처음부터 다시 시도하세요.");
  return entry.purpose;
}

/** 스트리머 채널 연결: 설정한 채널만 허용하고, 토큰 저장·기본 규칙·소유자 세션까지 만든다. */
function connectChannel(deps: AuthFlowDeps, user: ChzzkUser, tokens: TokenSet) {
  if (user.channelId !== deps.config.channelId) {
    throw new AuthError(`이 서버에 연결할 수 있는 채널이 아닙니다(${user.channelName}). 운영자가 설정한 스트리머 계정으로 로그인하세요.`);
  }
  adoptTokens(deps, user, tokens);
  deps.rules.seedDefaults(user.channelId);
  return deps.sessions.create({ channelId: user.channelId, channelName: user.channelName, role: "STREAMING_CHANNEL_OWNER" });
}

/** 로그인: 스트리머 본인이면 토큰을 새것으로 바꾸고, 아니면 관리자 목록으로 역할을 확인한다. 매니저 토큰은 버린다(revoke 금지). */
async function login(deps: AuthFlowDeps, user: ChzzkUser, tokens: TokenSet) {
  const channel = deps.credentialStore.loadChannel();
  if (!channel) throw new AuthError("아직 연결된 채널이 없습니다. 스트리머가 먼저 '채널 연결'을 해야 합니다.");
  if (user.channelId === channel.channelId) return connectChannel(deps, user, tokens);
  const role = await deps.roleVerifier.roleOf(user.channelId);
  if (!role) throw new AuthError("이 채널의 매니저가 아닙니다. 치지직에서 채널 관리자나 채팅 운영자로 등록돼 있어야 합니다.");
  return deps.sessions.create({ channelId: user.channelId, channelName: user.channelName, role });
}

/** 새 토큰을 채널 연결로 저장하고, 수신기 재시작 등을 알린다. */
function adoptTokens(deps: AuthFlowDeps, user: ChzzkUser, tokens: TokenSet): void {
  try {
    deps.tokenManager.adoptCredential(
      { channelId: user.channelId, channelName: user.channelName },
      { channelId: user.channelId, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessExpiresAt: deps.clock() + tokens.expiresInSeconds * 1000 },
    );
  } catch (error) {
    throw new AuthError(error instanceof Error ? error.message : String(error));
  }
  deps.roleVerifier.invalidate();
  deps.onChannelConnected();
}
