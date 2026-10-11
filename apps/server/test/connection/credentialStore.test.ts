import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/connection/credentialStore.js";
import { openDatabase } from "../../src/db/database.js";
import { createTokenCipher } from "../../src/security/tokenCipher.js";

/** 테스트용 저장소. */
function createStore() {
  const database = openDatabase(":memory:");
  return { database, store: createCredentialStore(database, createTokenCipher(randomBytes(32)), () => 1_000) };
}

/** 예시 채널과 토큰. */
const channel = { channelId: "owner-channel", channelName: "스트리머" };
const credential = { channelId: "owner-channel", accessToken: "access-1", refreshToken: "refresh-1", accessExpiresAt: 90_000 };

describe("CredentialStore", () => {
  it("연결을 저장하면 토큰을 암호화해 두고 그대로 읽는다", () => {
    const { database, store } = createStore();
    store.saveConnection(channel, credential);
    expect(store.loadChannel()).toEqual(channel);
    expect(store.loadCredential()).toEqual(credential);
    const row = database.prepare("SELECT access_token_enc FROM credential").get() as { access_token_enc: string };
    expect(row.access_token_enc).not.toContain("access-1");
    expect(database.prepare("SELECT auto_hide_enabled FROM setting").get()).toEqual({ auto_hide_enabled: 0 });
  });

  it("다른 채널 연결을 거부한다(MVP는 채널 1곳)", () => {
    const { store } = createStore();
    store.saveConnection(channel, credential);
    const other = { channelId: "other", channelName: "다른 채널" };
    expect(() => store.saveConnection(other, { ...credential, channelId: "other" })).toThrow(/이미 다른 채널/);
  });

  it("연결 해제 시 토큰과 설정까지 지운다", () => {
    const { database, store } = createStore();
    store.saveConnection(channel, credential);
    store.clearConnection();
    expect(store.loadChannel()).toBeNull();
    expect(store.loadCredential()).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM setting").get()).toEqual({ count: 0 });
  });
});
