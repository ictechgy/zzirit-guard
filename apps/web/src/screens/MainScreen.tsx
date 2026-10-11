import type { MeDto } from "@zzirit-guard/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { apiGet, apiSend, requiresSignIn } from "../api/client";
import { TabBar, type Tab } from "../components/TabBar";
import { buildSections, countActionable } from "../domain/candidates";
import { useNow } from "../state/useNow";
import { useServerState } from "../state/useServerState";
import { CandidatesScreen, type CandidateActions } from "./CandidatesScreen";
import { LiveChatScreen } from "./LiveChatScreen";
import { SettingsScreen } from "./SettingsScreen";

/** 후보 시각 창을 다시 계산하는 간격(15초). */
const NOW_REFRESH_MS = 15_000;
/** 임시 제한 성공 안내. 서버는 묶음의 첫 판정 1건만 restricted로 바꾸므로, 남은 메시지를 정리하라고 알린다. */
const TEMPORARY_RESTRICT_DONE = "임시 제한했습니다. 같은 사람의 남은 메시지는 숨기기나 무시로 정리하세요.";
/** 오판 신고 성공 안내. 신고한 판정은 후보 화면에서 빠지고 오판 검토 목록에 오른다. */
const FALSE_POSITIVE_DONE = "오판으로 신고했습니다. 기록·설정 → 오판 검토에서 볼 수 있습니다.";
/** 실시간 연결이 거듭 거절됐을 때의 안내(R-6). 출처 불일치(다른 주소로 연 경우)가 가장 흔한 원인이다. */
const REALTIME_REJECTED_MESSAGE = "실시간 연결이 계속 거절됩니다. 운영자가 알려 준 주소(https://…ts.net)로 열었는지 확인한 뒤 '다시 연결'을 누르세요.";

/** 조치 응답. 숨김·임시 제한은 { ok, note }, 무시·오판은 { ok }, 자동 숨김 스위치는 { enabled }라 공통으로 쓰는 필드만 둔다(routes.ts). */
interface ActionResponse {
  /** 매니저에게 보여 줄 안내(예: "이미 사라진 메시지입니다"). */
  note?: string | null;
}

/** MainScreen 속성. */
export interface MainScreenProps {
  /** 로그인한 매니저. */
  me: MeDto;
  /** 세션이 끝났을 때 로그인 화면으로 돌아간다(message는 안내 문구). 렌더마다 바뀌지 않는 함수여야 한다. */
  onSignedOut(message: string | null): void;
}

/**
 * 후보 화면 동작을 API로 채운다. 결과 상태는 서버가 WebSocket으로 다시 알려 화면이 바뀐다.
 * 로그인이 필요한 오류(401·409 no_channel)면 로그인 화면으로 보내고, 오류는 다시 던져 화면에 남긴다.
 * @param onSignedOut 로그인 화면으로 보낸다
 * @param ownDisableRef 이 기기가 자동 숨김 끄기를 요청했는지 표시한다(시스템이 끈 것과 가르려고, useSystemDisableNotice)
 */
function createCandidateActions(onSignedOut: (message: string | null) => void, ownDisableRef: RefObject<boolean>): CandidateActions {
  const send = (path: string, body?: unknown) =>
    apiSend<ActionResponse>("POST", path, body).catch((error: unknown) => {
      if (requiresSignIn(error)) onSignedOut(error.message);
      throw error;
    });
  return {
    hide: async (verdict) => (await send(`/api/verdicts/${verdict.id}/hide`)).note ?? null,
    temporaryRestrict: async (group) =>
      (await send(`/api/senders/${encodeURIComponent(group.senderChannelId)}/temporary-restrict`, { chatChannelId: group.chatChannelId, verdictId: group.verdicts[0]?.id ?? null })).note ?? TEMPORARY_RESTRICT_DONE,
    ignore: async (verdict) => (await send(`/api/verdicts/${verdict.id}/ignore`)).note ?? null,
    reportFalsePositive: async (verdict) => (await send(`/api/verdicts/${verdict.id}/false-positive`)).note ?? FALSE_POSITIVE_DONE,
    setAutoHide: async (enabled) => {
      if (!enabled) ownDisableRef.current = true;
      try {
        return (await send("/api/auto-hide", { enabled })).note ?? null;
      } catch (error) {
        // 끄기가 실패했으면 이 기기가 끈 것이 아니다: 표시를 남겨 두면 나중에 시스템이 끈 것을 놓친다.
        if (!enabled) ownDisableRef.current = false;
        throw error;
      }
    },
  };
}

/** useSystemDisableNotice 결과. */
interface SystemDisableNotice {
  /** 안내를 보여 줄지. */
  isVisible: boolean;
  /** 안내를 닫는다(렌더마다 같은 함수). */
  dismiss(): void;
}

/**
 * 자동 숨김이 켜짐→꺼짐으로 바뀌었는데 이 기기가 끈 것이 아니면 안내를 띄운다(F8, 스모크 S2).
 * 왜: 1분 한도 초과·치지직 호출 실패 증가로 서버가 스위치를 끄면 이유는 푸시와 감사 기록에만 남아, 화면을 보던 매니저는 왜 꺼졌는지 모른다.
 * 처음 받은 상태(모름→값)는 바뀐 것으로 보지 않는다. 다시 켜지면 낡은 안내를 지운다.
 * 주의: 상태에는 끈 이유가 없어, 다른 매니저가 손으로 끈 것도 같은 안내가 뜬다.
 * @param enabled 서버 상태의 자동 숨김 값(모르면 null)
 * @param ownDisableRef 이 기기가 끄기를 요청했는지(바뀐 것을 보면 내린다)
 */
