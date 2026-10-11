import type { ApiErrorBody } from "@zzirit-guard/shared";
import type { FastifyReply } from "fastify";
import { ZodError } from "zod";
import { ChzzkApiError } from "../chzzk/apiClient.js";
import { WriteLockedError } from "../connection/tokenManager.js";
import { RuleValidationError } from "../detection/ruleRepository.js";
import { describeError, type Logger } from "../logger.js";
import { SettingsValidationError } from "../records/settingsRepository.js";

/** 라우트에서 던지는 HTTP 오류. message는 사용자에게 그대로 보여 준다. */
export class RouteError extends Error {
  override readonly name = "RouteError";
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** 오류 응답 본문. */
export function errorBody(code: string, message: string): ApiErrorBody {
  return { error: code, message };
}

/**
 * 예외를 HTTP 응답으로 바꾼다. 사용자에게는 원인과 해결 방향이 담긴 문구를, 개발자에게는 로그를 남긴다.
 * 500은 내부 사정을 감추고 일반 문구만 보낸다.
 */
export function sendError(logger: Logger, error: unknown, reply: FastifyReply): FastifyReply {
  const status = statusFor(error);
  if (status >= 500) logger.error("요청 처리 실패", { status, error: describeError(error) });
  const body = status === 500 ? errorBody("internal", "서버 오류가 발생했습니다. 잠시 뒤 다시 시도하세요.") : errorBody(codeFor(error, status), messageFor(error));
  return reply.code(status).send(body);
}

/** 예외 종류별 HTTP 상태. */
function statusFor(error: unknown): number {
  if (error instanceof ZodError || error instanceof RuleValidationError || error instanceof SettingsValidationError) return 400;
  if (error instanceof WriteLockedError) return 409;
  if (error instanceof ChzzkApiError) return 502;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
}

/** 오류 코드(화면이 분기할 때 쓴다). */
function codeFor(error: unknown, status: number): string {
  if (error instanceof RouteError) return error.code;
  if (error instanceof ZodError) return "invalid_input";
  if (error instanceof WriteLockedError) return "write_locked";
  if (error instanceof ChzzkApiError) return "chzzk_failed";
  return status === 404 ? "not_found" : "bad_request";
}

/** 사용자에게 보여 줄 문구. */
function messageFor(error: unknown): string {
  if (error instanceof ZodError) return `입력값이 올바르지 않습니다: ${error.issues.map((issue) => issue.path.join(".") || "(본문)").join(", ")}`;
  if (error instanceof ChzzkApiError) return `치지직 오류(${error.status}): ${error.apiMessage}`;
  return error instanceof Error ? error.message : String(error);
}
