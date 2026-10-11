import type { ChatSettingsDto, VerdictStatus } from "@zzirit-guard/shared";
import { ChzzkApiError, type ChzzkApi, type MessageTarget } from "../chzzk/apiClient.js";
import { WriteLockedError, type TokenManager } from "../connection/tokenManager.js";
import { describeError, type Logger } from "../logger.js";
import type { AuditLog } from "../records/auditLog.js";
import type { VerdictRepository } from "../records/verdictRepository.js";
import type { Clock } from "../time.js";

/** 실행기가 처리하는 쓰기 요청. */
export type ActionRequest =
  | { kind: "hide"; target: MessageTarget; verdictId: number | null }
  | { kind: "temporary_restrict"; targetChannelId: string; chatChannelId: string; verdictId: number | null }
  | { kind: "restrict"; targetChannelId: string; verdictId: number | null }
  | { kind: "unrestrict"; targetChannelId: string }
  | { kind: "update_chat_settings"; settings: ChatSettingsDto };

/** 요청한 주체. rule은 자동 숨김, system은 서버 자체 동작이다. */
export interface Actor {
  type: "manager" | "rule" | "system";
  channelId: string | null;
}

/** 처리 결과. message·note는 매니저 화면에 그대로 보여 준다. */
export type ActionOutcome = { ok: true; note: string | null } | { ok: false; message: string };

/** 모든 쓰기 API가 지나는 유일한 통로(스펙 4장). */
export interface Executor {
  submit(channelId: string, request: ActionRequest, actor: Actor): Promise<ActionOutcome>;
  pendingCount(): number;
  onFailureRateExceeded(listener: (channelId: string) => void): void;
}

/** createExecutor 옵션. sleep은 테스트에서 기다리지 않으려고 바꿔 끼운다. */
export interface ExecutorOptions {
  api: ChzzkApi;
  tokenManager: TokenManager;
  auditLog: AuditLog;
  verdicts: VerdictRepository;
  clock: Clock;
  logger: Logger;
  onVerdictStatus(verdictId: number, status: VerdictStatus): void;
  sleep?: (ms: number) => Promise<void>;
}

/** 최대 재시도 횟수(스펙 10장). */
const MAX_RETRIES = 3;
/** 재시도 대기 기본값. 1·2·4초로 늘린다. */
const RETRY_BASE_MS = 1000;
/** 실패율을 보는 창(1분). */
const FAILURE_WINDOW_MS = 60_000;
/** 실패율을 판단하기 위한 최소 표본 수. 한두 번 실패로 스위치가 꺼지지 않게 한다. */
const FAILURE_MIN_SAMPLES = 10;
/** 이 비율을 넘으면 알린다(50%). */
const FAILURE_RATE_LIMIT = 0.5;

/** 실패 처리 결정: 끝내거나(done) 다시 시도(retry). */
type FailureDecision = { kind: "done"; outcome: ActionOutcome } | { kind: "retry" };

/** 실행기를 만든다. */
export function createExecutor(options: ExecutorOptions): Executor {
  return new SerialExecutor(options);
}

