import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../../src/chat/chatEvent.js";
import { createRepeatedChatFilter, MAX_REMEMBERED_CHATS, REPEATED_CHAT_WINDOW_MS } from "../../src/chat/repeatedChatFilter.js";

/** 채팅 이벤트. 보낸 사람·보낸 시각·받은 시각만 바꾼다. */
function chat(senderChannelId: string, messageTime: number, receivedAt = 0): ChatEvent {
  return { channelId: "c1", senderChannelId, chatChannelId: "chat-1", nickname: senderChannelId, userRoleCode: "common_user", content: "느금마", messageTime, receivedAt };
}

describe("RepeatedChatFilter(K4)", () => {
  it("같은 보낸 사람·보낸 시각의 채팅이 다시 오면 중복으로 본다", () => {
    const filter = createRepeatedChatFilter();
    expect(filter.isRepeat(chat("viewer-1", 100))).toBe(false);
    expect(filter.isRepeat(chat("viewer-1", 100, 5_000))).toBe(true);
  });

  it("보낸 시각이나 보낸 사람이 다르면 다른 메시지다", () => {
    const filter = createRepeatedChatFilter();
    expect([filter.isRepeat(chat("viewer-1", 100)), filter.isRepeat(chat("viewer-1", 101)), filter.isRepeat(chat("viewer-2", 100))]).toEqual([false, false, false]);
  });

  it("처음 본 뒤 10분이 지나면 잊는다", () => {
    const filter = createRepeatedChatFilter();
    filter.isRepeat(chat("viewer-1", 100, 0));
    expect(filter.isRepeat(chat("viewer-1", 100, REPEATED_CHAT_WINDOW_MS - 1))).toBe(true);
    expect(filter.isRepeat(chat("viewer-1", 100, REPEATED_CHAT_WINDOW_MS))).toBe(false);
  });

  it("기억하는 메시지가 상한을 넘으면 가장 먼저 본 것부터 잊는다(메모리 상한)", () => {
    const filter = createRepeatedChatFilter();
    for (let index = 0; index <= MAX_REMEMBERED_CHATS; index += 1) filter.isRepeat(chat(`viewer-${index}`, 100));
    expect(filter.isRepeat(chat(`viewer-${MAX_REMEMBERED_CHATS}`, 100))).toBe(true);
    expect(filter.isRepeat(chat("viewer-0", 100))).toBe(false);
  });
});
