import { existsSync } from "node:fs";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { RealtimeEvent } from "@zzirit-guard/shared";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { describeError, type Logger } from "../logger.js";
import { AuthError, CALLBACK_PATH, type AuthFlow } from "../managers/authFlow.js";
import { SESSION_TTL_MS, type ManagerSession, type SessionStore } from "../managers/sessionStore.js";
import type { RealtimeHub, SocketSink } from "../realtime/hub.js";
import { OAUTH_STATE_COOKIE, REQUEST_MARKER_HEADER, SESSION_COOKIE } from "./constants.js";
import { errorBody, sendError } from "./errors.js";
import { createTokenBucket, type TokenBucket } from "./rateLimiter.js";
import { registerApiRoutes, type RouteServices } from "./routes.js";

declare module "fastify" {
  interface FastifyRequest {
    /** 쿠키로 확인한 매니저 세션(없으면 null). */
    manager: ManagerSession | null;
  }
}

/** buildHttpServer 의존성. */
export interface HttpDeps {
  config: Pick<AppConfig, "publicOrigin" | "webDistDirectory">;
  sessions: SessionStore;
  authFlow: AuthFlow;
  hub: RealtimeHub;
  services: RouteServices;
  logger: Logger;
}

/** 부작용이 없는 메서드. CSRF 검사에서 뺀다. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
/** 잘못된 티켓으로 WebSocket을 열었을 때의 닫기 코드. */
const UNAUTHORIZED_CLOSE_CODE = 4003;
/** 콜백 쿼리. */
const callbackQuerySchema = z.object({ code: z.string().min(1), state: z.string().min(1) });

/** Fastify 서버를 만든다(아직 listen하지 않는다). */
export async function buildHttpServer(deps: HttpDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  // 서버는 클라이언트 메시지를 읽지 않으므로 수신 크기를 최소로 제한한다.
  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 } });
  app.decorateRequest("manager", null);
  app.addHook("onRequest", async (request) => {
    const rawId = request.cookies[SESSION_COOKIE];
    request.manager = rawId ? deps.sessions.get(rawId) : null;
  });
  app.addHook("onRequest", async (request, reply) => rejectCrossSite(deps.config.publicOrigin, request, reply));
  app.addHook("onSend", async (_request, reply, payload) => applySecurityHeaders(reply, deps.config.publicOrigin, payload));
  app.setErrorHandler((error, _request, reply) => sendError(deps.logger, error, reply));
  registerAuthRoutes(app, deps);
  registerWebSocket(app, deps);
  registerApiRoutes(app, deps.services, deps.sessions);
  await registerStatic(app, deps.config.webDistDirectory);
  return app;
}

/**
 * 상태 변경 요청은 경로와 상관없이 표식 헤더가 있고 출처가 같아야 한다(CSRF 방지, 스펙 8장).
 * 왜 경로를 보지 않나: 원본 URL은 "/%61pi/"처럼 인코딩될 수 있어 접두사 검사를 우회하며, /api 밖에는 상태 변경 라우트가 없다.
 * onRequest에서 검사해 본문 파싱 전에 거절한다.
 */
async function rejectCrossSite(publicOrigin: string, request: FastifyRequest, reply: FastifyReply) {
  if (SAFE_METHODS.has(request.method)) return;
  const origin = request.headers.origin;
  if (request.headers[REQUEST_MARKER_HEADER] === "1" && (origin === undefined || origin === publicOrigin)) return;
  return reply.code(403).send(errorBody("cross_site", "요청 출처를 확인할 수 없습니다. 앱을 새로고침한 뒤 다시 시도하세요."));
}

