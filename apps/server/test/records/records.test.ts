import type { MinuteStatDto } from "@zzirit-guard/shared";
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

  it("상태 전이는 허용한 이전 상태·같은 채널일 때만 바꾸고 결과를 알려 준다(S12)", () => {
    const repository = createVerdictRepository(openDatabase(":memory:"), () => 0);
    const verdict = repository.insert(sample);
    expect(repository.transitionStatus(verdict.id, "other-channel", "ignored", ["pending"])).toBe(false);
    expect(repository.transitionStatus(verdict.id, "c1", "ignored", ["hidden", "restricted"])).toBe(false);
    expect(repository.get(verdict.id)?.status).toBe("pending");
    expect(repository.transitionStatus(verdict.id, "c1", "ignored", ["pending"])).toBe(true);
    expect(repository.get(verdict.id)?.status).toBe("ignored");
    expect(repository.transitionStatus(verdict.id, "c1", "ignored", ["pending"])).toBe(false);
    expect(repository.transitionStatus(999, "c1", "hidden", ["pending"])).toBe(false);
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

describe("MinuteStats 저장 실패", () => {
  it("저장이 실패하면 누적값을 잃지 않고, 다음 flush에 정확히 한 번 저장한다", () => {
    let now = 61_000;
    const database = openDatabase(":memory:");
    const stats = createMinuteStats(database, () => now);
    stats.increment("c1", "received", 2);
    database.exec("DROP TABLE minute_stat");
    expect(() => stats.flush()).toThrow();
    database.exec(
      `CREATE TABLE minute_stat (
        channel_id TEXT NOT NULL, minute INTEGER NOT NULL,
        received INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
        deduplicated INTEGER NOT NULL DEFAULT 0, stage1_forwarded INTEGER NOT NULL DEFAULT 0,
        stage2_done INTEGER NOT NULL DEFAULT 0, stage2_dropped INTEGER NOT NULL DEFAULT 0,
        candidates INTEGER NOT NULL DEFAULT 0, auto_hidden INTEGER NOT NULL DEFAULT 0,
        shadow INTEGER NOT NULL DEFAULT 0, invalid_events INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel_id, minute)
      )`,
    );
    stats.increment("c1", "received");
    now = 125_000;
    stats.flush();
    expect(stats.recent("c1", 0)).toEqual([
      expect.objectContaining({ minute: 60_000, received: 3 }),
    ]);
  });
});

describe("VerdictRepository 오판 검토(스펙 5.5)", () => {
  it("오판 신고된 판정만 최신순으로 limit개 읽고, 이유별 건수는 많은 순으로 센다(다른 채널·다른 상태는 뺀다)", () => {
    let now = 1_000;
    const repository = createVerdictRepository(openDatabase(":memory:"), () => now);
    const report = (reason: string, channelId = "c1") => {
      now += 1_000;
      const verdict = repository.insert({ ...sample, channelId, reason });
      repository.updateStatus(verdict.id, "false_positive");
      return verdict.id;
    };
    const first = report("rule:strong:3");
    const second = report("rule:weak:7");
    const third = report("rule:strong:3");
    report("rule:strong:3", "other-channel");
    repository.insert({ ...sample, reason: "rule:strong:3" });
    expect(repository.listFalsePositives("c1", 2).map((verdict) => verdict.id)).toEqual([third, second]);
    expect(repository.listFalsePositives("c1", 10).map((verdict) => verdict.id)).toEqual([third, second, first]);
    expect(repository.countFalsePositivesByReason("c1")).toEqual([
      { reason: "rule:strong:3", count: 2 },
      { reason: "rule:weak:7", count: 1 },
    ]);
  });
});

describe("MinuteStats 행 형태", () => {
  it("recent 행의 키가 shared의 MinuteStatDto와 정확히 같다(웹이 같은 타입을 쓴다, R-20)", () => {
    const stats = createMinuteStats(openDatabase(":memory:"), () => 61_000);
    stats.increment("c1", "received");
    stats.flush();
    const expected: MinuteStatDto = {
      minute: 60_000, received: 1, skipped: 0, deduplicated: 0, stage1_forwarded: 0, stage2_done: 0, stage2_dropped: 0,
      candidates: 0, auto_hidden: 0, shadow: 0, invalid_events: 0,
    };
    expect(stats.recent("c1", 0)).toEqual([expected]);
  });
});
