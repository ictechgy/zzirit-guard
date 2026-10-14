import type { RealtimeEvent } from "@zzirit-guard/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoHideSwitch, type AutoHideSwitch } from "../../src/actions/autoHideSwitch.js";
import { createMessageHideGuard, type MessageHideGuard } from "../../src/actions/messageHideGuard.js";
import { createMessageHideLedger } from "../../src/records/messageHideLedger.js";
import { createVerdictClaims, type VerdictClaims } from "../../src/actions/verdictClaims.js";
import type { AiResult, AiSubmission } from "../../src/ai/aiStage.js";
import { createDecisionHandler, type DecisionHandler } from "../../src/actions/decisionHandler.js";
import type { Executor } from "../../src/actions/executor.js";
import type { ChatEvent } from "../../src/chat/chatEvent.js";
import { openDatabase, type Database } from "../../src/db/database.js";
import type { MessageRef } from "../../src/detection/floodDetectors.js";
import type { DetectionResult } from "../../src/detection/pipeline.js";
import { silentLogger, type Logger } from "../../src/logger.js";
import { createAuditLog } from "../../src/records/auditLog.js";
import { createMinuteStats, type MinuteStats } from "../../src/records/minuteStats.js";
import { createSettingsRepository } from "../../src/records/settingsRepository.js";
import { createVerdictRepository, type VerdictRepository } from "../../src/records/verdictRepository.js";

let database: Database;
let handler: DecisionHandler;
let verdicts: VerdictRepository;
let stats: MinuteStats;
let autoHide: AutoHideSwitch;
let submit: ReturnType<typeof vi.fn>;
let events: RealtimeEvent[];
let chatLines: string[];
let claims: VerdictClaims;
let hideGuard: MessageHideGuard;

beforeEach(() => {
  database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
  database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
  verdicts = createVerdictRepository(database, () => 0);
  stats = createMinuteStats(database, () => 0);
  autoHide = createAutoHideSwitch({ database, settings: createSettingsRepository(database), auditLog: createAuditLog(database, () => 0), clock: () => 0 });
  submit = vi.fn(async () => ({ ok: true, note: null }));
  events = [];
  chatLines = [];
  claims = createVerdictClaims();
  hideGuard = createMessageHideGuard(createMessageHideLedger(database, () => 0), silentLogger);
  handler = createDecisionHandler({
    verdicts, autoHide, stats, claims, logger: silentLogger, hideGuard, settings: createSettingsRepository(database),
    executor: { submit, pendingCount: () => 0, onFailureRateExceeded: () => undefined } as Executor,
    broadcaster: { broadcast: (event) => events.push(event), pushChatLine: (line) => chatLines.push(`${line.decision}:${line.content}`) },
  });
});

/** 메시지 참조. */
function ref(sender: string, content: string): MessageRef {
  return { chatChannelId: "chat-1", messageTime: 1, senderChannelId: sender, nickname: sender, content, privileged: false, isRoleUnknown: false };
}

/** 채팅 이벤트. */
function chat(content: string): ChatEvent {
  return { channelId: "c1", senderChannelId: "viewer-1", chatChannelId: "chat-1", nickname: "viewer-1", userRoleCode: "common_user", content, messageTime: 1, receivedAt: 1 };
}

/** 판정 결과. */
function result(decision: DetectionResult["decision"], content: string, extra: Partial<DetectionResult> = {}): DetectionResult {
  return { decision, reason: "rule:test", ref: ref("viewer-1", content), earlierFloodRefs: [], trivial: false, duplicate: false, aiEligible: false, keywordRouteId: null, ...extra };
}

/** 통계를 저장하고 첫 분의 값을 읽는다. */
function flushedStats() {
  stats.flush();
  return stats.recent("c1", 0)[0];
}

/** 폭주 차단 한도를 바꾼다. */
function settingsBreaker(limit: number): void {
  database.prepare("UPDATE setting SET breaker_per_minute = ? WHERE channel_id = 'c1'").run(limit);
}

