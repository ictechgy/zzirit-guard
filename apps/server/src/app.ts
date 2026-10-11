import { mkdirSync } from "node:fs";
import type { ServerStatus } from "@zzirit-guard/shared";
import type { FastifyInstance } from "fastify";
import { createAutoHideSwitch } from "./actions/autoHideSwitch.js";
import { createDecisionHandler } from "./actions/decisionHandler.js";
import { createExecutor } from "./actions/executor.js";
import { connectWithSocketIo, createChatReceiver, type SocketConnector } from "./chat/chatReceiver.js";
import { createChzzkApi } from "./chzzk/apiClient.js";
import type { AppConfig } from "./config.js";
import { createCredentialStore } from "./connection/credentialStore.js";
import { createTokenManager } from "./connection/tokenManager.js";
import { openDatabase } from "./db/database.js";
import { createGroupFloodDetector, createPersonalFloodDetector } from "./detection/floodDetectors.js";
import { createDuplicateTracker } from "./detection/messageTraits.js";
import { createDetectionPipeline } from "./detection/pipeline.js";
import { createRuleRepository } from "./detection/ruleRepository.js";
import type { RouteServices } from "./http/routes.js";
import { buildHttpServer } from "./http/server.js";
import { createConsoleLogger, describeError, type Logger } from "./logger.js";
import { createAuthFlow } from "./managers/authFlow.js";
import { recheckSessionRoles } from "./managers/roleRecheck.js";
import { createRoleVerifier } from "./managers/roleVerifier.js";
import { createSessionStore } from "./managers/sessionStore.js";
import { createPushNotifier, type PushMessage, type PushSender } from "./push/pushNotifier.js";
import { createRealtimeHub } from "./realtime/hub.js";
import { createAuditLog } from "./records/auditLog.js";
import { runBackup, runRetention } from "./records/maintenance.js";
import { createMinuteStats } from "./records/minuteStats.js";
import { createSettingsRepository } from "./records/settingsRepository.js";
import { createVerdictRepository } from "./records/verdictRepository.js";
import { createTokenCipher } from "./security/tokenCipher.js";
import { systemClock, type Clock } from "./time.js";

/** createApp 옵션. 테스트에서 시계·네트워크·소켓·푸시를 바꿔 끼운다. */
export interface AppOptions {
  encryptionKey: Buffer;
  clock?: Clock;
  logger?: Logger;
  fetchFunction?: typeof fetch;
  connect?: SocketConnector;
  pushSender?: PushSender;
}

/** 조립된 서버. */
export interface App {
  http: FastifyInstance;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): ServerStatus;
}

/** 주기 작업 간격. */
const INTERVALS = {
  tokenCheckMs: 10 * 60 * 1000,
  statsFlushMs: 60 * 1000,
  roleRecheckMs: 5 * 60 * 1000,
  maintenanceMs: 24 * 60 * 60 * 1000,
  firstMaintenanceDelayMs: 5 * 60 * 1000,
};
/** 시스템 행위자. */
const SYSTEM_ACTOR = { type: "system" as const, channelId: null };

