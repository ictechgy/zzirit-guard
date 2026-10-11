import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import type { Logger } from "../../src/logger.js";
import { createPushNotifier, isAllowedPushEndpoint, PUSH_TIMEOUT_MS, PushSubscriptionError, type PushSender } from "../../src/push/pushNotifier.js";

/** VAPID 설정 예시. */
const vapid = { publicKey: "public-key", privateKey: "private-key", subject: "mailto:owner@example.com" };

/** 구독 예시. 키 값은 로그 누출 검사를 위해 식별 가능한 문자열을 쓴다. */
function subscription(endpoint: string) {
  return { endpoint, keys: { p256dh: "p256dh-secret", auth: "auth-secret" } };
}

/** 테스트용 기록기. */
function silentTestLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

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
    expect(send.mock.calls[0]?.[2]).toMatchObject({ vapidDetails: vapid, timeout: PUSH_TIMEOUT_MS });
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

  it("사라진 구독(404)도 지운다", async () => {
    const database = openDatabase(":memory:");
    const send = vi.fn<PushSender>(async () => {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    });
    const notifier = createPushNotifier({ database, clock: () => 0, logger: silentTestLogger(), vapid, send });
    notifier.subscribe("m1", subscription("https://fcm.googleapis.com/fcm/send/nf"));
    await notifier.notifyAll({ title: "t", body: "b" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM push_subscription").get()).toEqual({ count: 0 });
  });

  it("전송 사이에 새 키로 다시 구독한 행은 옛 구독 삭제가 지우지 않는다", async () => {
    const database = openDatabase(":memory:");
    const endpoint = "https://fcm.googleapis.com/fcm/send/rekey";
    const notifier = createPushNotifier({
      database,
      clock: () => 0,
      logger: silentTestLogger(),
      vapid,
      send: async () => {
        notifier.subscribe("m1", { endpoint, keys: { p256dh: "new-p", auth: "new-a" } });
        throw Object.assign(new Error("gone"), { statusCode: 410 });
      },
    });
    notifier.subscribe("m1", subscription(endpoint));
    await notifier.notifyAll({ title: "t", body: "b" });
    expect(database.prepare("SELECT p256dh, auth FROM push_subscription").all()).toEqual([{ p256dh: "new-p", auth: "new-a" }]);
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

  it("응답 없는 푸시 서비스가 있어도 제한 시간 뒤 나머지 알림은 보내고 끝난다", async () => {
    vi.useFakeTimers();
    const database = openDatabase(":memory:");
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const hungSend = vi.fn<PushSender>(() => new Promise<unknown>(() => undefined));
    const goodSend = vi.fn<PushSender>(async () => ({}));
    const send: PushSender = (target, payload, options) => (target.endpoint.endsWith("hung") ? hungSend(target, payload, options) : goodSend(target, payload, options));
    const notifier = createPushNotifier({ database, clock: () => 0, logger, vapid, send });
    notifier.subscribe("m1", subscription("https://fcm.googleapis.com/fcm/send/hung"));
    notifier.subscribe("m2", subscription("https://fcm.googleapis.com/fcm/send/good"));
    const pending = notifier.notifyAll({ title: "t", body: "b" });
    await vi.advanceTimersByTimeAsync(PUSH_TIMEOUT_MS);
    await expect(pending).resolves.toBeUndefined();
    expect(goodSend).toHaveBeenCalledTimes(1);
    expect(hungSend).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("푸시 알림 전송 실패", expect.objectContaining({ host: "fcm.googleapis.com" }));
  });

  it("던져진 값이 undefined여도 notifyAll은 reject하지 않고 경고를 남긴다", async () => {
    const database = openDatabase(":memory:");
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const send = vi.fn<PushSender>(async () => {
      throw undefined;
    });
    const notifier = createPushNotifier({ database, clock: () => 0, logger, vapid, send });
    notifier.subscribe("m1", subscription("https://fcm.googleapis.com/fcm/send/undef"));
    await expect(notifier.notifyAll({ title: "t", body: "b" })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("저장된 endpoint가 파싱되지 않아도 다른 구독에는 보내고 reject하지 않는다", async () => {
    const database = openDatabase(":memory:");
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const send = vi.fn<PushSender>(async (target) => {
      if (target.endpoint === "not a url") {
        throw Object.assign(new Error("bad"), { statusCode: 404 });
      }
      return {};
    });
    const notifier = createPushNotifier({ database, clock: () => 0, logger, vapid, send });
    database.prepare("INSERT INTO push_subscription (manager_channel_id, endpoint, p256dh, auth, created_at) VALUES ('m0', 'not a url', 'p', 'a', 0)").run();
    notifier.subscribe("m1", subscription("https://fcm.googleapis.com/fcm/send/fine"));
    await expect(notifier.notifyAll({ title: "t", body: "b" })).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(database.prepare("SELECT endpoint FROM push_subscription ORDER BY id").all()).toEqual([{ endpoint: "https://fcm.googleapis.com/fcm/send/fine" }]);
  });

  it("구독 삭제가 실패해도 notifyAll은 reject하지 않고 오류를 기록한다", async () => {
    const database = openDatabase(":memory:");
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const send = vi.fn<PushSender>(async () => {
      database.exec("DROP TABLE push_subscription");
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    });
    const notifier = createPushNotifier({ database, clock: () => 0, logger, vapid, send });
    notifier.subscribe("m1", subscription("https://fcm.googleapis.com/fcm/send/dropped"));
    await expect(notifier.notifyAll({ title: "t", body: "b" })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("푸시 구독 삭제 실패", expect.objectContaining({ host: "fcm.googleapis.com" }));
  });

  it("로그에 전체 endpoint와 키 값이 남지 않는다", async () => {
    const database = openDatabase(":memory:");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const endpoint = "https://fcm.googleapis.com/fcm/send/capability-token-xyz";
    const send = vi.fn<PushSender>(async () => {
      throw Object.assign(new Error("server error"), { statusCode: 500 });
    });
    const notifier = createPushNotifier({ database, clock: () => 0, logger, vapid, send });
    notifier.subscribe("m1", subscription(endpoint));
    await notifier.notifyAll({ title: "t", body: "b" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls, logger.info.mock.calls]);
    expect(logged).toContain("fcm.googleapis.com");
    expect(logged).not.toContain("capability-token-xyz");
    expect(logged).not.toContain("/fcm/send/");
    expect(logged).not.toContain("p256dh-secret");
    expect(logged).not.toContain("auth-secret");
  });
});

describe("isAllowedPushEndpoint", () => {
  it.each([
    ["https://FCM.googleapis.com/x", true],
    ["https://fcm.googleapis.com:443/x", true],
    ["https://fcm.googleapis.com\\@evil.com/x", true],
    ["https://fcm.googleapis.com?@evil.com", true],
    ["https://fcm.googleapis.com./x", false],
    ["https://[::1]/x", false],
    ["https://.push.apple.com/x", false],
    ["https://push.apple.com/x", false],
    ["https://fcm.googleapis.com:8443/x", false],
    ["https://evil.com/fcm.googleapis.com/x", false],
  ])("%s → %s", (endpoint, expected) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(expected);
  });
});
