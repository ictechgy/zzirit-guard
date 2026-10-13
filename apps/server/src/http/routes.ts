import type { ChatSettingsDto, FalsePositiveReviewDto, ManagerRole, MeDto, Permission, ServerStatus, SettingsDto, VerdictStatus } from "@zzirit-guard/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AutoHideSwitch } from "../actions/autoHideSwitch.js";
import type { Broadcaster } from "../actions/decisionHandler.js";
import type { ActionOutcome, Actor, Executor } from "../actions/executor.js";
import { settleHideClaim, type VerdictClaims } from "../actions/verdictClaims.js";
import type { ConnectedChannel } from "../connection/credentialStore.js";
import type { RuleRepository } from "../detection/ruleRepository.js";
import { describeError, type Logger } from "../logger.js";
import { hasPermission, permissionsFor } from "../managers/permissions.js";
import type { ManagerSession, SessionStore } from "../managers/sessionStore.js";
import type { PushNotifier } from "../push/pushNotifier.js";
import type { AuditLog } from "../records/auditLog.js";
import type { MinuteStats } from "../records/minuteStats.js";
import type { ChannelSettings, SettingsRepository } from "../records/settingsRepository.js";
import type { VerdictRepository } from "../records/verdictRepository.js";
import type { Clock } from "../time.js";
import { CANDIDATE_WINDOW_MS, SESSION_COOKIE } from "./constants.js";
import { errorBody, RouteError } from "./errors.js";

/** 라우트가 쓰는 서비스 묶음. app.ts가 실제 구성 요소로 채운다. */
export interface RouteServices {
  channel(): ConnectedChannel | null;
  status(): ServerStatus;
  verdicts: VerdictRepository;
  /** 숨김을 보내는 중인 판정 모음. 자동 숨김(decisionHandler)과 함께 써서 같은 판정에 숨김이 두 번 나가지 않게 한다(S12). */
  claims: VerdictClaims;
  executor: Executor;
  autoHide: AutoHideSwitch;
  rules: RuleRepository;
  settings: SettingsRepository;
  auditLog: AuditLog;
  stats: MinuteStats;
  push: PushNotifier;
  broadcaster: Broadcaster;
  getChatSettings(): Promise<ChatSettingsDto>;
  /** 치지직 관리자 목록으로 지금 역할을 확인한다(5분 캐시). WebSocket 티켓을 줄 때 쓴다(스펙 7장). */
  verifyRole(managerChannelId: string): Promise<ManagerRole | null>;
  disconnectChannel(): void;
  /**
   * 세션이 끝났을 때 그 세션으로 열린 WebSocket을 닫는다(허브의 closeSessions에 연결된다).
   * 왜: 세션 행만 지우면 이미 열린 소켓이 계속 이벤트를 받는다(스펙 7장).
   */
  endSessions(sessionIds: readonly string[], reason: string): void;
  clock: Clock;
  /** 요청은 성공으로 끝내되 따로 남겨야 하는 실패(예: 해임된 매니저의 구독 삭제 실패)를 기록한다. 토큰·채팅 원문은 넘기지 않는다. */
  logger: Logger;
}

/** 권한 이름(오류 문구용). */
const PERMISSION_LABELS: Record<Permission, string> = {
  connect_channel: "채널 연결", disable_auto_hide: "자동 숨김 끄기", enable_auto_hide: "자동 숨김 켜기", edit_rules: "규칙 수정",
  hide_message: "메시지 숨김", temporary_restrict: "임시 제한", restrict: "활동 제한", edit_chat_settings: "채팅 설정", view_audit: "감사 기록 보기",
};
/** 치지직이 허용하는 최소 팔로우 시간(분) 값. */
const ALLOWED_FOLLOWER_MINUTES = [0, 5, 10, 30, 60, 1440, 10080, 43200, 86400, 129600, 172800, 216000, 259200];
/** 치지직이 허용하는 저속 모드(초) 값. */
const ALLOWED_SLOW_MODE_SECONDS = [0, 3, 5, 10, 30, 60, 120, 300];
/** 채널 ID 문자열의 최대 길이. */
const MAX_CHANNEL_ID_LENGTH = 128;
/** 푸시 구독 주소의 최대 길이. 왜: 저장·로그·전송 비용을 키우는 과대 입력을 막는다(R26). */
const MAX_PUSH_ENDPOINT_LENGTH = 2048;
/** 푸시 구독 키(p256dh·auth)의 최대 길이. 실제 값은 100자 안쪽이라 여유를 두고 제한한다(R26). */
const MAX_PUSH_KEY_LENGTH = 256;