/** 모든 구성 요소를 만들고 이벤트를 연결한다. */
export async function createApp(config: AppConfig, options: AppOptions): Promise<App> {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createConsoleLogger();
  mkdirSync(config.backupDirectory, { recursive: true });
  const database = openDatabase(config.databasePath);
  const api = createChzzkApi({ apiBase: config.chzzkApiBase, clientId: config.chzzkClientId, clientSecret: config.chzzkClientSecret, ...(options.fetchFunction ? { fetchFunction: options.fetchFunction } : {}) });
  const credentialStore = createCredentialStore(database, createTokenCipher(options.encryptionKey), clock);
  const tokenManager = createTokenManager({
    store: credentialStore, api, clock,
    reportError: (context, error) => logger.warn(context, { error: describeError(error) }),
  });
  const verdicts = createVerdictRepository(database, clock);
  const auditLog = createAuditLog(database, clock);
  const stats = createMinuteStats(database, clock);
  const settings = createSettingsRepository(database);
  const rules = createRuleRepository(database, clock);
  const sessions = createSessionStore(database, clock);
  const hub = createRealtimeHub();
  const push = createPushNotifier({ database, clock, logger, vapid: { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey, subject: config.vapidSubject }, ...(options.pushSender ? { send: options.pushSender } : {}) });
  const executor = createExecutor({ api, tokenManager, auditLog, verdicts, clock, logger, onVerdictStatus: (verdictId, status) => hub.broadcast({ type: "verdict_status", verdictId, status }) });
  const autoHide = createAutoHideSwitch({ settings, auditLog, clock, logger });
  const decisionHandler = createDecisionHandler({ verdicts, executor, autoHide, stats, broadcaster: hub, logger });
  const pipeline = createDetectionPipeline({ rules, auditLog, groupFlood: createGroupFloodDetector(), personalFlood: createPersonalFloodDetector(), duplicates: createDuplicateTracker() });
  const roleVerifier = createRoleVerifier({ api, tokenManager, credentialStore, clock, logger });
  let lastChatAt: number | null = null;

  const notify = (message: PushMessage) => void push.notifyAll(message).catch((error: unknown) => logger.warn("푸시 알림 실패", { error: describeError(error) }));
  const status = (): ServerStatus => {
    const channel = credentialStore.loadChannel();
    return {
      channelConnected: channel !== null, channelName: channel?.channelName ?? null, chatConnected: receiver.isConnected(),
      writeLocked: channel === null || tokenManager.isWriteLocked(), accessExpiresAt: tokenManager.accessExpiresAt(),
      autoHideEnabled: channel ? autoHide.isEnabled(channel.channelId) : false, lastChatAt, pendingActions: executor.pendingCount(),
    };
  };
  const broadcastStatus = () => hub.broadcast({ type: "status", status: status() });

  const receiver = createChatReceiver({
    api, tokenManager, clock, logger, connect: options.connect ?? connectWithSocketIo,
    onChat: (event) => {
      lastChatAt = event.receivedAt;
      decisionHandler.handle(event, pipeline.evaluate(event));
    },
    onConnectionChange: () => broadcastStatus(),
    onInvalidEvent: () => {
      const channel = credentialStore.loadChannel();
      if (channel) stats.increment(channel.channelId, "invalid_events");
    },
    onRevoked: () => {
      notify({ title: "찌리릿 가드", body: "치지직이 채팅 권한을 회수했습니다. 스트리머가 다시 연결해야 합니다." });
      broadcastStatus();
    },
  });

  const restartReceiverIfIdle = () => {
    if (receiver.isConnected()) return;
    receiver.stop();
    receiver.start();
  };
  const disconnectChannel = () => {
    receiver.stop();
    tokenManager.disconnect();
    const ids = sessions.listActive().map((session) => session.id);
    ids.forEach((id) => sessions.deleteById(id));
    hub.closeSessions(ids, "채널 연결이 해제되었습니다");
  };
  const authFlow = createAuthFlow({ config, api, tokenManager, credentialStore, roleVerifier, sessions, rules, clock, onChannelConnected: () => { restartReceiverIfIdle(); broadcastStatus(); } });

  tokenManager.onLockChange((locked) => {
    if (locked) notify({ title: "찌리릿 가드", body: "치지직 토큰을 갱신하지 못해 숨김·제재를 멈췄습니다. 스트리머가 다시 연결해 주세요." });
    broadcastStatus();
  });
  executor.onFailureRateExceeded((channelId) => autoHide.setEnabled(channelId, false, SYSTEM_ACTOR, "failure_rate"));
  autoHide.onChange((_channelId, enabled, reason) => {
    if (!enabled && reason !== "manual") notify({ title: "찌리릿 가드", body: `자동 숨김이 꺼졌습니다(${reason === "breaker" ? "1분 한도 초과" : "치지직 호출 실패 증가"}).` });
    broadcastStatus();
  });

  const services: RouteServices = {
    channel: () => credentialStore.loadChannel(), status, verdicts, executor, autoHide, rules, settings, auditLog, stats, push, broadcaster: hub, clock,
    getChatSettings: async () => api.getChatSettings(await tokenManager.getAccessToken()),
    verifyRole: (managerChannelId) => roleVerifier.roleOf(managerChannelId),
    disconnectChannel,
    endSessions: (sessionIds, reason) => hub.closeSessions(sessionIds, reason),
  };
  const http = await buildHttpServer({ config, sessions, authFlow, hub, services, logger });
  const timers: Array<ReturnType<typeof setInterval>> = [];

  /**
   * 주기 작업의 한 번 실행을 안전하게 감싼다.
   * 왜: setInterval 콜백에서 빠져나온 예외·거부는 Node 프로세스를 죽이므로, 모든 실패를 로그로만 남긴다.
   */
  const guarded = (message: string, task: () => unknown): (() => void) => () => {
    try {
      void Promise.resolve(task()).catch((error: unknown) => logger.error(message, { error: describeError(error) }));
    } catch (error) {
      logger.error(message, { error: describeError(error) });
    }
  };
  /** 주기 작업: 토큰 선제 갱신·통계 저장·역할 재확인·보관 기한 정리와 백업. */
  const startTimers = () => {
    timers.push(setInterval(() => void refreshTokenQuietly(), INTERVALS.tokenCheckMs));
    timers.push(setInterval(guarded("통계 저장 실패", () => stats.flush()), INTERVALS.statsFlushMs));
    timers.push(setInterval(guarded("역할 재확인 실패", () => recheckSessionRoles({ sessions, roleVerifier, logger, onRevoked: (ids) => hub.closeSessions(ids, "치지직에서 매니저 권한이 해제되었습니다") })), INTERVALS.roleRecheckMs));
    timers.push(setTimeout(() => void runMaintenance(), INTERVALS.firstMaintenanceDelayMs));
    timers.push(setInterval(() => void runMaintenance(), INTERVALS.maintenanceMs));
  };
  const refreshTokenQuietly = async () => {
    if (!credentialStore.loadChannel()) return;
    try {
      await tokenManager.getAccessToken();
    } catch (error) {
      logger.warn("토큰 선제 갱신 실패", { error: describeError(error) });
    }
  };
  const runMaintenance = async () => {
    try {
      logger.info("보관 기한 정리", { ...runRetention({ database, verdicts, auditLog, sessions, clock }) });
      logger.info("백업 완료", { path: await runBackup(database, config.backupDirectory, clock) });
    } catch (error) {
      logger.error("정리·백업 실패 — 디스크 공간과 데이터 디렉터리 권한을 확인하세요", { error: describeError(error) });
    }
  };
  /**
   * 저장된 채널이 설정(ZG_CHANNEL_ID)과 다르면 연결을 풀고 세션을 지운다.
   * 왜 start()에서 하나: createApp은 조립만 하고 부작용(DB 쓰기·네트워크)을 일으키지 않게 두며, 리스너를 열기 전이자 수신기를 켜기 전인 start()의 맨 앞이 한 번만 실행되는 자리다.
   * 치지직 토큰 폐기 API는 부르지 않는다(같은 clientId의 토큰이 모두 지워질 수 있다). 토큰 값은 로그에 남기지 않는다.
   * @returns 불일치로 연결을 해제했으면 true
   */
  const disconnectMismatchedChannel = (): boolean => {
    const stored = credentialStore.loadChannel();
    if (!stored || stored.channelId === config.channelId) return false;
    tokenManager.disconnect();
    const ids = sessions.listActive().map((session) => session.id);
    ids.forEach((id) => sessions.deleteById(id));
    logger.error("저장된 채널이 ZG_CHANNEL_ID와 다릅니다. 연결을 해제했습니다. 설정한 스트리머 계정으로 다시 연결하세요.", { storedChannelId: stored.channelId, configuredChannelId: config.channelId });
    return true;
  };
  /** 종료 단계 하나를 실행한다. 실패해도 다음 단계가 이어지도록 로그만 남긴다. */
  const attemptShutdownStep = async (step: string, action: () => unknown): Promise<void> => {
    try {
      await action();
    } catch (error) {
      logger.error(`종료 단계 실패: ${step}`, { error: describeError(error) });
    }
  };

  return {
    http,
    status,
    async start() {
      const isMismatched = disconnectMismatchedChannel();
      await http.listen({ host: "127.0.0.1", port: config.port });
      if (!isMismatched && credentialStore.loadChannel()) receiver.start();
      startTimers();
    },
    async stop() {
      await attemptShutdownStep("타이머", () => timers.forEach((timer) => clearInterval(timer)));
      await attemptShutdownStep("채팅 수신기", () => receiver.stop());
      await attemptShutdownStep("통계 저장", () => stats.flush());
      await attemptShutdownStep("실시간 허브", () => hub.stop());
      await attemptShutdownStep("HTTP 서버", () => http.close());
      await attemptShutdownStep("데이터베이스", () => database.close());
    },
  };
}
