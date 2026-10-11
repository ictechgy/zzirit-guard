import type { ChatSettingsDto } from "@zzirit-guard/shared";
import { z } from "zod";

/** 치지직 API 오류. status는 HTTP 상태, apiMessage는 치지직이 준 메시지다. */
export class ChzzkApiError extends Error {
  override readonly name = "ChzzkApiError";
  readonly status: number;
  readonly apiMessage: string;
  readonly path: string;

  constructor(status: number, apiMessage: string, path: string) {
    super(`치지직 API 오류 ${status} (${path}): ${apiMessage}`);
    this.status = status;
    this.apiMessage = apiMessage;
    this.path = path;
  }
}

/** 발급·갱신된 토큰 쌍. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

/** GET /open/v1/users/me 결과. */
export interface ChzzkUser {
  channelId: string;
  channelName: string;
}

/** GET /open/v1/channels/streaming-roles의 항목. */
export interface StreamingRole {
  managerChannelId: string;
  managerChannelName: string;
  userRole: string;
}

/** 숨길 메시지를 가리키는 값. 채팅 이벤트에 모두 들어 있다. */
export interface MessageTarget {
  chatChannelId: string;
  messageTime: number;
  senderChannelId: string;
}

/** 서버가 쓰는 치지직 Open API 묶음. 토큰을 인자로 받아 호출자가 어떤 토큰을 쓸지 정한다. */
export interface ChzzkApi {
  exchangeCode(code: string, state: string): Promise<TokenSet>;
  refreshToken(refreshToken: string): Promise<TokenSet>;
  getMe(accessToken: string): Promise<ChzzkUser>;
  getStreamingRoles(accessToken: string): Promise<StreamingRole[]>;
  createSessionUrl(accessToken: string): Promise<string>;
  subscribeChat(accessToken: string, sessionKey: string): Promise<void>;
  blindMessage(accessToken: string, target: MessageTarget): Promise<void>;
  addTemporaryRestriction(accessToken: string, targetChannelId: string, chatChannelId: string): Promise<void>;
  addRestriction(accessToken: string, targetChannelId: string): Promise<void>;
  removeRestriction(accessToken: string, targetChannelId: string): Promise<void>;
  getChatSettings(accessToken: string): Promise<ChatSettingsDto>;
  updateChatSettings(accessToken: string, settings: ChatSettingsDto): Promise<void>;
}

/** createChzzkApi 옵션. fetchFunction은 테스트에서 바꿔 끼우려고 둔다. */
export interface ChzzkApiOptions {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  fetchFunction?: typeof fetch;
  timeoutMs?: number;
}

/** 토큰 응답. 문서에 expiresIn이 String으로 적혀 있어 숫자·문자 모두 받되, NaN·0·음수는 거부한다. */
const tokenSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.union([z.string(), z.number()]).transform(Number).pipe(z.number().finite().positive()),
});
/** 사용자 정보 응답. */
const userSchema = z.object({ channelId: z.string(), channelName: z.string() });
/** 관리자 목록 응답. */
const rolesSchema = z.object({
  data: z.array(z.object({ managerChannelId: z.string(), managerChannelName: z.string(), userRole: z.string() })),
});
/** 세션 생성 응답. */
const sessionSchema = z.object({ url: z.string() });
/** 채팅 설정 응답. */
const chatSettingsSchema = z.object({
  chatAvailableCondition: z.enum(["NONE", "REAL_NAME"]),
  chatAvailableGroup: z.enum(["ALL", "FOLLOWER", "MANAGER", "SUBSCRIBER"]),
  minFollowerMinute: z.number(),
  allowSubscriberInFollowerMode: z.boolean(),
  chatSlowModeSec: z.number(),
  chatEmojiMode: z.boolean(),
});

/** HTTP 메서드. */
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
/** 호출 1건의 토큰·본문. */
interface CallOptions {
  token?: string;
  body?: unknown;
}
/** 봉투를 벗긴 content를 돌려주는 호출 함수. */
type Caller = (method: HttpMethod, path: string, callOptions: CallOptions) => Promise<unknown>;