/**
 * 숨길 수 있는 판정 상태(S12): 대기 중만.
 * 왜: 이미 숨겼거나 제한한 메시지에 숨김을 또 보내면 치지직 호출·감사 기록만 늘고(F9.2), 무시·오판으로 표시한 판정은 매니저가 이미 판단을 끝낸 것이다.
 * 특히 오판 표시가 판정을 다시 숨길 대상으로 되돌리면 안 된다(M11).
 */
const HIDE_ALLOWED_FROM: readonly VerdictStatus[] = ["pending"];
/**
 * 표시 동작별로 바꿀 수 있는 이전 상태(S12).
 * 무시는 대기 중만: 숨김·제한이 끝난 판정을 무시로 덮으면 실제 조치 기록이 화면에서 사라진다.
 * 오판은 대기 중·숨김·제한: 잘못된 자동 숨김(hidden)·제한을 알리는 통로다. 무시했거나 이미 오판인 판정은 받지 않는다.
 */
const MARK_ALLOWED_FROM: Readonly<Record<Extract<VerdictStatus, "ignored" | "false_positive">, readonly VerdictStatus[]>> = {
  ignored: ["pending"],
  false_positive: ["pending", "hidden", "restricted"],
};
/** 이미 처리된 판정에 다시 조치하려 할 때의 안내 문구. */
const ALREADY_HANDLED_MESSAGE = "이미 다른 조치가 끝난 판정입니다. '다시 불러오기'를 눌러 지금 상태를 확인하세요.";
/** 다른 매니저가 같은 판정을 숨기는 중일 때의 안내 문구. 화면이 already_handled 코드로 다시 불러오게 같은 코드를 쓴다. */
const ACTION_IN_PROGRESS_MESSAGE = "다른 요청이 이 판정을 숨기는 중입니다. 잠시 뒤 '다시 불러오기'를 눌러 결과를 확인하세요.";
/**
 * 자동 숨김이 같은 판정을 숨기는 중일 때의 안내 문구(N4). 코드는 in_progress라 화면이 실패가 아닌 안내로 이 문구를 그대로 보여 준다.
 * 왜 already_handled와 가르나: 자동 숨김은 아직 끝나지 않아 다시 불러와도 대기 중으로 보이므로 "이미 처리됨"은 틀린 안내다.
 */
const AUTO_HIDE_IN_PROGRESS_MESSAGE = "자동 숨김이 진행 중입니다. 잠시 뒤 결과가 반영됩니다.";
/**
 * 앞선 숨김의 결과를 알 수 없는 판정을 다시 숨기려 할 때의 안내 문구(K1). 코드는 result_unknown이다.
 * 왜 다시 보내지 않나: 치지직이 이미 숨겼을 수 있어, 서버가 다시 보내면 되돌릴 수 없는 숨김이 겹친다. 확인은 매니저가 치지직에서 한다.
 */
const HIDE_RESULT_UNKNOWN_MESSAGE = "숨김 결과를 알 수 없습니다. 치지직 채팅에서 숨겨졌는지 확인하고, 숨겨지지 않았다면 치지직 기본 도구로 숨기세요.";

