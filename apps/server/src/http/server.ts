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
import { REQUEST_MARKER_HEADER, SESSION_COOKIE } from "./constants.js";
import { errorBody, sendError } from "./errors.js";
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
  await app.register(fastifyWebsocket);
  app.decorateRequest("manager", null);
  app.addHook("onRequest", async (request) => {
    const rawId = request.cookies[SESSION_COOKIE];
    request.manager = rawId ? deps.sessions.get(rawId) : null;
  });
  app.addHook("preHandler", async (request, reply) => rejectCrossSite(deps.config.publicOrigin, request, reply));
  app.addHook("onSend", async (_request, reply, payload) => applySecurityHeaders(reply, deps.config.publicOrigin, payload));
  app.setErrorHandler((error, _request, reply) => sendError(deps.logger, error, reply));
  registerAuthRoutes(app, deps);
  registerWebSocket(app, deps);
  registerApiRoutes(app, deps.services, deps.sessions);
  await registerStatic(app, deps.config.webDistDirectory);
  return app;
}

/** /api의 상태 변경 요청은 표식 헤더가 있고 출처가 같아야 한다(CSRF 방지, 스펙 8장). */
async function rejectCrossSite(publicOrigin: string, request: FastifyRequest, reply: FastifyReply) {
  if (!request.url.startsWith("/api/") || SAFE_METHODS.has(request.method)) return;
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

/** 치지직 OAuth 시작·콜백. */
function registerAuthRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.get("/auth/connect", async (_request, reply) => reply.redirect(deps.authFlow.authorizeUrl("connect")));
  app.get("/auth/login", async (_request, reply) => reply.redirect(deps.authFlow.authorizeUrl("login")));
  app.get(CALLBACK_PATH, async (request, reply) => completeLogin(deps, request, reply));
}

/** 콜백 처리: 성공하면 세션 쿠키를 주고 첫 화면으로, 실패하면 이유를 쿼리에 담아 첫 화면으로 보낸다. */
async function completeLogin(deps: HttpDeps, request: FastifyRequest, reply: FastifyReply) {
  const query = callbackQuerySchema.safeParse(request.query);
  if (!query.success) return reply.redirect(`/?loginError=${encodeURIComponent("치지직에서 돌아온 값이 없습니다. 다시 시도하세요.")}`);
  try {
    const { rawId } = await deps.authFlow.complete(query.data.code, query.data.state);
    reply.setCookie(SESSION_COOKIE, rawId, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_MS / 1000 });
    return reply.redirect("/");
  } catch (error) {
    if (!(error instanceof AuthError)) deps.logger.error("로그인 처리 실패", { error: describeError(error) });
    const message = error instanceof AuthError ? error.message : "로그인 중 오류가 발생했습니다. 잠시 뒤 다시 시도하세요.";
    return reply.redirect(`/?loginError=${encodeURIComponent(message)}`);
  }
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
    if (request.url.startsWith("/api/") || request.url.startsWith("/auth/") || request.url.startsWith("/ws")) {
      return reply.code(404).send(errorBody("not_found", "없는 주소입니다."));
    }
    return reply.sendFile("index.html");
  });
}