/** 치지직 API 클라이언트를 만든다. */
export function createChzzkApi(options: ChzzkApiOptions): ChzzkApi {
  const call = createCaller(options);
  return {
    exchangeCode: (code, state) => requestTokens(call, options, { grantType: "authorization_code", code, state }),
    refreshToken: (refreshToken) => requestTokens(call, options, { grantType: "refresh_token", refreshToken }),
    getMe: async (token) => callParsed(call, userSchema, "GET", "/open/v1/users/me", { token }),
    getStreamingRoles: async (token) => (await callParsed(call, rolesSchema, "GET", "/open/v1/channels/streaming-roles", { token })).data,
    createSessionUrl: async (token) => (await callParsed(call, sessionSchema, "GET", "/open/v1/sessions/auth", { token })).url,
    subscribeChat: (token, sessionKey) => discard(call("POST", `/open/v1/sessions/events/subscribe/chat?sessionKey=${encodeURIComponent(sessionKey)}`, { token })),
    blindMessage: (token, target) => discard(call("POST", "/open/v1/chats/blind-message", { token, body: target })),
    addTemporaryRestriction: (token, targetChannelId, chatChannelId) =>
      discard(call("POST", "/open/v1/temporary-restrict-channels", { token, body: { targetChannelId, chatChannelId } })),
    addRestriction: (token, targetChannelId) => discard(call("POST", "/open/v1/restrict-channels", { token, body: { targetChannelId } })),
    removeRestriction: (token, targetChannelId) => discard(call("DELETE", "/open/v1/restrict-channels", { token, body: { targetChannelId } })),
    getChatSettings: async (token) => callParsed(call, chatSettingsSchema, "GET", "/open/v1/chats/settings", { token }),
    updateChatSettings: (token, settings) => discard(call("PUT", "/open/v1/chats/settings", { token, body: settings })),
  };
}

/**
 * 호출 후 content를 스키마로 검증한다. 형식이 다르면 raw ZodError 대신 502 ChzzkApiError를 던진다.
 * 호출자가 ChzzkApiError.status만으로 실패를 분류할 수 있게 하려는 것이다.
 */
async function callParsed<T>(call: Caller, schema: z.ZodType<T>, method: HttpMethod, path: string, callOptions: CallOptions): Promise<T> {
  const result = schema.safeParse(await call(method, path, callOptions));
  if (!result.success) throw new ChzzkApiError(502, `UNEXPECTED_RESPONSE: ${summarizeIssues(result.error)}`, path);
  return result.data;
}

/** zod 오류를 "필드: 사유" 목록으로 줄인다. 입력 값(토큰 등)은 넣지 않는다. */
function summarizeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/** 결과 값이 필요 없는 호출을 Promise<void>로 바꾼다. */
async function discard(promise: Promise<unknown>): Promise<void> {
  await promise;
}

/** 토큰 발급·갱신 공통 처리. clientId·clientSecret은 본문으로 보낸다(문서 규격). */
async function requestTokens(call: Caller, options: ChzzkApiOptions, grant: Record<string, string>): Promise<TokenSet> {
  const body = { ...grant, clientId: options.clientId, clientSecret: options.clientSecret };
  const parsed = await callParsed(call, tokenSchema, "POST", "/auth/v1/token", { body });
  return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresInSeconds: parsed.expiresIn };
}

/** fetch로 요청하고 봉투를 벗기는 호출 함수를 만든다. */
function createCaller(options: ChzzkApiOptions): Caller {
  const fetchFunction = options.fetchFunction ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (method, path, callOptions) => {
    const response = await fetchFunction(options.apiBase + path, buildRequestInit(method, callOptions, timeoutMs));
    return unwrapEnvelope(response, path);
  };
}

/** 헤더·본문·제한 시간을 붙인다. 토큰은 "Bearer " 뒤에 공백 하나를 두어야 한다(문서 주의사항). */
function buildRequestInit(method: HttpMethod, callOptions: CallOptions, timeoutMs: number): RequestInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (callOptions.token) headers.Authorization = `Bearer ${callOptions.token}`;
  const body = callOptions.body === undefined ? undefined : JSON.stringify(callOptions.body);
  return { method, headers, body, signal: AbortSignal.timeout(timeoutMs) };
}

/** 응답 봉투를 해석한다. 실패면 ChzzkApiError를 던지고, 성공이면 content를 돌려준다(없으면 undefined). */
async function unwrapEnvelope(response: Response, path: string): Promise<unknown> {
  const envelope = parseJsonOrNull(await response.text(), path, response.ok);
  const bodyCode = isRecord(envelope) && typeof envelope.code === "number" ? envelope.code : response.status;
  if (!response.ok || bodyCode >= 400) {
    const message = isRecord(envelope) && typeof envelope.message === "string" ? envelope.message : response.statusText;
    throw new ChzzkApiError(response.ok ? bodyCode : response.status, message, path);
  }
  return isRecord(envelope) ? envelope.content : undefined;
}

/**
 * 빈 본문은 null로 본다(blind-message는 본문 없이 200을 줄 수 있다).
 * 성공 상태인데 JSON이 아니면(예: 프록시의 HTML 페이지) 성공으로 오인하지 않도록 502로 던진다.
 */
function parseJsonOrNull(text: string, path: string, isSuccessStatus: boolean): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // 실패 상태(429 등)의 비JSON 본문은 원래 상태 코드를 살려야 하므로 null로 두어 호출부가 status로 오류를 만든다.
    if (!isSuccessStatus) return null;
    throw new ChzzkApiError(502, "UNEXPECTED_RESPONSE: JSON이 아닌 응답", path);
  }
}

/** 객체인지 확인한다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
