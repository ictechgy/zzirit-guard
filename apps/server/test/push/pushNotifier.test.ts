import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import type { Logger } from "../../src/logger.js";
import { createPushNotifier, isAllowedPushEndpoint, PushSubscriptionError, type PushSender } from "../../src/push/pushNotifier.js";

/** VAPID 설정 예시. */
const vapid = { publicKey: "public-key", privateKey: "private-key", subject: "mailto:owner@example.com" };

/** 구독 예시. */
function subscription(endpoint: string) {
  return { endpoint, keys: { p256dh: "p", auth: "a" } };
}

/** 테스트용 기록기. */
function silentTestLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("PushNotifier", () => {
  it("같은 endpoint는 한 번만 저장하고 모두에게 보낸다", async () => {
    const database = openDatabase(":memory:");
    const send = vi.fn<PushSender>(async () => ({}));
    const notifier = createPushNotifier({ database, clock: () => 0, logger: silentTestLogger(), vapid, send });
    notifier.subscribe("m1", subscription("https://fcm.googleapis.com/fcm/send/1"));
    notifier.subscribe("m1", subscription("https://fcm.googleapis.com/fcm/send/1"));
    notifier.subscribe("m2", subscription("https://fcm.googleapis.com/fcm/send/2"));
    await notifier.notifyAll({ title: "찌리릿 가드", body: "재연결이 필요합니다" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[0]?.[1] as string)).toEqual({ title: "찌리릿 가드", body: "재연결이 필요합니다" });
    expect(send.mock.calls[0]?.[2]).toMatchObject({ vapidDetails: vapid });
  });

  it("사라진 구독(410)은 지우고, 다른 실패는 기록만 한다", async () => {
    const database = openDatabase(":memory:");
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const send = vi.fn<PushSender>(async (target) => {
      throw Object.assign(new Error("push failed"), { statusCode: target.endpoint.endsWith("gone") ? 410 : 500 });
    });
    const notifier = createPushNotifier({ database, clock: () => 0, logger, vapid, send });
    notifier.subscribe("m1", subscription("https://fcm.googleapis.com/fcm/send/gone"));
    notifier.subscribe("m2", subscription("https://fcm.googleapis.com/fcm/send/flaky"));
    await notifier.notifyAll({ title: "t", body: "b" });
    const endpoints = database.prepare("SELECT endpoint FROM push_subscription").all();
    expect(endpoints).toEqual([{ endpoint: "https://fcm.googleapis.com/fcm/send/flaky" }]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("허용되지 않은 endpoint는 거부하고 저장하지 않는다(SSRF 방지, R24)", () => {
    const database = openDatabase(":memory:");
    const notifier = createPushNotifier({ database, clock: () => 0, logger: silentTestLogger(), vapid, send: vi.fn<PushSender>() });
    const rejectedEndpoints = [
      "http://fcm.googleapis.com/fcm/send/1",
      "https://127.0.0.1:8710/fcm/send/1",
      "https://localhost/fcm/send/1",
      "https://fcm.googleapis.com:8443/fcm/send/1",
      "https://user:pass@fcm.googleapis.com/fcm/send/1",
      "https://fcm.googleapis.com.evil.example/fcm/send/1",
      "https://evilpush.apple.com/1",
      "not a url",
    ];
    for (const endpoint of rejectedEndpoints) {
      expect(() => notifier.subscribe("m1", subscription(endpoint))).toThrow(PushSubscriptionError);
    }
    expect(database.prepare("SELECT COUNT(*) AS count FROM push_subscription").get()).toEqual({ count: 0 });
  });

  it("허용 목록의 브라우저 푸시 주소는 받아들인다", () => {
    expect(isAllowedPushEndpoint("https://web.push.apple.com/QWERTY")).toBe(true);
    expect(isAllowedPushEndpoint("https://wns2-xx.notify.windows.com/w/?token=abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
  });

  it("PushSubscriptionError는 400 상태 코드를 가진다", () => {
    const error = new PushSubscriptionError("x");
    expect(error.statusCode).toBe(400);
    expect(error.name).toBe("PushSubscriptionError");
    expect(error).toBeInstanceOf(Error);
  });
});
