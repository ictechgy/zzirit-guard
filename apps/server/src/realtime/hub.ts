import type { ChatLine, RealtimeEvent } from "@zzirit-guard/shared";
import type { Broadcaster } from "../actions/decisionHandler.js";
import type { ManagerSession } from "../managers/sessionStore.js";

/** 허브가 쓰는 WebSocket 기능(ws 라이브러리 소켓이 그대로 맞는다). bufferedAmount는 아직 보내지 못하고 쌓인 바이트 수다. */
export interface SocketSink {
  readyState: number;
  bufferedAmount?: number;
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
/** 전송 실패·버퍼 초과로 닫을 때 쓰는 코드(1011: 서버 내부 오류). */
const SEND_FAILED_CLOSE_CODE = 1011;
/** 서버가 멈출 때와 멈춘 뒤 들어온 연결을 닫을 때 쓰는 코드(1001: going away). */
const SERVER_STOPPING_CLOSE_CODE = 1001;
/**
 * 보내지 못하고 쌓인 데이터의 상한(1MB).
 * 왜: 반쯤 끊긴 휴대폰 연결은 'close'가 오지 않아 묶음이 계속 쌓이므로, 넘으면 끊어서 서버 메모리를 지킨다.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;
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
  let isStopped = false;

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
  // 왜: stop()을 깜빡해도 이 타이머가 프로세스를 붙잡아 종료를 막지 않게 한다.
  timer.unref();

  return {
    broadcast: sendToAll,
    pushChatLine(line) {
      if (isStopped) return;
      pendingLines.push(line);
    },
    attach(socket, session) {
      if (isStopped) {
        closeSocketSafely(socket, SERVER_STOPPING_CLOSE_CODE, "server stopping");
        return;
      }
      // 왜: 이미 닫힌 소켓은 'close' 이벤트가 다시 오지 않아 목록에 남으면 영원히 새므로 아예 넣지 않는다.
      if (socket.readyState !== OPEN) return;
      connections.set(socket, session.id);
      socket.on("close", () => connections.delete(socket));
    },
    closeSessions: (sessionIds, reason) => closeMatching(connections, new Set(sessionIds), reason),
    connectionCount: () => connections.size,
    flush,
    stop() {
      isStopped = true;
      clearInterval(timer);
      pendingLines = [];
      // 왜: 목록을 먼저 비워야 닫기 도중 실패해도 목록이 남지 않고, 소켓마다 닫기를 따로 시도할 수 있다.
      const sockets = [...connections.keys()];
      connections.clear();
      for (const socket of sockets) closeSocketSafely(socket, SERVER_STOPPING_CLOSE_CODE, "server stopping");
    },
  };
}

/**
 * 지정한 세션의 소켓에 종료 이유를 보내고 닫는다.
 * 왜: 권한을 잃은 세션은 화면에 이유를 알린 뒤 전용 코드로 닫아야 재연결 루프에 빠지지 않는다.
 * 소켓은 닫기 전에 목록에서 먼저 빼서, 닫기가 실패해도 목록에 남지 않게 한다.
 * 전송이 실패한 소켓은 sendToSocket이 이미 1011로 닫았으므로 4001 닫기는 건너뛴다.
 */
function closeMatching(connections: Map<SocketSink, string>, sessionIds: ReadonlySet<string>, reason: string): void {
  const message = JSON.stringify({ type: "session_ended", reason } satisfies RealtimeEvent);
  for (const [socket, sessionId] of connections) {
    if (!sessionIds.has(sessionId)) continue;
    connections.delete(socket);
    if (socket.readyState === OPEN && !sendToSocket(connections, socket, message)) continue;
    closeSocketSafely(socket, SESSION_ENDED_CLOSE_CODE, "session ended");
  }
}

/**
 * 소켓 하나에 데이터를 보내고, 성공 여부를 돌려준다.
 * 왜: ws의 send는 드물게 동기적으로 throw하고, 느린 휴대폰은 버퍼만 계속 쌓는다. 이 소켓만 분리해 서버 전체를 지킨다.
 * @returns 보내기에 성공하면 true, 실패하거나 버퍼가 넘쳐 소켓을 분리했으면 false.
 */
function sendToSocket(connections: Map<SocketSink, string>, socket: SocketSink, data: string): boolean {
  if ((socket.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) {
    dropBrokenSocket(connections, socket, "buffer full");
    return false;
  }
  try {
    socket.send(data);
    return true;
  } catch {
    dropBrokenSocket(connections, socket, "send failed");
    return false;
  }
}

/**
 * 문제가 생긴 소켓을 목록에서 빼고 1011로 닫는다.
 * 왜: 목록에서 먼저 빼야 이후 방송이 다시 실패하지 않는다. 클라이언트는 재연결하고, 다음 티켓 발급 때 다시 붙는다.
 * @param reason 닫기 사유 문구. 어떤 이유로 끊었는지 연결 쪽에서 구분할 수 있게 한다.
 */
function dropBrokenSocket(connections: Map<SocketSink, string>, socket: SocketSink, reason: string): void {
  connections.delete(socket);
  closeSocketSafely(socket, SEND_FAILED_CLOSE_CODE, reason);
}

/**
 * 소켓을 닫되, 닫기가 throw해도 호출한 쪽이 멈추지 않게 감싼다.
 * 왜: 닫기 한 번의 실패가 같은 방송·종료 루프의 나머지 소켓을 건너뛰게 하면, 권한이 해제된 매니저가 계속 연결되거나 서버 종료가 중간에 끊긴다.
 * 로거가 없어 닫기 실패는 기록하지 않는다. 소켓은 호출 전에 이미 목록에서 뺐으므로 상태에는 영향이 없다.
 */
function closeSocketSafely(socket: SocketSink, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // 닫기 실패는 무시한다: 목록에서는 이미 뺐고, 로거가 없어 기록할 곳도 없다.
  }
}