/** 보안 헤더: CSP(스크립트는 같은 출처만, 인라인 스크립트 금지), MIME 추측 금지, 리퍼러 숨김. */
async function applySecurityHeaders(reply: FastifyReply, publicOrigin: string, payload: unknown) {
  const websocketOrigin = publicOrigin.replace(/^http/, "ws");
  reply.header(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${websocketOrigin}; frame-ancestors 'none'; base-uri 'none'`,
  );
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  return payload;
}

/**
 * /auth/* 전체가 1분에 받을 요청 수(30). 로그인 시작·콜백은 사람이 가끔 누르는 것이라 넉넉하다.
 * 왜: 콜백은 인증 없이 치지직 토큰 발급 API를 부르게 하므로, 한도가 없으면 누구나 서버를 시켜 치지직을 무한히 호출할 수 있다(F6).
 */
const AUTH_RATE_LIMIT_PER_MINUTE = 30;
/** 한도를 다시 채우는 기준 시간(1분). 이 시간 동안 AUTH_RATE_LIMIT_PER_MINUTE개가 연속으로 채워진다. */
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
/** 한도를 넘었을 때의 안내 문구. */
const RATE_LIMITED_MESSAGE = "요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.";

/**
 * 치지직 OAuth 시작·콜백. 세 경로가 전역 요청 한도 하나를 함께 쓴다.
 * 왜 IP별이 아니라 전역인가: Tailscale Funnel 뒤에서는 모든 요청이 127.0.0.1에서 온 것처럼 보여 IP로 나눌 수 없다.
 */
function registerAuthRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const bucket = createTokenBucket({
    capacity: AUTH_RATE_LIMIT_PER_MINUTE, refillPerMs: AUTH_RATE_LIMIT_PER_MINUTE / AUTH_RATE_LIMIT_WINDOW_MS, clock: deps.services.clock,
  });
  const onRequest = async (_request: FastifyRequest, reply: FastifyReply) => rejectOverLimit(bucket, reply);
  app.get("/auth/connect", { onRequest }, async (_request, reply) => startAuthorization(deps, reply, "connect"));
  app.get("/auth/login", { onRequest }, async (_request, reply) => startAuthorization(deps, reply, "login"));
  app.get(CALLBACK_PATH, { onRequest }, async (request, reply) => completeLogin(deps, request, reply));
}

/**
 * 버킷이 비었으면 429와 이유를 보내 핸들러까지 가지 않게 한다. 세 경로 모두 같은 JSON 응답을 쓴다.
 * @param bucket 인증 경로 전역 버킷
 * @param reply 응답
 * @returns 거절했으면 보낸 응답, 통과면 undefined
 */
async function rejectOverLimit(bucket: TokenBucket, reply: FastifyReply) {
  if (bucket.tryTake()) return;
  return reply.code(429).send(errorBody("rate_limited", RATE_LIMITED_MESSAGE));
}

/** state 쿠키 수명(10분). 인증 페이지에서 머무는 시간보다 넉넉하다. */
const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 600;
/** state 쿠키 범위. 인증 경로에서만 보낸다. */
const OAUTH_STATE_COOKIE_PATH = "/auth";
/** state 쿠키가 없거나 다를 때의 안내 문구. */
const STATE_MISMATCH_MESSAGE = "로그인 요청이 만료되었거나 다른 브라우저에서 시작되었습니다. 처음부터 다시 시도하세요.";

/** 인증 URL의 state를 이 브라우저의 쿠키에 묶고 치지직으로 보낸다(로그인 CSRF 방지). */
function startAuthorization(deps: HttpDeps, reply: FastifyReply, purpose: "connect" | "login") {
  const url = deps.authFlow.authorizeUrl(purpose);
  const state = new URL(url).searchParams.get("state");
  if (state) reply.setCookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: "lax", path: OAUTH_STATE_COOKIE_PATH, maxAge: OAUTH_STATE_COOKIE_MAX_AGE_SECONDS });
  return reply.redirect(url);
}

/** 콜백 처리: 성공하면 세션 쿠키를 주고 첫 화면으로, 실패하면 이유를 쿼리에 담아 첫 화면으로 보낸다. */
async function completeLogin(deps: HttpDeps, request: FastifyRequest, reply: FastifyReply) {
  const query = callbackQuerySchema.safeParse(request.query);
  if (!query.success) return reply.redirect(`/?loginError=${encodeURIComponent("치지직에서 돌아온 값이 없습니다. 다시 시도하세요.")}`);
  const boundState = request.cookies[OAUTH_STATE_COOKIE];
  reply.clearCookie(OAUTH_STATE_COOKIE, { path: OAUTH_STATE_COOKIE_PATH });
  if (!boundState || boundState !== query.data.state) return reply.redirect(`/?loginError=${encodeURIComponent(STATE_MISMATCH_MESSAGE)}`);
  try {
    const { rawId } = await deps.authFlow.complete(query.data.code, query.data.state);
    rotateExistingSession(deps, request);
    reply.setCookie(SESSION_COOKIE, rawId, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_MS / 1000 });
    return reply.redirect("/");
  } catch (error) {
    if (!(error instanceof AuthError)) deps.logger.error("로그인 처리 실패", { error: describeError(error) });
    const message = error instanceof AuthError ? error.message : "로그인 중 오류가 발생했습니다. 잠시 뒤 다시 시도하세요.";
    return reply.redirect(`/?loginError=${encodeURIComponent(message)}`);
  }
}

/** 로그인 성공 시 이전 세션을 지우고 그 소켓을 닫는다(세션 고정 방지). */
function rotateExistingSession(deps: HttpDeps, request: FastifyRequest): void {
  const oldRawId = request.cookies[SESSION_COOKIE];
  const oldSession = oldRawId ? deps.sessions.get(oldRawId) : null;
  if (!oldRawId || !oldSession) return;
  deps.sessions.deleteByRawId(oldRawId);
  deps.services.endSessions([oldSession.id], "새로 로그인했습니다");
}

/** WebSocket: 일회용 티켓과 출처를 확인한 뒤 허브에 붙이고 현재 상태를 보낸다. */
function registerWebSocket(app: FastifyInstance, deps: HttpDeps): void {
  app.get("/ws", { websocket: true }, (socket, request) => {
    const ticket = (request.query as { ticket?: unknown }).ticket;
    const session = typeof ticket === "string" ? deps.sessions.redeemTicket(ticket) : null;
    const origin = request.headers.origin;
    if (!session || (origin !== undefined && origin !== deps.config.publicOrigin)) {
      socket.close(UNAUTHORIZED_CLOSE_CODE, "unauthorized");
      return;
    }
    deps.hub.attach(toSocketSink(socket), session);
    socket.send(JSON.stringify({ type: "status", status: deps.services.status() } satisfies RealtimeEvent));
  });
}

/**
 * ws 소켓을 허브가 쓰는 최소 형태로 감싼다(ws의 겹친 on 시그니처와 타입을 분리).
 * bufferedAmount를 넘기는 이유: 허브의 느린 연결 정리는 이 값으로 판단하므로, 빠지면 실제 소켓에서 영영 동작하지 않는다(R26).
 */
export function toSocketSink(socket: WebSocket): SocketSink {
  return {
    get readyState() {
      return socket.readyState;
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    on: (_event, listener) => socket.on("close", listener),
  };
}

/** PWA 정적 파일. 빌드 결과가 없으면(서버만 테스트할 때) 건너뛴다. 알 수 없는 화면 경로는 index.html로 보낸다. */
async function registerStatic(app: FastifyInstance, directory: string): Promise<void> {
  if (!existsSync(directory)) return;
  await app.register(fastifyStatic, { root: directory, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (!["GET", "HEAD"].includes(request.method) || request.url.startsWith("/api/") || request.url.startsWith("/auth/") || request.url.startsWith("/ws")) {
      return reply.code(404).send(errorBody("not_found", "없는 주소입니다."));
    }
    return reply.sendFile("index.html");
  });
}
