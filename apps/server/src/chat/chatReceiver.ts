import io from "socket.io-client";
import type { ChzzkApi } from "../chzzk/apiClient.js";
import type { TokenManager } from "../connection/tokenManager.js";
import { describeError, type Logger } from "../logger.js";
import type { Clock } from "../time.js";
import { parseChatPayload, parseSystemPayload, type ChatEvent } from "./chatEvent.js";

/** 소켓에서 필요한 기능만 뽑은 형태. 테스트와 실제 socket.io-client를 같은 방식으로 다룬다. */
export interface SocketLike {
  on(event: string, handler: (payload: unknown) => void): unknown;
  close(): unknown;
}

/** 세션 URL로 소켓을 여는 함수. */
export type SocketConnector = (url: string) => SocketLike;

/** 채팅 수신기. 세션 생성부터 재연결까지 스스로 관리한다. */
export interface ChatReceiver {
  /** 연결을 시작한다. 이미 시작돼 있으면 아무것도 하지 않는다. */
  start(): void;
  /** 연결과 예약된 재연결을 모두 멈춘다. 진행 중이던 비동기 작업의 결과는 버려진다. */
  stop(): void;
  /** 채팅 구독까지 끝난 상태인지 알려 준다(소켓만 열린 상태는 false). */
  isConnected(): boolean;
}

/** createChatReceiver 옵션. 콜백이 예외를 던져도 수신기는 로그만 남기고 계속 동작한다. */
export interface ChatReceiverOptions {
  /** 세션 URL 발급·채팅 구독에 쓰는 치지직 API. */
  api: ChzzkApi;
  /** 유효한 액세스 토큰을 내주는 관리자. */
  tokenManager: TokenManager;
  /** 세션 URL로 소켓을 여는 함수(테스트에서는 가짜로 바꾼다). */
  connect: SocketConnector;
  /** 수신 시각 기록용 시계. */
  clock: Clock;
  /** 구조화 로그 기록기(채팅 원문 금지). */
  logger: Logger;
  /** 형식이 맞는 채팅 1건을 받을 때마다 호출한다. */
  onChat(event: ChatEvent): void;
  /** 구독 완료(true)·끊김 또는 stop(false)로 상태가 실제로 바뀔 때만 호출한다. */
  onConnectionChange(connected: boolean): void;
  /** 형식이 틀려 버린 채팅 이벤트마다 호출한다(개수 집계용). */
  onInvalidEvent(): void;
  /** 권한 회수 시 호출한다. 수신기는 이미 stop된 뒤이며, 스트리머가 다시 연결해야 한다. */
  onRevoked(): void;
  /**
   * 지금 연결된 채널 ID. 연결이 없으면 null. CHAT·SYSTEM의 channelId를 이 값과 대조한다(S17, X09).
   * 왜: 다른 채널의 이벤트를 받아들이면 그 채널 시청자의 메시지를 판정·숨김 대상으로 삼거나, 남의 구독 해제·권한 회수로 연결 상태가 바뀐다.
   */
  connectedChannelId(): string | null;
  /** 소켓이 열린 뒤 구독 완료까지 기다리는 한도(ms). 기본 HANDSHAKE_TIMEOUT_MS, 테스트에서 줄인다. */
  handshakeTimeoutMs?: number;
}

/**
 * 치지직 문서의 연결 옵션 그대로(옛 이름과 2.x 이름을 함께 둔다).
 * 재연결은 끈다. 세션 URL이 일정 시간만 유효해서 재연결할 때마다 새로 받아야 하기 때문이다.
 * forceNode는 engine.io-client가 Node 22의 전역 WebSocket(undici) 대신 번들된 ws 패키지를 쓰게 한다.
 * undici는 연결 중 실패나 close() 때 readyState를 바꾸기 전에 error를 동기로 발생시켜
 * engine.io의 onError → onClose → close()가 끝없이 되풀이되고(스택 초과), 그 예외가
 * 비동기 uncaughtException이 되어 프로세스가 종료된다. ws는 재진입을 막는다.
 */
const SOCKET_OPTIONS = {
  reconnection: false,
  "force new connection": true,
  forceNew: true,
  "connect timeout": 3000,
  timeout: 3000,
  transports: ["websocket"],
  forceNode: true,
};

/** socket.io-client 2.0.3으로 세션에 연결한다. */
export const connectWithSocketIo: SocketConnector = (url) =>
  io.connect(url, SOCKET_OPTIONS as SocketIOClient.ConnectOpts) as unknown as SocketLike;

