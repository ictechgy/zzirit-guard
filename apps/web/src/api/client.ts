import type { ApiErrorBody } from "@zzirit-guard/shared";

/** API 주소 앞부분. 같은 출처면 빈 문자열. 화면만 Cloudflare Pages로 옮길 때 빌드 값으로 바꾼다(스펙 12장). */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";

/** 서버가 돌려준 오류. message는 사용자에게 그대로 보여 준다. status 0은 네트워크 오류다. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  /** HTTP 상태 코드. 서버에 닿지 못했으면 0. */
  readonly status: number;
  /** 서버 오류 코드(ApiErrorBody.error). 화면이 분기할 때 쓴다(예: no_channel·already_handled). */
  readonly code: string;

  /**
   * @param status HTTP 상태 코드(네트워크 오류는 0)
   * @param code 서버 오류 코드
   * @param message 사용자에게 보여 줄 문구
   * @param options cause에 원래 오류를 담아 개발자 도구에서 원인을 볼 수 있게 한다
   */
  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
    this.code = code;
  }
}

/**
 * 요청 하나를 기다리는 최대 시간(15초).
 * 왜: fetch에는 기본 시간 제한이 없어, 서버가 치지직 호출을 재시도하며 늦어지거나 연결이 반쯤 끊기면 버튼 잠금·화면이 끝없이 멈춘다(F2).
 * 서버는 늦게라도 조치를 끝낼 수 있으므로, 시간이 지나면 실패라 단정하지 않고 결과가 곧 목록에 반영된다고 알린다.
 */
export const REQUEST_TIMEOUT_MS = 15_000;
/** 시간 제한을 넘겼을 때의 안내. */
const TIMEOUT_MESSAGE = "응답이 늦습니다. 결과는 잠시 뒤 목록에 반영됩니다.";
/** 서버에 닿지 못했을 때의 안내. */
const NETWORK_MESSAGE = "서버에 연결할 수 없습니다. 맥 미니가 켜져 있는지, 네트워크가 연결돼 있는지 확인하세요.";

/** 상태 변경 요청 표식. 서버의 REQUEST_MARKER_HEADER(apps/server/src/http/constants.ts)와 같아야 한다(CSRF 방지). */
const MARKER_HEADERS = { "x-zzirit-request": "1" } as const;

/** 상태를 바꾸는 메서드. */
type MutatingMethod = "POST" | "PUT" | "DELETE";

/** 조회 요청. */
export function apiGet<T>(path: string): Promise<T> {
  return request<T>("GET", path, undefined);
}

/** 상태 변경 요청. 본문이 없으면 빈 객체를 보낸다(서버가 JSON 본문을 기대한다). */
export function apiSend<T>(method: MutatingMethod, path: string, body: unknown = {}): Promise<T> {
  return request<T>(method, path, body);
}

/** 화면에 보여 줄 오류 문구를 고른다. */
export function describeApiError(error: unknown): string {
  return error instanceof ApiError ? error.message : "알 수 없는 오류가 발생했습니다. 앱을 새로고침하세요.";
}

/**
 * 로그인 화면으로 돌아가야 하는 오류인지 본다: 세션이 끝났거나(401) 채널 연결이 사라졌다(409 no_channel).
 * 왜 no_channel도 넣나: 채널이 없으면 /api/status·/api/candidates·/api/ws-ticket이 모두 409라, 본 화면에 남으면
 * 배너가 "불러오는 중"에서 멈추고 티켓 요청만 끝없이 되풀이된다(R-12).
 */
export function requiresSignIn(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 401 || error.code === "no_channel");
}

/** 요청 → 응답 해석. 실패는 ApiError로 바꾼다. 시간 제한은 본문을 다 읽을 때까지 걸린다. */
async function request<T>(method: "GET" | MutatingMethod, path: string, body: unknown): Promise<T> {
  const init = buildInit(method, body);
  const response = await explainTransportFailure(() => fetch(API_BASE + path, init));
  const payload = parseBody(response.status, await explainTransportFailure(() => response.text()));
  if (!response.ok) throw toApiError(response.status, payload);
  return payload as T;
}

/** 요청 설정. 쿠키는 항상 함께 보낸다(나중에 출처가 갈라져도 동작하도록 include). 모든 요청에 시간 제한 신호를 단다. */
function buildInit(method: "GET" | MutatingMethod, body: unknown): RequestInit {
  const signal = createTimeoutSignal();
  if (method === "GET") return { method, credentials: "include", signal };
  return { method, credentials: "include", signal, headers: { ...MARKER_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * REQUEST_TIMEOUT_MS 뒤에 끊는 신호. AbortSignal.timeout이 없는 옛 브라우저에서는 시간 제한 없이 보낸다.
 * 왜 없을 때 건너뛰나: 없는 함수를 부르면 모든 요청이 실패하는데, 시간 제한이 없는 편이 그보다 낫다.
 */
function createTimeoutSignal(): AbortSignal | null {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : null;
}

/**
 * fetch·본문 읽기가 실패하면(시간 초과·서버 꺼짐·네트워크) 원인과 해결 방향을 담아 바꾸고, 원래 오류는 cause로 남긴다.
 * @param transfer fetch 또는 본문 읽기
 * @throws ApiError 시간 초과면 code "timeout", 그 밖에는 "network"(status는 둘 다 0)
 */
async function explainTransportFailure<T>(transfer: () => Promise<T>): Promise<T> {
  try {
    return await transfer();
  } catch (error) {
    if (isTimeoutError(error)) throw new ApiError(0, "timeout", TIMEOUT_MESSAGE, { cause: error });
    throw new ApiError(0, "network", NETWORK_MESSAGE, { cause: error });
  }
}

/** AbortSignal.timeout이 끊은 요청의 오류인지 본다(브라우저는 이름이 TimeoutError인 DOMException으로 거절한다). */
function isTimeoutError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError";
}

/** 본문을 JSON으로 읽는다. 비어 있으면 null, JSON이 아니면 형식 오류(해석 오류는 cause로 남긴다). */
function parseBody(status: number, text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ApiError(status, "bad_response", "서버 응답 형식이 올바르지 않습니다. 앱을 새로고침하세요.", { cause: error });
  }
}

/** 오류 본문을 ApiError로 바꾼다. */
function toApiError(status: number, payload: unknown): ApiError {
  const body = payload as Partial<ApiErrorBody> | null;
  if (body && typeof body.error === "string" && typeof body.message === "string") return new ApiError(status, body.error, body.message);
  return new ApiError(status, "unknown", `요청이 실패했습니다(${status}). 잠시 뒤 다시 시도하세요.`);
}
