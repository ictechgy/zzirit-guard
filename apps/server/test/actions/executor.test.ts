import { describe, expect, it, vi } from "vitest";
import { createExecutor, type ActionRequest } from "../../src/actions/executor.js";
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
