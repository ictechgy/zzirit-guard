import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

/** 필수 값을 모두 채운 환경 변수 예시. */
const validEnvironment = {
  ZG_PUBLIC_ORIGIN: "https://guard.example.ts.net/",
  ZG_CHANNEL_ID: "owner-channel",
  ZG_CHZZK_CLIENT_ID: "client-id",
  ZG_CHZZK_CLIENT_SECRET: "client-secret",
  ZG_DATA_DIR: "/tmp/zg",
  ZG_WEB_DIST: "/tmp/zg-web",
  ZG_VAPID_PUBLIC_KEY: "public",
  ZG_VAPID_PRIVATE_KEY: "private",
  ZG_VAPID_SUBJECT: "mailto:owner@example.com",
};

describe("loadConfig", () => {
  it("기본값을 채우고 경로를 만든다", () => {
    const config = loadConfig(validEnvironment);
    expect(config.port).toBe(8710);
    expect(config.publicOrigin).toBe("https://guard.example.ts.net");
    expect(config.channelId).toBe("owner-channel");
    expect(config.chzzkApiBase).toBe("https://openapi.chzzk.naver.com");
    expect(config.databasePath).toBe("/tmp/zg/zzirit-guard.sqlite");
    expect(config.backupDirectory).toBe("/tmp/zg/backups");
  });

  it("빠진 필수 값을 모두 알려 준다", () => {
    const { ZG_CHZZK_CLIENT_SECRET: _secret, ZG_DATA_DIR: _dir, ...partial } = validEnvironment;
    expect(() => loadConfig(partial)).toThrow(ConfigError);
    expect(() => loadConfig(partial)).toThrow(/ZG_CHZZK_CLIENT_SECRET.*ZG_DATA_DIR|ZG_DATA_DIR.*ZG_CHZZK_CLIENT_SECRET/s);
  });

  it("mailto가 아닌 VAPID subject를 거부한다", () => {
    expect(() => loadConfig({ ...validEnvironment, ZG_VAPID_SUBJECT: "owner@example.com" })).toThrow(/ZG_VAPID_SUBJECT/);
  });
});
