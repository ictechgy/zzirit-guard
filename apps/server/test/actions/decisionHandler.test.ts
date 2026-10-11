import type { RealtimeEvent } from "@zzirit-guard/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoHideSwitch, type AutoHideSwitch } from "../../src/actions/autoHideSwitch.js";
import { createDecisionHandler, type DecisionHandler } from "../../src/actions/decisionHandler.js";
import type { Executor } from "../../src/actions/executor.js";
import type { ChatEvent } from "../../src/chat/chatEvent.js";
import { openDatabase } from "../../src/db/database.js";
import type { MessageRef } from "../../src/detection/floodDetectors.js";
import type { DetectionResult } from "../../src/detection/pipeline.js";
import { silentLogger, type Logger } from "../../src/logger.js";
import { createAuditLog } from "../../src/records/auditLog.js";
import { createMinuteStats, type MinuteStats } from "../../src/records/minuteStats.js";
import { createSettingsRepository } from "../../src/records/settingsRepository.js";
import { createVerdictRepository, type VerdictRepository } from "../../src/records/verdictRepository.js";

let handler: DecisionHandler;
let verdicts: VerdictRepository;
let stats: MinuteStats;
let autoHide: AutoHideSwitch;
let submit: ReturnType<typeof vi.fn>;
let events: RealtimeEvent[];
let chatLines: string[];

beforeEach(() => {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
  database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
  verdicts = createVerdictRepository(database, () => 0);
  stats = createMinuteStats(database, () => 0);
  autoHide = createAutoHideSwitch({ settings: createSettingsRepository(database), auditLog: createAuditLog(database, () => 0), clock: () => 0 });
  submit = vi.fn(async () => ({ ok: true, note: null }));
  events = [];
  chatLines = [];
  handler = createDecisionHandler({
    verdicts, autoHide, stats, logger: silentLogger,
    executor: { submit, pendingCount: () => 0, onFailureRateExceeded: () => undefined } as Executor,
    broadcaster: { broadcast: (event) => events.push(event), pushChatLine: (line) => chatLines.push(`${line.decision}:${line.content}`) },
  });
});

/** 메시지 참조. */
function ref(sender: string, content: string): MessageRef {
  return { chatChannelId: "chat-1", messageTime: 1, senderChannelId: sender, nickname: sender, content, privileged: false };
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
    handler.handle(chat("홍어"), result("auto_hide", "홍어"));
    expect(verdicts.listRecent("c1", 0)[0]).toMatchObject({ decision: "shadow" });
    expect(submit).not.toHaveBeenCalled();
    expect(chatLines).toEqual(["shadow:홍어"]);
    expect(flushedStats()).toMatchObject({ shadow: 1, auto_hidden: 0 });
  });

  it("스위치가 켜져 있으면 실행기로 숨기고, 떼도배의 앞선 메시지도 함께 숨긴다", () => {
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    handler.handle(chat("도배 문장"), result("auto_hide", "도배 문장", { earlierFloodRefs: [ref("user-1", "도배 문장"), ref("user-2", "도배 문장")] }));
    expect(submit).toHaveBeenCalledTimes(3);
    expect(submit.mock.calls.map((call) => call[1].target.senderChannelId)).toEqual(["viewer-1", "user-1", "user-2"]);
    expect(submit.mock.calls[0]?.[2]).toEqual({ type: "rule", channelId: null });
    expect(verdicts.listRecent("c1", 0).map((verdict) => verdict.decision)).toEqual(["auto_hide", "auto_hide", "auto_hide"]);
    expect(flushedStats()).toMatchObject({ auto_hidden: 3 });
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

  it("자동 숨김 요청이 거절되면 예외를 로그로 남기고 처리를 끝낸다", async () => {
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const rejecting = vi.fn(async () => {
      throw new Error("실행기 실패");
    });
    const failingHandler = createDecisionHandler({
      verdicts, autoHide, stats, logger,
      executor: { submit: rejecting, pendingCount: () => 0, onFailureRateExceeded: () => undefined } as unknown as Executor,
      broadcaster: { broadcast: () => undefined, pushChatLine: () => undefined },
    });
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    failingHandler.handle(chat("홍어"), result("auto_hide", "홍어 내용"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejecting).toHaveBeenCalledTimes(1);
    const verdictId = verdicts.listRecent("c1", 0)[0]?.id;
    expect(logger.error).toHaveBeenCalledWith("자동 숨김 요청 처리 중 예외", { verdictId, error: "Error: 실행기 실패" });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("홍어 내용");
  });
});
