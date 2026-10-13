import { mkdirSync } from "node:fs";
import type { AutoHideOffReason, ServerStatus } from "@zzirit-guard/shared";
import type { FastifyInstance } from "fastify";
import { createAutoHideSwitch } from "./actions/autoHideSwitch.js";
import { createDecisionHandler } from "./actions/decisionHandler.js";
import { createExecutor } from "./actions/executor.js";
import { createSenderActionGuard } from "./actions/senderActionGuard.js";
import { createVerdictClaims } from "./actions/verdictClaims.js";
import { connectWithSocketIo, createChatReceiver, type SocketConnector } from "./chat/chatReceiver.js";
import { createRepeatedChatFilter } from "./chat/repeatedChatFilter.js";
import { createChzzkApi } from "./chzzk/apiClient.js";
import type { AppConfig } from "./config.js";
import { createCredentialStore } from "./connection/credentialStore.js";
import { createTokenManager } from "./connection/tokenManager.js";
import { openDatabase } from "./db/database.js";
import { restrictDatabaseFiles, restrictDataDirectory } from "./db/filePermissions.js";
import { createGroupFloodDetector, createPersonalFloodDetector } from "./detection/floodDetectors.js";
import { createDuplicateTracker } from "./detection/messageTraits.js";
import { createDetectionPipeline } from "./detection/pipeline.js";
import { createRuleRepository } from "./detection/ruleRepository.js";
import type { RouteServices } from "./http/routes.js";
import { buildHttpServer } from "./http/server.js";
import { createConsoleLogger, describeError, type Logger } from "./logger.js";
import { createAuthFlow } from "./managers/authFlow.js";
import { recheckSessionRoles, type RevokedSession } from "./managers/roleRecheck.js";
import { createRoleVerifier } from "./managers/roleVerifier.js";
import { createSessionStore } from "./managers/sessionStore.js";
import { createPushNotifier, type PushMessage, type PushSender } from "./push/pushNotifier.js";
import { createRealtimeHub, SESSION_EXPIRED_REASON } from "./realtime/hub.js";
import { createAuditLog } from "./records/auditLog.js";
import { runBackup, runRetention } from "./records/maintenance.js";
import { createMinuteStats } from "./records/minuteStats.js";
import { createSettingsRepository } from "./records/settingsRepository.js";
import { createVerdictRepository } from "./records/verdictRepository.js";
import { runOneAtATime } from "./runOneAtATime.js";
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

/** 주기 작업 간격. chatMemoryPruneMs는 도배·중복 감지기가 기억하는 채팅을 정리하는 간격이다(K16, 도배 창 10초보다 넉넉하고 짧게 남도록 1분). */
const INTERVALS = {
  tokenCheckMs: 10 * 60 * 1000,
  statsFlushMs: 60 * 1000,
  chatMemoryPruneMs: 60 * 1000,
  roleRecheckMs: 5 * 60 * 1000,
  maintenanceMs: 24 * 60 * 60 * 1000,
  firstMaintenanceDelayMs: 5 * 60 * 1000,
};
/**
 * 열린 매니저 화면에 현재 상태(status)를 다시 보내는 간격(20초, B19-2).
 * 왜: 화면은 45초 동안 메시지가 없으면 연결이 조용히 죽었다고 보고 다시 연결한다(useServerState STALE_CONNECTION_MS).
 * 채팅이 없는 조용한 채널은 보낼 것이 없어 살아 있는 연결도 죽은 것처럼 보였다. 이미 있는 status 메시지를 주기적으로 보내므로 프로토콜은 바뀌지 않는다.
 */
const STATUS_BROADCAST_MS = 20_000;
/** 시스템 행위자. */
const SYSTEM_ACTOR = { type: "system" as const, channelId: null };
/** 주기 작업이 이만큼 연속으로 건너뛰어지면 멈춘 것으로 보고 경고 로그를 남긴다(N5). */
const STUCK_TASK_SKIP_THRESHOLD = 3;