/** 요청을 순서대로 하나씩 실행한다. 치지직 호출 한도가 문서에 없어 한꺼번에 보내지 않는다. */
class SerialExecutor implements Executor {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private readonly outcomes: Array<{ at: number; ok: boolean }> = [];
  private readonly listeners: Array<(channelId: string) => void> = [];
  private lastAlertAt = Number.NEGATIVE_INFINITY;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ExecutorOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  submit(channelId: string, request: ActionRequest, actor: Actor): Promise<ActionOutcome> {
    this.pending += 1;
    const run = this.tail.then(() => this.execute(channelId, request, actor));
    // 대기열 사슬은 한 요청이 예외로 끝나도 이어져야 한다. 예외 자체는 run을 통해 호출자에게 그대로 전달된다.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.pending -= 1;
    });
  }

  pendingCount(): number {
    return this.pending;
  }

  onFailureRateExceeded(listener: (channelId: string) => void): void {
    this.listeners.push(listener);
  }

  /**
   * 실행 → 기록. 예외를 밖으로 던지지 않아 대기열이 끊기지 않는다.
   * 기록이 실패해도 치지직 호출은 이미 끝난 되돌릴 수 없는 일이므로 실제 결과를 그대로 돌려준다.
   */
  private async execute(channelId: string, request: ActionRequest, actor: Actor): Promise<ActionOutcome> {
    const outcome = await this.performWithRetry(request);
    this.recordOutcome(channelId, request, actor, outcome);
    return outcome;
  }

  /** 성공하거나 끝내기로 결정할 때까지 시도한다. */
  private async performWithRetry(request: ActionRequest): Promise<ActionOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await performRequest(this.options.api, await this.options.tokenManager.getAccessToken(), request);
        return { ok: true, note: null };
      } catch (error) {
        const decision = await this.decideAfterFailure(request, error, attempt);
        if (decision.kind === "done") return decision.outcome;
      }
    }
  }

  /** 실패 종류별 처리: 잠금·404·401·재시도 가능 오류·그 밖. */
  private async decideAfterFailure(request: ActionRequest, error: unknown, attempt: number): Promise<FailureDecision> {
    if (error instanceof WriteLockedError) return { kind: "done", outcome: { ok: false, message: error.message } };
    if (isStatus(error, 404) && request.kind === "hide") return { kind: "done", outcome: { ok: true, note: "이미 사라진 메시지입니다" } };
    if (isStatus(error, 401) && attempt === 0) return this.refreshAfterUnauthorized();
    if (isRetryable(error) && attempt < MAX_RETRIES) {
      await this.sleep(RETRY_BASE_MS * 2 ** attempt);
      return { kind: "retry" };
    }
    return { kind: "done", outcome: { ok: false, message: toUserMessage(error) } };
  }

  /** 401: 토큰을 강제로 갱신하고 한 번 더 시도한다. 갱신도 실패하면 그 이유로 끝낸다. */
  private async refreshAfterUnauthorized(): Promise<FailureDecision> {
    try {
      await this.options.tokenManager.forceRefresh();
      return { kind: "retry" };
    } catch (error) {
      return { kind: "done", outcome: { ok: false, message: toUserMessage(error) } };
    }
  }

  /** 감사 기록·판정 상태·실패율을 갱신한다. 각 단계는 서로 영향을 주지 않도록 따로 보호한다. */
  private recordOutcome(channelId: string, request: ActionRequest, actor: Actor, outcome: ActionOutcome): void {
    const verdictId = "verdictId" in request ? request.verdictId : null;
    this.guardRecording(request, "감사 기록 저장 실패", () =>
      this.options.auditLog.record({
        channelId, actorType: actor.type, actorChannelId: actor.channelId, action: request.kind, targetSenderChannelId: targetOf(request),
        verdictId, result: outcome.ok ? "ok" : "error", error: outcome.ok ? null : outcome.message,
      }),
    );
    if (!outcome.ok) this.options.logger.warn("쓰기 요청 실패", { action: request.kind, verdictId, message: outcome.message });
    if (outcome.ok && verdictId !== null) this.guardRecording(request, "판정 상태 갱신 실패", () => this.updateVerdict(verdictId, request.kind));
    this.trackFailureRate(channelId, outcome.ok);
  }

  /**
   * 기록 단계의 예외를 로그로 남기고 삼킨다. 치지직 호출은 이미 끝났으므로
   * 기록 오류를 실패로 보고하면 매니저가 되돌릴 수 없는 조치를 다시 시도하게 된다. 채팅 원문은 남기지 않는다.
   */
  private guardRecording(request: ActionRequest, context: string, step: () => void): void {
    try {
      step();
    } catch (error) {
      this.options.logger.error(context, { action: request.kind, error: describeError(error) });
    }
  }

  /** 성공한 조치에 맞게 판정 상태를 바꾸고 알린다. */
  private updateVerdict(verdictId: number, kind: ActionRequest["kind"]): void {
    const status: VerdictStatus | null = kind === "hide" ? "hidden" : kind === "temporary_restrict" || kind === "restrict" ? "restricted" : null;
    if (!status) return;
    this.options.verdicts.updateStatus(verdictId, status);
    this.options.onVerdictStatus(verdictId, status);
  }

  /** 최근 1분 실패율이 기준을 넘으면 1분에 한 번만 알린다. */
  private trackFailureRate(channelId: string, ok: boolean): void {
    const now = this.options.clock();
    this.outcomes.push({ at: now, ok });
    while (this.outcomes.length > 0 && (this.outcomes[0] as { at: number }).at <= now - FAILURE_WINDOW_MS) this.outcomes.shift();
    const failures = this.outcomes.filter((outcome) => !outcome.ok).length;
    const exceeded = this.outcomes.length >= FAILURE_MIN_SAMPLES && failures / this.outcomes.length > FAILURE_RATE_LIMIT;
    if (!exceeded || now - this.lastAlertAt < FAILURE_WINDOW_MS) return;
    this.lastAlertAt = now;
    this.listeners.forEach((listener) => this.notifyListener(listener, channelId));
  }

  /** 알림 수신자 하나의 예외가 다른 수신자나 submit 결과에 번지지 않게 격리한다. */
  private notifyListener(listener: (channelId: string) => void, channelId: string): void {
    try {
      listener(channelId);
    } catch (error) {
      this.options.logger.error("실패율 알림 처리 실패", { error: describeError(error) });
    }
  }
}

