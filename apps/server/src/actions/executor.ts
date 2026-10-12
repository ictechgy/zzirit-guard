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

/**
 * submit 추가 옵션. shouldRun은 시도마다 두 번 확인한다: 토큰을 받기 전, 그리고 토큰을 받은 뒤 치지직 쓰기를 부르기 직전.
 * 이유: 자동 숨김은 되돌릴 수 없으므로, 대기 중이거나 재시도·토큰 갱신을 기다리는 중에 스위치가 꺼졌다면 더 보내지 않아야 한다(F9.1, S2).
 */
export interface SubmitOptions {
  shouldRun?: () => boolean;
}

/** 자동 숨김 스위치가 꺼져서 요청을 취소했을 때의 매니저용 문구. */
const CANCELLED_MESSAGE = "자동 숨김이 꺼져 보내지 않았습니다";

/** 모든 쓰기 API가 지나는 유일한 통로(스펙 4장). */
export interface Executor {
  submit(channelId: string, request: ActionRequest, actor: Actor, options?: SubmitOptions): Promise<ActionOutcome>;
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

/**
 * 처리 대기 중(실행 중 포함) 요청 수의 상한(S3).
 * 왜: 직렬 대기열에 상한이 없으면 떼도배·치지직 장애 때 요청이 끝없이 쌓여 메모리가 늘고, 매니저의 조치가 수십 분 뒤에야 나간다.
 * 넘치면 새 요청을 바로 거절해 매니저가 지금 상황을 알게 한다.
 */
export const MAX_PENDING_ACTIONS = 500;
/** 대기열이 가득 차 거절할 때의 매니저용 문구. */
const QUEUE_FULL_MESSAGE = `처리 대기 중인 조치가 너무 많아(${MAX_PENDING_ACTIONS}건) 이 요청을 보내지 않았습니다. 잠시 뒤 다시 시도하세요.`;
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

/** 숨김이 성공했을 때 hidden으로 바꿔도 되는 지금 상태(S12): 대기 중만. */
const HIDE_ALLOWED_FROM: readonly VerdictStatus[] = ["pending"];

/** 실패 처리 결정: 끝내거나(done) 다시 시도(retry). */
type FailureDecision = { kind: "done"; outcome: ActionOutcome } | { kind: "retry" };

/**
 * 실패가 난 단계. token은 토큰을 받다가(쓰기 요청은 아직 나가지 않음), write는 치지직 쓰기 호출 중이다.
 * 왜 가르나: 쓰기 호출 중의 시간 초과·연결 끊김은 치지직이 이미 처리했을 수 있어 다시 보내면 되돌릴 수 없는 조치가 겹친다(S1).
 * 토큰 단계 실패는 쓰기 요청이 나가지 않았으므로 다시 시도해도 겹치지 않는다.
 */
type FailurePhase = "token" | "write";

/** 시도 한 번의 결과. 성공(sent), 토큰을 받은 뒤 shouldRun이 false여서 멈춤(cancelled), 또는 실패한 단계와 오류. */
type AttemptResult = { kind: "sent" } | { kind: "cancelled" } | { kind: "failed"; phase: FailurePhase; error: unknown };

/**
 * 요청이 나가기 전에 났다고 확실히 말할 수 있는 네트워크 오류 코드: 연결 거부와 DNS 실패.
 * 왜 이것만인가: 연결이 맺어지지 않았으니 치지직은 요청을 받지 못했다. 시간 초과·리셋 등은 요청이 이미 닿았을 수 있다(S1).
 */
const PRE_SEND_NETWORK_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
/** 오류의 cause를 따라가 code를 찾을 때 볼 최대 깊이. 순환 참조에서 끝나지 않는 일을 막는다. */
const MAX_CAUSE_DEPTH = 5;
/**
 * 쓰기 호출 중 응답을 받지 못했을 때(시간 초과·연결 끊김 등)의 매니저용 문구.
 * 왜 "실패"라 하지 않나: 치지직이 이미 처리했을 수 있어, 확인 없이 다시 누르면 조치가 두 번 간다.
 */
const RESULT_UNKNOWN_MESSAGE = "치지직 응답을 받지 못해 처리 결과를 알 수 없습니다. 치지직 채팅에서 실제로 처리됐는지 확인한 뒤, 안 됐을 때만 다시 시도하세요.";
/** 요청이 나가기 전에 연결하지 못했을 때의 매니저용 문구. */
const NETWORK_FAILURE_MESSAGE = "치지직에 연결하지 못했습니다. 네트워크를 확인하세요.";

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

