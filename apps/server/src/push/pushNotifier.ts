import webpush from "web-push";
import type { Database } from "../db/database.js";
import { describeError, type Logger } from "../logger.js";
import type { Clock } from "../time.js";

/** 브라우저가 준 푸시 구독 정보. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** 알림 내용. 서비스 워커가 그대로 표시한다. */
export interface PushMessage {
  title: string;
  body: string;
}

/** 실제 전송 함수. 테스트에서 바꿔 끼운다. */
export type PushSender = (subscription: PushSubscriptionInput, payload: string, options: webpush.RequestOptions) => Promise<unknown>;

/** 매니저 휴대폰으로 장애 알림을 보낸다(스펙 6장). */
export interface PushNotifier {
  publicKey(): string;
  subscribe(managerChannelId: string, subscription: PushSubscriptionInput): void;
  unsubscribe(endpoint: string): void;
  notifyAll(message: PushMessage): Promise<void>;
}

/** createPushNotifier 의존성. */
export interface PushNotifierDeps {
  database: Database;
  clock: Clock;
  logger: Logger;
  vapid: { publicKey: string; privateKey: string; subject: string };
  send?: PushSender;
}

/**
 * 구독 주소가 허용 목록에 없을 때 던지는 오류. HTTP 계층은 statusCode(400)로 응답을 만든다.
 * 메시지는 사용자에게 그대로 보여 줄 수 있는 문장이다.
 */
export class PushSubscriptionError extends Error {
  override readonly name = "PushSubscriptionError";
  readonly statusCode = 400;
}

/**
 * 허용하는 푸시 서비스 호스트 전체 일치 목록.
 * 왜 필요한가: 구독 주소는 인증된 매니저가 보내므로 임의 URL이면 서버가 내부망(예: 127.0.0.1:8710)에 POST하는 SSRF가 된다.
 * FCM은 Chrome·Android, Mozilla 주소는 Firefox에서 쓴다.
 */
const ALLOWED_PUSH_HOSTS: ReadonlySet<string> = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com"]);
/**
 * 허용하는 푸시 서비스 호스트 접미사 목록.
 * Apple(Safari·iOS)과 Microsoft(Edge, WNS)는 지역·샤드별 하위 호스트를 쓰므로 접미사로 본다.
 * 접미사 앞에 점을 붙여 비교해 "evilpush.apple.com" 같은 유사 호스트를 막는다.
 */
const ALLOWED_PUSH_HOST_SUFFIXES: readonly string[] = [".push.apple.com", ".notify.windows.com"];
/** 구독 제거 판단 상태 코드. 푸시 서비스가 이 구독을 더 이상 쓸 수 없다고 한 것이므로 지운다. */
const GONE_STATUS_CODES: ReadonlySet<number> = new Set([404, 410]);
/** 푸시 서비스가 알림을 보관하는 시간(초). 장애 알림은 늦게 오면 의미가 없어 짧게 둔다. */
const PUSH_TTL_SECONDS = 300;

/** push_subscription 행. */
interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * 구독 주소가 허용 목록에 드는지 확인한다.
 * @param endpoint 브라우저가 준 푸시 주소 문자열
 * @returns https이고 포트·사용자 정보가 없으며 허용 호스트일 때만 true. 파싱 실패도 false
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") {
    return false;
  }
  return isAllowedPushHost(url.hostname);
}

/**
 * 호스트 이름이 허용 목록(전체 일치 또는 접미사)에 드는지 본다.
 * @param hostname URL의 호스트 이름
 * @returns 허용 호스트면 true
 */
function isAllowedPushHost(hostname: string): boolean {
  return ALLOWED_PUSH_HOSTS.has(hostname) || ALLOWED_PUSH_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/** 푸시 알림기를 만든다. */
export function createPushNotifier(deps: PushNotifierDeps): PushNotifier {
  const send: PushSender = deps.send ?? ((subscription, payload, options) => webpush.sendNotification(subscription, payload, options));
  return {
    publicKey: () => deps.vapid.publicKey,
    subscribe: (managerChannelId, subscription) => saveSubscription(deps, managerChannelId, subscription),
    unsubscribe: (endpoint) => void deps.database.prepare("DELETE FROM push_subscription WHERE endpoint = ?").run(endpoint),
    notifyAll: (message) => notifyAll(deps, send, message),
  };
}

/**
 * 허용된 주소인지 확인한 뒤 구독을 저장한다. 같은 endpoint는 키와 채널만 갱신한다.
 * @throws PushSubscriptionError 허용 목록에 없는 주소일 때(아무것도 저장하지 않는다)
 */
function saveSubscription(deps: PushNotifierDeps, managerChannelId: string, subscription: PushSubscriptionInput): void {
  if (!isAllowedPushEndpoint(subscription.endpoint)) {
    throw new PushSubscriptionError("지원하지 않는 푸시 주소입니다. 크롬·사파리·파이어폭스·엣지 브라우저에서 알림을 다시 켜 주세요.");
  }
  deps.database
    .prepare(
      `INSERT INTO push_subscription (manager_channel_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET manager_channel_id = excluded.manager_channel_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    )
    .run(managerChannelId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, deps.clock());
}

/** 모든 구독에 보낸다. 하나가 실패해도 나머지는 보낸다. */
async function notifyAll(deps: PushNotifierDeps, send: PushSender, message: PushMessage): Promise<void> {
  const rows = deps.database.prepare("SELECT endpoint, p256dh, auth FROM push_subscription").all() as SubscriptionRow[];
  const options: webpush.RequestOptions = { vapidDetails: deps.vapid, TTL: PUSH_TTL_SECONDS };
  const payload = JSON.stringify(message);
  await Promise.all(rows.map((row) => sendOne(deps, send, row, payload, options)));
}

/**
 * 한 구독에 보낸다. 사라진 구독은 지우고, 그 밖의 실패는 기록한다.
 * 로그에는 호스트 이름만 남긴다. 전체 endpoint는 인증 없이 쓸 수 있는 주소라 기록하지 않는다.
 */
async function sendOne(deps: PushNotifierDeps, send: PushSender, row: SubscriptionRow, payload: string, options: webpush.RequestOptions): Promise<void> {
  try {
    await send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload, options);
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode !== undefined && GONE_STATUS_CODES.has(statusCode)) {
      deps.database.prepare("DELETE FROM push_subscription WHERE endpoint = ?").run(row.endpoint);
      return;
    }
    deps.logger.warn("푸시 알림 전송 실패", { host: new URL(row.endpoint).hostname, statusCode, error: describeError(error) });
  }
}
