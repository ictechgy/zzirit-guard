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

  it("관리자 목록과 세션 URL을 읽는다", async () => {
    const owner = fake.issueTokens(fake.owner);
    fake.streamingRoles.push({ managerChannelId: "m1", managerChannelName: "매니저", userRole: "STREAMING_CHAT_MANAGER" });
    expect(await api.getStreamingRoles(owner.accessToken)).toEqual(fake.streamingRoles);
    expect(await api.createSessionUrl(owner.accessToken)).toContain("?auth=");
  });

  it("제한 API 세 개가 올바른 메서드·경로·본문으로 나간다", async () => {
    const owner = fake.issueTokens(fake.owner);
    await api.addTemporaryRestriction(owner.accessToken, "t1", "c1");
    await api.addRestriction(owner.accessToken, "t2");
    await api.removeRestriction(owner.accessToken, "t3");
    expect(fake.calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "POST", path: "/open/v1/temporary-restrict-channels", body: { targetChannelId: "t1", chatChannelId: "c1" } },
      { method: "POST", path: "/open/v1/restrict-channels", body: { targetChannelId: "t2" } },
      { method: "DELETE", path: "/open/v1/restrict-channels", body: { targetChannelId: "t3" } },
    ]);
  });
});

describe("ChzzkApi 비정상 응답", () => {
  /** 고정 본문을 HTTP 200으로 돌려주는 가짜 fetch로 클라이언트를 만든다. */
  function apiWithBody(body: string): ChzzkApi {
    const fetchFunction: typeof fetch = async () => new Response(body, { status: 200 });
    return createChzzkApi({ apiBase: "http://stub", clientId: "c", clientSecret: "s", fetchFunction });
  }

  it("스키마와 다른 content는 502 ChzzkApiError가 된다", async () => {
    const stub = apiWithBody(JSON.stringify({ code: 200, message: null, content: { channelId: 1 } }));
    const error = await stub.getMe("t").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChzzkApiError);
    expect(error).toMatchObject({ status: 502, path: "/open/v1/users/me" });
    expect((error as ChzzkApiError).apiMessage).toMatch(/UNEXPECTED_RESPONSE/);
  });

  it("JSON이 아닌 200 본문은 502 ChzzkApiError가 된다", async () => {
    const error = await apiWithBody("<html>").blindMessage("t", { chatChannelId: "c", messageTime: 1, senderChannelId: "s" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChzzkApiError);
    expect(error).toMatchObject({ status: 502 });
  });

  it("빈 200 본문은 성공으로 본다", async () => {
    await expect(apiWithBody("").blindMessage("t", { chatChannelId: "c", messageTime: 1, senderChannelId: "s" })).resolves.toBeUndefined();
  });

  it("expiresIn이 숫자가 아니면 502 ChzzkApiError가 된다", async () => {
    const content = { accessToken: "a", refreshToken: "r", expiresIn: "abc" };
    const error = await apiWithBody(JSON.stringify({ code: 200, message: null, content })).refreshToken("r")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChzzkApiError);
    expect(error).toMatchObject({ status: 502 });
  });
});