describe("DecisionHandler", () => {
  it("통과는 저장하지 않고 채팅 줄과 통계만 남긴다", () => {
    handler.handle(chat("안녕"), result("pass", "안녕", { trivial: true, duplicate: true }));
    expect(verdicts.listRecent("c1", 0)).toEqual([]);
    expect(chatLines).toEqual(["pass:안녕"]);
    expect(flushedStats()).toMatchObject({ received: 1, skipped: 1, deduplicated: 1 });
  });

  it("후보는 저장하고 방송한다", () => {
    handler.handle(chat("나쁜 말"), result("candidate", "나쁜 말"));
    expect(events).toEqual([{ type: "verdict", verdict: expect.objectContaining({ decision: "candidate", content: "나쁜 말" }) }]);
    expect(flushedStats()).toMatchObject({ candidates: 1 });
  });

  it("스위치가 꺼져 있으면 숨기지 않고 섀도로 기록한다", () => {
    handler.handle(chat("느금마"), result("auto_hide", "느금마"));
    expect(verdicts.listRecent("c1", 0)[0]).toMatchObject({ decision: "shadow" });
    expect(submit).not.toHaveBeenCalled();
    expect(chatLines).toEqual(["shadow:느금마"]);
    expect(flushedStats()).toMatchObject({ shadow: 1, auto_hidden: 0 });
  });

  it("스위치가 켜져 있으면 실행기로 숨기고, 떼도배의 앞선 메시지도 함께 숨긴다", async () => {
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    handler.handle(chat("도배 문장"), result("auto_hide", "도배 문장", { earlierFloodRefs: [ref("user-1", "도배 문장"), ref("user-2", "도배 문장")] }));
    expect(submit).toHaveBeenCalledTimes(3);
    expect(submit.mock.calls.map((call) => call[1].target.senderChannelId)).toEqual(["viewer-1", "user-1", "user-2"]);
    expect(submit.mock.calls[0]?.[2]).toEqual({ type: "rule", channelId: null });
    expect(verdicts.listRecent("c1", 0).map((verdict) => verdict.decision)).toEqual(["auto_hide", "auto_hide", "auto_hide"]);
    // 자동 숨김 통계는 실행기가 성공을 알린 뒤에 센다(S5).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flushedStats()).toMatchObject({ auto_hidden: 3 });
  });

  it("자동 숨김 통계는 숨김이 성공한 뒤에만 센다(S5, M01)", async () => {
    let finish: (outcome: { ok: boolean; note?: null; message?: string }) => void = () => undefined;
    submit.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    handler.handle(chat("느금마"), result("auto_hide", "느금마"));
    expect(flushedStats()?.auto_hidden ?? 0).toBe(0);
    finish({ ok: true, note: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flushedStats()).toMatchObject({ auto_hidden: 1 });
  });

  it.each([
    ["실패", { ok: false, message: "치지직 서버 오류로 실패했습니다." }],
    ["취소", { ok: false, message: "자동 숨김이 꺼져 보내지 않았습니다" }],
  ])("자동 숨김이 %s로 끝나면 auto_hidden을 세지 않는다(S5, M01)", async (_label, outcome) => {
    submit.mockImplementation(async () => outcome);
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    handler.handle(chat("느금마"), result("auto_hide", "느금마"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flushedStats()).toMatchObject({ auto_hidden: 0, shadow: 0 });
  });

  it("자동 숨김을 보내는 동안 그 판정을 붙잡아 매니저 숨기기·무시와 겹치지 않게 하고, 끝나면 놓는다(S12)", async () => {
    let finish: (outcome: { ok: boolean; note: null }) => void = () => undefined;
    submit.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    handler.handle(chat("느금마"), result("auto_hide", "느금마"));
    const verdictId = verdicts.listRecent("c1", 0)[0]?.id as number;
    expect(claims.holderOf(verdictId)).toBe("auto_hide");
    finish({ ok: true, note: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(claims.isClaimed(verdictId)).toBe(false);
  });

  it("자동 숨김 결과를 알 수 없으면 판정을 놓지 않고 unknown으로 붙잡아 둔다(K1)", async () => {
    submit.mockImplementation(async () => ({ ok: false, message: "치지직 응답을 받지 못해 처리 결과를 알 수 없습니다.", isResultUnknown: true }));
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    handler.handle(chat("느금마"), result("auto_hide", "느금마"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const verdictId = verdicts.listRecent("c1", 0)[0]?.id as number;
    expect(claims.holderOf(verdictId)).toBe("unknown");
    expect(claims.tryClaim(verdictId, "manager")).toBe(false);
  });

  it("폭주 한도에 걸려 섀도로 저장되는 메시지는 실시간 채팅 줄도 shadow로 보인다(S5, M02)", () => {
    settingsBreaker(1);
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    handler.handle(chat("첫 금칙어"), result("auto_hide", "첫 금칙어"));
    handler.handle(chat("둘째 금칙어"), result("auto_hide", "둘째 금칙어", { ref: { ...ref("viewer-1", "둘째 금칙어"), messageTime: 2 } }));
    expect(verdicts.listRecent("c1", 0).map((verdict) => verdict.decision)).toEqual(["auto_hide", "shadow"]);
    expect(chatLines).toEqual(["auto_hide:첫 금칙어", "shadow:둘째 금칙어"]);
  });

  it("후보 판정(권한자)이어도 떼도배의 앞선 메시지는 규칙 이유로 숨긴다", () => {
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    handler.handle(
      chat("도배 문장"),
      result("candidate", "도배 문장", { reason: "rule:group_flood:privileged", earlierFloodRefs: [ref("user-1", "도배 문장"), ref("user-2", "도배 문장")] }),
    );
    expect(verdicts.listRecent("c1", 0)).toEqual([
      expect.objectContaining({ decision: "candidate", senderChannelId: "viewer-1", reason: "rule:group_flood:privileged" }),
      expect.objectContaining({ decision: "auto_hide", senderChannelId: "user-1", reason: "rule:group_flood" }),
      expect.objectContaining({ decision: "auto_hide", senderChannelId: "user-2", reason: "rule:group_flood" }),
    ]);
    expect(submit.mock.calls.map((call) => call[1].target.senderChannelId)).toEqual(["user-1", "user-2"]);
    expect(submit.mock.calls.map((call) => call[1].kind)).toEqual(["hide", "hide"]);
  });

  it("숨김 요청에는 스위치 상태를 다시 확인하는 shouldRun을 붙인다", () => {
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    handler.handle(chat("느금마"), result("auto_hide", "느금마"));
    const options = submit.mock.calls[0]?.[3] as { shouldRun: () => boolean };
    expect(options.shouldRun()).toBe(true);
    autoHide.setEnabled("c1", false, { type: "manager", channelId: "m1" }, "manual");
    expect(options.shouldRun()).toBe(false);
  });

  it("폭주 한도에 걸리면 앞선 숨김 2건만 보내고 스위치를 끈 뒤 나머지는 섀도로 남긴다", () => {
    settingsBreaker(2);
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    handler.handle(chat("도배 문장"), result("auto_hide", "도배 문장", {
      earlierFloodRefs: [ref("user-1", "도배 문장"), ref("user-2", "도배 문장"), ref("user-3", "도배 문장")],
    }));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(autoHide.isEnabled("c1")).toBe(false);
    expect(verdicts.listRecent("c1", 0).map((verdict) => verdict.decision)).toEqual(["auto_hide", "auto_hide", "shadow", "shadow"]);
  });

  it("권한자 앞선 메시지는 떼도배 숨김에서 빠진다", () => {
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    handler.handle(chat("도배 문장"), result("auto_hide", "도배 문장", {
      earlierFloodRefs: [ref("user-1", "도배 문장"), { ...ref("manager-1", "도배 문장"), privileged: true }],
    }));
    expect(submit.mock.calls.map((call) => call[1].target.senderChannelId)).toEqual(["viewer-1", "user-1"]);
    expect(verdicts.listRecent("c1", 0).map((verdict) => verdict.senderChannelId)).toEqual(["viewer-1", "user-1"]);
  });

  it("역할을 모르는 사람의 앞선 메시지는 떼도배 숨김에서 빠진다(S18)", () => {
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    handler.handle(chat("도배 문장"), result("auto_hide", "도배 문장", {
      earlierFloodRefs: [ref("user-1", "도배 문장"), { ...ref("role-missing", "도배 문장"), isRoleUnknown: true }],
    }));
    expect(submit.mock.calls.map((call) => call[1].target.senderChannelId)).toEqual(["viewer-1", "user-1"]);
  });

  it("자동 숨김 요청이 거절되면 예외를 로그로 남기고 처리를 끝낸다", async () => {
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const rejecting = vi.fn(async () => {
      throw new Error("실행기 실패");
    });
    const failingHandler = createDecisionHandler({
      verdicts, autoHide, stats, claims, logger, hideGuard, settings: createSettingsRepository(database),
      executor: { submit: rejecting, pendingCount: () => 0, onFailureRateExceeded: () => undefined } as unknown as Executor,
      broadcaster: { broadcast: () => undefined, pushChatLine: () => undefined },
    });
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    failingHandler.handle(chat("느금마"), result("auto_hide", "느금마 내용"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejecting).toHaveBeenCalledTimes(1);
    const verdictId = verdicts.listRecent("c1", 0)[0]?.id;
    expect(logger.error).toHaveBeenCalledWith("자동 숨김 요청 처리 중 예외", { verdictId, error: "Error: 실행기 실패" });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("느금마 내용");
  });

  it("자동 숨김이 실패하면 기록기의 message를 덮지 않게 outcomeMessage로 남긴다(F8)", async () => {
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const failingHandler = createDecisionHandler({
      verdicts, autoHide, stats, claims, logger, hideGuard, settings: createSettingsRepository(database),
      executor: { submit: async () => ({ ok: false, message: "치지직 서버 오류" }), pendingCount: () => 0, onFailureRateExceeded: () => undefined } as Executor,
      broadcaster: { broadcast: () => undefined, pushChatLine: () => undefined },
    });
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    failingHandler.handle(chat("느금마"), result("auto_hide", "느금마"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const verdictId = verdicts.listRecent("c1", 0)[0]?.id;
    expect(logger.warn).toHaveBeenCalledWith("자동 숨김 실패", { verdictId, outcomeMessage: "치지직 서버 오류" });
  });
});

/** AI 단계가 넘기는 채팅. */
function aiSubmission(sender = "viewer-1", content = "애매한 말"): AiSubmission {
  return { channelId: "c1", ref: ref(sender, content), keywordRouteId: null };
}

/** 2차 결과. */
function aiResult(unsafeProbability: number, category: AiResult["category"] = "S2"): AiResult {
  return { unsafeProbability, category, model: "kanana@1" };
}

describe("DecisionHandler AI 결과(로드맵 2단계)", () => {
  it("후보 임계값 미만이면 저장·방송하지 않는다(최소 저장)", () => {
    handler.handleAiResult(aiSubmission(), aiResult(0.49));
    expect(verdicts.listRecent("c1", 0)).toEqual([]);
    expect(events).toEqual([]);
  });

  it("임계값 이상이면 AI 칸을 담은 후보로 저장·방송하고, 채팅 줄은 다시 보내지 않는다", () => {
    handler.handleAiResult(aiSubmission(), aiResult(0.7));
    const stored = verdicts.listRecent("c1", 0)[0];
    expect(stored).toMatchObject({ decision: "candidate", reason: "ai:S2", aiProbability: 0.7, aiCategory: "S2", sure: false });
    expect(events).toEqual([{ type: "verdict", verdict: stored }]);
    expect(chatLines).toEqual([]);
    expect(flushedStats()).toMatchObject({ candidates: 1, received: 0 });
  });

  it("'확실'은 결과가 나온 때의 임계값으로 정해 저장하고, 나중에 임계값을 바꿔도 바뀌지 않는다", () => {
    const settings = createSettingsRepository(database);
    handler.handleAiResult(aiSubmission(), aiResult(0.995));
    settings.update("c1", { sureThreshold: 0.999 });
    handler.handleAiResult(aiSubmission("viewer-2"), aiResult(0.995));
    expect(verdicts.listRecent("c1", 0).map((verdict) => verdict.sure)).toEqual([true, false]);
  });

  it("가장 높은 범주가 S6이면 '도움 필요'로 기록한다", () => {
    handler.handleAiResult(aiSubmission(), aiResult(0.8, "S6"));
    expect(verdicts.listRecent("c1", 0)[0]).toMatchObject({ decision: "needs_care", reason: "ai:S6" });
  });

  it("같은 메시지에 판정이 이미 있으면 후보는 만들지 않지만 '도움 필요'는 기록한다", () => {
    handler.handle(chat("도배 문장"), result("auto_hide", "도배 문장"));
    handler.handleAiResult(aiSubmission("viewer-1", "도배 문장"), aiResult(0.9, "S2"));
    handler.handleAiResult(aiSubmission("viewer-1", "도배 문장"), aiResult(0.9, "S6"));
    expect(verdicts.listRecent("c1", 0).map((verdict) => verdict.decision)).toEqual(["shadow", "needs_care"]);
  });

  it("채널의 후보 임계값을 바꾸면 다음 결과부터 그 값으로 정한다", () => {
    createSettingsRepository(database).update("c1", { candidateThreshold: 0.8 });
    handler.handleAiResult(aiSubmission(), aiResult(0.7));
    expect(verdicts.listRecent("c1", 0)).toEqual([]);
  });

  it("AI 대상 판정이면 키워드 경로 번호와 함께 AI 단계에 넘긴다", () => {
    const submitted: AiSubmission[] = [];
    const withAi = createDecisionHandler({
      verdicts, autoHide, stats, claims, logger: silentLogger, hideGuard, settings: createSettingsRepository(database),
      executor: { submit, pendingCount: () => 0, onFailureRateExceeded: () => undefined } as Executor,
      broadcaster: { broadcast: () => undefined, pushChatLine: () => undefined },
      submitToAi: (item) => submitted.push(item),
    });
    withAi.handle(chat("죽고싶다"), result("pass", "죽고싶다", { reason: "none", aiEligible: true, keywordRouteId: 7 }));
    withAi.handle(chat("규칙 후보"), result("candidate", "규칙 후보"));
    expect(submitted).toEqual([{ channelId: "c1", ref: expect.objectContaining({ content: "죽고싶다" }), keywordRouteId: 7 }]);
  });
});

describe("같은 메시지 숨김 한 번(로드맵 2단계 계획 R4)", () => {
  it("AI 후보를 매니저가 숨긴 뒤 떼도배가 발동해도 그 메시지에는 숨김·판정·폭주 한도를 쓰지 않는다", async () => {
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    const hiddenRef = ref("user-1", "도배 문장");
    const target = { chatChannelId: hiddenRef.chatChannelId, messageTime: hiddenRef.messageTime, senderChannelId: hiddenRef.senderChannelId };
    expect(hideGuard.tryAcquire(target)).toBeNull();
    hideGuard.settle(target, { ok: true, note: null });
    handler.handle(chat("도배 문장"), result("auto_hide", "도배 문장", { earlierFloodRefs: [hiddenRef, ref("user-2", "도배 문장")] }));
    expect(submit.mock.calls.map((call) => call[1].target.senderChannelId)).toEqual(["viewer-1", "user-2"]);
    expect(verdicts.listRecent("c1", 0).map((verdict) => verdict.senderChannelId)).toEqual(["viewer-1", "user-2"]);
  });

  it("떼도배로 숨긴 메시지는 AI 결과가 늦게 와도 후보가 생기지 않고, 매니저 숨김도 막힌다", async () => {
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    handler.handle(chat("도배 문장"), result("auto_hide", "도배 문장"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    handler.handleAiResult(aiSubmission("viewer-1", "도배 문장"), aiResult(0.9));
    expect(verdicts.listRecent("c1", 0)).toHaveLength(1);
    expect(hideGuard.blockOf({ chatChannelId: "chat-1", messageTime: 1, senderChannelId: "viewer-1" })).toBe("hidden");
  });
});

describe("메시지 숨김 장부(Codex PR C 리뷰)", () => {
  it("이미 숨긴 메시지가 다시 전달되면(재시작 뒤) 폭주 한도·판정을 쓰지 않고 숨김도 보내지 않는다", () => {
    settingsBreaker(1);
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    const target = { chatChannelId: "chat-1", messageTime: 1, senderChannelId: "viewer-1" };
    createMessageHideLedger(database, () => 0).record(target, "hidden");
    handler.handle(chat("느금마"), result("auto_hide", "느금마"));
    handler.handle(chat("다른 금칙어"), result("auto_hide", "다른 금칙어", { ref: { ...ref("viewer-1", "다른 금칙어"), messageTime: 2 } }));
    expect(submit.mock.calls.map((call) => call[1].target.messageTime)).toEqual([2]);
    expect(verdicts.listRecent("c1", 0).map((verdict) => verdict.messageTime)).toEqual([2]);
    expect(chatLines[0]).toBe("auto_hide:느금마");
  });

  it("결과를 알 수 없는 숨김은 기한 없이 막고, 한 번 숨긴 메시지는 결과 모름으로 되돌리지 않는다", () => {
    const ledger = createMessageHideLedger(database, () => 0);
    const guard = createMessageHideGuard(ledger, silentLogger);
    const target = { chatChannelId: "chat-1", messageTime: 9, senderChannelId: "x" };
    expect(guard.tryAcquire(target)).toBeNull();
    guard.settle(target, { ok: false, message: "모름", isResultUnknown: true });
    expect(guard.tryAcquire(target)).toBe("result_unknown");
    ledger.record(target, "hidden");
    ledger.record(target, "result_unknown");
    expect(ledger.stateOf(target)).toBe("hidden");
  });

  it("보내지 않았거나 실패한 숨김은 막지 않는다", () => {
    const guard = createMessageHideGuard(createMessageHideLedger(database, () => 0), silentLogger);
    const target = { chatChannelId: "chat-1", messageTime: 10, senderChannelId: "x" };
    expect(guard.tryAcquire(target)).toBeNull();
    expect(guard.tryAcquire(target)).toBe("in_flight");
    guard.settle(target, { ok: false, message: "실패" });
    expect(guard.tryAcquire(target)).toBeNull();
  });
});

describe("숨김 장부 쓰기 실패(Codex PR C 2차 리뷰)", () => {
  const target = { chatChannelId: "chat-1", messageTime: 20, senderChannelId: "x" };

  it("보낸 뒤 결과를 장부에 적지 못해도 예외를 던지지 않고, 같은 메시지는 결과 모름으로 계속 막는다", () => {
    const ledger = createMessageHideLedger(database, () => 0);
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const failingRecord = () => {
      throw new Error("SQLITE_BUSY");
    };
    const guard = createMessageHideGuard({ ...ledger, record: failingRecord }, logger);
    expect(guard.tryAcquire(target)).toBeNull();
    expect(() => guard.settle(target, { ok: true, note: null })).not.toThrow();
    expect(guard.blockOf(target)).toBe("result_unknown");
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("보내는 중 표시가 남은 채 재시작하면(결과를 적기 전에 죽음) 결과 모름으로 막는다", () => {
    const ledger = createMessageHideLedger(database, () => 0);
    expect(createMessageHideGuard(ledger, silentLogger).tryAcquire(target)).toBeNull();
    expect(createMessageHideGuard(ledger, silentLogger).blockOf(target)).toBe("result_unknown");
  });

  it("보내기 전에 장부에 적지 못하면 자동 숨김을 보내지 않고, 판정은 대기 중으로 남아 매니저가 처리할 수 있다", () => {
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ledger = createMessageHideLedger(database, () => 0);
    const failingMark = () => {
      throw new Error("SQLITE_FULL");
    };
    const failingHandler = createDecisionHandler({
      verdicts, autoHide, stats, claims, logger, settings: createSettingsRepository(database),
      hideGuard: createMessageHideGuard({ ...ledger, markSending: failingMark }, logger),
      executor: { submit, pendingCount: () => 0, onFailureRateExceeded: () => undefined } as Executor,
      broadcaster: { broadcast: () => undefined, pushChatLine: () => undefined },
    });
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    expect(() => failingHandler.handle(chat("느금마"), result("auto_hide", "느금마"))).not.toThrow();
    expect(submit).not.toHaveBeenCalled();
    expect(verdicts.listRecent("c1", 0).map((verdict) => verdict.status)).toEqual(["pending"]);
    expect(logger.error).toHaveBeenCalledWith("숨김 장부에 적지 못해 자동 숨김을 보내지 않았습니다(DB 상태를 확인하세요)", expect.objectContaining({ error: "Error: SQLITE_FULL" }));
  });
});

