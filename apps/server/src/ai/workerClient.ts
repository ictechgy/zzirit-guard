import { lstatSync, type Stats } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { dirname } from "node:path";
import type { AiCategory } from "@zzirit-guard/shared";

/**
 * AI 워커 클라이언트: 워커 계약 v1(workers/contract/README.md)대로 유닉스 소켓의 /classify·/health를 부른다.
 * 왜 유닉스 소켓인가: TCP 포트는 다른 사용자도 바인딩할 수 있어, 워커가 꺼진 사이 다른 사용자 프로세스가 채팅을 받거나
 * 가짜 판정을 돌려줄 수 있다. 이 사용자만 들어갈 수 있는 0700 디렉터리의 소켓은 그럴 수 없다. 그래서 연결 전에 디렉터리와
 * 소켓의 종류·소유자·권한을 확인한다.
 * 주의: 오류 메시지에 요청·응답 본문을 넣지 않는다(채팅 원문이 로그로 새지 않게).
 */

/** 워커 단계. 1차는 범주가 없고 2차는 S1~S7 범주를 준다. */
export type WorkerStage = "stage1" | "stage2";

/** 판정을 부탁할 채팅 한 줄. id는 `^[A-Za-z0-9_-]{1,64}$`이다. */
export interface WorkerItem {
  id: string;
  text: string;
}

/** 채팅 한 줄의 판정. */
export interface WorkerVerdict {
  id: string;
  unsafeProbability: number;
  category: AiCategory | null;
}

/** /classify 응답. model은 워커의 모델 식별자다(바뀌면 점수 캐시를 비운다). */
export interface WorkerResult {
  model: string;
  verdicts: WorkerVerdict[];
}

/**
 * 워커 호출 실패의 종류.
 * - rejected: 워커가 이 요청을 거절함(4xx, 예: 2차의 text_too_long). 워커는 살아 있다.
 * - busy: 워커가 바쁨(503). 워커는 살아 있다.
 * - unavailable: 소켓 없음·권한 이상·연결 실패·시간 초과·5xx·계약에 어긋난 응답. 워커를 '중지'로 본다.
 * - aborted: 서버가 스스로 중단함(세션 초기화·종료).
 */
export type WorkerFailureKind = "rejected" | "busy" | "unavailable" | "aborted";

/** 워커 호출 실패. code는 워커가 준 오류 코드(rejected·busy)나 실패 원인을 가리키는 짧은 코드다. */
export class WorkerCallError extends Error {
  override readonly name = "WorkerCallError";

  constructor(
    readonly kind: WorkerFailureKind,
    readonly code: string,
  ) {
    super(`워커 호출 실패(${kind}: ${code})`);
  }
}

/** 워커 클라이언트. */
export interface WorkerClient {
  /**
   * 채팅 묶음을 판정한다.
   * @param items 판정할 채팅(1차 1~32건, 2차 1건)
   * @param signal 서버가 스스로 중단할 때 쓰는 신호(세션 초기화·종료)
   * @throws WorkerCallError 실패 종류와 코드
   */
  classify(items: readonly WorkerItem[], signal?: AbortSignal): Promise<WorkerResult>;
  /**
   * 워커가 살아 있는지 본다.
   * @returns 워커의 모델 식별자
   * @throws WorkerCallError 실패 종류와 코드
   */
  health(signal?: AbortSignal): Promise<string>;
}

/** createWorkerClient 옵션. */
export interface WorkerClientOptions {
  /** 워커 소켓 경로($ZG_DATA_DIR/run/stage1.sock 등). */
  socketPath: string;
  stage: WorkerStage;
  /** 응답을 기다리는 최대 시간(ms). 스펙 10장: 2초가 넘으면 실패로 본다. */
  timeoutMs?: number;
  /** 이 프로세스의 사용자 번호(테스트에서 바꾼다). */
  userId?: number;
}