/** 요청 종류에 맞는 치지직 API를 부른다. */
function performRequest(api: ChzzkApi, token: string, request: ActionRequest): Promise<void> {
  switch (request.kind) {
    case "hide":
      return api.blindMessage(token, request.target);
    case "temporary_restrict":
      return api.addTemporaryRestriction(token, request.targetChannelId, request.chatChannelId);
    case "restrict":
      return api.addRestriction(token, request.targetChannelId);
    case "unrestrict":
      return api.removeRestriction(token, request.targetChannelId);
    case "update_chat_settings":
      return api.updateChatSettings(token, request.settings);
  }
}

/** 감사 기록에 남길 대상 사용자. */
function targetOf(request: ActionRequest): string | null {
  if (request.kind === "hide") return request.target.senderChannelId;
  if (request.kind === "update_chat_settings") return null;
  return request.targetChannelId;
}

/** 특정 HTTP 상태의 치지직 오류인지 본다. */
function isStatus(error: unknown, status: number): boolean {
  return error instanceof ChzzkApiError && error.status === status;
}

/** 다시 시도할 만한 오류: 429, 5xx, 그리고 네트워크 오류(치지직 오류가 아닌 예외). */
function isRetryable(error: unknown): boolean {
  if (error instanceof ChzzkApiError) return error.status === 429 || error.status >= 500;
  return true;
}

/** 오류를 매니저에게 보여 줄 문장으로 바꾼다(원인과 해결 방향 포함). */
function toUserMessage(error: unknown): string {
  if (error instanceof WriteLockedError) return error.message;
  if (!(error instanceof ChzzkApiError)) return `치지직에 연결하지 못했습니다(${describeError(error)}). 네트워크를 확인하세요.`;
  if (error.status === 429) return "치지직 호출 한도를 넘었습니다. 잠시 뒤 다시 시도하세요.";
  if (error.status === 403) return "치지직이 권한 없음으로 거부했습니다. 스트리머 연결 때 동의한 권한(Scope)을 확인하세요.";
  if (error.status >= 500) return "치지직 서버 오류로 실패했습니다. 잠시 뒤 다시 시도하세요.";
  return `치지직이 요청을 거부했습니다: ${error.apiMessage}`;
}
