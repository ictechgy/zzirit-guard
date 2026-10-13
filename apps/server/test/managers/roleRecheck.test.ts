import { describe, expect, it, vi } from "vitest";
import type { ChzzkApi, StreamingRole } from "../../src/chzzk/apiClient.js";
import type { CredentialStore } from "../../src/connection/credentialStore.js";
import type { TokenManager } from "../../src/connection/tokenManager.js";
import { openDatabase } from "../../src/db/database.js";
import { silentLogger } from "../../src/logger.js";
import { recheckSessionRoles } from "../../src/managers/roleRecheck.js";
import { createRoleVerifier } from "../../src/managers/roleVerifier.js";
import { createSessionStore } from "../../src/managers/sessionStore.js";

/** 채팅 운영자 역할 항목. */
function chatManager(managerChannelId: string): StreamingRole {
  return { managerChannelId, managerChannelName: managerChannelId, userRole: "STREAMING_CHAT_MANAGER" };
}

/**
 * 실제 세션 저장소·역할 확인기와, 관리자 목록 호출 수를 세는 가짜 치지직으로 재확인을 준비한다.
 * @param options roles: 치지직 관리자 목록(오류면 호출 실패), sessions: 활성 세션의 매니저, subscribers: 장애 알림 구독 주인
 */
function setup(options: { roles: StreamingRole[] | Error; sessions: string[]; subscribers: string[] }) {
  const sessions = createSessionStore(openDatabase(":memory:"), () => 0);
  options.sessions.forEach((channelId) => sessions.create({ channelId, channelName: channelId, role: "STREAMING_CHAT_MANAGER" }));
  const getStreamingRoles = vi.fn(async () => {
    if (options.roles instanceof Error) throw options.roles;
    return options.roles;
  });
  const roleVerifier = createRoleVerifier({
    api: { getStreamingRoles } as unknown as ChzzkApi,
    tokenManager: { getAccessToken: async () => "token" } as unknown as TokenManager,
    credentialStore: { loadChannel: () => ({ channelId: "owner", channelName: "스트리머" }) } as unknown as CredentialStore,
    clock: () => 0, logger: silentLogger,
  });
  const onRevoked = vi.fn();
  const onRevokedSubscribers = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const run = () => recheckSessionRoles({ sessions, roleVerifier, logger, onRevoked, subscriberIds: () => options.subscribers, onRevokedSubscribers });
  return { run, onRevoked, onRevokedSubscribers, logger, getStreamingRoles };
}

describe("장애 알림 구독 주인의 역할 재확인(K11)", () => {
  it("활성 세션이 없는 구독 주인도 같은 관리자 목록으로 확인해, 해임된 사람만 구독 삭제 대상으로 알린다", async () => {
    const recheck = setup({ roles: [chatManager("m1"), chatManager("m3")], sessions: ["m1"], subscribers: ["m1", "m2", "m3", "owner"] });
    await recheck.run();
    expect(recheck.onRevokedSubscribers).toHaveBeenCalledWith(["m2"]);
    expect(recheck.onRevoked).not.toHaveBeenCalled();
    expect(recheck.getStreamingRoles).toHaveBeenCalledTimes(1);
  });

  it("세션으로 이미 확인한 매니저는 구독 쪽에서 다시 묻지 않는다(세션 해임으로 이미 정리된다)", async () => {
    const recheck = setup({ roles: [], sessions: ["m2"], subscribers: ["m2"] });
    await recheck.run();
    expect(recheck.onRevoked).toHaveBeenCalledWith([expect.objectContaining({ managerChannelId: "m2" })]);
    expect(recheck.onRevokedSubscribers).not.toHaveBeenCalled();
    expect(recheck.getStreamingRoles).toHaveBeenCalledTimes(1);
  });

  it("관리자 목록을 받지 못하면 구독을 지우지 않고 경고를 한 번만 남긴다", async () => {
    const recheck = setup({ roles: new Error("치지직 장애"), sessions: [], subscribers: ["m2", "m3"] });
    await recheck.run();
    expect(recheck.onRevokedSubscribers).not.toHaveBeenCalled();
    expect(recheck.logger.warn).toHaveBeenCalledTimes(1);
    expect(recheck.getStreamingRoles).toHaveBeenCalledTimes(1);
  });

  it("세션 확인이 이미 실패한 차례에는 구독 주인을 확인하지 않아 실패한 호출을 되풀이하지 않는다", async () => {
    const recheck = setup({ roles: new Error("치지직 장애"), sessions: ["m1"], subscribers: ["m2"] });
    await recheck.run();
    expect(recheck.getStreamingRoles).toHaveBeenCalledTimes(1);
    expect(recheck.onRevokedSubscribers).not.toHaveBeenCalled();
  });

  it("확인할 구독 주인이 없으면 관리자 목록을 부르지 않는다", async () => {
    const recheck = setup({ roles: [], sessions: [], subscribers: [] });
    await recheck.run();
    expect(recheck.getStreamingRoles).not.toHaveBeenCalled();
    expect(recheck.onRevokedSubscribers).not.toHaveBeenCalled();
  });
});
