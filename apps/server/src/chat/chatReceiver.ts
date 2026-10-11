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

/** 채팅 수신기. */
export interface ChatReceiver {
  start(): void;
  stop(): void;
  isConnected(): boolean;
}

/** createChatReceiver 옵션. */
export interface ChatReceiverOptions {
  api: ChzzkApi;
  tokenManager: TokenManager;
  connect: SocketConnector;
  clock: Clock;
  logger: Logger;
  onChat(event: ChatEvent): void;
  onConnectionChange(connected: boolean): void;
  onInvalidEvent(): void;
  onRevoked(): void;
}

/**
 * 치지직 문서의 연결 옵션 그대로(옛 이름과 2.x 이름을 함께 둔다).
 * 재연결은 끈다. 세션 URL이 일정 시간만 유효해서 재연결할 때마다 새로 받아야 하기 때문이다.
 */
const SOCKET_OPTIONS = {
  reconnection: false,
  "force new connection": true,
  forceNew: true,
  "connect timeout": 3000,
  timeout: 3000,
  transports: ["websocket"],
};

/** socket.io-client 2.0.3으로 세션에 연결한다. */
export const connectWithSocketIo: SocketConnector = (url) =>
  io.connect(url, SOCKET_OPTIONS as SocketIOClient.ConnectOpts) as unknown as SocketLike;

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

/** 세션 생성 → 소켓 연결 → connected → 구독 → subscribed 순서로 연결하고, 끊기면 백오프로 다시 시작한다. */
class SessionChatReceiver implements ChatReceiver {
  private socket: SocketLike | null = null;
  private stopped = true;
  private connected = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ChatReceiverOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connectOnce();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.closeSocket();
    this.setConnected(false);
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** 새 세션 URL을 받아 소켓을 연다. 실패하면 재연결을 예약한다. */
  private async connectOnce(): Promise<void> {
    try {
      const url = await this.options.api.createSessionUrl(await this.options.tokenManager.getAccessToken());
      if (this.stopped) return;
      this.attachSocket(this.options.connect(url));
    } catch (error) {
      this.options.logger.warn("채팅 세션 생성 실패, 다시 시도합니다", { error: describeError(error) });
      this.scheduleReconnect();
    }
  }

  /** 소켓 이벤트를 연결한다. */
  private attachSocket(socket: SocketLike): void {
    this.socket = socket;
    socket.on("SYSTEM", (payload) => void this.handleSystem(payload));
    socket.on("CHAT", (payload) => this.handleChat(payload));
    for (const event of ["disconnect", "connect_error", "connect_timeout", "error"]) {
      socket.on(event, () => this.handleDrop(event));
    }
  }

  /** 시스템 메시지 처리. */
  private async handleSystem(payload: unknown): Promise<void> {
    const message = parseSystemPayload(payload);
    if (message?.type === "connected") await this.subscribe(message.sessionKey);
    else if (message?.type === "subscribed") this.markConnected();
    else if (message?.type === "revoked") this.handleRevoked();
  }

  /** sessionKey로 채팅 이벤트를 구독한다. 실패하면 연결을 버리고 다시 시작한다. */
  private async subscribe(sessionKey: string): Promise<void> {
    try {
      await this.options.api.subscribeChat(await this.options.tokenManager.getAccessToken(), sessionKey);
    } catch (error) {
      this.options.logger.warn("채팅 구독 실패, 다시 연결합니다", { error: describeError(error) });
      this.handleDrop("subscribe_failed");
    }
  }

  /** 구독 완료. 백오프 단계를 처음으로 돌린다. */
  private markConnected(): void {
    this.attempt = 0;
    this.setConnected(true);
  }

  /** 채팅 이벤트를 검증해 넘기고, 형식이 틀리면 개수만 센다(원문은 로그에 남기지 않는다). */
  private handleChat(payload: unknown): void {
    const event = parseChatPayload(payload, this.options.clock());
    if (event) this.options.onChat(event);
    else this.options.onInvalidEvent();
  }

  /** 권한 회수: 다시 연결해도 소용없으므로 멈추고 알린다. */
  private handleRevoked(): void {
    this.options.logger.warn("치지직이 채팅 이벤트 권한을 회수했습니다. 스트리머가 다시 연결해야 합니다");
    this.stop();
    this.options.onRevoked();
  }

  /** 연결이 끊긴 경우: 소켓을 버리고 재연결을 예약한다. */
  private handleDrop(reason: string): void {
    if (this.stopped) return;
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

  /** 예약된 재연결을 취소한다. */
  private clearTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** 소켓을 닫는다. 먼저 참조를 비워 close가 일으키는 disconnect 이벤트가 되돌아오지 않게 한다. */
  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  /** 연결 상태를 바꾸고, 바뀌었을 때만 알린다. */
  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.options.onConnectionChange(connected);
  }
}