/** 응답 시간 제한 기본값(ms, 스펙 10장). */
export const WORKER_TIMEOUT_MS = 2_000;
/** 받을 응답 본문 상한(바이트). 계약상 응답은 몇 KB이므로 넉넉히 두되, 고장 난 워커가 메모리를 채우지 못하게 한다. */
const MAX_RESPONSE_BYTES = 256 * 1024;
/** 계약 번호. */
const CONTRACT_VERSION = 1;
/** 모델 식별자 길이 상한. */
const MAX_MODEL_LENGTH = 200;
/** 2차 범주. */
const STAGE2_CATEGORIES: ReadonlySet<string> = new Set(["S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
/** 소켓 디렉터리 권한. 이 사용자만 들어갈 수 있어야 한다. */
const PRIVATE_DIRECTORY_MODE = 0o700;

/**
 * 워커 클라이언트를 만든다.
 * @param options 소켓 경로·단계·시간 제한
 */
export function createWorkerClient(options: WorkerClientOptions): WorkerClient {
  const settings = { timeoutMs: WORKER_TIMEOUT_MS, userId: process.getuid?.() ?? -1, ...options };
  return {
    async classify(items, signal) {
      const body = JSON.stringify({ items: items.map(({ id, text }) => ({ id, text })) });
      const raw = await callWorker(settings, { method: "POST", path: "/classify", body }, signal);
      return parseClassifyResponse(settings.stage, items.map((item) => item.id), raw);
    },
    async health(signal) {
      return parseHealthResponse(await callWorker(settings, { method: "GET", path: "/health", body: null }, signal));
    },
  };
}

/** 워커에 보낼 요청 하나. */
interface WorkerRequest {
  method: "GET" | "POST";
  path: string;
  body: string | null;
}

/**
 * 소켓을 확인하고 요청을 보내 200 응답 본문을 돌려준다. 200이 아니면 상태에 맞는 WorkerCallError를 던진다.
 * @param settings 소켓 경로·시간 제한·사용자 번호
 * @param workerRequest 메서드·경로·본문
 * @param signal 서버가 스스로 중단할 때 쓰는 신호
 */
async function callWorker(settings: Required<WorkerClientOptions>, workerRequest: WorkerRequest, signal?: AbortSignal): Promise<string> {
  ensureSafeSocket(settings.socketPath, settings.userId);
  const { status, body } = await sendRequest(settings, workerRequest, signal);
  if (status === 200) return body;
  throw failureForStatus(status, body);
}

/**
 * 소켓 디렉터리가 이 사용자 소유의 0700 디렉터리(링크 아님)이고 소켓이 이 사용자의 소켓인지 본다. 아니면 보내지 않는다.
 * @param socketPath 워커 소켓 경로
 * @param userId 이 프로세스의 사용자 번호
 */
export function ensureSafeSocket(socketPath: string, userId: number): void {
  const directory = lstatOrNull(dirname(socketPath));
  if (!directory || !directory.isDirectory() || directory.uid !== userId || (directory.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new WorkerCallError("unavailable", "unsafe_directory");
  }
  const socket = lstatOrNull(socketPath);
  if (!socket) throw new WorkerCallError("unavailable", "socket_missing");
  if (!socket.isSocket() || socket.uid !== userId) throw new WorkerCallError("unavailable", "unsafe_socket");
}

/** lstat 결과. 없으면 null(다른 오류는 그대로 던진다). */
function lstatOrNull(path: string): Stats | null {
  return lstatSync(path, { throwIfNoEntry: false }) ?? null;
}

/**
 * 유닉스 소켓으로 HTTP 요청을 보내고 상태와 본문을 받는다. 시간 제한·중단·본문 상한을 지킨다. 리디렉션은 따르지 않는다.
 * @param settings 소켓 경로·시간 제한
 * @param workerRequest 메서드·경로·본문
 * @param signal 서버가 스스로 중단할 때 쓰는 신호
 */
function sendRequest(
  settings: Required<WorkerClientOptions>,
  workerRequest: WorkerRequest,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers: Record<string, string | number> = { Connection: "close", Host: "worker" };
  if (workerRequest.body !== null) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(workerRequest.body);
  }
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath: settings.socketPath, method: workerRequest.method, path: workerRequest.path, headers, signal: combined, agent: false }, (response) =>
      collectBody(response, resolve, reject),
    );
    outgoing.on("error", (error) => reject(failureForError(error, signal, timeout)));
    outgoing.end(workerRequest.body ?? undefined);
  });
}

/**
 * 응답 본문을 상한까지 모은다. 넘으면 연결을 끊고 계약 위반으로 본다.
 * @param response 워커 응답
 * @param resolve 다 받았을 때
 * @param reject 실패했을 때
 */
function collectBody(
  response: IncomingMessage,
  resolve: (value: { status: number; body: string }) => void,
  reject: (error: unknown) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  response.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) response.destroy(new WorkerCallError("unavailable", "response_too_large"));
    else chunks.push(chunk);
  });
  response.on("error", (error) => reject(error instanceof WorkerCallError ? error : new WorkerCallError("unavailable", "connection")));
  response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
}

/**
 * 요청 오류를 실패 종류로 바꾼다. 서버가 중단했으면 aborted, 시간 초과면 timeout, 나머지는 연결 실패다.
 * @param error 요청 오류
 * @param signal 서버의 중단 신호
 * @param timeout 시간 제한 신호
 */
function failureForError(error: unknown, signal: AbortSignal | undefined, timeout: AbortSignal): WorkerCallError {
  if (error instanceof WorkerCallError) return error;
  if (signal?.aborted) return new WorkerCallError("aborted", "aborted");
  if (timeout.aborted) return new WorkerCallError("unavailable", "timeout");
  return new WorkerCallError("unavailable", "connection");
}

