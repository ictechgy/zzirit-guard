import { beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../../src/chat/chatEvent.js";
import { openDatabase } from "../../src/db/database.js";
import { createGroupFloodDetector, createPersonalFloodDetector } from "../../src/detection/floodDetectors.js";
import { createDuplicateTracker } from "../../src/detection/messageTraits.js";
import { createDetectionPipeline, type DetectionPipeline } from "../../src/detection/pipeline.js";
import { createRuleRepository, type RuleRepository } from "../../src/detection/ruleRepository.js";
import { createAuditLog, type AuditLog } from "../../src/records/auditLog.js";

let pipeline: DetectionPipeline;
let rules: RuleRepository;
let auditLog: AuditLog;
let clock = 0;

beforeEach(() => {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
  rules = createRuleRepository(database, () => 0);
  rules.seedDefaults("c1");
  rules.add("c1", "allow", "적팀 죽여버려!!", "m");
  auditLog = createAuditLog(database, () => clock);
  pipeline = createDetectionPipeline({
    rules, auditLog, groupFlood: createGroupFloodDetector(), personalFlood: createPersonalFloodDetector(), duplicates: createDuplicateTracker(),
  });
});

/** 채팅 이벤트를 만든다. receivedAt이 겹치지 않게 시계를 1초씩 민다. */
function chat(content: string, overrides: Partial<ChatEvent> = {}): ChatEvent {
  clock += 1_000;
  return {
    channelId: "c1", senderChannelId: "viewer-1", chatChannelId: "chat-1", nickname: "시청자1", userRoleCode: "common_user",
    content, messageTime: clock, receivedAt: clock, ...overrides,
  };
}

describe("DetectionPipeline", () => {
  it.each([
    ["홍어들은 다 이래", "auto_hide", /^rule:strong:\d+$/],
    ["무료 치킨 쿠폰 받기 👉 bit.ly/free-chk", "auto_hide", /^rule:link$/],
    ["010-1234-5678 이 번호로 연락해봐", "auto_hide", /^rule:phone$/],
    ["씨@발 방송 꺼라", "candidate", /^rule:weak:\d+$/],
    ["방송 끝나고 칼 들고 기다린다", "candidate", /^rule:threat:\d+$/],
    ["101동 1203호 맞지?", "candidate", /^rule:address$/],
    ["여기가 시발점이다", "pass", /^none$/],
    ["안녕하세요~", "pass", /^none$/],
  ])("%s → %s", (content, decision, reason) => {
    const result = pipeline.evaluate(chat(content));
    expect(result.decision).toBe(decision);
    expect(result.reason).toMatch(reason);
  });

  it("허용어는 메시지 전체가 같을 때만 통과시킨다", () => {
    expect(pipeline.evaluate(chat("적팀 죽여버려!!")).decision).toBe("pass");
    expect(pipeline.evaluate(chat("적팀 죽여버려 시발")).decision).toBe("candidate");
  });

  it("허용어여도 금칙어 강보다 앞서지 않는다", () => {
    rules.add("c1", "allow", "홍어", "m");
    expect(pipeline.evaluate(chat("홍어")).decision).toBe("auto_hide");
  });

  it("스트리머·매니저 메시지는 자동 숨김 대신 후보", () => {
    const result = pipeline.evaluate(chat("홍어들은 다 이래", { userRoleCode: "streaming_chat_manager" }));
    expect(result.decision).toBe("candidate");
    expect(result.reason).toMatch(/:privileged$/);
  });

  it("떼도배는 다섯 번째에 앞선 메시지까지 넘긴다(권한자 메시지는 빼고)", () => {
    const text = "구독하면 선물 드려요 진짜로";
    for (let user = 1; user <= 3; user += 1) pipeline.evaluate(chat(text, { senderChannelId: `user-${user}` }));
    pipeline.evaluate(chat(text, { senderChannelId: "manager-1", userRoleCode: "streaming_channel_manager" }));
    const fifth = pipeline.evaluate(chat(text, { senderChannelId: "user-5" }));
    expect(fifth).toMatchObject({ decision: "auto_hide", reason: "rule:group_flood" });
    expect(fifth.earlierFloodRefs.map((ref) => ref.senderChannelId)).toEqual(["user-1", "user-2", "user-3"]);
  });

  it("개인 도배는 다섯 번째부터 후보", () => {
    const decisions = [1, 2, 3, 4, 5].map((index) => pipeline.evaluate(chat(`그냥 말 ${index}`)).decision);
    expect(decisions).toEqual(["pass", "pass", "pass", "pass", "candidate"]);
  });

  it("최근 180일 안에 실제로 조치된 사용자는 후보", () => {
    auditLog.record({ channelId: "c1", actorType: "manager", actorChannelId: "m1", action: "hide", targetSenderChannelId: "viewer-9", verdictId: null, result: "ok", error: null });
    expect(pipeline.evaluate(chat("평범한 말", { senderChannelId: "viewer-9" }))).toMatchObject({ decision: "candidate", reason: "rule:watch_user" });
  });

  it("가벼운 반응과 중복을 표시한다", () => {
    expect(pipeline.evaluate(chat("ㅋㅋㅋㅋㅋ"))).toMatchObject({ trivial: true, duplicate: false });
    expect(pipeline.evaluate(chat("ㅋㅋㅋ", { senderChannelId: "viewer-2" }))).toMatchObject({ trivial: true, duplicate: true });
  });
});
