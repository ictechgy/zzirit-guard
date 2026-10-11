import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChzzkApi } from "../../src/chzzk/apiClient.js";
import { createCredentialStore, type CredentialStore } from "../../src/connection/credentialStore.js";
import { createTokenManager } from "../../src/connection/tokenManager.js";
import { openDatabase } from "../../src/db/database.js";
import { createRuleRepository, type RuleRepository } from "../../src/detection/ruleRepository.js";
import { silentLogger } from "../../src/logger.js";
import { AuthError, createAuthFlow, MAX_PENDING_STATES, type AuthFlow } from "../../src/managers/authFlow.js";
import { recheckSessionRoles } from "../../src/managers/roleRecheck.js";
import { createRoleVerifier, type RoleVerifier } from "../../src/managers/roleVerifier.js";
import { createSessionStore, type SessionStore } from "../../src/managers/sessionStore.js";
import { createTokenCipher } from "../../src/security/tokenCipher.js";
import { startFakeChzzk, type FakeChzzk } from "../fakes/fakeChzzk.js";

let fake: FakeChzzk;
let authFlow: AuthFlow;
let credentialStore: CredentialStore;
let sessions: SessionStore;
let rules: RuleRepository;
let roleVerifier: RoleVerifier;
let connectedCount: number;
let api: ReturnType<typeof createChzzkApi>;
let tokenManager: ReturnType<typeof createTokenManager>;

beforeEach(async () => {
  fake = await startFakeChzzk();
  const database = openDatabase(":memory:");
  api = createChzzkApi({ apiBase: fake.baseUrl, clientId: "test-client", clientSecret: "test-secret" });
  credentialStore = createCredentialStore(database, createTokenCipher(randomBytes(32)), Date.now);
  tokenManager = createTokenManager({ store: credentialStore, api, clock: Date.now });
  sessions = createSessionStore(database, Date.now);
  rules = createRuleRepository(database, Date.now);
  roleVerifier = createRoleVerifier({ api, tokenManager, credentialStore, clock: Date.now, logger: silentLogger });
  connectedCount = 0;
  authFlow = createAuthFlow({
    config: { chzzkClientId: "test-client", chzzkAuthorizeUrl: "https://chzzk.example/account-interlock", publicOrigin: "https://guard.example", channelId: fake.owner.channelId },
    api, tokenManager, credentialStore, roleVerifier, sessions, rules, clock: Date.now, onChannelConnected: () => { connectedCount += 1; },
  });
});
afterEach(async () => fake.close());

/** authorizeUrl에서 state를 꺼낸다. */
function stateFor(purpose: "connect" | "login"): string {
  const url = new URL(authFlow.authorizeUrl(purpose));
  expect(url.searchParams.get("redirectUri")).toBe("https://guard.example/auth/callback");
  expect(url.searchParams.get("clientId")).toBe("test-client");
  return url.searchParams.get("state") as string;
}

/** 매니저 계정. */
const managerUser = { channelId: "manager-1", channelName: "매니저1" };

