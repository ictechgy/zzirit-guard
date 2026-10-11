// 테스트용 가짜 치지직. 공식 문서의 경로·봉투({code, message, content})·권한 규칙(쓰기는 스트리머만)을 흉내 낸다.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import SocketIO from "socket.io";
import type { ChatSettingsDto } from "@zzirit-guard/shared";

/** 가짜 치지직 계정. */
export interface FakeUser {
  channelId: string;
  channelName: string;
}

/** 가짜 서버가 받은 API 호출 기록. */
export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  token: string | null;
  body: unknown;
}

/** 테스트에서 조작하는 가짜 치지직. */
export interface FakeChzzk {
  baseUrl: string;
  owner: FakeUser;
  streamingRoles: Array<{ managerChannelId: string; managerChannelName: string; userRole: string }>;
  chatSettings: ChatSettingsDto;
  calls: RecordedCall[];
  failNext(path: string, status: number, times?: number): void;
  grantCode(user: FakeUser): string;
  issueTokens(user: FakeUser): { accessToken: string; refreshToken: string };
  emitChat(payload: unknown): void;
  emitSystem(payload: unknown): void;
  subscribedSessionCount(): number;
  dropAllSockets(): void;
  close(): Promise<void>;
}

/** 무작위 토큰 문자열. */
function randomToken(): string {
  return randomBytes(12).toString("hex");
}

