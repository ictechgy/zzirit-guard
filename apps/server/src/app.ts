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
/** 만료된 세션의 소켓을 닫을 때 화면에 보여 줄 이유. */
const SESSION_EXPIRED_REASON = "세션이 만료되었습니다. 다시 로그인하세요";

/** 모든 구성 요소를 만들고 이벤트를 연결한다. */
export async function createApp(config: AppConfig, options: AppOptions): Promise<App> {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createConsoleLogger();
  mkdirSync(config.backupDirectory, { recursive: true });
  const database = openDatabase(config.databasePath);
  const api = createChzzkApi({
    apiBase: config.chzzkApiBase,
    clientId: config.chzzkClientId,
    clientSecret: config.chzzkClientSecret,
    ...(options.fetchFunction ? { fetchFunction: options.fetchFunction } : {}),
  });
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
  const push = createPushNotifier({
    database, clock, logger,
    vapid: { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey, subject: config.vapidSubject },
    ...(options.pushSender ? { send: options.pushSender } : {}),
  });
  const executor = createExecutor({
    api, tokenManager, auditLog, verdicts, clock, logger,
    onVerdictStatus: (verdictId, status) => hub.broadcast({ type: "verdict_status", verdictId, status }),
  });
  const autoHide = createAutoHideSwitch({ settings, auditLog, clock, logger });
  const decisionHandler = createDecisionHandler({ verdicts, executor, autoHide, stats, broadcaster: hub, logger });
  const pipeline = createDetectionPipeline({
    rules, auditLog,
    groupFlood: createGroupFloodDetector(),
    personalFlood: createPersonalFloodDetector(),
    duplicates: createDuplicateTracker(),
  });
  const roleVerifier = createRoleVerifier({ api, tokenManager, credentialStore, clock, logger });
  /** 마지막으로 채팅을 받은 시각(ms). 화면의 "채팅 수신 중" 표시에 쓰며, 아직 받은 적이 없으면 null이다. */
  let lastChatAt: number | null = null;

  /**
   * 등록된 기기에 푸시 알림을 보낸다. 알림 실패가 본 동작을 막으면 안 되므로 거부는 경고 로그로만 남긴다.
   * @param message 알림 제목과 본문
   */
  const notify = (message: PushMessage): void => {
    void push.notifyAll(message).catch((error: unknown) => logger.warn("푸시 알림 실패", { error: describeError(error) }));
  };
  /**
   * 화면에 보여 줄 서버 상태를 지금 시점으로 계산한다.
   * 왜 매번 계산하나: 연결·잠금·스위치 상태가 여러 구성 요소에 나뉘어 있어 한 곳에 복제해 두면 어긋난다.
   * @returns 채널 연결·채팅 수신·쓰기 잠금·자동 숨김 등의 요약
   */
  const status = (): ServerStatus => {
    const channel = credentialStore.loadChannel();
    return {
      channelConnected: channel !== null,
      channelName: channel?.channelName ?? null,
      chatConnected: receiver.isConnected(),
      writeLocked: channel === null || tokenManager.isWriteLocked(),
      accessExpiresAt: tokenManager.accessExpiresAt(),
      autoHideEnabled: channel ? autoHide.isEnabled(channel.channelId) : false,
      lastChatAt,
      pendingActions: executor.pendingCount(),
    };
  };
  /** 현재 상태를 열린 모든 매니저 화면에 즉시 보낸다. 연결·잠금·스위치가 바뀔 때 부른다. */
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

  /**
   * 채팅이 연결돼 있지 않을 때만 수신기를 다시 시작한다.
   * 왜: 채널을 (다시) 연결한 직후 새 토큰으로 수신을 시작하되, 이미 정상 수신 중이면 끊지 않으려는 것이다.
   */
  const restartReceiverIfIdle = (): void => {
    if (receiver.isConnected()) return;
    receiver.stop();
    receiver.start();
  };
  /**
   * 스트리머 요청으로 채널 연결을 해제한다: 수신 중지, 토큰·연결 삭제, 모든 세션 삭제와 소켓 종료.
   * 왜 세션도 지우나: 연결이 없는 채널의 화면을 열어 둘 이유가 없고, 다시 연결하면 새로 로그인해야 안전하다.
   */
  const disconnectChannel = (): void => {
    receiver.stop();
    tokenManager.disconnect();
    const ids = sessions.listActive().map((session) => session.id);
    ids.forEach((id) => sessions.deleteById(id));
    hub.closeSessions(ids, "채널 연결이 해제되었습니다");
  };
  const authFlow = createAuthFlow({
    config, api, tokenManager, credentialStore, roleVerifier, sessions, rules, clock,
    onChannelConnected: () => {
      restartReceiverIfIdle();
      broadcastStatus();
    },
  });

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
    channel: () => credentialStore.loadChannel(),
    status, verdicts, executor, autoHide, rules, settings, auditLog, stats, push,
    broadcaster: hub,
    clock,
    getChatSettings: async () => api.getChatSettings(await tokenManager.getAccessToken()),
    verifyRole: (managerChannelId) => roleVerifier.roleOf(managerChannelId),
    disconnectChannel,
    endSessions: (sessionIds, reason) => hub.closeSessions(sessionIds, reason),
  };
  const http = await buildHttpServer({ config, sessions, authFlow, hub, services, logger });
  /** 반복 타이머 핸들. stop()에서 비운다. */
  let intervalTimers: Array<ReturnType<typeof setInterval>> = [];
  /** 한 번만 도는 타이머 핸들(첫 정리·백업). clearTimeout으로 해제하려고 반복 타이머와 따로 둔다. */
  let timeoutTimers: Array<ReturnType<typeof setTimeout>> = [];
  /** start()가 이미 불렸는지. 두 번 불려도 listen·타이머가 중복되지 않게 한다. */
  let hasStarted = false;
  /** stop()이 이미 불렸는지. 닫힌 DB에 다시 쓰지 않게 한다. */
  let hasStopped = false;

  /**
   * 주기 작업의 한 번 실행을 안전하게 감싼다.
   * 왜: setInterval 콜백에서 빠져나온 예외·거부는 Node 프로세스를 죽이므로, 모든 실패를 로그로만 남긴다.
   * @param message 실패 시 남길 로그 문구
   * @param task 동기 또는 비동기 작업
   * @returns 타이머 콜백으로 쓸 함수
   */
  const guarded = (message: string, task: () => unknown): (() => void) => () => {
    try {
      void Promise.resolve(task()).catch((error: unknown) => logger.error(message, { error: describeError(error) }));
    } catch (error) {
      logger.error(message, { error: describeError(error) });
    }
  };
  /**
   * 토큰이 만료되기 전에 미리 갱신한다(getAccessToken이 만료 임박이면 갱신).
   * 왜 전체를 try 안에 두나: 연결 조회(DB)가 실패해도 타이머의 거부가 처리되지 않아 프로세스가 죽지 않게 한다.
   */
  const refreshTokenQuietly = async (): Promise<void> => {
    try {
      if (!credentialStore.loadChannel()) return;
      await tokenManager.getAccessToken();
    } catch (error) {
      logger.warn("토큰 선제 갱신 실패", { error: describeError(error) });
    }
  };
  /**
   * 보관 기한이 지난 기록을 정리하고 DB를 백업한다. 실패하면 운영자가 볼 수 있게 오류 로그를 남기고 서버는 계속 돈다.
   */
  const runMaintenance = async (): Promise<void> => {
    try {
      logger.info("보관 기한 정리", { ...runRetention({ database, verdicts, auditLog, sessions, clock }) });
      logger.info("백업 완료", { path: await runBackup(database, config.backupDirectory, clock) });
    } catch (error) {
      logger.error("정리·백업 실패 — 디스크 공간과 데이터 디렉터리 권한을 확인하세요", { error: describeError(error) });
    }
  };
  /**
   * 활성 세션의 역할을 다시 확인한 뒤, 활성 목록에 없는 세션(12시간 만료 등)의 소켓을 닫는다.
   * 왜: 세션 만료는 DB에서만 일어나 허브가 모르므로, 재확인 주기마다 맞추지 않으면 만료된 화면이 판정·채팅을 계속 받는다(스펙 7장, F2).
   */
  const recheckRolesAndCloseExpired = async (): Promise<void> => {
    await recheckSessionRoles({
      sessions, roleVerifier, logger,
      onRevoked: (ids) => hub.closeSessions(ids, "치지직에서 매니저 권한이 해제되었습니다"),
    });
    hub.closeSessionsExcept(new Set(sessions.listActive().map((session) => session.id)), SESSION_EXPIRED_REASON);
  };
  /** 주기 작업을 등록한다: 토큰 선제 갱신·통계 저장·역할 재확인과 만료 세션 소켓 종료·보관 기한 정리와 백업. */
  const startTimers = (): void => {
    intervalTimers.push(setInterval(guarded("토큰 선제 갱신 실패", refreshTokenQuietly), INTERVALS.tokenCheckMs));
    intervalTimers.push(setInterval(guarded("통계 저장 실패", () => stats.flush()), INTERVALS.statsFlushMs));
    intervalTimers.push(setInterval(guarded("역할 재확인 실패", recheckRolesAndCloseExpired), INTERVALS.roleRecheckMs));
    timeoutTimers.push(setTimeout(guarded("정리·백업 실패", runMaintenance), INTERVALS.firstMaintenanceDelayMs));
    intervalTimers.push(setInterval(guarded("정리·백업 실패", runMaintenance), INTERVALS.maintenanceMs));
  };
  /** 등록한 모든 타이머를 해제하고 목록을 비운다. */
  const clearTimers = (): void => {
    intervalTimers.forEach((timer) => clearInterval(timer));
    timeoutTimers.forEach((timer) => clearTimeout(timer));
    intervalTimers = [];
    timeoutTimers = [];
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
  /**
   * 종료 단계 하나를 실행한다. 실패해도 다음 단계가 이어지도록 로그만 남긴다.
   * @param step 로그에 쓸 단계 이름
   * @param action 실행할 동기 또는 비동기 작업
   */
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
      if (hasStopped) throw new Error("이미 종료된 서버입니다. createApp으로 새 서버를 만든 뒤 start()를 호출하세요.");
      if (hasStarted) return;
      hasStarted = true;
      const isMismatched = disconnectMismatchedChannel();
      await http.listen({ host: "127.0.0.1", port: config.port });
      if (!isMismatched && credentialStore.loadChannel()) receiver.start();
      startTimers();
    },
    async stop() {
      if (hasStopped) return;
      hasStopped = true;
      await attemptShutdownStep("타이머", clearTimers);
      await attemptShutdownStep("채팅 수신기", () => receiver.stop());
      await attemptShutdownStep("통계 저장", () => stats.flush());
      await attemptShutdownStep("실시간 허브", () => hub.stop());
      await attemptShutdownStep("HTTP 서버", () => http.close());
      await attemptShutdownStep("데이터베이스", () => database.close());
    },
  };
}
