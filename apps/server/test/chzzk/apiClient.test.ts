import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChzzkApiError, createChzzkApi, type ChzzkApi } from "../../src/chzzk/apiClient.js";
import { startFakeChzzk, type FakeChzzk } from "../fakes/fakeChzzk.js";

let fake: FakeChzzk;
let api: ChzzkApi;

beforeEach(async () => {
  fake = await startFakeChzzk();
  api = createChzzkApi({ apiBase: fake.baseUrl, clientId: "test-client", clientSecret: "test-secret" });
});
afterEach(async () => fake.close());

describe("ChzzkApi", () => {
  it("인증 코드로 토큰을 받고 사용자 정보를 읽는다", async () => {
    const tokens = await api.exchangeCode(fake.grantCode(fake.owner), "state-1");
    expect(tokens.expiresInSeconds).toBe(86400);
    expect(await api.getMe(tokens.accessToken)).toEqual(fake.owner);
    const tokenCall = fake.calls.find((call) => call.path === "/auth/v1/token");
    expect(tokenCall?.body).toMatchObject({ grantType: "authorization_code", state: "state-1", clientId: "test-client" });
  });

  it("refresh token은 한 번만 쓸 수 있다", async () => {
    const tokens = fake.issueTokens(fake.owner);
    await api.refreshToken(tokens.refreshToken);
    await expect(api.refreshToken(tokens.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it("스트리머가 아닌 토큰의 쓰기는 400 오류가 된다", async () => {
    const viewer = fake.issueTokens({ channelId: "viewer", channelName: "시청자" });
    const target = { chatChannelId: "chat-1", messageTime: 1, senderChannelId: "bad" };
    const error = await api.blindMessage(viewer.accessToken, target).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChzzkApiError);
    expect(error).toMatchObject({ status: 400, apiMessage: "스트리머가 아닙니다" });
  });

  it("429를 상태 코드와 함께 알린다", async () => {
    const owner = fake.issueTokens(fake.owner);
    fake.failNext("/open/v1/chats/blind-message", 429);
    const target = { chatChannelId: "chat-1", messageTime: 1, senderChannelId: "bad" };
    await expect(api.blindMessage(owner.accessToken, target)).rejects.toMatchObject({ status: 429 });
    await expect(api.blindMessage(owner.accessToken, target)).resolves.toBeUndefined();
  });

  it("sessionKey를 쿼리로 보내고 채팅 설정을 읽고 쓴다", async () => {
    const owner = fake.issueTokens(fake.owner);
    await expect(api.subscribeChat(owner.accessToken, "no-such-session")).rejects.toMatchObject({ status: 400 });
    expect(fake.calls.at(-1)?.query).toEqual({ sessionKey: "no-such-session" });
    const settings = await api.getChatSettings(owner.accessToken);
    await api.updateChatSettings(owner.accessToken, { ...settings, chatSlowModeSec: 5 });
    expect(fake.chatSettings.chatSlowModeSec).toBe(5);
  });
});