/** 가짜 치지직 서버를 임의 포트에 띄운다. */
export async function startFakeChzzk(): Promise<FakeChzzk> {
  const state = createState();
  const server = createServer((request, response) => void handleRequest(state, request, response));
  const io = SocketIO(server);
  io.on("connection", (socket) => handleSocket(state, socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return buildHandle(state, () => closeAll(io, server));
}

/** 가짜 서버 내부 상태. */
interface FakeState {
  baseUrl: string;
  owner: FakeUser;
  accessTokens: Map<string, FakeUser>;
  refreshTokens: Map<string, FakeUser>;
  codes: Map<string, FakeUser>;
  streamingRoles: FakeChzzk["streamingRoles"];
  chatSettings: ChatSettingsDto;
  calls: RecordedCall[];
  failures: Map<string, { status: number; remaining: number }>;
  sockets: Map<string, SocketIO.Socket>;
  subscribed: Set<string>;
}

/** 기본 상태: 스트리머 1명, 관리자 목록은 비어 있음. */
function createState(): FakeState {
  return {
    baseUrl: "",
    owner: { channelId: "owner-channel", channelName: "스트리머" },
    accessTokens: new Map(),
    refreshTokens: new Map(),
    codes: new Map(),
    streamingRoles: [],
    chatSettings: {
      chatAvailableCondition: "NONE", chatAvailableGroup: "ALL", minFollowerMinute: 0,
      allowSubscriberInFollowerMode: false, chatSlowModeSec: 0, chatEmojiMode: false,
    },
    calls: [],
    failures: new Map(),
    sockets: new Map(),
    subscribed: new Set(),
  };
}

/** 테스트에 넘길 조작 핸들. state를 직접 공유해 테스트가 값을 바꿀 수 있다. */
function buildHandle(state: FakeState, close: () => Promise<void>): FakeChzzk {
  return {
    get baseUrl() { return state.baseUrl; },
    owner: state.owner,
    streamingRoles: state.streamingRoles,
    get chatSettings() { return state.chatSettings; },
    calls: state.calls,
    failNext: (path, status, times = 1) => void state.failures.set(path, { status, remaining: times }),
    grantCode: (user) => grantCode(state, user),
    issueTokens: (user) => issueTokens(state, user),
    emitChat: (payload) => state.subscribed.forEach((key) => state.sockets.get(key)?.emit("CHAT", payload)),
    emitSystem: (payload) => state.sockets.forEach((socket) => socket.emit("SYSTEM", payload)),
    subscribedSessionCount: () => state.subscribed.size,
    dropAllSockets: () => state.sockets.forEach((socket) => socket.disconnect(true)),
    close,
  };
}

/** 인증 코드를 발급한다(account-interlock 리다이렉트를 흉내 냄). */
function grantCode(state: FakeState, user: FakeUser): string {
  const code = randomToken();
  state.codes.set(code, user);
  return code;
}

/** 토큰 쌍을 발급한다. refresh token은 한 번 쓰면 사라진다(일회용). */
function issueTokens(state: FakeState, user: FakeUser): { accessToken: string; refreshToken: string } {
  const tokens = { accessToken: randomToken(), refreshToken: randomToken() };
  state.accessTokens.set(tokens.accessToken, user);
  state.refreshTokens.set(tokens.refreshToken, user);
  return tokens;
}

/** HTTP 요청 하나를 처리한다. */
async function handleRequest(state: FakeState, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://fake");
  const call = await recordCall(state, request, url);
  const failure = state.failures.get(url.pathname);
  if (failure && failure.remaining > 0) {
    failure.remaining -= 1;
    return sendError(response, failure.status, "INJECTED_FAILURE");
  }
  routeRequest(state, call, response);
}

/** 요청 본문과 토큰을 읽어 기록한다. */
async function recordCall(state: FakeState, request: IncomingMessage, url: URL): Promise<RecordedCall> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const authorization = request.headers.authorization ?? "";
  const call: RecordedCall = {
    method: request.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    token: authorization.startsWith("Bearer ") ? authorization.slice(7) : null,
    body: raw ? JSON.parse(raw) : null,
  };
  state.calls.push(call);
  return call;
}

/** 경로별 응답. 스트리머 전용 쓰기 API는 소유자 토큰이 아니면 400을 준다(실제 동작과 같음). */
function routeRequest(state: FakeState, call: RecordedCall, response: ServerResponse): void {
  const key = `${call.method} ${call.path}`;
  if (key === "POST /auth/v1/token") return handleToken(state, call, response);
  const user = call.token ? state.accessTokens.get(call.token) : undefined;
  if (!user) return sendError(response, 401, "INVALID_TOKEN");
  const isOwner = user.channelId === state.owner.channelId;
  if (key === "GET /open/v1/users/me") return sendContent(response, user);
  if (key === "GET /open/v1/sessions/auth") return sendContent(response, { url: `${state.baseUrl}?auth=${call.token}` });
  if (key === "POST /open/v1/sessions/events/subscribe/chat") return handleSubscribe(state, call, response);
  if (key === "GET /open/v1/channels/streaming-roles") return sendContent(response, { data: state.streamingRoles });
  if (key === "GET /open/v1/chats/settings") return sendContent(response, state.chatSettings);
  if (!isOwner) return sendError(response, 400, "스트리머가 아닙니다");
  return handleOwnerWrite(state, key, call, response);
}

/** 스트리머 전용 쓰기 API. 성공 시 내용 없이 200을 준다. */
function handleOwnerWrite(state: FakeState, key: string, call: RecordedCall, response: ServerResponse): void {
  const writeKeys = [
    "POST /open/v1/chats/blind-message", "POST /open/v1/temporary-restrict-channels",
    "POST /open/v1/restrict-channels", "DELETE /open/v1/restrict-channels",
  ];
  if (key === "PUT /open/v1/chats/settings") {
    state.chatSettings = call.body as ChatSettingsDto;
    return sendContent(response, null);
  }
  if (writeKeys.includes(key)) return sendContent(response, null);
  sendError(response, 404, "NOT_FOUND");
}

/** 토큰 발급·갱신. 갱신에 쓴 refresh token은 즉시 지운다. */
function handleToken(state: FakeState, call: RecordedCall, response: ServerResponse): void {
  const body = call.body as Record<string, string>;
  const source = body.grantType === "authorization_code" ? state.codes : state.refreshTokens;
  const lookupKey = body.grantType === "authorization_code" ? body.code : body.refreshToken;
  const user = lookupKey ? source.get(lookupKey) : undefined;
  if (!user || body.clientSecret !== "test-secret") return sendError(response, 401, "INVALID_TOKEN");
  source.delete(lookupKey as string);
  sendContent(response, { ...issueTokens(state, user), tokenType: "Bearer", expiresIn: "86400" });
}

/** 채팅 구독. 해당 세션 소켓으로 subscribed 시스템 메시지를 보낸다. */
function handleSubscribe(state: FakeState, call: RecordedCall, response: ServerResponse): void {
  const sessionKey = call.query.sessionKey ?? "";
  const socket = state.sockets.get(sessionKey);
  if (!socket) return sendError(response, 400, "잘못된 값을 입력했습니다.");
  state.subscribed.add(sessionKey);
  sendContent(response, null);
  socket.emit("SYSTEM", { type: "subscribed", data: { eventType: "CHAT", channelId: state.owner.channelId } });
}

/** 소켓 연결: auth 쿼리의 토큰을 확인하고 connected 시스템 메시지를 보낸다. */
function handleSocket(state: FakeState, socket: SocketIO.Socket): void {
  const token = String(socket.handshake.query.auth ?? "");
  if (!state.accessTokens.has(token)) {
    socket.disconnect(true);
    return;
  }
  const sessionKey = randomToken();
  state.sockets.set(sessionKey, socket);
  socket.on("disconnect", () => {
    state.sockets.delete(sessionKey);
    state.subscribed.delete(sessionKey);
  });
  socket.emit("SYSTEM", { type: "connected", data: { sessionKey } });
}

/** 성공 봉투로 응답한다. */
function sendContent(response: ServerResponse, content: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ code: 200, message: null, content }));
}

/** 실패 봉투로 응답한다. */
function sendError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ code: status, message }));
}

/** 소켓 서버와 HTTP 서버를 닫는다. */
async function closeAll(io: SocketIO.Server, server: ReturnType<typeof createServer>): Promise<void> {
  io.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
