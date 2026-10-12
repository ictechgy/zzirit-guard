import type { RealtimeEvent } from "@zzirit-guard/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoHideSwitch, type AutoHideSwitch } from "../../src/actions/autoHideSwitch.js";
import { createVerdictClaims, type VerdictClaims } from "../../src/actions/verdictClaims.js";
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

beforeEach(() => {
  database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
  database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
  verdicts = createVerdictRepository(database, () => 0);
  stats = createMinuteStats(database, () => 0);
  autoHide = createAutoHideSwitch({ settings: createSettingsRepository(database), auditLog: createAuditLog(database, () => 0), clock: () => 0 });
  submit = vi.fn(async () => ({ ok: true, note: null }));
  events = [];
  chatLines = [];
  claims = createVerdictClaims();
  handler = createDecisionHandler({
    verdicts, autoHide, stats, claims, logger: silentLogger,
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
  return { decision, reason: "rule:test", ref: ref("viewer-1", content), earlierFloodRefs: [], trivial: false, duplicate: false, ...extra };
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

  it("폭주 한도에 걸려 섀도로 저장되는 메시지는 실시간 채팅 줄도 shadow로 보인다(S5, M02)", () => {
    settingsBreaker(1);
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    handler.handle(chat("첫 금칙어"), result("auto_hide", "첫 금칙어"));
    handler.handle(chat("둘째 금칙어"), result("auto_hide", "둘째 금칙어"));
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
      verdicts, autoHide, stats, claims, logger,
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
      verdicts, autoHide, stats, claims, logger,
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
