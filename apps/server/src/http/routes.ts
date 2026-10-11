import type { ChatSettingsDto, ManagerRole, MeDto, Permission, ServerStatus, SettingsDto, VerdictStatus } from "@zzirit-guard/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AutoHideSwitch } from "../actions/autoHideSwitch.js";
import type { Broadcaster } from "../actions/decisionHandler.js";
import type { ActionOutcome, Actor, Executor } from "../actions/executor.js";
import type { ConnectedChannel } from "../connection/credentialStore.js";
import type { RuleRepository } from "../detection/ruleRepository.js";
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
  clock: Clock;
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
/** 푸시 구독 주소의 최대 길이. 왜: 저장·로그·전송 비용을 키우는 과대 입력을 막는다(R26). */
const MAX_PUSH_ENDPOINT_LENGTH = 2048;
/** 푸시 구독 키(p256dh·auth)의 최대 길이. 실제 값은 100자 안쪽이라 여유를 두고 제한한다(R26). */
const MAX_PUSH_KEY_LENGTH = 256;

/** 입력 검증 규칙. */
const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const senderParamSchema = z.object({ senderChannelId: z.string().min(1).max(100) });
const autoHideBodySchema = z.object({ enabled: z.boolean() });
const ruleBodySchema = z.object({
  kind: z.enum(["strong", "weak", "exception", "allow", "allow_domain", "threat", "keyword_route"]),
  pattern: z.string().min(1).max(100),
});
const settingsBodySchema = z
  .object({ breakerPerMinute: z.number().int().optional(), retentionDaysContent: z.number().int().optional(), retentionDaysAudit: z.number().int().optional() })
  .strict();
const chatSettingsBodySchema = z.object({
  chatAvailableCondition: z.enum(["NONE", "REAL_NAME"]),
  chatAvailableGroup: z.enum(["ALL", "FOLLOWER", "MANAGER", "SUBSCRIBER"]),
  minFollowerMinute: z.number().refine((value) => ALLOWED_FOLLOWER_MINUTES.includes(value), "치지직이 허용하지 않는 값입니다"),
  allowSubscriberInFollowerMode: z.boolean(),
  chatSlowModeSec: z.number().refine((value) => ALLOWED_SLOW_MODE_SECONDS.includes(value), "치지직이 허용하지 않는 값입니다"),
  chatEmojiMode: z.boolean(),
});
const temporaryRestrictBodySchema = z.object({ chatChannelId: z.string().min(1), verdictId: z.number().int().nullable().optional() });
const restrictBodySchema = z.object({ verdictId: z.number().int().nullable().optional() }).optional();
const pushSubscriptionSchema = z.object({
  endpoint: z.url().max(MAX_PUSH_ENDPOINT_LENGTH),
  keys: z.object({ p256dh: z.string().min(1).max(MAX_PUSH_KEY_LENGTH), auth: z.string().min(1).max(MAX_PUSH_KEY_LENGTH) }),
});
const pushDeleteSchema = z.object({ endpoint: z.string().min(1).max(MAX_PUSH_ENDPOINT_LENGTH) });
const auditQuerySchema = z.object({ beforeId: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
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
    if (rawId) sessions.deleteByRawId(rawId);
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
  app.post(
    "/api/verdicts/:id/hide",
    guarded(services, "hide_message", async ({ request, reply, manager, channelId }) => {
      const verdict = findVerdict(services, request.params, channelId);
      const target = { chatChannelId: verdict.chatChannelId, messageTime: verdict.messageTime, senderChannelId: verdict.senderChannelId };
      return sendOutcome(reply, await services.executor.submit(channelId, { kind: "hide", target, verdictId: verdict.id }, actorOf(manager)));
    }),
  );
  app.post("/api/verdicts/:id/ignore", guarded(services, "hide_message", (context) => markVerdict(services, context, "ignored")));
  app.post("/api/verdicts/:id/false-positive", guarded(services, "hide_message", (context) => markVerdict(services, context, "false_positive")));
}

/** 사용자 단위 제재. */
function registerSenderRoutes(app: FastifyInstance, services: RouteServices): void {
  app.post(
    "/api/senders/:senderChannelId/temporary-restrict",
    guarded(services, "temporary_restrict", async ({ request, reply, manager, channelId }) => {
      const { senderChannelId } = senderParamSchema.parse(request.params);
      const body = temporaryRestrictBodySchema.parse(request.body);
      const action = { kind: "temporary_restrict" as const, targetChannelId: senderChannelId, chatChannelId: body.chatChannelId, verdictId: body.verdictId ?? null };
      return sendOutcome(reply, await services.executor.submit(channelId, action, actorOf(manager)));
    }),
  );
  app.post(
    "/api/senders/:senderChannelId/restrict",
    guarded(services, "restrict", async ({ request, reply, manager, channelId }) => {
      const { senderChannelId } = senderParamSchema.parse(request.params);
      const verdictId = restrictBodySchema.parse(request.body)?.verdictId ?? null;
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
    guarded(services, null, ({ request }) => {
      services.push.unsubscribe(pushDeleteSchema.parse(request.body).endpoint);
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
    throw new RouteError(401, "unauthorized", "치지직에서 매니저 권한이 해제되었습니다. 다시 로그인하세요.");
  }
  if (role !== manager.role) sessions.updateRole(manager.id, role);
  return { ticket: sessions.issueTicket(manager.id) };
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

/** 무시·오판으로 표시하고 기록·방송한다. 오판은 해당 규칙을 검토할 근거가 된다. */
function markVerdict(services: RouteServices, { request, manager, channelId }: GuardedContext, status: Extract<VerdictStatus, "ignored" | "false_positive">) {
  const verdict = findVerdict(services, request.params, channelId);
  services.verdicts.updateStatus(verdict.id, status);
  services.auditLog.record({
    channelId, actorType: "manager", actorChannelId: manager.managerChannelId, action: status,
    targetSenderChannelId: verdict.senderChannelId, verdictId: verdict.id, result: "ok", error: null,
  });
  services.broadcaster.broadcast({ type: "verdict_status", verdictId: verdict.id, status });
  return { ok: true };
}

/** 실행 결과를 응답으로 바꾼다. 치지직 실패는 502와 이유. */
function sendOutcome(reply: FastifyReply, outcome: ActionOutcome) {
  if (outcome.ok) return reply.send({ ok: true, note: outcome.note });
  return reply.code(502).send(errorBody("chzzk_failed", outcome.message));
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
