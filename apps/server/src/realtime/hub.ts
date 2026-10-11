import type { ChatLine, RealtimeEvent } from "@zzirit-guard/shared";
import type { Broadcaster } from "../actions/decisionHandler.js";
import type { ManagerSession } from "../managers/sessionStore.js";

/** 허브가 쓰는 WebSocket 기능(ws 라이브러리 소켓이 그대로 맞는다). */
export interface SocketSink {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): unknown;
}

/** 매니저 화면으로 실시간 이벤트를 보낸다. */
export interface RealtimeHub extends Broadcaster {
  attach(socket: SocketSink, session: ManagerSession): void;
  closeSessions(sessionIds: readonly string[], reason: string): void;
  connectionCount(): number;
  flush(): void;
  stop(): void;
}

/** WebSocket OPEN 상태 값. */
const OPEN = 1;
/** 세션 종료로 닫을 때 쓰는 앱 전용 닫기 코드. 화면은 이 코드를 보고 재연결 대신 로그인으로 보낸다. */
const SESSION_ENDED_CLOSE_CODE = 4001;
/** 전송 실패로 닫을 때 쓰는 코드(1011: 서버 내부 오류). */
const SEND_FAILED_CLOSE_CODE = 1011;
/** 채팅 묶음 전송 기본값: 250ms마다 최대 100줄. 초당 수십 건이어도 휴대폰이 버틸 만큼만 보낸다. */
const DEFAULTS = { flushIntervalMs: 250, maxLinesPerFlush: 100 };

/**
 * 허브를 만든다.
 * 왜: 판정·상태는 즉시 보내야 하고, 채팅 줄은 묶어서 보내야 휴대폰 부하를 막을 수 있다.
 * @param options 묶음 전송 주기와 한 번에 보낼 최대 줄 수. 생략하면 기본값을 쓴다.
 * @returns 방송·연결 관리·종료 기능을 가진 허브.
 */
export function createRealtimeHub(options: Partial<typeof DEFAULTS> = {}): RealtimeHub {
  const settings = { ...DEFAULTS, ...options };
  const connections = new Map<SocketSink, string>();
  let pendingLines: ChatLine[] = [];

  /**
   * 열린 모든 소켓에 이벤트를 보낸다.
   * 왜: 한 소켓의 전송 실패가 나머지 소켓으로 번지지 않도록 소켓마다 따로 보낸다.
   */
  const sendToAll = (event: RealtimeEvent) => {
    const data = JSON.stringify(event);
    connections.forEach((_sessionId, socket) => {
      if (socket.readyState === OPEN) sendToSocket(connections, socket, data);
    });
  };
  /**
   * 대기 중인 채팅 줄을 최신 maxLinesPerFlush개만 골라 한 번에 보낸다.
   * 왜: 밀린 줄이 많으면 오래된 것은 버려서 화면이 항상 최근 채팅을 보여 주게 한다.
   */
  const flush = () => {
    if (pendingLines.length === 0) return;
    const lines = pendingLines.slice(-settings.maxLinesPerFlush);
    pendingLines = [];
    sendToAll({ type: "chat_batch", lines });
  };
  const timer = setInterval(flush, settings.flushIntervalMs);

  return {
    broadcast: sendToAll,
    pushChatLine: (line) => void pendingLines.push(line),
    attach(socket, session) {
      connections.set(socket, session.id);
      socket.on("close", () => connections.delete(socket));
    },
    closeSessions: (sessionIds, reason) => closeMatching(connections, new Set(sessionIds), reason),
    connectionCount: () => connections.size,
    flush,
    stop() {
      clearInterval(timer);
      connections.forEach((_sessionId, socket) => socket.close(1001, "server stopping"));
      connections.clear();
    },
  };
}

/**
 * 지정한 세션의 소켓에 종료 이유를 보내고 닫는다.
 * 왜: 권한을 잃은 세션은 화면에 이유를 알린 뒤 전용 코드로 닫아야 재연결 루프에 빠지지 않는다.
 * 전송이 실패한 소켓은 sendToSocket이 이미 빼고 닫았으므로 여기서는 건너뛴다.
 */
function closeMatching(connections: Map<SocketSink, string>, sessionIds: ReadonlySet<string>, reason: string): void {
  const message = JSON.stringify({ type: "session_ended", reason } satisfies RealtimeEvent);
  for (const [socket, sessionId] of connections) {
    if (!sessionIds.has(sessionId)) continue;
    if (socket.readyState === OPEN && !sendToSocket(connections, socket, message)) continue;
    socket.close(SESSION_ENDED_CLOSE_CODE, "session ended");
    connections.delete(socket);
  }
}

/**
 * 소켓 하나에 데이터를 보내고, 성공 여부를 돌려준다.
 * 왜: ws의 send는 드물게 동기적으로 throw한다. 한 휴대폰의 오류로 서버 전체가 죽지 않게 이 소켓만 분리한다.
 * @returns 보내기에 성공하면 true, 실패해 소켓을 분리했으면 false.
 */
function sendToSocket(connections: Map<SocketSink, string>, socket: SocketSink, data: string): boolean {
  try {
    socket.send(data);
    return true;
  } catch {
    dropBrokenSocket(connections, socket);
    return false;
  }
}

/**
 * 전송에 실패한 소켓을 목록에서 빼고 1011로 닫는다.
 * 왜: 목록에서 먼저 빼야 이후 방송이 다시 실패하지 않는다. 클라이언트는 재연결하고, 다음 티켓 발급 때 다시 붙는다.
 * 닫기 자체가 실패해도 이미 목록에서 뺐으므로 서버 상태에는 영향이 없다.
 */
function dropBrokenSocket(connections: Map<SocketSink, string>, socket: SocketSink): void {
  connections.delete(socket);
  try {
    socket.close(SEND_FAILED_CLOSE_CODE, "send failed");
  } catch {
    // 이미 깨진 소켓의 닫기 실패는 무시한다. 목록에서는 이미 뺐고, 로거가 없어 따로 기록할 곳도 없다.
  }
}
