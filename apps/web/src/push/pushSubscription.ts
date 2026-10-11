import { apiGet, apiSend } from "../api/client";

/** 지원하지 않는 환경 안내. iPhone은 홈 화면에 추가한 PWA에서만 웹 푸시를 받는다(iOS 16.4 이상). */
const UNSUPPORTED_MESSAGE = "이 브라우저는 알림을 지원하지 않습니다. iPhone은 Safari 공유 버튼 → '홈 화면에 추가'로 연 앱에서 다시 시도하세요(iOS 16.4 이상).";
/** 알림 권한을 거부했을 때의 안내. */
const PERMISSION_DENIED_MESSAGE = "알림 권한이 거부되었습니다. 브라우저(또는 iPhone 설정 → 알림)에서 이 앱의 알림을 허용하세요.";
/**
 * 서비스 워커 준비를 기다리는 최대 시간(10초).
 * 왜: 등록이 실패하면 navigator.serviceWorker.ready는 영영 끝나지 않아 "장애 알림 받기"가 아무 문구 없이 멈춘다(X3).
 */
export const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;
/** 서비스 워커가 준비되지 않았을 때의 안내. */
const READY_TIMEOUT_MESSAGE = "알림 준비(서비스 워커)가 끝나지 않았습니다. 앱을 완전히 닫았다가 다시 열고 시도하세요.";

/**
 * base64url 문자열을 바이트 배열로 바꾼다(PushManager가 VAPID 공개키를 바이트로 받는다).
 * 반환 타입을 Uint8Array<ArrayBuffer>로 두는 이유: TS 6 lib.dom의 applicationServerKey는 BufferSource라 ArrayBufferLike 버전을 받지 않는다(R-2).
 */
export function base64UrlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

/**
 * 알림 권한을 받고 푸시를 구독해 서버에 등록한다.
 * @param readyTimeoutMs 서비스 워커 준비를 기다릴 시간(테스트에서 줄인다)
 * @throws Error 지원하지 않거나 권한이 거부되거나 서비스 워커가 준비되지 않으면 이유와 해결 방법을 담아 던진다
 * @throws ApiError 서버가 구독을 거절하면(그때는 브라우저 구독도 해지한다)
 */
export async function enablePush(readyTimeoutMs: number = SERVICE_WORKER_READY_TIMEOUT_MS): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error(UNSUPPORTED_MESSAGE);
  if ((await Notification.requestPermission()) !== "granted") throw new Error(PERMISSION_DENIED_MESSAGE);
  const registration = await waitForServiceWorker(readyTimeoutMs);
  const { publicKey } = await apiGet<{ publicKey: string }>("/api/push/public-key");
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(publicKey) });
  await registerSubscription(subscription);
}

/**
 * 이 기기의 푸시 구독을 해지한다: 서버에서 지우고 브라우저 구독도 끊는다(스펙 11장 "해지 시 삭제", R-14).
 * 로그아웃·연결 해제 전에 부른다. 서비스 워커나 구독이 없으면 아무것도 하지 않는다.
 * 왜 ready가 아니라 getRegistration인가: 등록이 없으면 ready는 끝나지 않아 로그아웃이 멈춘다.
 * 서버 삭제가 실패해도 브라우저 구독은 끊는다: 끊긴 주소로 보낸 푸시는 푸시 서비스가 410으로 돌려주고, 서버가 그때 지운다.
 */
export async function disablePush(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  try {
    await apiSend("DELETE", "/api/push/subscriptions", { endpoint: subscription.endpoint });
  } finally {
    await subscription.unsubscribe();
  }
}

/** 서비스 워커 준비를 기다리되, timeoutMs가 지나면 이유를 담아 실패한다. */
function waitForServiceWorker(timeoutMs: number): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(READY_TIMEOUT_MESSAGE)), timeoutMs);
  });
  return Promise.race([navigator.serviceWorker.ready, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 서버에 구독을 등록한다. 실패하면(허용하지 않는 푸시 주소 400 등) 브라우저 구독도 해지해, 서버가 모르는 구독이 남지 않게 하고 원래 오류를 다시 던진다.
 */
async function registerSubscription(subscription: PushSubscription): Promise<void> {
  try {
    await apiSend("POST", "/api/push/subscriptions", subscription.toJSON());
  } catch (error) {
    await subscription.unsubscribe().catch((unsubscribeError: unknown) => console.warn("서버가 거절한 푸시 구독을 브라우저에서 해지하지 못했습니다", unsubscribeError));
    throw error;
  }
}