/** 모든 구성 요소를 만들고 이벤트를 연결한다. */
export async function createApp(config: AppConfig, options: AppOptions): Promise<App> {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createConsoleLogger();
  // 데이터 폴더와 DB 파일은 소유자만 읽게 한다(K13). 예전 설치에서 넓게 만들어진 권한도 시작할 때마다 바로잡는다.
  restrictDataDirectory(config.dataDirectory);
  mkdirSync(config.backupDirectory, { recursive: true });
  const database = openDatabase(config.databasePath);
  restrictDatabaseFiles(config.databasePath);
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
  const hub = createRealtimeHub({ clock });
  const push = createPushNotifier({
    database, clock, logger,
    vapid: { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey, subject: config.vapidSubject },
    ...(options.pushSender ? { send: options.pushSender } : {}),
  });
  const executor = createExecutor({
    api, tokenManager, auditLog, verdicts, clock, logger,
    onVerdictStatus: (verdictId, status) => hub.broadcast({ type: "verdict_status", verdictId, status }),
  });
  const autoHide = createAutoHideSwitch({ database, settings, auditLog, clock, logger });
  /** 숨김을 보내는 중인 판정 모음. 매니저 숨기기(routes)와 자동 숨김이 함께 써서 같은 판정에 숨김이 두 번 나가지 않게 한다(S12). */
  const claims = createVerdictClaims();
  /** 사람 단위 제재가 같은 사람에게 겹쳐 나가지 않게 막는 표(K2). 제재는 매니저 라우트에서만 보낸다. */
  const senderActions = createSenderActionGuard(clock);
  const decisionHandler = createDecisionHandler({ verdicts, executor, autoHide, claims, stats, broadcaster: hub, logger });
  const pipeline = createDetectionPipeline({
    rules, auditLog,
    groupFlood: createGroupFloodDetector(),
    personalFlood: createPersonalFloodDetector(),
    duplicates: createDuplicateTracker(),
  });
  /** 같은 채팅이 다시 전달되면(재연결·중복 전달) 판정 전에 버린다(K4). 숨김 요청이 한 메시지에 두 번 나가지 않게 한다. */
  const repeatedChats = createRepeatedChatFilter();
  const roleVerifier = createRoleVerifier({ api, tokenManager, credentialStore, clock, logger });
  /** 마지막으로 채팅을 받은 시각(ms). 화면의 "채팅 수신 중" 표시에 쓰며, 아직 받은 적이 없으면 null이다. */
  let lastChatAt: number | null = null;
  /**
   * 일부러 연결을 끊는 중인지(스트리머의 연결 해제·설정과 다른 저장 채널 정리).
   * 왜: tokenManager.disconnect()도 잠금(setLocked(true))을 알려, 표시가 없으면 모든 매니저에게 "토큰을 갱신하지 못해" 장애 알림이 잘못 간다(F10).
   */
  let isDisconnectingOnPurpose = false;
  /**
   * 자동 숨김이 마지막으로 꺼진 이유. 켜지면 null로 되돌린다(B19-3).
   * 왜: 화면이 시스템이 끈 것(1분 한도·실패율)과 매니저가 손으로 끈 것을 가려, 앞의 경우에만 이유를 밝힌 안내를 띄우게 한다.
   * 메모리에만 둔다: 재시작 뒤에는 이유를 모르므로 null이다(감사 기록에는 남아 있다).
   */
  let autoHideOffReason: AutoHideOffReason | null = null;

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
      autoHideOffReason,
      lastChatAt,
      pendingActions: executor.pendingCount(),
    };
  };
  /** 현재 상태를 열린 모든 매니저 화면에 즉시 보낸다. 연결·잠금·스위치가 바뀔 때 부른다. */
  const broadcastStatus = () => hub.broadcast({ type: "status", status: status() });

  const receiver = createChatReceiver({
    api, tokenManager, clock, logger, connect: options.connect ?? connectWithSocketIo,
    connectedChannelId: () => credentialStore.loadChannel()?.channelId ?? null,
    onChat: (event) => {
      lastChatAt = event.receivedAt;
      // 중복 전달은 도배 집계·판정·통계·실행기 어디에도 넣지 않는다(K4). 수신 자체는 살아 있다는 신호라 lastChatAt은 갱신한다.
      if (repeatedChats.isRepeat(event)) return;
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
   * 토큰 연결을 일부러 해제한다. 해제가 알리는 잠금 변화는 장애가 아니므로 장애 알림을 보내지 않게 표시해 둔다.
   * 리스너는 setLocked 안에서 동기로 불리므로, 표시는 disconnect()가 끝나면 바로 내린다.
   */
  const disconnectTokensOnPurpose = (): void => {
    isDisconnectingOnPurpose = true;
    try {
      tokenManager.disconnect();
    } finally {
      isDisconnectingOnPurpose = false;
    }
  };
  /**
   * 채널 연결을 풀 때 모든 장애 알림 구독을 지운다(K11). 실패해도 연결 해제는 끝까지 하고 오류만 남긴다.
   * 왜: 연결이 풀린 채널의 매니저가 그 채널의 장애 알림을 계속 받으면 안 된다. 토큰을 지운 뒤에 불러,
   * 해제 중에 장애 알림이 잘못 나가는지(F10) 확인할 수 있는 순서를 지킨다.
   */
  const removeAllPushSubscriptions = (): void => {
    try {
      push.unsubscribeAll();
    } catch (error) {
      logger.error("연결을 해제했지만 장애 알림 구독을 지우지 못했습니다. DB 상태를 확인하세요.", { error: describeError(error) });
    }
  };
  /**
   * 스트리머 요청으로 채널 연결을 해제한다: 수신 중지, 토큰·연결 삭제, 장애 알림 구독 삭제, 모든 세션 삭제와 소켓 종료.
   * 왜 세션도 지우나: 연결이 없는 채널의 화면을 열어 둘 이유가 없고, 다시 연결하면 새로 로그인해야 안전하다.
   */
  const disconnectChannel = (): void => {
    receiver.stop();
    disconnectTokensOnPurpose();
    removeAllPushSubscriptions();
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
    if (locked && !isDisconnectingOnPurpose) notify({ title: "찌리릿 가드", body: "치지직 토큰을 갱신하지 못해 숨김·제재를 멈췄습니다. 스트리머가 다시 연결해 주세요." });
    broadcastStatus();
  });
  executor.onFailureRateExceeded((channelId) => autoHide.setEnabled(channelId, false, SYSTEM_ACTOR, "failure_rate"));
  autoHide.onChange((_channelId, enabled, reason) => {
    autoHideOffReason = enabled ? null : reason;
    if (!enabled && reason !== "manual") notify({ title: "찌리릿 가드", body: `자동 숨김이 꺼졌습니다(${reason === "breaker" ? "1분 한도 초과" : "치지직 호출 실패 증가"}).` });
    broadcastStatus();
  });

  const services: RouteServices = {
    channel: () => credentialStore.loadChannel(),
    status, verdicts, claims, senderActions, executor, autoHide, rules, settings, auditLog, stats, push,
    broadcaster: hub,
    clock,
    getChatSettings: async () => api.getChatSettings(await tokenManager.getAccessToken()),
    verifyRole: (managerChannelId) => roleVerifier.roleOf(managerChannelId),
    disconnectChannel,
    endSessions: (sessionIds, reason) => hub.closeSessions(sessionIds, reason),
    logger,
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
   * 해임된 매니저들의 장애 알림 구독(모든 기기)을 지운다.
   * 왜: 해임된 매니저가 채널 장애 알림을 계속 받으면 안 된다(F10, K11). 지우기가 실패해도 다른 정리는 이어지게 기록만 남긴다.
   * @param managerChannelIds 해임된 매니저 채널 ID들
   */
  const removeRevokedManagerPush = (managerChannelIds: Iterable<string>): void => {
    try {
      for (const managerChannelId of managerChannelIds) push.unsubscribeManager(managerChannelId);
    } catch (error) {
      logger.error("해임된 매니저의 장애 알림 구독을 지우지 못했습니다. DB 상태를 확인하세요.", { error: describeError(error) });
    }
  };
  /**
   * 해임된 매니저의 소켓을 닫고 장애 알림 구독(모든 기기)을 지운다.
   * @param revoked 해임으로 지운 세션과 그 매니저
   */
  const handleRevokedSessions = (revoked: RevokedSession[]): void => {
    hub.closeSessions(revoked.map(({ sessionId }) => sessionId), "치지직에서 매니저 권한이 해제되었습니다");
    removeRevokedManagerPush(new Set(revoked.map(({ managerChannelId }) => managerChannelId)));
  };
  /**
   * 활성 세션의 역할을 다시 확인한 뒤, 활성 목록에 없는 세션(12시간 만료 등)의 소켓을 닫는다.
   * 왜: 세션 만료는 DB에서만 일어나 허브가 모르므로, 재확인 주기마다 맞추지 않으면 만료된 화면이 판정·채팅을 계속 받는다(스펙 7장, F2).
   */
  const recheckRolesAndCloseExpired = async (): Promise<void> => {
    await recheckSessionRoles({
      sessions, roleVerifier, logger, onRevoked: handleRevokedSessions,
      subscriberIds: () => push.subscriberIds(),
      onRevokedSubscribers: removeRevokedManagerPush,
    });
    hub.closeSessionsExcept(new Set(sessions.listActive().map((session) => session.id)), SESSION_EXPIRED_REASON);
  };
  /**
   * 오래 걸릴 수 있는 주기 작업을 한 번에 하나만 돌게 감싼다(S15). 건너뛴 차례는 정보 로그로 남기고,
   * 3번 연속 건너뛰면 경고로 올린다(N5). 왜: 한 번 실행이 주기의 세 배 넘게 끝나지 않으면 치지직 장애나 DB 잠금처럼 운영자가 봐야 할 문제다.
   * @param name 로그에 쓸 작업 이름
   * @param task 감쌀 비동기 작업
   */
  const oneAtATime = (name: string, task: () => Promise<void>): (() => Promise<void>) =>
    runOneAtATime(task, (skipCount) => {
      if (skipCount < STUCK_TASK_SKIP_THRESHOLD) logger.info("이전 실행이 아직 끝나지 않아 이번 차례를 건너뜁니다", { task: name });
      else logger.warn(`주기 작업이 ${skipCount}번 연속 건너뛰어졌습니다. 이전 실행이 멈췄는지 치지직·DB 상태를 확인하세요`, { task: name, skipCount });
    });
  /** 토큰 선제 갱신(겹침 방지). */
  const refreshTokenOnce = oneAtATime("토큰 선제 갱신", refreshTokenQuietly);
  /** 역할 재확인과 만료 세션 소켓 종료(겹침 방지). */
  const recheckRolesOnce = oneAtATime("역할 재확인", recheckRolesAndCloseExpired);
  /** 보관 기한 정리와 백업(겹침 방지). 첫 실행 타이머와 하루 주기 타이머가 이 함수 하나를 함께 써야 서로 겹치지 않는다. */
  const runMaintenanceOnce = oneAtATime("정리·백업", runMaintenance);
  /** 주기 작업을 등록한다: 토큰 선제 갱신·통계 저장·채팅 기억 정리·역할 재확인과 만료 세션 소켓 종료·보관 기한 정리와 백업·상태 방송. */
  const startTimers = (): void => {
    intervalTimers.push(setInterval(guarded("상태 방송 실패", broadcastStatus), STATUS_BROADCAST_MS));
    intervalTimers.push(setInterval(guarded("토큰 선제 갱신 실패", refreshTokenOnce), INTERVALS.tokenCheckMs));
    intervalTimers.push(setInterval(guarded("통계 저장 실패", () => stats.flush()), INTERVALS.statsFlushMs));
    intervalTimers.push(setInterval(guarded("채팅 기억 정리 실패", () => pipeline.pruneExpired(clock())), INTERVALS.chatMemoryPruneMs));
    intervalTimers.push(setInterval(guarded("역할 재확인 실패", recheckRolesOnce), INTERVALS.roleRecheckMs));
    timeoutTimers.push(setTimeout(guarded("정리·백업 실패", runMaintenanceOnce), INTERVALS.firstMaintenanceDelayMs));
    intervalTimers.push(setInterval(guarded("정리·백업 실패", runMaintenanceOnce), INTERVALS.maintenanceMs));
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
    disconnectTokensOnPurpose();
    removeAllPushSubscriptions();
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
