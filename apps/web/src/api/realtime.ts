import type { RealtimeEvent } from "@zzirit-guard/shared";
import { API_BASE, ApiError, apiSend, requiresSignIn } from "./client";

/** 연결에 필요한 WebSocket 기능. 테스트에서 가짜로 바꾼다. onopen은 쓰지 않는다(연결됨은 첫 메시지로 판단, RealtimeOptions 참고). */
export interface SocketLike {
  /** 서버 메시지를 받았을 때. */
  onmessage: ((event: { data: unknown }) => void) | null;
  /** 연결이 닫혔을 때(닫기 코드 포함). */
  onclose: ((event: { code: number }) => void) | null;
  /** 연결 오류가 났을 때(선택). stop()이 옛 소켓에서 떼어 낼 수 있게 둔다. */
  onerror?: (() => void) | null;
  /** 연결을 닫는다. */
  close(): void;
}

/** RealtimeConnection 옵션. issueTicket·openSocket·schedule은 테스트에서 바꿔 끼운다. */
export interface RealtimeOptions {
  /** 판정·상태·채팅 이벤트를 받는다(session_ended는 onSessionEnded로 간다). */
  onEvent(event: RealtimeEvent): void;
  /**
   * 연결 상태가 바뀔 때. true는 열린 뒤 첫 메시지를 받았을 때다.
   * 왜 onopen이 아닌가: 서버는 업그레이드를 마친 뒤에 티켓·출처를 확인하고 실패하면 4003으로 닫으므로, 열렸다고 인증된 것이 아니다.
   * 인증된 연결에는 곧바로 status를 보낸다(server.ts registerWebSocket).
   */
  onConnectionChange(connected: boolean): void;
  /** 세션이 끝나 로그인 화면으로 가야 할 때(4001·session_ended·티켓 401·409 no_channel). */
  onSessionEnded(reason: string): void;
  /** 4003 거절이 MAX_CONSECUTIVE_REJECTIONS번 이어져 다시 연결을 멈췄을 때. */
  onRejected(): void;
  /** 같은 세션의 새 연결에 밀려(4002) 다시 연결을 멈췄을 때. 매니저가 '다시 연결'로 start()를 부를 때까지 멈춰 있다. */
  onReplaced(): void;
  /** 티켓 발급(기본: POST /api/ws-ticket). */
  issueTicket?: () => Promise<string>;
  /** 소켓 열기(기본: 브라우저 WebSocket). */
  openSocket?: (url: string) => SocketLike;
  /** 재연결 예약(기본: setTimeout). 예약을 취소하는 함수를 돌려준다. */
  schedule?: (callback: () => void, ms: number) => () => void;
  /** 백오프 지터용 난수 0~1(기본: Math.random). 테스트에서 고정값으로 바꾼다. */
  random?: () => number;
}

/** 서버가 세션을 끝낼 때 쓰는 닫기 코드(hub.ts). */
const SESSION_ENDED_CLOSE_CODE = 4001;
/**
 * 같은 세션의 새 연결에 밀려 닫힐 때 서버가 쓰는 닫기 코드(세션당 소켓 3개를 넘으면 가장 오래된 것을 닫는다).
 * 왜 다시 연결하지 않나: 자동으로 다시 열면 같은 세션의 창들이 서로를 끊으며 끝없이 돈다.
 */
const REPLACED_CLOSE_CODE = 4002;
/** 티켓이 틀렸거나 출처가 다를 때 서버가 쓰는 닫기 코드(server.ts). */
const REJECTED_CLOSE_CODE = 4003;
/**
 * 4003을 이만큼 이어서 받으면 다시 연결을 멈춘다.
 * 왜: 출처 불일치(다른 주소로 접속)는 재시도해도 낫지 않는데, 멈추지 않으면 그때마다 티켓을 발급받으며 끝없이 되풀이한다(R-6).
 */
const MAX_CONSECUTIVE_REJECTIONS = 3;
/** 재연결 대기 시간의 시작값(1초). 시도마다 두 배로 늘린다. */
const BACKOFF_BASE_MS = 1000;
/** 재연결 대기 시간의 최댓값(30초, 스펙 10장). */
const BACKOFF_MAX_MS = 30_000;

