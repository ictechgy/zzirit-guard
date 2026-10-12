import { describe, expect, it, vi } from "vitest";
import { createExecutor, MAX_PENDING_ACTIONS, type ActionRequest } from "../../src/actions/executor.js";
import { ChzzkApiError, type ChzzkApi } from "../../src/chzzk/apiClient.js";
import { WriteLockedError } from "../../src/connection/tokenManager.js";
import { openDatabase } from "../../src/db/database.js";
import { silentLogger, type Logger } from "../../src/logger.js";
import { createAuditLog } from "../../src/records/auditLog.js";
import { createVerdictRepository } from "../../src/records/verdictRepository.js";
import { createFakeApi } from "../fakes/fakeApi.js";
import { stubTokenManager } from "../fakes/stubTokenManager.js";

/** 실패를 정해진 순서로 낸 뒤 성공하는 blindMessage. */
function failingThenOk(errors: unknown[]): ChzzkApi["blindMessage"] {
  return vi.fn(async () => {
    const next = errors.shift();
    if (next) throw next;
  });
}

/** 실행기와 기록 저장소를 함께 만든다. */
function setup(api: Partial<ChzzkApi>, tokenOverrides = {}, logger: Logger = silentLogger, onStatus?: (id: number, status: string) => void) {
  const database = openDatabase(":memory:");
  const verdicts = createVerdictRepository(database, () => 0);
  const auditLog = createAuditLog(database, () => 0);
  const sleeps: number[] = [];
  const statusEvents: Array<[number, string]> = [];
  const executor = createExecutor({
    api: createFakeApi(api), tokenManager: stubTokenManager(tokenOverrides), auditLog, verdicts, clock: () => 0, logger,
    onVerdictStatus: (id, status) => { statusEvents.push([id, status]); onStatus?.(id, status); },
    sleep: async (ms) => void sleeps.push(ms),
  });
  const verdict = verdicts.insert({
    channelId: "c1", chatChannelId: "chat-1", messageTime: 7, senderChannelId: "bad", senderNickname: "악플러",
    content: "나쁜 말", decision: "candidate", reason: "rule:weak:1",
  });
  const hide: ActionRequest = { kind: "hide", target: { chatChannelId: "chat-1", messageTime: 7, senderChannelId: "bad" }, verdictId: verdict.id };
  return { executor, verdicts, auditLog, sleeps, statusEvents, verdict, hide };
}

/** 매니저 행위자. */
const manager = { type: "manager" as const, channelId: "manager-1" };

/**
 * undici fetch가 던지는 모양의 네트워크 오류(TypeError "fetch failed" + cause.code).
 * @param code 원인 오류의 code(ECONNREFUSED·ECONNRESET 등)
 */