function useSystemDisableNotice(enabled: boolean | null, ownDisableRef: RefObject<boolean>): SystemDisableNotice {
  const [isVisible, setVisible] = useState(false);
  const previousRef = useRef<boolean | null>(null);
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = enabled;
    if (enabled === null || previous === null || previous === enabled) return;
    const isOwnDisable = ownDisableRef.current;
    ownDisableRef.current = false;
    setVisible(!enabled && !isOwnDisable);
  }, [enabled, ownDisableRef]);
  const dismiss = useCallback(() => setVisible(false), []);
  return { isVisible, dismiss };
}

/** 로그인 뒤 본 화면: 탭 3개(스펙 6장). 세션이 끝나면 로그인 화면으로 돌아간다. */
export function MainScreen({ me, onSignedOut }: MainScreenProps) {
  const [tab, setTab] = useState<Tab>("candidates");
  // 왜 처음 방문 때 마운트하나: 설정 화면은 마운트되자마자 감사 기록·규칙·통계와 치지직 API를 직접 부르는 /api/chat-settings를 읽고 15초 상태 갱신을 시작한다. 설정을 열지 않는 매니저에게는 필요 없는 호출이다.
  const [hasVisitedSettings, setHasVisitedSettings] = useState(false);
  // 설정 탭을 열 때마다 올려, 통계·오판 검토·감사 기록·규칙·한도를 다시 읽게 한다(F6). 처음 마운트한 뒤로는 숨기기만 해서 그대로 두면 값이 멈춘다.
  const [settingsRefreshKey, setSettingsRefreshKey] = useState(0);
  const refreshSettings = useCallback(() => setSettingsRefreshKey((key) => key + 1), []);
  const changeTab = (next: Tab) => {
    if (next === "settings" && tab !== "settings") {
      setHasVisitedSettings(true);
      refreshSettings();
    }
    setTab(next);
  };
  const { state, reload, reconnect } = useServerState();
  const now = useNow(NOW_REFRESH_MS);
  const ownDisableRef = useRef(false);
  const actions = useMemo(() => createCandidateActions(onSignedOut, ownDisableRef), [onSignedOut]);
  const systemDisableNotice = useSystemDisableNotice(state.status?.autoHideEnabled ?? null, ownDisableRef);
  useEffect(() => {
    if (state.sessionEndedReason !== null) onSignedOut(state.sessionEndedReason);
  }, [state.sessionEndedReason, onSignedOut]);
  // 구역은 여기서 한 번만 계산해 후보 화면과 탭 배지가 같은 값을 쓴다.
  const sections = useMemo(() => buildSections(state.verdicts, now), [state.verdicts, now]);
  return (
    <div className="app">
      {state.loadError && <p className="error" role="alert">{state.loadError}</p>}
      {state.realtimeRejected && <RealtimeRejectedNotice onRetry={reconnect} onSignedOut={onSignedOut} />}
      {/* 후보·채팅은 처음부터, 설정은 처음 열 때 마운트하고 이후에는 숨기기만 한다: 탭을 오가도 진행 중인 요청 결과·처리 중 잠금·채팅 필터가 사라지지 않는다. */}
      <div hidden={tab !== "candidates"}>
        <CandidatesScreen me={me} status={state.status} sections={sections} realtimeConnected={state.realtimeConnected} actions={actions} onReload={reload}
          isSystemDisableNoticeVisible={systemDisableNotice.isVisible} onDismissSystemDisableNotice={systemDisableNotice.dismiss} />
      </div>
      <div hidden={tab !== "chat"}>
        <LiveChatScreen lines={state.chatLines} />
      </div>
      {hasVisitedSettings && (
        <div hidden={tab !== "settings"}>
          <SettingsScreen me={me} onSignedOut={onSignedOut} refreshKey={settingsRefreshKey} onRefresh={refreshSettings} />
        </div>
      )}
      <TabBar active={tab} onChange={changeTab} pendingCount={countActionable(sections)} />
    </div>
  );
}

/** 실시간 거절 안내 속성. */
interface RealtimeRejectedNoticeProps {
  /** '다시 연결'을 누르면 부른다. */
  onRetry(): void;
  /** 세션이 끝났으면 로그인 화면으로 보낸다. */
  onSignedOut(message: string | null): void;
}

/**
 * 실시간 연결이 거듭 거절됐을 때의 안내(R-6). 먼저 /api/me로 세션을 확인해, 세션이 끝났으면 로그인 화면으로 보낸다.
 * 세션이 살아 있으면 출처 문제일 가능성이 크므로 주소를 확인하라고 알리고 '다시 연결'을 둔다.
 */
function RealtimeRejectedNotice({ onRetry, onSignedOut }: RealtimeRejectedNoticeProps) {
  useEffect(() => {
    apiGet<MeDto>("/api/me").catch((error: unknown) => {
      if (requiresSignIn(error)) onSignedOut(error.message);
      else console.warn("실시간 연결이 거절된 뒤 세션 확인에 실패했습니다", error);
    });
  }, [onSignedOut]);
  return (
    <div className="error" role="alert">
      <p>{REALTIME_REJECTED_MESSAGE}</p>
      <button type="button" onClick={onRetry}>다시 연결</button>
    </div>
  );
}
