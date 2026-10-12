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
    connectedChannelId: () => fake.owner.channelId,
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

/** 테스트용 가짜 소켓. 핸들러를 모아 두고 직접 이벤트를 흘려 보낸다. */
class FakeSocket {
  readonly handlers = new Map<string, (payload: unknown) => void>();
  closed = false;
  on(event: string, handler: (payload: unknown) => void): void {
    this.handlers.set(event, handler);
  }
  close(): void {
    this.closed = true;
  }
  emit(event: string, payload?: unknown): void {
    this.handlers.get(event)?.(payload);
  }
}

/** 가짜 소켓을 쓰는 수신기를 만든다. api는 가짜 치지직 서버를 향한다. */
function createFakeSocketReceiver(overrides: Partial<Parameters<typeof createChatReceiver>[0]> = {}, beforeSession?: Promise<void>) {
  const sockets: FakeSocket[] = [];
  const errors: string[] = [];
  const baseApi = createChzzkApi({ apiBase: fake.baseUrl, clientId: "test-client", clientSecret: "test-secret" });
  const api = { ...baseApi, createSessionUrl: async (token: string) => { await beforeSession; return baseApi.createSessionUrl(token); } };
  const store = createCredentialStore(openDatabase(":memory:"), createTokenCipher(randomBytes(32)), Date.now);
  store.saveConnection(fake.owner, { channelId: fake.owner.channelId, ...fake.issueTokens(fake.owner), accessExpiresAt: Date.now() + 86_400_000 });
  const logger = { ...silentLogger, error: (message: string) => { errors.push(message); } };
  const instance = createChatReceiver({
    api, tokenManager: createTokenManager({ store, api: baseApi, clock: Date.now }), clock: Date.now, logger,
    connectedChannelId: () => fake.owner.channelId,
    connect: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    onChat: () => undefined, onConnectionChange: () => undefined, onInvalidEvent: () => undefined, onRevoked: () => undefined,
    ...overrides,
  });
  return { instance, sockets, errors };
}

/** 인덱스의 소켓을 꺼낸다. 없으면 테스트 가정이 깨진 것이므로 던진다. */
function socketAt(sockets: FakeSocket[], index: number): FakeSocket {
  const socket = sockets[index];
  if (!socket) throw new Error(`소켓 ${index}번이 아직 없습니다`);
  return socket;
}

/** 구독 완료 시스템 메시지. */
const subscribedMessage = { type: "subscribed", data: { eventType: "CHAT", channelId: "owner-channel" } };

describe("ChatReceiver 견고성", () => {
  it("핸드셰이크가 멈추면 소켓을 닫고 새 세션으로 다시 연결한다", async () => {
    const { instance, sockets } = createFakeSocketReceiver({ handshakeTimeoutMs: 50 });
    receiver = instance;
    receiver.start();
    await waitFor(() => sockets.length === 1);
    await waitFor(() => socketAt(sockets, 0).closed);
    await waitFor(() => sockets.length === 2, 4_000);
    expect(fake.calls.filter((call) => call.path === "/open/v1/sessions/auth")).toHaveLength(2);
  });

  it("이전 소켓의 늦은 이벤트는 새 연결 상태를 바꾸지 않는다", async () => {
    const { instance, sockets } = createFakeSocketReceiver({ handshakeTimeoutMs: 60_000 });
    receiver = instance;
    receiver.start();
    await waitFor(() => sockets.length === 1);
    socketAt(sockets, 0).emit("disconnect");
    await waitFor(() => sockets.length === 2, 4_000);
    socketAt(sockets, 1).emit("SYSTEM", subscribedMessage);
    expect(receiver.isConnected()).toBe(true);
    socketAt(sockets, 0).emit("disconnect");
    socketAt(sockets, 0).emit("SYSTEM", { type: "revoked", data: { eventType: "CHAT", channelId: "owner-channel" } });
    expect(receiver.isConnected()).toBe(true);
    expect(socketAt(sockets, 1).closed).toBe(false);
  });

  it("세션 생성 중 stop 후 start해도 소켓은 하나만 붙는다", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { instance, sockets } = createFakeSocketReceiver({ handshakeTimeoutMs: 60_000 }, gate);
    receiver = instance;
    receiver.start();
    receiver.stop();
    receiver.start();
    release();
    await waitFor(() => sockets.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sockets).toHaveLength(1);
  });

  it("onConnectionChange가 예외를 던져도 로그만 남기고 구독 상태는 유지된다", async () => {
    const { instance, sockets, errors } = createFakeSocketReceiver({
      handshakeTimeoutMs: 60_000,
      onConnectionChange: () => { throw new Error("콜백 실패"); },
    });
    receiver = instance;
    receiver.start();
    await waitFor(() => sockets.length === 1);
    socketAt(sockets, 0).emit("SYSTEM", subscribedMessage);
    await waitFor(() => errors.length === 1);
    expect(receiver.isConnected()).toBe(true);
  });
});