/**
 * 200이 아닌 응답을 실패 종류로 바꾼다. 4xx는 요청 거절, 503은 바쁨, 그 밖은 장애다.
 * @param status 상태 코드
 * @param body 응답 본문(오류 코드만 꺼낸다)
 */
function failureForStatus(status: number, body: string): WorkerCallError {
  const code = errorCodeOf(body) ?? `http_${status}`;
  if (status >= 400 && status < 500) return new WorkerCallError("rejected", code);
  if (status === 503) return new WorkerCallError("busy", code);
  return new WorkerCallError("unavailable", code);
}

/** 오류 본문 `{"error": "<코드>"}`에서 코드만 꺼낸다. 형식이 다르거나 코드가 이상하면 null. */
function errorCodeOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const code = isRecord(parsed) ? parsed["error"] : null;
    return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : null;
  } catch {
    // 오류 본문이 JSON이 아니면 상태 코드로만 구분한다(본문 내용은 로그에 남기지 않는다).
    return null;
  }
}

/** 값이 일반 객체인지. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 객체가 정확히 이 키들만 가졌는지. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** 계약에 어긋난 응답. 워커를 '중지'로 본다(고장 난 워커의 판정을 쓰지 않게). */
function contractViolation(code: string): WorkerCallError {
  return new WorkerCallError("unavailable", code);
}

/**
 * /classify 응답을 계약대로 확인하고 바꾼다. 키·계약 번호·모델·항목 수·순서·id·확률·범주가 하나라도 어긋나면 계약 위반이다.
 * @param stage 워커 단계(범주 규칙이 다르다)
 * @param requestIds 보낸 요청의 id 순서
 * @param body 응답 본문
 */
export function parseClassifyResponse(stage: WorkerStage, requestIds: readonly string[], body: string): WorkerResult {
  const document = parseJsonObject(body);
  if (!hasExactKeys(document, ["contract", "model", "items"])) throw contractViolation("bad_response_keys");
  const model = parseEnvelope(document);
  const items = document["items"];
  if (!Array.isArray(items) || items.length !== requestIds.length) throw contractViolation("bad_response_items");
  return { model, verdicts: items.map((item: unknown, index) => parseVerdict(stage, requestIds[index] ?? "", item)) };
}

/**
 * /health 응답을 확인하고 모델 식별자를 돌려준다.
 * @param body 응답 본문
 */
export function parseHealthResponse(body: string): string {
  const document = parseJsonObject(body);
  if (!hasExactKeys(document, ["contract", "model", "ready"]) || document["ready"] !== true) throw contractViolation("bad_health");
  return parseEnvelope(document);
}

/** 본문을 JSON 객체로 읽는다. JSON이 아니거나(NaN 포함) 객체가 아니면 계약 위반이다. */
function parseJsonObject(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // 응답이 JSON이 아니면 계약 위반으로 본다(본문은 오류에 넣지 않는다).
    throw contractViolation("bad_json");
  }
  if (!isRecord(parsed)) throw contractViolation("bad_json");
  return parsed;
}

/** 계약 번호와 모델 식별자를 확인한다. */
function parseEnvelope(document: Record<string, unknown>): string {
  if (document["contract"] !== CONTRACT_VERSION) throw contractViolation("bad_contract");
  const model = document["model"];
  if (typeof model !== "string" || model.length < 1 || model.length > MAX_MODEL_LENGTH) throw contractViolation("bad_model");
  return model;
}

/**
 * 응답 항목 하나를 확인한다. id가 보낸 순서와 같고, 확률이 0~1의 유한한 수이고, 범주가 단계 규칙에 맞아야 한다.
 * @param stage 워커 단계
 * @param expectedId 이 자리에 있어야 할 id
 * @param item 응답 항목
 */
function parseVerdict(stage: WorkerStage, expectedId: string, item: unknown): WorkerVerdict {
  if (!isRecord(item) || !hasExactKeys(item, ["id", "unsafe_probability", "category"]) || item["id"] !== expectedId) {
    throw contractViolation("bad_response_item");
  }
  const probability = item["unsafe_probability"];
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) throw contractViolation("bad_probability");
  return { id: expectedId, unsafeProbability: probability, category: parseCategory(stage, item["category"]) };
}

/** 범주를 확인한다. 1차는 null, 2차는 S1~S7이다. */
function parseCategory(stage: WorkerStage, category: unknown): AiCategory | null {
  if (stage === "stage1") {
    if (category !== null) throw contractViolation("bad_category");
    return null;
  }
  if (typeof category !== "string" || !STAGE2_CATEGORIES.has(category)) throw contractViolation("bad_category");
  return category as AiCategory;
}