/** 백오프 지터 폭(±20%). 여러 기기가 서버 재시작 직후 한꺼번에 몰리지 않게 흩뜨린다. */
const BACKOFF_JITTER_RATIO = 0.2;
/**
 * 티켓 발급이 한도 초과(429)일 때 다시 받기까지 기다리는 최소 시간(10초).
 * 왜: 서버는 세션당 1분에 티켓 10개만 준다. 1초부터 시작하는 백오프로 곧바로 다시 받으면 거듭 429만 받는다.
 */
const RATE_LIMITED_RETRY_MIN_MS = 10_000;

/**
 * n번째 재연결 대기 시간(지터 없음).
 * @param attempt 연이은 재연결 시도 횟수(0부터)
 * @returns 1초부터 두 배씩 늘어 30초에서 멈추는 대기 시간(ms)
 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

/**
 * 티켓을 붙인 WebSocket 주소. base가 비면 현재 화면의 출처를 쓴다.
 * @param ticket 일회용 티켓(주소에 넣기 전에 인코딩한다)
 * @param base API 주소 앞부분(기본: API_BASE)
 * @param origin base가 비었을 때 쓸 출처(기본: 현재 화면)
 * @returns ws(s)://…/ws?ticket=… 주소
 */
export function websocketUrl(ticket: string, base: string = API_BASE, origin: string = window.location.origin): string {
  return `${(base || origin).replace(/^http/, "ws")}/ws?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * 티켓 발급 한도 초과(429)인지 본다. 세션은 살아 있으므로 로그아웃하지 않고, 4003 거절로도 세지 않는다.
 * @param error 티켓 발급이 던진 오류
 */
function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && error.status === 429;
}

/** 기본 티켓 발급. */
async function requestTicket(): Promise<string> {
  return (await apiSend<{ ticket: string }>("POST", "/api/ws-ticket")).ticket;
}

/** 서버와의 실시간 연결. 끊기면 새 티켓으로 다시 연결하고, 세션이 끝났거나 거듭 거절되면 멈춘다. */
export class RealtimeConnection {
  /** 지금 열려 있거나 여는 중인 소켓. */
  private socket: SocketLike | null = null;
  /** stop()을 불렀거나 아직 start()하지 않았으면 true. 비동기 처리 중에 멈췄는지 확인하는 데 쓴다. */
  private stopped = true;
  /** 연이은 재연결 시도 횟수. 백오프에 쓰고, 서버 메시지를 받으면 0으로 되돌린다. */
  private attempt = 0;
  /** start()·stop()마다 올리는 세대 번호. 비동기 처리·타이머가 옛 세대의 것인지 가려내 새 연결에 끼어들지 못하게 한다. */
  private generation = 0;
  /** 예약된 재연결을 취소하는 함수(없으면 null). stop()에서 부른다. */
  private cancelReconnect: (() => void) | null = null;
  /** 연이은 4003 거절 횟수. 서버 메시지를 받으면 0으로 되돌린다. */
  private rejections = 0;
  /** 티켓 발급 함수. */
  private readonly issueTicket: () => Promise<string>;
  /** 소켓 여는 함수. */
  private readonly openSocket: (url: string) => SocketLike;
  /** 재연결 예약 함수. */
  private readonly schedule: (callback: () => void, ms: number) => () => void;
  /** 지터용 난수 함수. */
  private readonly random: () => number;

  /** @param options 이벤트 수신자와(테스트용) 바꿔 끼울 함수 */
  constructor(private readonly options: RealtimeOptions) {
    this.issueTicket = options.issueTicket ?? requestTicket;
    this.openSocket = options.openSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.schedule =
      options.schedule ??
      ((callback, ms) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      });
    this.random = options.random ?? Math.random;
  }

  /** 연결을 시작한다. 이미 돌고 있으면 무시한다. 거절로 멈춘 뒤 다시 부르면 처음부터 센다. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    this.attempt = 0;
    this.rejections = 0;
    void this.connect();
  }

  /** 연결을 멈추고 소켓을 닫는다. 이후 닫힘·예약된 재연결은 무시된다. */
  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.cancelReconnect?.();
    this.cancelReconnect = null;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.close();
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    this.options.onConnectionChange(false);
  }

  /** 티켓을 받아 소켓을 연다. 로그인이 필요한 오류(401·no_channel)면 세션 종료, 그 밖의 실패는 재연결(한도 초과 429는 10초 이상 뒤). */
  private async connect(): Promise<void> {
    const generation = this.generation;
    try {
      const ticket = await this.issueTicket();
      if (generation !== this.generation) return;
      this.attach(this.openSocket(websocketUrl(ticket)));
    } catch (error) {
      if (generation !== this.generation) return;
      if (requiresSignIn(error)) return this.endSession(error.message);
      console.warn("실시간 연결 티켓 발급 실패, 다시 시도합니다", error);
      this.scheduleReconnect(isRateLimited(error) ? RATE_LIMITED_RETRY_MIN_MS : 0);
    }
  }

  /** 소켓 이벤트를 연결한다. 연결됨 표시는 첫 메시지에서 한다(RealtimeOptions.onConnectionChange 참고). */
  private attach(socket: SocketLike): void {
    this.socket = socket;
    let received = false;
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      if (!received) this.markConnected();
      received = true;
      this.handleMessage(event.data);
    };
    socket.onclose = (event) => this.handleClose(socket, event.code);
  }

  /** 인증된 연결을 확인했다: 백오프·거절 횟수를 처음으로 되돌리고 알린다. */
  private markConnected(): void {
    this.attempt = 0;
    this.rejections = 0;
    this.options.onConnectionChange(true);
  }

  /** 메시지 처리. 형식이 틀린 메시지는 콘솔에 남기고 버린다(연결은 유지). */
  private handleMessage(data: unknown): void {
    let event: RealtimeEvent;
    try {
      const parsed: unknown = JSON.parse(String(data));
      if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
        console.warn("실시간 메시지에 type 문자열이 없어 버립니다");
        return;
      }
      event = parsed as RealtimeEvent;
    } catch (error) {
      console.warn("실시간 메시지 형식 오류", error);
      return;
    }
    if (event.type === "session_ended") this.endSession(event.reason);
    else this.options.onEvent(event);
  }

  /** 닫힘 처리: 4001이면 세션 종료, 4002면 멈춤(다른 창에 밀림), 4003이 이어지면 멈춤, 그 밖에는(1013 서버 혼잡 포함) 백오프 재연결. */
  private handleClose(socket: SocketLike, code: number): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.options.onConnectionChange(false);
    if (this.stopped) return;
    if (code === SESSION_ENDED_CLOSE_CODE) return this.endSession("세션이 종료되었습니다. 다시 로그인하세요.");
    if (code === REPLACED_CLOSE_CODE) return this.yieldToNewerConnection();
    if (code === REJECTED_CLOSE_CODE && ++this.rejections >= MAX_CONSECUTIVE_REJECTIONS) return this.giveUp();
    this.scheduleReconnect();
  }

  /** 세션 종료: 멈추고 한 번만 알린다. */
  private endSession(reason: string): void {
    if (this.stopped) return;
    this.stop();
    this.options.onSessionEnded(reason);
  }

  /** 거절이 이어져 멈춘다. 화면이 /api/me를 다시 확인하고 이유를 보여 준다. */
  private giveUp(): void {
    this.stop();
    this.options.onRejected();
  }

  /** 같은 세션의 새 연결에 밀려(4002) 멈추고 알린다. 매니저가 '다시 연결'을 누르면 start()로 다시 연다. */
  private yieldToNewerConnection(): void {
    this.stop();
    this.options.onReplaced();
  }

  /**
   * 재연결 예약.
   * @param minimumDelayMs 백오프가 이보다 짧으면 이만큼 기다린다(티켓 한도 초과 때 쓴다)
   */
  private scheduleReconnect(minimumDelayMs = 0): void {
    const jitter = 1 + BACKOFF_JITTER_RATIO * (this.random() * 2 - 1);
    const delay = Math.max(Math.min(Math.round(reconnectDelayMs(this.attempt) * jitter), BACKOFF_MAX_MS), minimumDelayMs);
    const generation = this.generation;
    this.attempt += 1;
    this.cancelReconnect = this.schedule(() => {
      if (generation !== this.generation) return;
      this.cancelReconnect = null;
      void this.connect();
    }, delay);
  }
}