  submit(channelId: string, request: ActionRequest, actor: Actor, options?: SubmitOptions): Promise<ActionOutcome> {
    if (this.pending >= MAX_PENDING_ACTIONS) return Promise.resolve(this.rejectQueueFull(channelId, request, actor));
    this.pending += 1;
    const run = this.tail.then(() => this.execute(channelId, request, actor, options));
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
   * 대기열이 가득 찬 요청을 치지직에 보내지 않고 바로 실패로 끝낸다. 감사 기록과 경고 로그를 남긴다.
   * 실패율에는 넣지 않는다: 치지직 호출 결과가 아니어서, 넣으면 대기열 폭주만으로 자동 숨김이 꺼질 수 있다.
   * @param channelId 채널 ID
   * @param request 거절한 요청(종류만 로그에 남긴다)
   * @param actor 요청한 주체
   */
  private rejectQueueFull(channelId: string, request: ActionRequest, actor: Actor): ActionOutcome {
    const outcome: ActionOutcome = { ok: false, message: QUEUE_FULL_MESSAGE };
    this.options.logger.warn("실행기 대기열이 가득 차 요청을 거절했습니다", { action: request.kind, pending: this.pending });
    this.recordAudit(channelId, request, actor, outcome);
    return outcome;
  }

  /**
   * 실행 → 기록. 예외를 밖으로 던지지 않아 대기열이 끊기지 않는다.
   * 기록이 실패해도 치지직 호출은 이미 끝난 되돌릴 수 없는 일이므로 실제 결과를 그대로 돌려준다.
   */
  private async execute(channelId: string, request: ActionRequest, actor: Actor, options?: SubmitOptions): Promise<ActionOutcome> {
    const outcome = await this.performWithRetry(request, options);
    if (outcome === null) {
      // 취소는 치지직 호출 결과가 아니므로 판정 상태·실패율에는 넣지 않고 감사 기록만 남긴다.
      const cancelled: ActionOutcome = { ok: false, message: CANCELLED_MESSAGE };
      this.recordAudit(channelId, request, actor, cancelled);
      return cancelled;
    }
    this.recordOutcome(channelId, request, actor, outcome);
    return outcome;
  }

  /**
   * 성공하거나 끝내기로 결정할 때까지 시도한다. 시도마다 직전에 shouldRun을 확인한다.
   * @returns 시도 결과. shouldRun이 false여서 더 시도하지 않고 멈췄으면 null(취소)
   */
  private async performWithRetry(request: ActionRequest, options?: SubmitOptions): Promise<ActionOutcome | null> {
    for (let attempt = 0; ; attempt += 1) {
      if (options?.shouldRun?.() === false) return null;
      const result = await this.attemptOnce(request, options);
      if (result.kind === "cancelled") return null;
      if (result.kind === "sent") return { ok: true, note: null };
      const decision = await this.decideAfterFailure(request, result.phase, result.error, attempt);
      if (decision.kind === "done") return decision.outcome;
    }
  }

  /**
   * 토큰을 받고 치지직을 한 번 부른다. 실패는 던지지 않고 어느 단계에서 났는지와 함께 돌려준다.
   * 왜 단계를 가르나: 쓰기 호출 중의 실패만 '이미 처리됐을 수 있음'으로 다뤄야 하기 때문이다(FailurePhase).
   * 토큰을 받은 뒤 쓰기 직전에 shouldRun을 다시 본다. 토큰 갱신은 수 초 걸릴 수 있어, 그사이 꺼진 스위치를 놓치면 안 된다(S2).
   * @param request 보낼 요청
   * @param options shouldRun(자동 숨김 스위치 확인)
   */
  private async attemptOnce(request: ActionRequest, options?: SubmitOptions): Promise<AttemptResult> {
    let token: string;
    try {
      token = await this.options.tokenManager.getAccessToken();
    } catch (error) {
      return { kind: "failed", phase: "token", error };
    }
    if (options?.shouldRun?.() === false) return { kind: "cancelled" };
    try {
      await performRequest(this.options.api, token, request);
      return { kind: "sent" };
    } catch (error) {
      return { kind: "failed", phase: "write", error };
    }
  }

  /**
   * 실패 종류별 처리: 잠금·404·401·재시도 가능 오류·그 밖.
   * 404·401은 쓰기 호출의 응답일 때만 본다. 토큰 갱신의 404를 '이미 사라진 메시지'로 오인하지 않기 위해서다.
   */
  private async decideAfterFailure(request: ActionRequest, phase: FailurePhase, error: unknown, attempt: number): Promise<FailureDecision> {
    if (error instanceof WriteLockedError) return { kind: "done", outcome: { ok: false, message: error.message } };
    if (phase === "write" && isStatus(error, 404) && request.kind === "hide") return { kind: "done", outcome: { ok: true, note: "이미 사라진 메시지입니다" } };
    if (phase === "write" && isStatus(error, 401) && attempt === 0) return this.refreshAfterUnauthorized(request);
    if (isRetryable(error, phase) && attempt < MAX_RETRIES) {
      await this.sleep(RETRY_BASE_MS * 2 ** attempt);
      return { kind: "retry" };
    }
    return { kind: "done", outcome: { ok: false, message: this.describeFailure(request, error, phase) } };
  }

  /**
   * 401: 토큰을 강제로 갱신하고 한 번 더 시도한다. 갱신도 실패하면 그 이유로 끝낸다.
   * @param request 401을 받은 요청(갱신 실패를 기록할 때 쓴다)
   */
  private async refreshAfterUnauthorized(request: ActionRequest): Promise<FailureDecision> {
    try {
      await this.options.tokenManager.forceRefresh();
      return { kind: "retry" };
    } catch (error) {
      return { kind: "done", outcome: { ok: false, message: this.describeFailure(request, error, "token") } };
    }
  }

  /**
   * 실패를 매니저용 문구로 바꾸고, 치지직 오류가 아니면(네트워크·내부 오류) 자세한 내용을 경고 로그로 남긴다.
   * 왜: 내부 오류 문구(주소·포트·스택 이름)는 화면에 보일 필요가 없고 운영자 로그에만 있어야 한다(F10).
   * errorCode는 원인 오류의 code(ECONNRESET 등)다. undici는 "fetch failed"만 겉에 보여 원인을 따로 남긴다.
   * @param request 실패한 요청(종류만 로그에 남긴다. 채팅 원문은 남기지 않는다)
   * @param error 잡은 오류
   * @param phase 실패한 단계(쓰기 호출 중이면 결과를 알 수 없다는 문구가 된다)
   */
  private describeFailure(request: ActionRequest, error: unknown, phase: FailurePhase): string {
    if (!(error instanceof ChzzkApiError) && !(error instanceof WriteLockedError)) {
      this.options.logger.warn("치지직 호출 실패(치지직 응답이 아닌 오류)", { action: request.kind, phase, error: describeError(error), errorCode: networkErrorCode(error) });
    }
    return toUserMessage(error, phase);
  }

  /** 감사 기록·판정 상태·실패율을 갱신한다. 각 단계는 서로 영향을 주지 않도록 따로 보호한다. */
  private recordOutcome(channelId: string, request: ActionRequest, actor: Actor, outcome: ActionOutcome): void {
    const verdictId = "verdictId" in request ? request.verdictId : null;
    this.recordAudit(channelId, request, actor, outcome);
    if (!outcome.ok) this.options.logger.warn("쓰기 요청 실패", { action: request.kind, verdictId, outcomeMessage: outcome.message });
    if (outcome.ok && verdictId !== null) this.guardRecording(request, "판정 상태 갱신 실패", () => this.updateVerdict(channelId, verdictId, request.kind));
    this.trackFailureRate(channelId, outcome.ok);
  }

  /** 감사 기록 한 줄을 남긴다. 실패해도 실행 결과에는 영향을 주지 않는다. */
  private recordAudit(channelId: string, request: ActionRequest, actor: Actor, outcome: ActionOutcome): void {
    const verdictId = "verdictId" in request ? request.verdictId : null;
    this.guardRecording(request, "감사 기록 저장 실패", () =>
      this.options.auditLog.record({
        channelId, actorType: actor.type, actorChannelId: actor.channelId, action: request.kind, targetSenderChannelId: targetOf(request),
        verdictId, result: outcome.ok ? "ok" : "error", error: outcome.ok ? null : outcome.message,
      }),
    );
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

  /**
   * 성공한 조치에 맞게 판정 상태를 바꾸고 알린다.
   * 숨김은 대기 중(pending)인 판정만 hidden으로 바꾼다(S12). 왜: 숨기는 사이 매니저가 오판·임시 제한으로 바꿨으면 그 기록을 덮지 않는다.
   * 제한은 지금처럼 어떤 상태든 restricted로 바꾼다(사람 단위 조치가 더 강한 기록이다).
   * @param channelId 요청한 채널(판정이 이 채널의 것이어야 바꾼다)
   * @param verdictId 판정 번호
   * @param kind 성공한 조치 종류
   */
  private updateVerdict(channelId: string, verdictId: number, kind: ActionRequest["kind"]): void {
    if (kind === "hide") {
      if (this.options.verdicts.transitionStatus(verdictId, channelId, "hidden", HIDE_ALLOWED_FROM)) this.options.onVerdictStatus(verdictId, "hidden");
      return;
    }
    if (kind !== "temporary_restrict" && kind !== "restrict") return;
    this.options.verdicts.updateStatus(verdictId, "restricted");
    this.options.onVerdictStatus(verdictId, "restricted");
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

/**
 * 다시 시도할 만한 오류인지 본다(S1): 치지직의 429·5xx, 요청이 나가기 전에 난 연결 거부·DNS 실패.
 * 토큰 단계의 그 밖의 실패(시간 초과 등)도 쓰기 요청이 나가지 않았으므로 다시 시도한다.
 * 쓰기 호출 중의 시간 초과·연결 끊김·내부 오류는 치지직이 이미 처리했을 수 있어 다시 보내지 않는다.
 * @param error 잡은 오류
 * @param phase 실패한 단계
 */
function isRetryable(error: unknown, phase: FailurePhase): boolean {
  if (error instanceof ChzzkApiError) return error.status === 429 || error.status >= 500;
  return phase === "token" || isPreSendNetworkError(error);
}

/** 요청이 나가기 전에 난 네트워크 오류(연결 거부·DNS 실패)인지 본다. */
function isPreSendNetworkError(error: unknown): boolean {
  const code = networkErrorCode(error);
  return code !== null && PRE_SEND_NETWORK_CODES.has(code);
}

/**
 * 오류와 그 cause 사슬에서 처음 나오는 문자열 code를 찾는다. 없으면 null.
 * 왜 cause까지 보나: Node fetch(undici)는 TypeError("fetch failed")로 감싸고 실제 원인(ECONNREFUSED 등)을 cause에 둔다.
 * DOMException의 code는 숫자라 세지 않는다.
 * @param error 잡은 오류
 */
function networkErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * 오류를 매니저에게 보여 줄 문장으로 바꾼다(원인과 해결 방향 포함).
 * @param error 잡은 오류
 * @param phase 실패한 단계. 쓰기 호출 중의 치지직 응답이 아닌 오류는 요청이 이미 닿았을 수 있어 확인하라고 안내한다
 */
function toUserMessage(error: unknown, phase: FailurePhase): string {
  if (error instanceof WriteLockedError) return error.message;
  // 내부 오류 내용은 넣지 않는다(describeFailure가 로그로 남긴다).
  if (!(error instanceof ChzzkApiError)) return phase === "write" && !isPreSendNetworkError(error) ? RESULT_UNKNOWN_MESSAGE : NETWORK_FAILURE_MESSAGE;
  if (error.status === 429) return "치지직 호출 한도를 넘었습니다. 잠시 뒤 다시 시도하세요.";
  if (error.status === 403) return "치지직이 권한 없음으로 거부했습니다. 스트리머 연결 때 동의한 권한(Scope)을 확인하세요.";
  if (error.status >= 500) return "치지직 서버 오류로 실패했습니다. 잠시 뒤 다시 시도하세요.";
  return `치지직이 요청을 거부했습니다: ${error.apiMessage}`;
}
