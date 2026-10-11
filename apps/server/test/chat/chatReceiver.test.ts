import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../../src/chat/chatEvent.js";
import { connectWithSocketIo, createChatReceiver, reconnectDelayMs, type ChatReceiver } from "../../src/chat/chatReceiver.js";
import { createChzzkApi } from "../../src/chzzk/apiClient.js";
import { createCredentialStore } from "../../src/connection/credentialStore.js";
import { createTokenManager } from "../../src/connection/tokenManager.js";
import { openDatabase } from "../../src/db/database.js";
import { silentLogger } from "../../src/logger.js";
import { createTokenCipher } from "../../src/security/tokenCipher.js";
import { startFakeChzzk, type FakeChzzk } from "../fakes/fakeChzzk.js";
import { waitFor } from "../helpers/waitFor.js";

let fake: FakeChzzk;
let receiver: ChatReceiver;
let received: ChatEvent[];
let invalidCount: number;
let revokedCount: number;

beforeEach(async () => {
  fake = await startFakeChzzk();
  received = [];
  invalidCount = 0;
  revokedCount = 0;
  const api = createChzzkApi({ apiBase: fake.baseUrl, clientId: "test-client", clientSecret: "test-secret" });
  const store = createCredentialStore(openDatabase(":memory:"), createTokenCipher(randomBytes(32)), Date.now);
  const tokens = fake.issueTokens(fake.owner);
  store.saveConnection(fake.owner, { channelId: fake.owner.channelId, ...tokens, accessExpiresAt: Date.now() + 86_400_000 });
  receiver = createChatReceiver({
    api, tokenManager: createTokenManager({ store, api, clock: Date.now }), connect: connectWithSocketIo, clock: Date.now,
    logger: silentLogger, onChat: (event) => received.push(event), onConnectionChange: () => undefined,
    onInvalidEvent: () => { invalidCount += 1; }, onRevoked: () => { revokedCount += 1; },
  });
});
afterEach(async () => {
  receiver.stop();
  await fake.close();
});

/** 정상 CHAT 페이로드. */
function chatPayload(content: string) {
  return { channelId: "owner-channel", senderChannelId: "viewer-1", chatChannelId: "chat-1", profile: { nickname: "시청자1" }, userRoleCode: "common_user", content, emojis: {}, messageTime: Date.now() };
}

describe("ChatReceiver", () => {
  it("세션을 만들고 sessionKey로 구독한 뒤 채팅을 넘긴다", async () => {
    receiver.start();
    await waitFor(() => receiver.isConnected());
    expect(fake.calls.some((call) => call.path === "/open/v1/sessions/events/subscribe/chat" && call.query.sessionKey)).toBe(true);
    fake.emitChat(chatPayload("첫 채팅"));
    fake.emitChat(JSON.stringify(chatPayload("문자열 채팅")));
    fake.emitChat({ broken: true });
    await waitFor(() => received.length === 2 && invalidCount === 1);
    expect(received.map((event) => event.content)).toEqual(["첫 채팅", "문자열 채팅"]);
  });

  it("끊기면 새 세션으로 다시 연결한다", async () => {
    receiver.start();
    await waitFor(() => receiver.isConnected());
    fake.dropAllSockets();
    await waitFor(() => !receiver.isConnected());
    await waitFor(() => receiver.isConnected() && fake.subscribedSessionCount() === 1, 8_000);
    expect(fake.calls.filter((call) => call.path === "/open/v1/sessions/auth")).toHaveLength(2);
  });

  it("권한 회수(revoked)를 받으면 멈추고 알린다", async () => {
    receiver.start();
    await waitFor(() => receiver.isConnected());
    fake.emitSystem({ type: "revoked", data: { eventType: "CHAT", channelId: "owner-channel" } });
    await waitFor(() => revokedCount === 1);
    expect(receiver.isConnected()).toBe(false);
  });
});

describe("reconnectDelayMs", () => {
  it("1초부터 두 배씩 늘리고 30초에서 멈춘다", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
