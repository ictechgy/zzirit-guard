import type { ServerStatus, VerdictDto } from "@zzirit-guard/shared";
import { useCallback, useEffect, useReducer, useRef, type Dispatch } from "react";
import { apiGet, describeApiError, requiresSignIn } from "../api/client";
import { RealtimeConnection } from "../api/realtime";
import { initialServerState, serverReducer, type ServerAction, type ServerState } from "./serverReducer";

/** useServerState 결과. */
export interface ServerConnection {
  /** 화면이 쓰는 서버 상태. */
  state: ServerState;
  /** 상태·후보를 서버에서 다시 읽는다('다시 불러오기', 409 already_handled). */
  reload(): void;
  /** 거절로 멈춘 실시간 연결을 다시 시작한다(R-6). */
  reconnect(): void;
}

/** 상태·후보 조회기. 한 번에 하나만 돌고, 도는 중에 다시 요청되면 끝난 뒤 한 번 더 읽는다. */
interface SnapshotLoader {
  /** 조회를 요청한다. 이미 도는 중이면 끝난 뒤 한 번만 더 읽도록 합쳐 둔다. */
  request(): void;
  /** 더 이상 조회하지 않고 진행 중인 결과도 버린다(화면이 사라졌거나 세션이 끝났다). */
  cancel(): void;
}

/** 한 번의 effect 수명 동안 쓰는 실시간 연결과 조회기 묶음. */
interface ServerControls {
  /** 상태·후보 조회기. */
  loader: SnapshotLoader;
  /** 실시간 연결. */
  connection: RealtimeConnection;
  /** 이 묶음을 닫는다: 조회 결과를 버리고 연결을 닫으며, 닫는 중에 동기로 오는 콜백은 무시한다. */
  dispose(): void;
}

/**
 * 처음 상태를 REST로 읽고 이후 변화는 WebSocket으로 받는다.
 * 실시간 연결이 (다시) 열릴 때마다 상태·후보를 다시 읽는다. 휴대폰은 화면이 꺼질 때마다 연결이 끊겨, 그동안 생긴 후보를 놓치기 때문이다(R-3).
 * 조회·티켓이 로그인이 필요한 오류(401·409 no_channel)면 실시간을 멈추고 세션 종료로 처리해 로그인 화면으로 보낸다(R-12).
 * 연결 콜백은 정리(cleanup) 중에 동기적으로 다시 불리거나 같은 값으로 거듭 불릴 수 있어(StrictMode 포함) 멱등하게, 화면이 사라진 뒤에는 아무것도 하지 않게 둔다.
 */
export function useServerState(): ServerConnection {
  const [state, dispatch] = useReducer(serverReducer, initialServerState);
  const controls = useRef<ServerControls | null>(null);
  useEffect(() => {
    const created = createControls(dispatch);
    controls.current = created;
    created.loader.request();
    created.connection.start();
    return created.dispose;
  }, []);
  const reload = useCallback(() => controls.current?.loader.request(), []);
  const reconnect = useCallback(() => controls.current?.connection.start(), []);
  return { state, reload, reconnect };
}

/**
 * 조회기와 실시간 연결을 만든다. 모든 콜백은 이 묶음이 살아 있을 때만 상태를 바꾼다.
 * 왜 mounted 깃발인가: stop()이 정리 중에 onConnectionChange(false)를 동기로 부르는데, 그때는 이미 화면이 사라졌거나 다음 effect가 새 묶음을 만든 뒤라 옛 묶음이 상태를 건드리면 안 된다.
 * @param dispatch 리듀서 디스패치
 * @returns 조회기·연결·닫기 함수
 */
function createControls(dispatch: Dispatch<ServerAction>): ServerControls {
  let isMounted = true;
  let wasConnected = false;
  const guarded = (action: ServerAction) => {
    if (isMounted) dispatch(action);
  };
  // endSession·loader·connection은 서로를 부르지만 모두 비동기 콜백 안에서만 부르므로, 선언 순서로도 초기화 전에 쓰이지 않는다.
  const endSession = (reason: string) => {
    loader.cancel();
    connection.stop();
    guarded({ type: "event", event: { type: "session_ended", reason } });
  };
  const loader = createSnapshotLoader(guarded, endSession);
  const connection = new RealtimeConnection({
    onEvent: (event) => guarded({ type: "event", event }),
    onConnectionChange: (connected) => {
      if (!isMounted || connected === wasConnected) return;
      wasConnected = connected;
      guarded({ type: "connection", connected });
      if (connected) loader.request();
    },
    onSessionEnded: endSession,
    onRejected: () => guarded({ type: "realtime_rejected" }),
  });
  const dispose = () => {
    isMounted = false;
    loader.cancel();
    connection.stop();
  };
  return { loader, connection, dispose };
}

/**
 * 조회기를 만든다. 조회를 하나씩만 돌리는 이유: 리듀서는 조회 하나가 진행 중인 동안의 이벤트만 기록했다가 다시 적용한다(replayLog).
 * 진행 중에 snapshot_started를 또 보내면 그 기록이 지워져 조회 중 받은 이벤트를 잃는다.
 * @param dispatch 리듀서 디스패치
 * @param onSignInRequired 로그인이 필요한 오류일 때 서버 문구로 부른다
 */
function createSnapshotLoader(dispatch: Dispatch<ServerAction>, onSignInRequired: (message: string) => void): SnapshotLoader {
  let isRunning = false;
  let isRequestedAgain = false;
  let isCancelled = false;
  const run = async (): Promise<void> => {
    isRunning = true;
    try {
      await loadSnapshot(dispatch, () => isCancelled, onSignInRequired);
    } finally {
      // 왜 finally인가: 예기치 않은 예외로 깃발이 true로 남으면 이후 요청이 영영 '진행 중'으로 합쳐져 다시는 조회하지 않는다.
      isRunning = false;
    }
    if (!isRequestedAgain || isCancelled) return;
    isRequestedAgain = false;
    startRun();
  };
  /** 조회를 시작하되, 예외는 처리되지 않은 거부로 새지 않게 경고로 남긴다. */
  const startRun = (): void => {
    run().catch((error: unknown) => console.warn("상태·후보 조회 중 예기치 않은 오류가 났습니다", error));
  };
  return {
    request: () => {
      if (isCancelled) return;
      if (isRunning) isRequestedAgain = true;
      else startRun();
    },
    cancel: () => {
      isCancelled = true;
    },
  };
}

/** 상태와 최근 후보를 함께 읽어 리듀서에 넣는다. 취소됐으면 결과를 버린다. */
async function loadSnapshot(dispatch: Dispatch<ServerAction>, hasBeenCancelled: () => boolean, onSignInRequired: (message: string) => void): Promise<void> {
  dispatch({ type: "snapshot_started" });
  try {
    const [status, verdicts] = await Promise.all([apiGet<ServerStatus>("/api/status"), apiGet<VerdictDto[]>("/api/candidates")]);
    if (!hasBeenCancelled()) dispatch({ type: "snapshot_loaded", status, verdicts });
  } catch (error) {
    if (hasBeenCancelled()) return;
    dispatch({ type: "snapshot_failed", message: describeApiError(error) });
    if (requiresSignIn(error)) onSignInRequired(error.message);
  }
}