/** 경로의 숫자 ID(판정·규칙). 왜: 문자열이 DB 조회로 흘러가지 않게 양의 정수만 받는다. */
const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
/** 경로의 보낸 사람 채널 ID. 길이를 제한해 과대 입력을 막는다. */
const senderParamSchema = z.object({ senderChannelId: z.string().min(1).max(MAX_CHANNEL_ID_LENGTH) });
/** 자동 숨김 스위치 요청 본문. */
const autoHideBodySchema = z.object({ enabled: z.boolean() });
/** 규칙 추가 본문. 종류는 허용 목록으로, 패턴은 길이로 제한한다. */
const ruleBodySchema = z.object({
  kind: z.enum(["strong", "weak", "exception", "allow", "allow_domain", "threat", "keyword_route"]),
  pattern: z.string().min(1).max(100),
});
/** 설정 변경 본문. strict로 알 수 없는 키(예: 스위치 상태)를 거부한다. */
const settingsBodySchema = z
  .object({ breakerPerMinute: z.number().int().optional(), retentionDaysContent: z.number().int().optional(), retentionDaysAudit: z.number().int().optional() })
  .strict();
/** 채팅 설정 본문. 치지직이 허용하는 값만 통과시켜 쓰기 API 거부를 미리 막는다. */
const chatSettingsBodySchema = z.object({
  chatAvailableCondition: z.enum(["NONE", "REAL_NAME"]),
  chatAvailableGroup: z.enum(["ALL", "FOLLOWER", "MANAGER", "SUBSCRIBER"]),
  minFollowerMinute: z.number().refine((value) => ALLOWED_FOLLOWER_MINUTES.includes(value), "치지직이 허용하지 않는 값입니다"),
  allowSubscriberInFollowerMode: z.boolean(),
  chatSlowModeSec: z.number().refine((value) => ALLOWED_SLOW_MODE_SECONDS.includes(value), "치지직이 허용하지 않는 값입니다"),
  chatEmojiMode: z.boolean(),
});
/**
 * 임시 제한 본문. 판정 ID가 꼭 있어야 하고, 서버가 보낸 사람·채널과 일치하는지 확인한다(S13, M12).
 * 채팅 채널 ID는 받지 않고 저장된 판정에서 읽는다. 왜: 본문 값을 그대로 치지직에 넘기면 매니저가 다른 채팅 채널을 지정할 수 있다.
 * 예전 화면이 보내는 chatChannelId는 zod가 알 수 없는 키로 버린다(따르지 않는다).
 */
const temporaryRestrictBodySchema = z.object({ verdictId: z.number().int().positive() });
/** 활동 제한 본문(본문 자체도 생략 가능). */
const restrictBodySchema = z.object({ verdictId: z.number().int().nullable().optional() }).optional();
/** 푸시 구독 본문. 길이 상한으로 과대 입력을 막는다. */
const pushSubscriptionSchema = z.object({
  endpoint: z.url().max(MAX_PUSH_ENDPOINT_LENGTH),
  keys: z.object({ p256dh: z.string().min(1).max(MAX_PUSH_KEY_LENGTH), auth: z.string().min(1).max(MAX_PUSH_KEY_LENGTH) }),
});
/** 푸시 구독 해제 본문. */
const pushDeleteSchema = z.object({ endpoint: z.string().min(1).max(MAX_PUSH_ENDPOINT_LENGTH) });
/** 감사 기록 조회 쿼리(커서와 페이지 크기). */
const auditQuerySchema = z.object({ beforeId: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
/** 오판 검토 목록 쿼리. 최근 목록의 길이를 감사 기록과 같은 범위(1~200, 기본 50)로 제한한다. */
const falsePositiveQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
/** 통계 조회 쿼리(최근 N분, 최대 24시간). */
const statsQuerySchema = z.object({ sinceMinutes: z.coerce.number().int().min(1).max(1440).default(60) });

/** 권한 확인을 통과한 요청 정보. */
interface GuardedContext {
  request: FastifyRequest;
  reply: FastifyReply;
  manager: ManagerSession;
  channelId: string;
}

/** 로그인·권한·채널 연결을 확인한 뒤 실행하는 핸들러를 만든다. */
function guarded(services: RouteServices, permission: Permission | null, handler: (context: GuardedContext) => unknown) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const manager = request.manager;
    if (!manager) throw new RouteError(401, "unauthorized", "로그인이 필요합니다.");
    if (permission && !hasPermission(manager.role, permission)) {
      throw new RouteError(403, "forbidden", `이 기능을 쓸 권한이 없습니다(${PERMISSION_LABELS[permission]}).`);
    }
    const channel = services.channel();
    if (!channel) throw new RouteError(409, "no_channel", "연결된 채널이 없습니다. 스트리머가 먼저 채널을 연결하세요.");
    return handler({ request, reply, manager, channelId: channel.channelId });
  };
}

