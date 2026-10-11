import type { ChatLine, RealtimeEvent, ServerStatus, VerdictDto } from "@zzirit-guard/shared";
import { addVerdictIfAbsent, applyVerdictStatus, mergeVerdicts, pruneVerdicts } from "../domain/candidates";

/** 실시간 채팅 화면에 남길 최대 줄 수. 초당 수십 건이어도 휴대폰이 버티게 한다. */
export const MAX_CHAT_LINES = 300;

/**
 * 화면에 남는 채팅 줄: 서버 줄 + 클라이언트 순번(seq).
 * 왜: 초당 수십 건이 들어오면 줄 위치(index)가 매번 바뀌어 React 키가 흔들리고 300행이 모두 다시 마운트된다.
 * 순번은 줄이 처음 들어올 때 한 번 정해져 바뀌지 않으므로, 키로 쓰면 기존 행이 그대로 유지된다. 같은 messageTime이 여러 개여도 순번은 겹치지 않는다.
 */
export type ChatLineEntry = ChatLine & { seq: number };

/** 화면이 쓰는 서버 상태. */
export interface ServerState {
  /** 서버 상태(상태 배너·스위치). 아직 모르면 null. */
  status: ServerStatus | null;
  /** 최근 판정. 창과 여유(VERDICT_KEEP_MS)를 넘긴 것은 지운다. */
  verdicts: VerdictDto[];
  /** 실시간 채팅 줄(최근 MAX_CHAT_LINES개). 각 줄에는 순번(seq)이 붙어 있다. */
  chatLines: ChatLineEntry[];
  /** 다음 채팅 줄에 붙일 순번. 줄이 잘려 나가도 줄어들지 않는다(순번 재사용 방지). */
  nextChatSeq: number;
  /** 실시간 연결이 열려 서버 메시지를 받고 있는지. */
  realtimeConnected: boolean;
  /** 실시간 연결이 거듭 거절돼(4003) 다시 연결을 멈췄는지(R-6). */
  realtimeRejected: boolean;
  /** 세션이 끝난 이유. 값이 생기면 로그인 화면으로 돌아간다. */
  sessionEndedReason: string | null;
  /** 마지막 조회 실패 문구. 성공하면 지운다. */
  loadError: string | null;
  /**
   * 조회(snapshot)가 진행 중일 때 받은 판정·상태 이벤트. 조회 결과를 넣은 뒤 그 위에 다시 적용한다. 조회 중이 아니면 null.
   * 왜: 조회 결과는 요청 시점의 사진이라, 응답을 기다리는 동안 온 이벤트보다 오래됐을 수 있다(X1).
   */
  replayLog: RealtimeEvent[] | null;
}

/** 상태를 바꾸는 동작. 조회는 snapshot_started → snapshot_loaded·snapshot_failed 순서로 하나씩만 진행한다(useServerState가 보장). */
export type ServerAction =
  | { type: "snapshot_started" }
  | { type: "snapshot_loaded"; status: ServerStatus; verdicts: VerdictDto[] }
  | { type: "snapshot_failed"; message: string }
  | { type: "event"; event: RealtimeEvent }
  | { type: "connection"; connected: boolean }
  | { type: "realtime_rejected" };

/** 처음 상태. */
export const initialServerState: ServerState = {
  status: null, verdicts: [], chatLines: [], nextChatSeq: 0, realtimeConnected: false, realtimeRejected: false, sessionEndedReason: null, loadError: null, replayLog: null,
};

/** 조회 중에 기록해 두었다가 다시 적용할 이벤트 종류. 채팅 줄·세션 종료는 다시 적용할 필요가 없다. */
const REPLAYED_EVENT_TYPES: ReadonlySet<RealtimeEvent["type"]> = new Set(["verdict", "verdict_status", "status"]);

/** 순수 리듀서. 화면 로직을 테스트할 수 있게 부수 효과 없이 둔다. */
export function serverReducer(state: ServerState, action: ServerAction): ServerState {
  switch (action.type) {
    case "snapshot_started":
      return { ...state, replayLog: [] };
    case "snapshot_loaded":
      return applySnapshot(state, action.status, action.verdicts);
    case "snapshot_failed":
      return { ...state, loadError: action.message, replayLog: null };
    case "connection":
      return { ...state, realtimeConnected: action.connected, realtimeRejected: action.connected ? false : state.realtimeRejected };
    case "realtime_rejected":
      return { ...state, realtimeConnected: false, realtimeRejected: true };
    case "event":
      return recordForReplay(applyEvent(state, action.event), action.event);
  }
}

/** 조회 결과를 합치고, 조회 중에 받은 이벤트를 그 위에 다시 적용한다. */
function applySnapshot(state: ServerState, status: ServerStatus, verdicts: readonly VerdictDto[]): ServerState {
  const base: ServerState = { ...state, status, verdicts: pruneVerdicts(mergeVerdicts(state.verdicts, verdicts)), loadError: null, replayLog: null };
  return (state.replayLog ?? []).reduce(applyEvent, base);
}

/** 조회 중이면 판정·상태 이벤트를 기록해 둔다. */
function recordForReplay(state: ServerState, event: RealtimeEvent): ServerState {
  if (!state.replayLog || !REPLAYED_EVENT_TYPES.has(event.type)) return state;
  return { ...state, replayLog: [...state.replayLog, event] };
}

/** 실시간 이벤트 반영. */
function applyEvent(state: ServerState, event: RealtimeEvent): ServerState {
  switch (event.type) {
    case "verdict":
      return { ...state, verdicts: pruneVerdicts(addVerdictIfAbsent(state.verdicts, event.verdict)) };
    case "verdict_status":
      return { ...state, verdicts: applyVerdictStatus(state.verdicts, event.verdictId, event.status) };
    case "chat_batch":
      return appendChatLines(state, event.lines);
    case "status":
      return { ...state, status: event.status };
    case "session_ended":
      return { ...state, sessionEndedReason: event.reason };
  }
}

/** 받은 배치 줄마다 순번을 차례로 붙여 덧붙이고, 최근 MAX_CHAT_LINES개만 남긴다. */
function appendChatLines(state: ServerState, lines: readonly ChatLine[]): ServerState {
  const entries: ChatLineEntry[] = lines.map((line, offset) => ({ ...line, seq: state.nextChatSeq + offset }));
  return { ...state, chatLines: [...state.chatLines, ...entries].slice(-MAX_CHAT_LINES), nextChatSeq: state.nextChatSeq + lines.length };
}
