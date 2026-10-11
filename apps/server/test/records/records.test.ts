import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createAuditLog } from "../../src/records/auditLog.js";
import { createMinuteStats } from "../../src/records/minuteStats.js";
import { createVerdictRepository, type NewVerdict } from "../../src/records/verdictRepository.js";

/** 예시 판정. */
const sample: NewVerdict = {
  channelId: "c1", chatChannelId: "chat-1", messageTime: 111, senderChannelId: "viewer-1",
  senderNickname: "시청자1", content: "나쁜 말", decision: "candidate", reason: "rule:weak:1",
};

describe("VerdictRepository", () => {
  it("저장하고 상태를 바꾸고 최근 것만 읽는다", () => {
    let now = 1_000;
    const repository = createVerdictRepository(openDatabase(":memory:"), () => now);
    const first = repository.insert(sample);
    now = 5_000;
    const second = repository.insert({ ...sample, messageTime: 222, decision: "shadow", reason: "rule:strong:3" });
    repository.updateStatus(first.id, "ignored");
    expect(repository.get(first.id)).toMatchObject({ channelId: "c1", status: "ignored" });
    expect(repository.listRecent("c1", 2_000).map((verdict) => verdict.id)).toEqual([second.id]);
    expect(repository.deleteOlderThan(2_000)).toBe(1);
  });
});

describe("AuditLog", () => {
  it("기록하고 최신순으로 읽으며, 실제로 조치된 사용자만 요주의로 본다", () => {
    let now = 1_000;
    const log = createAuditLog(openDatabase(":memory:"), () => now);
    const base = { channelId: "c1", actorType: "manager" as const, actorChannelId: "m1", verdictId: null, error: null };
    log.record({ ...base, action: "hide", targetSenderChannelId: "bad", result: "ok" });
    now = 2_000;
    log.record({ ...base, action: "hide", targetSenderChannelId: "failed", result: "error", error: "429" });
    log.record({ ...base, action: "auto_hide_on", targetSenderChannelId: null, result: "ok" });
    expect(log.list("c1", 10, null).map((entry) => entry.action)).toEqual(["auto_hide_on", "hide", "hide"]);
    expect(log.hasEnforcedAction("c1", "bad", 0)).toBe(true);
    expect(log.hasEnforcedAction("c1", "failed", 0)).toBe(false);
    expect(log.hasEnforcedAction("c1", "bad", 1_500)).toBe(false);
  });
});

describe("MinuteStats", () => {
  it("메모리에 모았다가 분 단위로 더해 저장한다", () => {
    let now = 61_000;
    const stats = createMinuteStats(openDatabase(":memory:"), () => now);
    stats.increment("c1", "received");
    stats.increment("c1", "received", 2);
    stats.flush();
    stats.increment("c1", "received");
    stats.increment("c1", "shadow");
    now = 125_000;
    stats.increment("c1", "received");
    stats.flush();
    expect(stats.recent("c1", 0)).toEqual([
      expect.objectContaining({ minute: 60_000, received: 4, shadow: 1 }),
      expect.objectContaining({ minute: 120_000, received: 1, shadow: 0 }),
    ]);
  });
});
