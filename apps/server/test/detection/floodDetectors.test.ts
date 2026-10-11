import { describe, expect, it } from "vitest";
import { createGroupFloodDetector, createPersonalFloodDetector, type MessageRef } from "../../src/detection/floodDetectors.js";

/** 사용자 번호로 만든 메시지 참조. messageTime은 일부러 뒤죽박죽으로 둔다. */
function ref(user: number, messageTime = 1_000 - user): MessageRef {
  return { chatChannelId: "chat-1", messageTime, senderChannelId: `user-${user}`, nickname: `u${user}`, content: "복붙 도배 문장입니다아아", privileged: false };
}

/** 길이 10자 이상인 정규화 문장. */
const LONG_TEXT = "복붙도배문장입니다아아";

describe("GroupFloodDetector", () => {
  it("10초 안에 서로 다른 5명이 같은 문장을 보내면 앞선 4건까지 돌려준다", () => {
    const detector = createGroupFloodDetector();
    for (let user = 1; user <= 4; user += 1) expect(detector.observe(LONG_TEXT, ref(user), user * 1_000).triggered).toBe(false);
    const fifth = detector.observe(LONG_TEXT, ref(5), 5_000);
    expect(fifth.triggered).toBe(true);
    expect(fifth.earlierRefs.map((item) => item.senderChannelId)).toEqual(["user-1", "user-2", "user-3", "user-4"]);
    const sixth = detector.observe(LONG_TEXT, ref(6), 6_000);
    expect(sixth).toEqual({ triggered: true, earlierRefs: [] });
  });

  it("같은 사람이 반복한 것은 1명으로 센다", () => {
    const detector = createGroupFloodDetector();
    for (let index = 0; index < 6; index += 1) expect(detector.observe(LONG_TEXT, ref(1), index * 100).triggered).toBe(false);
  });

  it("10자 미만(ㅋㅋㅋ, GG 같은 집단 반응)은 보지 않는다", () => {
    const detector = createGroupFloodDetector();
    for (let user = 1; user <= 10; user += 1) expect(detector.observe("ㅋㅋ", ref(user), user).triggered).toBe(false);
  });

  it("창은 서버 수신 시각 기준이라, messageTime이 어긋나도 10초가 지나면 센 것을 잊는다", () => {
    const detector = createGroupFloodDetector();
    for (let user = 1; user <= 4; user += 1) detector.observe(LONG_TEXT, ref(user, 9_999_999), user * 1_000);
    expect(detector.observe(LONG_TEXT, ref(5, 0), 15_000).triggered).toBe(false);
  });
});

describe("PersonalFloodDetector", () => {
  it("한 사람이 10초 안에 5건째 보내면 참", () => {
    const detector = createPersonalFloodDetector();
    const results = [0, 1_000, 2_000, 3_000, 4_000].map((time) => detector.observe("user-1", time));
    expect(results).toEqual([false, false, false, false, true]);
    expect(detector.observe("user-2", 4_000)).toBe(false);
    expect(detector.observe("user-1", 20_000)).toBe(false);
  });
});
