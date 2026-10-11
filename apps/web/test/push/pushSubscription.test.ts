import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/client";
import { base64UrlToUint8Array, disablePush, enablePush } from "../../src/push/pushSubscription";
import { json, stubFetch } from "../helpers/stubFetch";

/** jsdom에는 서비스 워커가 없어 테스트마다 navigator.serviceWorker를 직접 심는다. */
function stubServiceWorker(container: unknown): void {
  Object.defineProperty(window.navigator, "serviceWorker", { value: container, configurable: true });
}

/** 알림 권한을 허락하는 브라우저로 만든다. */
function stubPushSupport(): void {
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { requestPermission: async () => "granted" });
}

/** 가짜 푸시 구독. */
function fakeSubscription() {
  const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
  return { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }), unsubscribe: vi.fn(async () => true) };
}

afterEach(() => {
  delete (window.navigator as { serviceWorker?: unknown }).serviceWorker;
  vi.unstubAllGlobals();
});

describe("pushSubscription", () => {
  it("VAPID 공개키(base64url)를 바이트로 바꾼다", () => {
    expect([...base64UrlToUint8Array("AQID-_8")]).toEqual([1, 2, 3, 251, 255]);
  });

  it("서비스 워커가 없는 브라우저면 이유와 해결 방법을 알려 준다", async () => {
    await expect(enablePush()).rejects.toThrow(/홈 화면에 추가/);
  });

  it("서비스 워커가 준비되지 않으면 기다리다 멈추지 않고 이유를 알려 준다(X3)", async () => {
    stubPushSupport();
    stubServiceWorker({ ready: new Promise(() => undefined) });
    await expect(enablePush(10)).rejects.toThrow(/서비스 워커/);
  });

  it("서버가 구독을 거절하면 서버 문구를 전하고 브라우저 구독도 해지한다(R-14)", async () => {
    stubPushSupport();
    const subscription = fakeSubscription();
    stubServiceWorker({ ready: Promise.resolve({ pushManager: { subscribe: async () => subscription } }) });
    stubFetch({
      "GET /api/push/public-key": () => json(200, { publicKey: "AQID" }),
      "POST /api/push/subscriptions": () => json(400, { error: "bad_request", message: "지원하지 않는 푸시 주소입니다." }),
    });
    const error = await enablePush().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("지원하지 않는 푸시 주소입니다.");
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("알림 해지는 서버에서 구독을 지우고 브라우저 구독도 끊는다(스펙 11장, R-14)", async () => {
    const subscription = fakeSubscription();
    stubServiceWorker({ getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }) });
    const fetchMock = stubFetch({ "DELETE /api/push/subscriptions": () => json(200, { ok: true }) });
    await disablePush();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ endpoint: subscription.endpoint });
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("구독이 없으면 알림 해지는 아무것도 보내지 않는다", async () => {
    stubServiceWorker({ getRegistration: async () => undefined });
    const fetchMock = stubFetch({});
    await disablePush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
