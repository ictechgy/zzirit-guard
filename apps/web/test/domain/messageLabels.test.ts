import type { VerdictDto } from "@zzirit-guard/shared";
import { describe, expect, it } from "vitest";
import { buildMessageLabels, messageLabelOf } from "../../src/domain/messageLabels";
import { formatClockTime } from "../../src/domain/timeFormat";
import { NO_AI } from "../helpers/aiFixtures";

/** 기준 시각. */
const NOW = 1_000_000;

/** 판정 예시. */
function verdict(id: number, overrides: Partial<VerdictDto> = {}): VerdictDto {
  return { id, chatChannelId: "c", senderChannelId: "s", senderNickname: "닉", content: "x", messageTime: id, decision: "candidate", reason: "rule:weak:1", status: "pending", createdAt: NOW, ...NO_AI, ...overrides };
}

describe("buildMessageLabels(K22)", () => {
  it("겹치지 않으면 순번 없이, 같은 사람·같은 초가 겹치면 나온 순서대로 순번을 붙인다", () => {
    const time = formatClockTime(NOW);
    const labels = buildMessageLabels([verdict(1), verdict(2, { createdAt: NOW - 5_000 }), verdict(3), verdict(4, { senderNickname: "다른닉" })]);
    expect([...labels.values()]).toEqual([`닉의 ${time} 1번째 메시지`, `닉의 ${formatClockTime(NOW - 5_000)} 메시지`, `닉의 ${time} 2번째 메시지`, `다른닉의 ${time} 메시지`]);
  });

  it("모음에 없는 판정은 순번 없는 설명으로 대신한다", () => {
    expect(messageLabelOf(new Map(), verdict(9))).toBe(`닉의 ${formatClockTime(NOW)} 메시지`);
  });
});