function fetchFailure(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code} 10.0.0.7:443`), { code }) });
}

/** AbortSignal.timeout이 끊은 요청의 오류(이름이 TimeoutError인 DOMException). */
function timeoutFailure(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/** 되돌릴 수 없는 쓰기 세 가지: 이름, 요청, 그 요청을 받는 가짜 API 메서드 이름. */
const IRREVERSIBLE_REQUESTS: Array<[string, ActionRequest, keyof ChzzkApi]> = [
  ["hide", { kind: "hide", target: { chatChannelId: "chat-1", messageTime: 7, senderChannelId: "bad" }, verdictId: null }, "blindMessage"],
  ["temporary_restrict", { kind: "temporary_restrict", targetChannelId: "bad", chatChannelId: "chat-1", verdictId: null }, "addTemporaryRestriction"],
  ["restrict", { kind: "restrict", targetChannelId: "bad", verdictId: null }, "addRestriction"],
];

describe("Executor", () => {
  it("숨기면 감사 기록을 남기고 판정 상태를 hidden으로 바꾼다", async () => {
    const blindMessage = vi.fn(async () => undefined);
    const { executor, verdicts, auditLog, statusEvents, verdict, hide } = setup({ blindMessage });
    await expect(executor.submit("c1", hide, manager)).resolves.toEqual({ ok: true, note: null });
    expect(blindMessage).toHaveBeenCalledWith("owner-token", hide.kind === "hide" ? hide.target : null);
    expect(verdicts.get(verdict.id)?.status).toBe("hidden");
    expect(statusEvents).toEqual([[verdict.id, "hidden"]]);
    expect(auditLog.list("c1", 10, null)[0]).toMatchObject({ action: "hide", actorChannelId: "manager-1", targetSenderChannelId: "bad", result: "ok" });
  });

  it("429는 1·2초 기다리며 다시 시도한다", async () => {
    const blindMessage = failingThenOk([new ChzzkApiError(429, "TOO_MANY_REQUESTS", "/x"), new ChzzkApiError(429, "TOO_MANY_REQUESTS", "/x")]);
    const { executor, sleeps, hide } = setup({ blindMessage });
    await expect(executor.submit("c1", hide, manager)).resolves.toMatchObject({ ok: true });
    expect(blindMessage).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("서버 오류가 계속되면 3번 다시 시도한 뒤 실패를 기록한다", async () => {
    const serverError = () => new ChzzkApiError(500, "INTERNAL_SERVER_ERROR", "/x");
    const blindMessage = failingThenOk([serverError(), serverError(), serverError(), serverError()]);
    const { executor, sleeps, auditLog, hide } = setup({ blindMessage });
    const outcome = await executor.submit("c1", hide, manager);
    expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/서버 오류/) });
    expect(blindMessage).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(auditLog.list("c1", 10, null)[0]).toMatchObject({ result: "error" });
  });

  it("실패를 로그로 남길 때 기록기의 message를 덮지 않게 outcomeMessage로 남긴다(F8)", async () => {
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const blindMessage = failingThenOk([new ChzzkApiError(400, "스트리머가 아닙니다", "/x")]);
    const { executor, verdict, hide } = setup({ blindMessage }, {}, logger);
    await executor.submit("c1", hide, manager);
    expect(logger.warn).toHaveBeenCalledWith("쓰기 요청 실패", { action: "hide", verdictId: verdict.id, outcomeMessage: "치지직이 요청을 거부했습니다: 스트리머가 아닙니다" });
  });

  it("400은 다시 시도하지 않고 치지직 메시지를 보여 준다", async () => {
    const blindMessage = failingThenOk([new ChzzkApiError(400, "스트리머가 아닙니다", "/x")]);
    const { executor, hide } = setup({ blindMessage });
    await expect(executor.submit("c1", hide, manager)).resolves.toEqual({ ok: false, message: "치지직이 요청을 거부했습니다: 스트리머가 아닙니다" });
    expect(blindMessage).toHaveBeenCalledTimes(1);
  });

  it("숨기려던 메시지가 이미 없으면(404) 숨김 완료로 정리한다", async () => {
    const { executor, verdicts, verdict, hide } = setup({ blindMessage: failingThenOk([new ChzzkApiError(404, "NOT_FOUND", "/x")]) });
    await expect(executor.submit("c1", hide, manager)).resolves.toEqual({ ok: true, note: "이미 사라진 메시지입니다" });
    expect(verdicts.get(verdict.id)?.status).toBe("hidden");
  });

  it("401이면 토큰을 강제로 갱신하고 한 번 더 시도한다", async () => {
    const forceRefresh = vi.fn(async () => "refreshed");
    const blindMessage = failingThenOk([new ChzzkApiError(401, "INVALID_TOKEN", "/x")]);
    const { executor, hide } = setup({ blindMessage }, { forceRefresh });
    await expect(executor.submit("c1", hide, manager)).resolves.toMatchObject({ ok: true });
    expect(forceRefresh).toHaveBeenCalledTimes(1);
  });

  it("쓰기가 잠겨 있으면 호출하지 않고 이유를 알려 준다", async () => {
    const blindMessage = vi.fn(async () => undefined);
    const { executor, hide } = setup({ blindMessage }, { getAccessToken: async () => { throw new WriteLockedError("다시 연결해야 합니다"); } });
    await expect(executor.submit("c1", hide, manager)).resolves.toEqual({ ok: false, message: "다시 연결해야 합니다" });
    expect(blindMessage).not.toHaveBeenCalled();
  });

  it("1분 안에 10건 이상이고 절반 넘게 실패하면 한 번 알린다", async () => {
    const blindMessage = vi.fn(async () => { throw new ChzzkApiError(400, "bad", "/x"); });
    const { executor, hide } = setup({ blindMessage });
    const listener = vi.fn();
    executor.onFailureRateExceeded(listener);
    for (let index = 0; index < 12; index += 1) await executor.submit("c1", hide, manager);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("c1");
  });

  it("shouldRun이 false면 치지직을 부르지 않고 취소로 기록하며 판정 상태는 그대로 둔다", async () => {
    const blindMessage = vi.fn(async () => undefined);
    const getAccessToken = vi.fn(async () => "owner-token");
    const { executor, verdicts, auditLog, statusEvents, verdict, hide } = setup({ blindMessage }, { getAccessToken });
    await expect(executor.submit("c1", hide, manager, { shouldRun: () => false })).resolves.toEqual({ ok: false, message: "자동 숨김이 꺼져 보내지 않았습니다" });
    expect(blindMessage).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(verdicts.get(verdict.id)?.status).toBe("pending");
    expect(statusEvents).toEqual([]);
    expect(auditLog.list("c1", 10, null)[0]).toMatchObject({ action: "hide", result: "error", error: "자동 숨김이 꺼져 보내지 않았습니다", verdictId: verdict.id });
  });

  it("재시도를 기다리는 동안 스위치가 꺼지면 다시 부르지 않고 취소로 끝낸다(F9.1)", async () => {
    const blindMessage = failingThenOk([new ChzzkApiError(500, "INTERNAL_SERVER_ERROR", "/x")]);
    const getAccessToken = vi.fn(async () => "owner-token");
    const { executor, verdicts, auditLog, sleeps, statusEvents, verdict, hide } = setup({ blindMessage }, { getAccessToken });
    // 첫 시도의 5xx 뒤 백오프(sleep)에 들어가는 순간 스위치가 꺼진 상황을 흉내 낸다.
    const outcome = await executor.submit("c1", hide, manager, { shouldRun: () => sleeps.length === 0 });
    expect(outcome).toEqual({ ok: false, message: "자동 숨김이 꺼져 보내지 않았습니다" });
    expect(blindMessage).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([1000]);
    expect(verdicts.get(verdict.id)?.status).toBe("pending");
    expect(statusEvents).toEqual([]);
    expect(auditLog.list("c1", 10, null)).toEqual([expect.objectContaining({ action: "hide", result: "error", error: "자동 숨김이 꺼져 보내지 않았습니다" })]);
  });

  it("토큰을 받는(갱신하는) 동안 스위치가 꺼지면 치지직을 부르지 않고 취소로 끝낸다(S2, X02)", async () => {
    const blindMessage = vi.fn(async () => undefined);
    let isSwitchOn = true;
    // 토큰 갱신을 기다리는 사이 매니저가 스위치를 끈 상황을 흉내 낸다.
    const getAccessToken = vi.fn(async () => {
      isSwitchOn = false;
      return "owner-token";
    });
    const { executor, verdicts, statusEvents, verdict, hide } = setup({ blindMessage }, { getAccessToken });
    await expect(executor.submit("c1", hide, manager, { shouldRun: () => isSwitchOn })).resolves.toEqual({ ok: false, message: "자동 숨김이 꺼져 보내지 않았습니다" });
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(blindMessage).not.toHaveBeenCalled();
    expect(verdicts.get(verdict.id)?.status).toBe("pending");
    expect(statusEvents).toEqual([]);
  });

  it("취소가 12건 쌓여도 실패율 알림은 울리지 않는다", async () => {
    const blindMessage = vi.fn(async () => undefined);
    const { executor, hide } = setup({ blindMessage });
    const listener = vi.fn();
    executor.onFailureRateExceeded(listener);
    for (let index = 0; index < 12; index += 1) await executor.submit("c1", hide, manager, { shouldRun: () => false });
    expect(blindMessage).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("shouldRun이 true면 평소처럼 치지직을 부른다", async () => {
    const blindMessage = vi.fn(async () => undefined);
    const { executor, hide } = setup({ blindMessage });
    await expect(executor.submit("c1", hide, manager, { shouldRun: () => true })).resolves.toEqual({ ok: true, note: null });
    expect(blindMessage).toHaveBeenCalledTimes(1);
  });

  it("요청을 들어온 순서대로 하나씩 처리한다", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const blindMessage = vi.fn(async (_token: string, target: { senderChannelId: string }) => {
      order.push(`start:${target.senderChannelId}`);
      if (target.senderChannelId === "first") await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push(`end:${target.senderChannelId}`);
    });
    const { executor } = setup({ blindMessage: blindMessage as ChzzkApi["blindMessage"] });
    const request = (sender: string): ActionRequest => ({ kind: "hide", target: { chatChannelId: "c", messageTime: 1, senderChannelId: sender }, verdictId: null });
    const first = executor.submit("c1", request("first"), manager);
    const second = executor.submit("c1", request("second"), manager);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executor.pendingCount()).toBe(2);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("대기열이 가득 차면(MAX_PENDING_ACTIONS) 새 요청을 바로 거절하고 실패로 기록·로그한다(S3)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const blindMessage = vi.fn(async () => gate);
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { executor, auditLog, verdict, hide } = setup({ blindMessage }, {}, logger);
    const queued = Array.from({ length: MAX_PENDING_ACTIONS }, () => executor.submit("c1", hide, manager));
    expect(executor.pendingCount()).toBe(MAX_PENDING_ACTIONS);
    const rejected = await executor.submit("c1", hide, manager);
    expect(rejected).toEqual({ ok: false, message: expect.stringMatching(/대기 중인 조치가 너무 많아.*잠시 뒤 다시 시도/) });
    expect(executor.pendingCount()).toBe(MAX_PENDING_ACTIONS);
    expect(auditLog.list("c1", 1, null)[0]).toMatchObject({ action: "hide", result: "error", verdictId: verdict.id, error: rejected.ok ? null : rejected.message });
    expect(logger.warn).toHaveBeenCalledWith("실행기 대기열이 가득 차 요청을 거절했습니다", { action: "hide", pending: MAX_PENDING_ACTIONS });
    release();
    await Promise.all(queued);
    expect(executor.pendingCount()).toBe(0);
    await expect(executor.submit("c1", hide, manager)).resolves.toEqual({ ok: true, note: null });
  });

  it("실패율 알림 수신자가 예외를 던져도 나머지에게 알리고 submit은 결과를 돌려준다", async () => {
    const error = vi.fn();
    const logger: Logger = { ...silentLogger, error };
    const blindMessage = vi.fn(async () => { throw new ChzzkApiError(400, "bad", "/x"); });
    const { executor, hide } = setup({ blindMessage }, {}, logger);
    const second = vi.fn();
    executor.onFailureRateExceeded(() => { throw new Error("수신자 고장"); });
    executor.onFailureRateExceeded(second);
    for (let index = 0; index < 10; index += 1) await expect(executor.submit("c1", hide, manager)).resolves.toMatchObject({ ok: false });
    expect(second).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("실패율 알림 처리 실패", { error: expect.stringContaining("수신자 고장") });
  });

  it("기록 단계가 던져도 치지직 호출 결과를 그대로 돌려주고 로그만 남긴다", async () => {
    const error = vi.fn();
    const logger: Logger = { ...silentLogger, error };
    const blindMessage = vi.fn(async () => undefined);
    const { executor, auditLog, hide } = setup({ blindMessage }, {}, logger, () => { throw new Error("상태 알림 고장"); });
    vi.spyOn(auditLog, "record").mockImplementation(() => { throw new Error("DB 고장"); });
    await expect(executor.submit("c1", hide, manager)).resolves.toEqual({ ok: true, note: null });
    expect(error).toHaveBeenCalledWith("감사 기록 저장 실패", { action: "hide", error: expect.stringContaining("DB 고장") });
    expect(error).toHaveBeenCalledWith("판정 상태 갱신 실패", { action: "hide", error: expect.stringContaining("상태 알림 고장") });
    expect(JSON.stringify(error.mock.calls)).not.toContain("나쁜 말");
  });
});

describe("Executor 사용자 문구(F10)", () => {
  it("치지직 오류가 아닌 실패(네트워크 등)는 내부 내용을 문구에 넣지 않고, 자세한 내용은 경고 로그로 남긴다", async () => {
    const blindMessage = failingThenOk([fetchFailure("ECONNREFUSED"), fetchFailure("ECONNREFUSED"), fetchFailure("ECONNREFUSED"), fetchFailure("ECONNREFUSED")]);
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { executor, hide } = setup({ blindMessage }, {}, logger);
    const outcome = await executor.submit("c1", hide, manager);
    expect(outcome).toEqual({ ok: false, message: "치지직에 연결하지 못했습니다. 네트워크를 확인하세요." });
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ action: "hide", error: "TypeError: fetch failed", errorCode: "ECONNREFUSED" }));
  });
});

describe("Executor 재시도 범위(S1): 요청이 나갔을 수 있는 실패는 다시 보내지 않는다", () => {
  /** 실패 하나를 낸 뒤 성공하는 쓰기 API를 그 메서드 이름으로 만든다. */
  function apiFailingOnce(method: keyof ChzzkApi, error: unknown) {
    const call = vi.fn(failingThenOk([error]) as (...args: unknown[]) => Promise<void>);
    return { call, api: { [method]: call } as Partial<ChzzkApi> };
  }

  describe.each(IRREVERSIBLE_REQUESTS)("%s", (_name, request, method) => {
    it.each([
      ["응답 시간 초과(TimeoutError)", timeoutFailure()],
      ["연결 리셋(ECONNRESET)", fetchFailure("ECONNRESET")],
      ["소켓 끊김(UND_ERR_SOCKET)", fetchFailure("UND_ERR_SOCKET")],
    ])("%s는 한 번만 보내고 결과를 알 수 없으니 확인하라고 알린다", async (_label, error) => {
      const { call, api } = apiFailingOnce(method, error);
      const { executor, sleeps } = setup(api);
      const outcome = await executor.submit("c1", request, manager);
      expect(call).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
      expect(outcome).toEqual({ ok: false, message: expect.stringMatching(/결과를 알 수 없습니다.*확인/) });
    });
  });

  it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])("요청이 나가기 전 실패(%s)는 기다렸다가 다시 시도한다", async (code) => {
    const blindMessage = failingThenOk([fetchFailure(code)]);
    const { executor, sleeps, hide } = setup({ blindMessage });
    await expect(executor.submit("c1", hide, manager)).resolves.toEqual({ ok: true, note: null });
    expect(blindMessage).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]);
  });

  it("원인 코드가 없는 내부 오류(TypeError)도 다시 보내지 않는다", async () => {
    const blindMessage = failingThenOk([new TypeError("Cannot read properties of undefined")]);
    const { executor, sleeps, hide } = setup({ blindMessage });
    await expect(executor.submit("c1", hide, manager)).resolves.toMatchObject({ ok: false });
    expect(blindMessage).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("토큰을 받다가 난 네트워크 실패는 쓰기 요청이 나가지 않았으므로 다시 시도하고, 끝내 실패하면 연결 실패로 알린다", async () => {
    const blindMessage = vi.fn(async () => undefined);
    const getAccessToken = vi.fn(async () => { throw timeoutFailure(); });
    const { executor, sleeps, hide } = setup({ blindMessage }, { getAccessToken });
    await expect(executor.submit("c1", hide, manager)).resolves.toEqual({ ok: false, message: "치지직에 연결하지 못했습니다. 네트워크를 확인하세요." });
    expect(getAccessToken).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(blindMessage).not.toHaveBeenCalled();
  });

  it("토큰 갱신 단계의 404는 '이미 사라진 메시지'로 오인하지 않는다", async () => {
    const blindMessage = vi.fn(async () => undefined);
    const getAccessToken = vi.fn(async () => { throw new ChzzkApiError(404, "NOT_FOUND", "/auth/v1/token"); });
    const { executor, verdicts, verdict, hide } = setup({ blindMessage }, { getAccessToken });
    await expect(executor.submit("c1", hide, manager)).resolves.toMatchObject({ ok: false });
    expect(verdicts.get(verdict.id)?.status).toBe("pending");
  });
});