/** REST 라우트를 등록한다. */
export function registerApiRoutes(app: FastifyInstance, services: RouteServices, sessions: SessionStore): void {
  registerSessionRoutes(app, services, sessions);
  registerVerdictRoutes(app, services);
  registerSenderRoutes(app, services);
  registerConfigurationRoutes(app, services);
  registerPushRoutes(app, services);
}

/** 세션·상태·티켓·연결 해제. */
function registerSessionRoutes(app: FastifyInstance, services: RouteServices, sessions: SessionStore): void {
  app.post("/api/logout", async (request, reply) => {
    const rawId = request.cookies[SESSION_COOKIE];
    const session = rawId ? sessions.get(rawId) : null;
    if (rawId) sessions.deleteByRawId(rawId);
    if (session) services.endSessions([session.id], "로그아웃했습니다");
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
  app.get("/api/me", guarded(services, null, ({ manager }) => toMe(manager)));
  app.get("/api/status", guarded(services, null, () => services.status()));
  app.post("/api/ws-ticket", guarded(services, null, ({ manager }) => issueTicketAfterRoleCheck(services, sessions, manager)));
  app.post(
    "/api/channel/disconnect",
    guarded(services, "connect_channel", () => {
      services.disconnectChannel();
      return { ok: true };
    }),
  );
}

/** 후보 목록과 판정 조치. */
function registerVerdictRoutes(app: FastifyInstance, services: RouteServices): void {
  app.get("/api/candidates", guarded(services, null, ({ channelId }) => services.verdicts.listRecent(channelId, services.clock() - CANDIDATE_WINDOW_MS)));
  app.post("/api/verdicts/:id/hide", guarded(services, "hide_message", (context) => hideVerdict(services, context)));
  app.post("/api/verdicts/:id/ignore", guarded(services, "hide_message", (context) => markVerdict(services, context, "ignored")));
  app.post("/api/verdicts/:id/false-positive", guarded(services, "hide_message", (context) => markVerdict(services, context, "false_positive")));
  app.get("/api/false-positives", guarded(services, null, (context) => listFalsePositiveReview(services, context)));
}

/**
 * 판정 하나를 숨긴다. 대기 중인 판정만 받고, 보내기 전에 판정을 붙잡아 동시에 누른 요청 중 하나만 실행기로 보낸다(S12, M10).
 * 확인(findVerdict·상태)과 붙잡기 사이에 await가 없어 다른 요청이 끼어들 수 없다.
 * 끝나면 놓되, 결과를 알 수 없으면 놓지 않고 unknown으로 붙잡아 둔다(K1, settleHideClaim).
 * 성공했을 때의 hidden 전이는 실행기가 pending에서만 한다(그사이 오판·제한으로 바뀌었으면 덮지 않는다).
 */
async function hideVerdict(services: RouteServices, { request, reply, manager, channelId }: GuardedContext) {
  const verdict = findVerdict(services, request.params, channelId);
  if (!HIDE_ALLOWED_FROM.includes(verdict.status)) throw new RouteError(409, "already_handled", ALREADY_HANDLED_MESSAGE);
  if (!services.claims.tryClaim(verdict.id, "manager")) throw claimConflict(services, verdict.id);
  let outcome: ActionOutcome | null = null;
  try {
    const target = { chatChannelId: verdict.chatChannelId, messageTime: verdict.messageTime, senderChannelId: verdict.senderChannelId };
    outcome = await services.executor.submit(channelId, { kind: "hide", target, verdictId: verdict.id }, actorOf(manager));
    return sendOutcome(reply, outcome);
  } finally {
    settleHideClaim(services.claims, verdict.id, outcome);
  }
}

/**
 * 이미 붙잡힌 판정에 대한 409 오류를 만든다. 자동 숨김이 붙잡았으면 in_progress와 "곧 반영" 안내, 다른 매니저면 already_handled(N4),
 * 앞선 숨김의 결과를 알 수 없으면 result_unknown과 치지직에서 확인하라는 안내(K1).
 * @param services 붙잡기 모음
 * @param verdictId 판정 번호
 */
function claimConflict(services: RouteServices, verdictId: number): RouteError {
  const holder = services.claims.holderOf(verdictId);
  if (holder === "unknown") return new RouteError(409, "result_unknown", HIDE_RESULT_UNKNOWN_MESSAGE);
  if (holder === "auto_hide") return new RouteError(409, "in_progress", AUTO_HIDE_IN_PROGRESS_MESSAGE);
  return new RouteError(409, "already_handled", ACTION_IN_PROGRESS_MESSAGE);
}

/**
 * 오판 검토 목록(스펙 5.5): 최근 오판 신고 판정과 이유별 건수. 이유에 규칙 번호가 있어 어떤 규칙을 고칠지 보인다.
 * 읽기 전용이라 다른 조회 라우트(/api/candidates·/api/rules)처럼 로그인한 매니저면 누구나 본다.
 */
function listFalsePositiveReview(services: RouteServices, { request, channelId }: GuardedContext): FalsePositiveReviewDto {
  const { limit } = falsePositiveQuerySchema.parse(request.query);
  return { recent: services.verdicts.listFalsePositives(channelId, limit), byReason: services.verdicts.countFalsePositivesByReason(channelId) };
}

/** 사용자 단위 제재. */
function registerSenderRoutes(app: FastifyInstance, services: RouteServices): void {
  app.post(
    "/api/senders/:senderChannelId/temporary-restrict",
    guarded(services, "temporary_restrict", async ({ request, reply, manager, channelId }) => {
      const { senderChannelId } = senderParamSchema.parse(request.params);
      const verdict = findSenderVerdict(services, temporaryRestrictBodySchema.parse(request.body).verdictId, senderChannelId, channelId);
      const action = { kind: "temporary_restrict" as const, targetChannelId: senderChannelId, chatChannelId: verdict.chatChannelId, verdictId: verdict.id };
      return sendOutcome(reply, await services.executor.submit(channelId, action, actorOf(manager)));
    }),
  );
  app.post(
    "/api/senders/:senderChannelId/restrict",
    guarded(services, "restrict", async ({ request, reply, manager, channelId }) => {
      const { senderChannelId } = senderParamSchema.parse(request.params);
      const verdictId = resolveVerdictId(services, restrictBodySchema.parse(request.body)?.verdictId, senderChannelId, channelId);
      return sendOutcome(reply, await services.executor.submit(channelId, { kind: "restrict", targetChannelId: senderChannelId, verdictId }, actorOf(manager)));
    }),
  );
  app.delete(
    "/api/senders/:senderChannelId/restrict",
    guarded(services, "restrict", async ({ request, reply, manager, channelId }) => {
      const { senderChannelId } = senderParamSchema.parse(request.params);
      return sendOutcome(reply, await services.executor.submit(channelId, { kind: "unrestrict", targetChannelId: senderChannelId }, actorOf(manager)));
    }),
  );
}

/** 스위치·규칙·설정·채팅 설정·감사 기록·통계. */
function registerConfigurationRoutes(app: FastifyInstance, services: RouteServices): void {
  app.post("/api/auto-hide", guarded(services, null, (context) => toggleAutoHide(services, context)));
  app.get("/api/rules", guarded(services, null, ({ channelId }) => services.rules.list(channelId)));
  app.post("/api/rules", guarded(services, "edit_rules", (context) => addRule(services, context)));
  app.delete("/api/rules/:id", guarded(services, "edit_rules", (context) => removeRule(services, context)));
  app.get("/api/settings", guarded(services, null, ({ channelId }) => toSettingsDto(services.settings.get(channelId))));
  app.put("/api/settings", guarded(services, "edit_rules", (context) => updateSettings(services, context)));
  app.get("/api/chat-settings", guarded(services, null, () => services.getChatSettings()));
  app.put(
    "/api/chat-settings",
    guarded(services, "edit_chat_settings", async ({ request, reply, manager, channelId }) =>
      sendOutcome(reply, await services.executor.submit(channelId, { kind: "update_chat_settings", settings: chatSettingsBodySchema.parse(request.body) }, actorOf(manager))),
    ),
  );
  app.get(
    "/api/audit",
    guarded(services, "view_audit", ({ request, channelId }) => {
      const query = auditQuerySchema.parse(request.query);
      return services.auditLog.list(channelId, query.limit, query.beforeId ?? null);
    }),
  );
  app.get(
    "/api/stats",
    guarded(services, null, ({ request, channelId }) => services.stats.recent(channelId, services.clock() - statsQuerySchema.parse(request.query).sinceMinutes * 60_000)),
  );
}

/** 푸시 구독. */
function registerPushRoutes(app: FastifyInstance, services: RouteServices): void {
  app.get("/api/push/public-key", guarded(services, null, () => ({ publicKey: services.push.publicKey() })));
  app.post(
    "/api/push/subscriptions",
    guarded(services, null, ({ request, manager }) => {
      services.push.subscribe(manager.managerChannelId, pushSubscriptionSchema.parse(request.body));
      return { ok: true };
    }),
  );
  app.delete(
    "/api/push/subscriptions",
    guarded(services, null, ({ request, manager }) => {
      // 요청한 매니저의 구독만 지운다. 없거나 남의 것이면 아무것도 지우지 않고 똑같이 ok를 준다(구독 존재 여부를 드러내지 않는다).
      services.push.unsubscribe(manager.managerChannelId, pushDeleteSchema.parse(request.body).endpoint);
      return { ok: true };
    }),
  );
}

/**
 * WebSocket을 열기 전에 역할을 다시 확인한다(스펙 7장: 연결할 때와 5분마다).
 * 해임됐으면 세션을 지우고 401, 역할이 바뀌었으면 세션을 갱신한 뒤 티켓을 준다.
 */
async function issueTicketAfterRoleCheck(services: RouteServices, sessions: SessionStore, manager: ManagerSession) {
  const role = await services.verifyRole(manager.managerChannelId);
  if (!role) {
    sessions.deleteById(manager.id);
    services.endSessions([manager.id], "매니저 권한이 해제되었습니다");
    removeRevokedManagerPush(services, manager.managerChannelId);
    throw new RouteError(401, "unauthorized", "치지직에서 매니저 권한이 해제되었습니다. 다시 로그인하세요.");
  }
  if (role !== manager.role) sessions.updateRole(manager.id, role);
  return { ticket: sessions.issueTicket(manager.id) };
}

/**
 * 해임된 매니저의 장애 알림 구독(모든 기기)을 지운다(B19-5). 5분 역할 재확인(app.ts)과 같은 정리를 티켓 경로에서도 한다.
 * 실패해도 해임 처리(세션 삭제·401)는 끝까지 하고 오류만 기록한다: 구독이 남는 것보다 해임이 막히는 편이 더 나쁘다.
 * @param services 푸시 알림기와 기록기
 * @param managerChannelId 해임된 매니저 채널 ID
 */
function removeRevokedManagerPush(services: RouteServices, managerChannelId: string): void {
  try {
    services.push.unsubscribeManager(managerChannelId);
  } catch (error) {
    services.logger.error("해임된 매니저의 장애 알림 구독을 지우지 못했습니다. DB 상태를 확인하세요.", { error: describeError(error) });
  }
}

/** 스위치 켜기·끄기. 켜기와 끄기의 권한이 다르다(끄기는 안전한 방향이라 더 넓게 준다). */
function toggleAutoHide(services: RouteServices, { request, manager, channelId }: GuardedContext) {
  const { enabled } = autoHideBodySchema.parse(request.body);
  const needed: Permission = enabled ? "enable_auto_hide" : "disable_auto_hide";
  if (!hasPermission(manager.role, needed)) throw new RouteError(403, "forbidden", `이 기능을 쓸 권한이 없습니다(${PERMISSION_LABELS[needed]}).`);
  services.autoHide.setEnabled(channelId, enabled, actorOf(manager), "manual");
  return { enabled };
}

/** 규칙을 추가하고 감사 기록을 남긴다. */
function addRule(services: RouteServices, { request, manager, channelId }: GuardedContext) {
  const body = ruleBodySchema.parse(request.body);
  const rule = services.rules.add(channelId, body.kind, body.pattern, manager.managerChannelId);
  recordConfigChange(services, channelId, manager, `rule_add:${body.kind}`);
  return rule;
}

/** 규칙을 지우고 감사 기록을 남긴다. */
function removeRule(services: RouteServices, { request, manager, channelId }: GuardedContext) {
  const { id } = idParamSchema.parse(request.params);
  if (!services.rules.remove(channelId, id)) throw new RouteError(404, "not_found", "해당 규칙이 없습니다. 이미 지워졌을 수 있습니다.");
  recordConfigChange(services, channelId, manager, "rule_remove");
  return { ok: true };
}

/** 설정을 바꾸고 감사 기록을 남긴다. */
function updateSettings(services: RouteServices, { request, manager, channelId }: GuardedContext) {
  const updated = services.settings.update(channelId, settingsBodySchema.parse(request.body));
  recordConfigChange(services, channelId, manager, "settings_update");
  return toSettingsDto(updated);
}

/** 설정 변경 감사 기록. */
function recordConfigChange(services: RouteServices, channelId: string, manager: ManagerSession, action: string): void {
  services.auditLog.record({ channelId, actorType: "manager", actorChannelId: manager.managerChannelId, action, targetSenderChannelId: null, verdictId: null, result: "ok", error: null });
}

/** 판정을 찾는다. 다른 채널의 판정이나 보관 기간이 지난 판정은 404. */
function findVerdict(services: RouteServices, params: unknown, channelId: string) {
  const { id } = idParamSchema.parse(params);
  const verdict = services.verdicts.get(id);
  if (!verdict || verdict.channelId !== channelId) throw new RouteError(404, "not_found", "해당 판정을 찾을 수 없습니다. 보관 기간이 지났을 수 있습니다.");
  return verdict;
}

/**
 * 본문의 판정 ID가 이 채널의 것이고 대상 사용자의 판정인지 확인한다. 판정 ID가 없으면(활동 제한은 선택) null.
 * 왜: 실행기는 판정 상태를 그대로 바꾸고 방송하므로, 다른 사용자·채널의 판정을 가리키면 엉뚱한 기록이 바뀐다.
 */
function resolveVerdictId(services: RouteServices, verdictId: number | null | undefined, senderChannelId: string, channelId: string): number | null {
  if (verdictId === null || verdictId === undefined) return null;
  return findSenderVerdict(services, verdictId, senderChannelId, channelId).id;
}

/**
 * 판정을 찾고, 대상 사용자의 판정인지 확인한다. 임시 제한은 이 판정에서 채팅 채널을 읽는다(S13).
 * @throws RouteError 없거나 다른 채널이면 404, 보낸 사람이 다르면 400
 */
function findSenderVerdict(services: RouteServices, verdictId: number, senderChannelId: string, channelId: string) {
  const verdict = findVerdict(services, { id: verdictId }, channelId);
  if (verdict.senderChannelId !== senderChannelId) throw new RouteError(400, "verdict_mismatch", "판정의 보낸 사람과 대상 사용자가 다릅니다. '다시 불러오기'를 누른 뒤 다시 시도하세요.");
  return verdict;
}

/**
 * 무시·오판으로 표시하고 기록·방송한다. 오판은 해당 규칙을 검토할 근거가 된다.
 * 바꿀 수 있는 이전 상태는 MARK_ALLOWED_FROM이고, 확인과 쓰기를 조건부 UPDATE 한 번으로 해 동시 요청이 서로 덮어쓰지 못한다(S12).
 * 숨기는 중인 판정은 무시로 바꾸지 않는다: 숨김이 성공하면 무시 표시와 실제 조치가 어긋난다.
 * 오판은 숨기는 중에도 받는다: 그 뒤 숨김이 성공해도 실행기가 오판을 hidden으로 덮지 않는다.
 * 숨김 결과를 알 수 없는 판정(unknown)은 무시·오판 모두 받는다(K1): 매니저가 치지직에서 확인한 뒤 카드를 정리할 수 있어야 한다.
 */
function markVerdict(services: RouteServices, { request, manager, channelId }: GuardedContext, status: Extract<VerdictStatus, "ignored" | "false_positive">) {
  const verdict = findVerdict(services, request.params, channelId);
  if (status === "ignored" && isHideInFlight(services.claims, verdict.id)) throw claimConflict(services, verdict.id);
  if (!services.verdicts.transitionStatus(verdict.id, channelId, status, MARK_ALLOWED_FROM[status])) throw new RouteError(409, "already_handled", ALREADY_HANDLED_MESSAGE);
  releaseUnknownClaim(services.claims, verdict.id);
  services.auditLog.record({
    channelId, actorType: "manager", actorChannelId: manager.managerChannelId, action: status,
    targetSenderChannelId: verdict.senderChannelId, verdictId: verdict.id, result: "ok", error: null,
  });
  services.broadcaster.broadcast({ type: "verdict_status", verdictId: verdict.id, status });
  return { ok: true };
}

/**
 * 지금 숨김을 보내는 중인지(매니저·자동 숨김이 붙잡음) 본다. 결과를 알 수 없는 붙잡기(unknown)는 보내는 중이 아니다(K1).
 * @param claims 붙잡기 모음
 * @param verdictId 판정 번호
 */
function isHideInFlight(claims: VerdictClaims, verdictId: number): boolean {
  const holder = claims.holderOf(verdictId);
  return holder === "manager" || holder === "auto_hide";
}

/**
 * 무시·오판으로 정리된 판정의 결과 모름 붙잡기를 놓는다(K1).
 * 왜 놓아도 되나: 판정이 더는 대기 중이 아니어서 숨기기는 상태 확인(HIDE_ALLOWED_FROM)에서 막히고, 놓지 않으면 메모리에 계속 남는다.
 * @param claims 붙잡기 모음
 * @param verdictId 판정 번호
 */
function releaseUnknownClaim(claims: VerdictClaims, verdictId: number): void {
  if (claims.holderOf(verdictId) === "unknown") claims.release(verdictId);
}

/**
 * 실행 결과를 응답으로 바꾼다. 치지직 실패는 502와 이유.
 * 처리 결과를 알 수 없는 실패(시간 초과·연결 끊김·해석할 수 없는 2xx)는 코드를 result_unknown으로 둔다(N4).
 * 왜: 화면이 이 코드를 보고 시간 초과와 같이 60초 동안 같은 버튼을 다시 보내지 않게 한다(치지직이 이미 처리했을 수 있다).
 */
function sendOutcome(reply: FastifyReply, outcome: ActionOutcome) {
  if (outcome.ok) return reply.send({ ok: true, note: outcome.note });
  return reply.code(502).send(errorBody(outcome.isResultUnknown ? "result_unknown" : "chzzk_failed", outcome.message));
}

/** 매니저 행위자. */
function actorOf(manager: ManagerSession): Actor {
  return { type: "manager", channelId: manager.managerChannelId };
}

/** 세션을 MeDto로 바꾼다. */
function toMe(manager: ManagerSession): MeDto {
  const role: ManagerRole = manager.role;
  return { channelId: manager.managerChannelId, channelName: manager.managerChannelName, role, permissions: permissionsFor(role) };
}

/** 스위치 상태를 뺀 설정 DTO. */
function toSettingsDto(settings: ChannelSettings): SettingsDto {
  return { breakerPerMinute: settings.breakerPerMinute, retentionDaysContent: settings.retentionDaysContent, retentionDaysAudit: settings.retentionDaysAudit };
}
