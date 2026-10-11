import type { ManagerRole } from "@zzirit-guard/shared";
import { vi } from "vitest";
import { createAutoHideSwitch } from "../../src/actions/autoHideSwitch.js";
import type { ActionOutcome, Executor } from "../../src/actions/executor.js";
import { openDatabase } from "../../src/db/database.js";
import { createRuleRepository } from "../../src/detection/ruleRepository.js";
import type { RouteServices } from "../../src/http/routes.js";
import { buildHttpServer } from "../../src/http/server.js";
import { silentLogger } from "../../src/logger.js";
import { AuthError, type AuthFlow } from "../../src/managers/authFlow.js";
import { createSessionStore } from "../../src/managers/sessionStore.js";
import { createPushNotifier } from "../../src/push/pushNotifier.js";
import { createRealtimeHub } from "../../src/realtime/hub.js";
import { createAuditLog } from "../../src/records/auditLog.js";
import { createMinuteStats } from "../../src/records/minuteStats.js";
import { createSettingsRepository } from "../../src/records/settingsRepository.js";
import { createVerdictRepository } from "../../src/records/verdictRepository.js";

/** 테스트 서버의 공개 출처. */
export const ORIGIN = "https://guard.test";

/** 상태 변경 요청에 필요한 헤더(쿠키·출처·표식). */
export function mutatingHeaders(rawId: string): Record<string, string> {
  return { cookie: `zg_session=${rawId}`, origin: ORIGIN, "x-zzirit-request": "1" };
}

/** 실제 저장소와 가짜 실행기로 HTTP 서버를 띄운다. */
export async function createHttpHarness(authFlowOverrides: Partial<AuthFlow> = {}) {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
  database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
  const clock = () => 1_000_000;
  const verdicts = createVerdictRepository(database, clock);
  const auditLog = createAuditLog(database, clock);
  const settings = createSettingsRepository(database);
  const sessions = createSessionStore(database, clock);
  const hub = createRealtimeHub({ flushIntervalMs: 60_000 });
  const submit = vi.fn<Executor["submit"]>(async () => ({ ok: true, note: null }) as ActionOutcome);
  const services: RouteServices = {
    channel: () => ({ channelId: "c1", channelName: "채널" }),
    status: () => ({ channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, lastChatAt: null, pendingActions: 0 }),
    verdicts, auditLog, settings, clock,
    executor: { submit, pendingCount: () => 0, onFailureRateExceeded: () => undefined },
    autoHide: createAutoHideSwitch({ settings, auditLog, clock, logger: silentLogger }),
    rules: createRuleRepository(database, clock),
    stats: createMinuteStats(database, clock),
    push: createPushNotifier({ database, clock, logger: silentLogger, vapid: { publicKey: "pk", privateKey: "sk", subject: "mailto:a@b.c" }, send: async () => ({}) }),
    broadcaster: hub,
    getChatSettings: async () => ({ chatAvailableCondition: "NONE", chatAvailableGroup: "ALL", minFollowerMinute: 0, allowSubscriberInFollowerMode: false, chatSlowModeSec: 0, chatEmojiMode: false }),
    /** login()이 만든 채널 ID("<역할>-id")에서 역할을 그대로 돌려준다. 해임을 흉내 내려면 테스트에서 덮어쓴다. */
    verifyRole: async (managerChannelId) => managerChannelId.replace(/-id$/, "") as ManagerRole,
    disconnectChannel: vi.fn(),
  };
  const authFlow: AuthFlow = {
    authorizeUrl: (purpose) => `https://chzzk.example/account-interlock?purpose=${purpose}`,
    complete: async () => { throw new AuthError("이 채널의 매니저가 아닙니다."); },
    ...authFlowOverrides,
  };
  const app = await buildHttpServer({ config: { publicOrigin: ORIGIN, webDistDirectory: "/nonexistent-web-dist" }, sessions, authFlow, hub, services, logger: silentLogger });
  /** 역할로 로그인한 세션의 쿠키 값. */
  const login = (role: ManagerRole) => sessions.create({ channelId: `${role}-id`, channelName: role, role }).rawId;
  return { app, verdicts, auditLog, sessions, hub, services, submit, login, close: async () => { hub.stop(); await app.close(); } };
}
