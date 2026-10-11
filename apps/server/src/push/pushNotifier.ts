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
/**
 * 호스트 이름 형식: 영소문자·숫자·하이픈 라벨을 점으로 이은 것.
 * 왜 필요한가: 앞·뒤 점이나 빈 라벨(".push.apple.com", "a..b")을 접미사 검사가 통과시키지 않게 막는다.
 */
const HOSTNAME_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
/** 구독 제거 판단 상태 코드. 푸시 서비스가 이 구독을 더 이상 쓸 수 없다고 한 것이므로 지운다. */
const GONE_STATUS_CODES: ReadonlySet<number> = new Set([404, 410]);
/** 푸시 서비스가 알림을 보관하는 시간(초). 장애 알림은 늦게 오면 의미가 없어 짧게 둔다. */
const PUSH_TTL_SECONDS = 300;
/**
 * 한 구독에 보내는 최대 시간(ms).
 * 왜 필요한가: 장애 알림은 장애 중에 보내므로 응답 없는 푸시 서비스 하나가 나머지 알림을 붙잡으면 안 된다.
 * web-push의 timeout은 소켓 기준이라 전체 시간을 막지 못해, 타이머 경주로 따로 제한한다.
 */
export const PUSH_TIMEOUT_MS = 10_000;

/** push_subscription 행. */
interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * 구독 주소가 허용 목록에 드는지 확인한다.
 * URL은 호스트를 소문자로 돌려주므로 대문자 입력도 허용된다.
 * 끝에 점이 붙은 FQDN("fcm.googleapis.com.")은 의도적으로 거부한다. 허용 목록과 문자열이 달라 비교 규칙을 단순하게 두려고다.
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
 * 호스트 이름이 형식과 허용 목록(전체 일치 또는 접미사)을 모두 만족하는지 본다.
 * @param hostname URL의 호스트 이름
 * @returns 허용 호스트면 true
 */
function isAllowedPushHost(hostname: string): boolean {
  if (!HOSTNAME_PATTERN.test(hostname)) {
    return false;
  }
  return ALLOWED_PUSH_HOSTS.has(hostname) || ALLOWED_PUSH_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/**
 * 로그용 호스트 이름을 돌려준다. 전체 endpoint는 기록하지 않는다(캡처 URL이라 그 자체가 권한이다).
 * 저장된 값이 깨져 있어도 로그 때문에 전송 흐름이 끊기지 않도록 "invalid"로 대신한다.
 * @param endpoint 구독 주소
 * @returns 호스트 이름, 파싱 실패 시 "invalid"
 */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "invalid";
  }
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

/**
 * 모든 구독에 보낸다. 하나가 실패하거나 멈춰도 나머지는 보내고, 이 함수는 reject하지 않는다.
 * 최후의 방어로 allSettled를 쓴다. 한 구독의 처리 중 예외가 나도 알림 전체가 실패하면 안 되기 때문이다.
 */
async function notifyAll(deps: PushNotifierDeps, send: PushSender, message: PushMessage): Promise<void> {
  const rows = deps.database.prepare("SELECT endpoint, p256dh, auth FROM push_subscription").all() as SubscriptionRow[];
  const options: webpush.RequestOptions = { vapidDetails: deps.vapid, TTL: PUSH_TTL_SECONDS, timeout: PUSH_TIMEOUT_MS };
  const payload = JSON.stringify(message);
  const results = await Promise.allSettled(rows.map((row) => sendOne(deps, send, row, payload, options)));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      deps.logger.error("푸시 알림 처리 중 예기치 않은 실패", { host: hostOf(rows[index]?.endpoint ?? ""), error: describeError(result.reason) });
    }
  });
}

/**
 * 한 구독에 보낸다. 제한 시간을 넘기면 실패로 본다.
 * 사라진 구독은 지우고, 그 밖의 실패는 기록한다. 이 함수 자체는 reject하지 않는다.
 */
async function sendOne(deps: PushNotifierDeps, send: PushSender, row: SubscriptionRow, payload: string, options: webpush.RequestOptions): Promise<void> {
  try {
    await withTimeout(send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload, options), PUSH_TIMEOUT_MS);
  } catch (error) {
    handleSendFailure(deps, row, error);
  }
}

/**
 * 전송 실패를 처리한다. 404·410이면 구독을 지우고, 그 밖이면 호스트와 상태 코드만 경고로 남긴다.
 * @param error send가 던진 값. undefined·null일 수도 있어 속성을 안전하게 읽는다.
 */
function handleSendFailure(deps: PushNotifierDeps, row: SubscriptionRow, error: unknown): void {
  const host = hostOf(row.endpoint);
  const statusCode = statusCodeOf(error);
  if (statusCode !== undefined && GONE_STATUS_CODES.has(statusCode)) {
    removeGoneSubscription(deps, row, host);
    return;
  }
  deps.logger.warn("푸시 알림 전송 실패", { host, statusCode, error: describeError(error) });
}

/**
 * 사라진 구독을 지운다. 키까지 맞춰 지우므로, 전송 사이에 같은 endpoint로 새로 구독한 행은 남는다.
 * 삭제가 실패해도 알림 전송 흐름은 계속되어야 하므로 오류는 로그로만 남긴다.
 */
function removeGoneSubscription(deps: PushNotifierDeps, row: SubscriptionRow, host: string): void {
  try {
    deps.database.prepare("DELETE FROM push_subscription WHERE endpoint = ? AND p256dh = ? AND auth = ?").run(row.endpoint, row.p256dh, row.auth);
  } catch (error) {
    deps.logger.error("푸시 구독 삭제 실패", { host, error: describeError(error) });
  }
}

/**
 * 던져진 값에서 HTTP 상태 코드를 안전하게 꺼낸다. 객체가 아니면 undefined.
 * @param error catch로 받은 임의의 값
 * @returns 숫자 statusCode 또는 undefined
 */
function statusCodeOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return undefined;
}

/**
 * 작업이 제한 시간 안에 끝나지 않으면 "푸시 전송 시간 초과" 오류로 거부한다.
 * 작업이 먼저 끝나면 타이머를 지워 테스트·프로세스에 타이머가 남지 않게 한다.
 * @param work 제한할 전송 작업
 * @param timeoutMs 제한 시간(ms)
 * @returns 작업의 결과
 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("푸시 전송 시간 초과")), timeoutMs);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