describe("AuthFlow", () => {
  it("스트리머가 연결하면 토큰을 저장하고 기본 규칙을 넣고 소유자 세션을 만든다", async () => {
    const { session } = await authFlow.complete(fake.grantCode(fake.owner), stateFor("connect"));
    expect(session.role).toBe("STREAMING_CHANNEL_OWNER");
    expect(credentialStore.loadChannel()).toEqual(fake.owner);
    expect(rules.list(fake.owner.channelId).length).toBeGreaterThan(0);
    expect(connectedCount).toBe(1);
  });

  it("설정한 채널이 아니면 연결을 거부한다(공개 주소 가로채기 방지)", async () => {
    await expect(authFlow.complete(fake.grantCode(managerUser), stateFor("connect"))).rejects.toMatchObject({ code: "not_allowed_channel", message: expect.stringMatching(/연결할 수 있는 채널이 아닙니다/) });
    expect(credentialStore.loadChannel()).toBeNull();
  });

  it("연결 전에는 로그인할 수 없다", async () => {
    await expect(authFlow.complete(fake.grantCode(managerUser), stateFor("login"))).rejects.toMatchObject({ code: "no_channel", message: expect.stringMatching(/스트리머가 먼저/) });
  });

  it("관리자 목록에 있는 매니저는 그 역할로, 없으면 거부한다", async () => {
    await authFlow.complete(fake.grantCode(fake.owner), stateFor("connect"));
    fake.streamingRoles.push({ managerChannelId: "manager-1", managerChannelName: "매니저1", userRole: "STREAMING_CHAT_MANAGER" });
    roleVerifier.invalidate();
    const { session } = await authFlow.complete(fake.grantCode(managerUser), stateFor("login"));
    expect(session.role).toBe("STREAMING_CHAT_MANAGER");
    const stranger = { channelId: "stranger", channelName: "모르는 사람" };
    await expect(authFlow.complete(fake.grantCode(stranger), stateFor("login"))).rejects.toMatchObject({ code: "not_manager", message: expect.stringMatching(/매니저가 아닙니다/) });
  });

  it("state는 한 번만 쓸 수 있다", async () => {
    const state = stateFor("connect");
    await authFlow.complete(fake.grantCode(fake.owner), state);
    await expect(authFlow.complete(fake.grantCode(fake.owner), state)).rejects.toBeInstanceOf(AuthError);
    await expect(authFlow.complete(fake.grantCode(fake.owner), state)).rejects.toMatchObject({ code: "state_mismatch" });
  });

  it("스트리머가 로그인하면 새 토큰으로 바꿔 둔다", async () => {
    await authFlow.complete(fake.grantCode(fake.owner), stateFor("connect"));
    const before = credentialStore.loadCredential()?.accessToken;
    await authFlow.complete(fake.grantCode(fake.owner), stateFor("login"));
    expect(credentialStore.loadCredential()?.accessToken).not.toBe(before);
  });

  it("치지직에서 해임된 매니저의 세션은 다음 확인 때 끊긴다", async () => {
    await authFlow.complete(fake.grantCode(fake.owner), stateFor("connect"));
    fake.streamingRoles.push({ managerChannelId: "manager-1", managerChannelName: "매니저1", userRole: "STREAMING_CHANNEL_MANAGER" });
    roleVerifier.invalidate();
    const { session } = await authFlow.complete(fake.grantCode(managerUser), stateFor("login"));
    fake.streamingRoles.splice(0);
    roleVerifier.invalidate();
    const onRevoked = vi.fn();
    await recheckSessionRoles({ sessions, roleVerifier, logger: silentLogger, onRevoked });
    expect(onRevoked).toHaveBeenCalledWith([session.id]);
    expect(sessions.getById(session.id)).toBeNull();
  });

  it("hasPendingState는 발급된 state만 true로 보고, 조회로 지우지 않으며, 사용·만료 뒤에는 false다(B10-3)", async () => {
    let now = 1_000_000;
    const flow = createAuthFlow({
      config: { chzzkClientId: "test-client", chzzkAuthorizeUrl: "https://chzzk.example/account-interlock", publicOrigin: "https://guard.example", channelId: fake.owner.channelId },
      api, tokenManager, credentialStore, roleVerifier, sessions, rules, clock: () => now, onChannelConnected: () => undefined,
    });
    const issue = () => new URL(flow.authorizeUrl("connect")).searchParams.get("state") as string;
    const used = issue();
    expect(flow.hasPendingState("never-issued")).toBe(false);
    expect(flow.hasPendingState(used)).toBe(true);
    expect(flow.hasPendingState(used)).toBe(true);
    await flow.complete(fake.grantCode(fake.owner), used);
    expect(flow.hasPendingState(used)).toBe(false);
    const expiring = issue();
    now += 10 * 60 * 1000;
    expect(flow.hasPendingState(expiring)).toBe(true);
    now += 1;
    expect(flow.hasPendingState(expiring)).toBe(false);
  });

  it("대기 중인 state는 상한을 넘으면 가장 오래된 것 하나만 버린다(R20)", async () => {
    const states = Array.from({ length: MAX_PENDING_STATES + 1 }, () => stateFor("connect"));
    await expect(authFlow.complete(fake.grantCode(fake.owner), states[0] as string)).rejects.toBeInstanceOf(AuthError);
    await expect(authFlow.complete(fake.grantCode(fake.owner), states[1] as string)).resolves.toBeDefined();
    await expect(authFlow.complete(fake.grantCode(fake.owner), states[MAX_PENDING_STATES] as string)).resolves.toBeDefined();
  });

  it("다시 로그인·연결해도 지운 기본 규칙은 되살아나지 않는다", async () => {
    await authFlow.complete(fake.grantCode(fake.owner), stateFor("connect"));
    const [first] = rules.list(fake.owner.channelId);
    const total = rules.list(fake.owner.channelId).length;
    rules.remove(fake.owner.channelId, (first as { id: number }).id);
    await authFlow.complete(fake.grantCode(fake.owner), stateFor("login"));
    await authFlow.complete(fake.grantCode(fake.owner), stateFor("connect"));
    expect(rules.list(fake.owner.channelId)).toHaveLength(total - 1);
  });

  it("토큰 저장 오류는 AuthError로 감싸지 않고 그대로 던진다", async () => {
    const failure = new Error("disk full");
    const failing = createAuthFlow({
      config: { chzzkClientId: "test-client", chzzkAuthorizeUrl: "https://chzzk.example/account-interlock", publicOrigin: "https://guard.example", channelId: fake.owner.channelId },
      api, tokenManager: { ...tokenManager, adoptCredential: () => { throw failure; } }, credentialStore, roleVerifier, sessions, rules, clock: Date.now, onChannelConnected: () => undefined,
    });
    const state = new URL(failing.authorizeUrl("connect")).searchParams.get("state") as string;
    const error = await failing.complete(fake.grantCode(fake.owner), state).catch((caught: unknown) => caught);
    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(AuthError);
  });
});