describe("ChatReceiver 구독 해제(S16, M05)", () => {
  it("SYSTEM unsubscribed를 받으면 끊긴 것으로 알리고 소켓을 닫은 뒤 백오프로 다시 연결한다", async () => {
    const changes: boolean[] = [];
    const { instance, sockets } = createFakeSocketReceiver({ handshakeTimeoutMs: 60_000, onConnectionChange: (connected) => void changes.push(connected) });
    receiver = instance;
    receiver.start();
    await waitFor(() => sockets.length === 1);
    socketAt(sockets, 0).emit("SYSTEM", subscribedMessage);
    expect(receiver.isConnected()).toBe(true);
    socketAt(sockets, 0).emit("SYSTEM", { type: "unsubscribed", data: { eventType: "CHAT", channelId: "owner-channel" } });
    expect(receiver.isConnected()).toBe(false);
    expect(changes).toEqual([true, false]);
    expect(socketAt(sockets, 0).closed).toBe(true);
    await waitFor(() => sockets.length === 2, 4_000);
    expect(fake.calls.filter((call) => call.path === "/open/v1/sessions/auth")).toHaveLength(2);
  });
});

describe("ChatReceiver 연결 채널 확인(S17, X09)", () => {
  /** 경고 로그를 모으는 기록기. */
  function warningLogger() {
    const warnings: Array<{ message: string; details?: Record<string, unknown> }> = [];
    return { warnings, logger: { ...silentLogger, warn: (message: string, details?: Record<string, unknown>) => void warnings.push({ message, ...(details ? { details } : {}) }) } };
  }

  it("다른 채널의 CHAT은 넘기지도 형식 오류로 세지도 않고, 원문 없이 경고를 한 번만 남긴다", async () => {
    const chats: ChatEvent[] = [];
    let invalid = 0;
    const { warnings, logger } = warningLogger();
    const { instance, sockets } = createFakeSocketReceiver({ handshakeTimeoutMs: 60_000, logger, onChat: (event) => void chats.push(event), onInvalidEvent: () => { invalid += 1; } });
    receiver = instance;
    receiver.start();
    await waitFor(() => sockets.length === 1);
    socketAt(sockets, 0).emit("SYSTEM", subscribedMessage);
    socketAt(sockets, 0).emit("CHAT", { ...chatPayload("다른 채널 원문"), channelId: "other-channel" });
    socketAt(sockets, 0).emit("CHAT", { ...chatPayload("다른 채널 원문2"), channelId: "other-channel" });
    socketAt(sockets, 0).emit("CHAT", chatPayload("우리 채널"));
    expect(chats.map((event) => event.content)).toEqual(["우리 채널"]);
    expect(invalid).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain("원문");
    expect(JSON.stringify(warnings)).not.toContain("other-channel");
  });

  it("다른 채널의 SYSTEM subscribed·unsubscribed·revoked는 무시한다", async () => {
    let revoked = 0;
    const { instance, sockets } = createFakeSocketReceiver({ handshakeTimeoutMs: 60_000, onRevoked: () => { revoked += 1; } });
    receiver = instance;
    receiver.start();
    await waitFor(() => sockets.length === 1);
    const other = (type: string) => ({ type, data: { eventType: "CHAT", channelId: "other-channel" } });
    socketAt(sockets, 0).emit("SYSTEM", other("subscribed"));
    expect(receiver.isConnected()).toBe(false);
    socketAt(sockets, 0).emit("SYSTEM", subscribedMessage);
    socketAt(sockets, 0).emit("SYSTEM", other("unsubscribed"));
    socketAt(sockets, 0).emit("SYSTEM", other("revoked"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(receiver.isConnected()).toBe(true);
    expect(revoked).toBe(0);
    expect(socketAt(sockets, 0).closed).toBe(false);
  });

  it("연결된 채널을 모르면(null) 채널이 든 메시지를 모두 무시한다", async () => {
    const chats: ChatEvent[] = [];
    const { instance, sockets } = createFakeSocketReceiver({ handshakeTimeoutMs: 60_000, connectedChannelId: () => null, onChat: (event) => void chats.push(event) });
    receiver = instance;
    receiver.start();
    await waitFor(() => sockets.length === 1);
    socketAt(sockets, 0).emit("SYSTEM", subscribedMessage);
    socketAt(sockets, 0).emit("CHAT", chatPayload("채팅"));
    expect(receiver.isConnected()).toBe(false);
    expect(chats).toEqual([]);
  });
});