/** 소켓이 열린 뒤 connected·subscribed가 모두 오기까지 기다리는 한도(10초). 넘으면 연결을 버리고 재시도한다. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** 재연결 대기 시간 기본값(1초). */
const BACKOFF_BASE_MS = 1000;
/** 재연결 대기 시간 상한(30초, 스펙 10장). */
const BACKOFF_MAX_MS = 30_000;

/** 지수 백오프: 1, 2, 4, 8, 16, 30, 30… 초. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

/** 채팅 수신기를 만든다. */
export function createChatReceiver(options: ChatReceiverOptions): ChatReceiver {
  return new SessionChatReceiver(options);
}

/**
 * 세션 생성 → 소켓 연결 → connected → 구독 → subscribed 순서로 연결하고, 끊기면 백오프로 다시 시작한다.
 * 오래된 소켓·오래된 비동기 작업의 결과가 새 연결을 망치지 않도록 소켓 동일성과 세대 번호로 걸러낸다.
 */
class SessionChatReceiver implements ChatReceiver {
  private socket: SocketLike | null = null;
  private stopped = true;
  private connected = false;
  private attempt = 0;
  /** stop()과 연결 시도마다 올라가는 번호. 시작 시점과 다르면 그 비동기 작업은 낡은 것이다. */
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 이 소켓에서 다른 채널 이벤트 경고를 이미 남겼는지. 같은 연결에서 매 이벤트마다 로그가 쌓이지 않게 한 번만 남긴다. */
  private hasWarnedChannelMismatch = false;

  constructor(private readonly options: ChatReceiverOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connectOnce();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.clearTimers();
    this.closeSocket();
    this.setConnected(false);
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** 새 세션 URL을 받아 소켓을 연다. 실패하면 재연결을 예약한다. await 뒤에는 세대를 다시 확인한다. */
  private async connectOnce(): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    try {
      const url = await this.options.api.createSessionUrl(await this.options.tokenManager.getAccessToken());
      if (this.stopped || generation !== this.generation) return;
      this.attachSocket(this.options.connect(url));
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      this.options.logger.warn("채팅 세션 생성 실패, 다시 시도합니다", { error: describeError(error) });
      this.scheduleReconnect();
    }
  }

  /** 소켓 이벤트를 연결한다. 모든 핸들러는 지금 소켓이 자기 자신일 때만 동작한다. */
  private attachSocket(socket: SocketLike): void {
    this.socket = socket;
    this.hasWarnedChannelMismatch = false;
    this.armHandshakeWatchdog(socket);
    socket.on("SYSTEM", (payload) => {
      if (socket === this.socket) this.runSystemHandler(socket, payload);
    });
    socket.on("CHAT", (payload) => {
      if (socket === this.socket) this.handleChat(payload);
    });
    for (const event of ["disconnect", "connect_error", "connect_timeout", "error"]) {
      socket.on(event, () => this.handleDrop(socket, event));
    }
  }

