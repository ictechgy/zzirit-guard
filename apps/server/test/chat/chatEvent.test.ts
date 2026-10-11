import { describe, expect, it } from "vitest";
import { isPrivilegedRole, parseChatPayload, parseSystemPayload } from "../../src/chat/chatEvent.js";

/** 문서 필드표대로 만든 정상 CHAT 페이로드. */
const payload = {
  channelId: "owner-channel", senderChannelId: "viewer-1", chatChannelId: "chat-1",
  profile: { nickname: "시청자1", badges: [], verifiedMark: false },
  userRoleCode: "common_user", content: "안녕하세요", emojis: {}, messageTime: 1_700_000_000_000,
};

describe("parseChatPayload", () => {
  it("문서 형식을 ChatEvent로 바꾼다", () => {
    expect(parseChatPayload(payload, 5)).toEqual({
      channelId: "owner-channel", senderChannelId: "viewer-1", chatChannelId: "chat-1", nickname: "시청자1",
      userRoleCode: "common_user", content: "안녕하세요", messageTime: 1_700_000_000_000, receivedAt: 5,
    });
  });

  it("JSON 문자열로 와도 읽는다", () => {
    expect(parseChatPayload(JSON.stringify(payload), 5)?.content).toBe("안녕하세요");
  });

  it("profile·emojis·userRoleCode가 빠져도 기본값으로 읽는다", () => {
    const { profile: _profile, emojis: _emojis, userRoleCode: _role, ...minimal } = payload;
    expect(parseChatPayload(minimal, 5)).toMatchObject({ nickname: "(알 수 없음)", userRoleCode: "common_user" });
  });

  it("필수 필드가 없거나 JSON이 깨지면 null", () => {
    expect(parseChatPayload({ ...payload, content: undefined }, 5)).toBeNull();
    expect(parseChatPayload("{broken", 5)).toBeNull();
  });
});

describe("parseSystemPayload", () => {
  it("connected와 revoked를 구분한다", () => {
    expect(parseSystemPayload({ type: "connected", data: { sessionKey: "k1" } })).toEqual({ type: "connected", sessionKey: "k1" });
    expect(parseSystemPayload(JSON.stringify({ type: "revoked", data: { eventType: "CHAT", channelId: "c" } }))).toEqual({
      type: "revoked", eventType: "CHAT", channelId: "c",
    });
    expect(parseSystemPayload({ type: "unknown" })).toBeNull();
  });
});

describe("isPrivilegedRole", () => {
  it("스트리머와 매니저만 참", () => {
    expect(["streamer", "streaming_channel_manager", "streaming_chat_manager"].map(isPrivilegedRole)).toEqual([true, true, true]);
    expect(isPrivilegedRole("common_user")).toBe(false);
  });
});