  /** 구독 완료가 오지 않으면 연결을 버리고 다시 시작하도록 감시 타이머를 건다. */
  private armHandshakeWatchdog(socket: SocketLike): void {
    const timeoutMs = this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      this.handleDrop(socket, "handshake_timeout");
    }, timeoutMs);
  }

  /** 시스템 메시지 처리를 시작하고, 예외가 새어 나가 프로세스를 죽이지 않도록 로그로 붙잡는다. */
  private runSystemHandler(socket: SocketLike, payload: unknown): void {
    this.handleSystem(socket, payload).catch((error: unknown) => {
      this.options.logger.error("시스템 메시지 처리 중 예외가 발생했습니다", { error: describeError(error) });
    });
  }

  /**
   * 시스템 메시지 처리.
   * unsubscribed는 구독이 풀린 것이라 끊김과 같이 다룬다: 연결 안 됨으로 알리고 소켓을 버린 뒤 백오프로 새 세션을 만든다(S16, M05).
   * 왜: 무시하면 채팅이 더 오지 않는데도 connected=true로 남아 화면이 "채팅 수신 중"으로 보이고 다시 연결하지도 않는다.
   */
  private async handleSystem(socket: SocketLike, payload: unknown): Promise<void> {
    const message = parseSystemPayload(payload);
    // connected 말고는 channelId가 있다. 연결한 채널이 아니면 상태를 바꾸지 않는다(S17).
    if (message !== null && message.type !== "connected" && !this.isConnectedChannel(message.channelId)) return this.warnChannelMismatch("SYSTEM");
    if (message?.type === "connected") await this.subscribe(socket, message.sessionKey);
    else if (message?.type === "subscribed") this.markConnected();
    else if (message?.type === "unsubscribed") this.handleDrop(socket, "unsubscribed");
    else if (message?.type === "revoked") this.handleRevoked();
  }

  /** sessionKey로 채팅 이벤트를 구독한다. 실패하면 이 소켓일 때만 연결을 버리고 다시 시작한다. */
  private async subscribe(socket: SocketLike, sessionKey: string): Promise<void> {
    try {
      await this.options.api.subscribeChat(await this.options.tokenManager.getAccessToken(), sessionKey);
    } catch (error) {
      if (socket !== this.socket) return;
      this.options.logger.warn("채팅 구독 실패, 다시 연결합니다", { error: describeError(error) });
      this.handleDrop(socket, "subscribe_failed");
    }
  }

  /** 구독 완료. 감시 타이머를 풀고 백오프 단계를 처음으로 돌린다. */
  private markConnected(): void {
    this.clearHandshakeTimer();
    this.attempt = 0;
    this.setConnected(true);
  }

  /**
   * 채팅 이벤트를 검증해 넘기고, 형식이 틀리면 개수만 센다(원문은 로그에 남기지 않는다).
   * 연결한 채널이 아닌 채팅은 넘기지도 세지도 않는다(S17). 형식은 맞으므로 형식 오류 수에 넣지 않는다.
   */
  private handleChat(payload: unknown): void {
    const event = parseChatPayload(payload, this.options.clock());
    if (event && !this.isConnectedChannel(event.channelId)) this.warnChannelMismatch("CHAT");
    else if (event) this.notify("onChat", () => this.options.onChat(event));
    else this.notify("onInvalidEvent", () => this.options.onInvalidEvent());
  }

  /**
   * 이벤트의 채널이 지금 연결된 채널인지 본다. 연결 채널을 모르거나(null) 읽다가 실패하면 받아들이지 않는다(안전한 쪽).
   * @param channelId 이벤트에 든 채널 ID
   */
  private isConnectedChannel(channelId: string): boolean {
    try {
      const connectedChannelId = this.options.connectedChannelId();
      return connectedChannelId !== null && connectedChannelId === channelId;
    } catch (error) {
      this.options.logger.error("연결된 채널을 읽지 못해 이벤트를 무시했습니다. DB 상태를 확인하세요", { error: describeError(error) });
      return false;
    }
  }

  /**
   * 다른 채널의 이벤트를 무시했다고 소켓마다 한 번만 경고한다. 원문·채널 ID는 남기지 않는다.
   * @param eventName 무시한 이벤트 이름
   */
  private warnChannelMismatch(eventName: "CHAT" | "SYSTEM"): void {
    if (this.hasWarnedChannelMismatch) return;
    this.hasWarnedChannelMismatch = true;
    this.options.logger.warn("연결한 채널과 다른 채널의 이벤트를 무시했습니다(같은 연결에서는 다시 기록하지 않습니다)", { event: eventName });
  }

  /** 권한 회수: 다시 연결해도 소용없으므로 멈추고 알린다. */
  private handleRevoked(): void {
    this.options.logger.warn("치지직이 채팅 이벤트 권한을 회수했습니다. 스트리머가 다시 연결해야 합니다");
    this.stop();
    this.notify("onRevoked", () => this.options.onRevoked());
  }

  /** 연결이 끊긴 경우: 현재 소켓이 아니면 무시하고, 맞으면 버리고 재연결을 예약한다. */
  private handleDrop(socket: SocketLike, reason: string): void {
    if (this.stopped || socket !== this.socket) return;
    this.options.logger.info("채팅 연결이 끊겼습니다", { reason });
    this.closeSocket();
    this.setConnected(false);
    this.scheduleReconnect();
  }

  /** 백오프 시간 뒤 다시 연결한다. 이미 예약돼 있으면 아무것도 하지 않는다. */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = reconnectDelayMs(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOnce();
    }, delay);
  }

  /** 재연결 예약과 핸드셰이크 감시를 모두 취소한다. */
  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHandshakeTimer();
  }

  /** 핸드셰이크 감시 타이머만 취소한다. */
  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  /**
   * 소켓을 닫는다. 먼저 참조를 비워 두므로, close()가 동기로 disconnect 이벤트를 일으켜도
   * 핸들러의 소켓 동일성 검사에 걸려 무시된다.
   */
  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.clearHandshakeTimer();
    socket?.close();
  }

  /** 연결 상태를 바꾸고, 바뀌었을 때만 알린다. */
  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.notify("onConnectionChange", () => this.options.onConnectionChange(connected));
  }

  /** 호출자 콜백을 실행하되, 던진 예외는 소켓 이벤트 흐름으로 번지지 않게 로그로만 남긴다. */
  private notify(callbackName: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.options.logger.error("콜백에서 예외가 발생했습니다", { callback: callbackName, error: describeError(error) });
    }
  }
}
