import type { AutoHideOffReason, MeDto, ServerStatus } from "@zzirit-guard/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
/** 숨기기 성공 기본 안내. 서버가 안내(note, 예: "이미 사라진 메시지입니다")를 주지 않았을 때 쓴다(F9). */
const HIDE_DONE = "숨겼습니다.";
/** 무시 성공 기본 안내. 무시한 판정은 후보 화면에서 빠진다(F9). */
const IGNORE_DONE = "무시했습니다.";
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
  /** 자동 숨김 스위치의 지금 값(스위치 응답에만 있다). */
  enabled?: boolean;
}

/** 조치 요청 함수. 로그인이 필요한 오류면 로그인 화면으로 보내고 오류를 다시 던진다. */
type SendAction = (path: string, body?: unknown) => Promise<ActionResponse>;

/** 스위치 응답을 화면의 서버 상태와 맞추는 도구. */
interface AutoHideSync {
  /** 응답의 스위치 값을 바로 상태에 넣는다(useServerState.applyAutoHide). */
  apply(enabled: boolean): void;
  /** 서버 상태를 다시 읽는다(useServerState.reload). */
  reload(): void;
  /**
   * 마지막으로 보낸 스위치 요청의 순번. MainScreen이 ref로 들고 있다.
   * 왜 ref인가: 동작 묶음(createCandidateActions)이 다시 만들어져도 순번이 이어져야, 앞 묶음이 보낸 요청의 늦은 응답을 가려낼 수 있다.
   */
  sequence: { latest: number };
}

/**
 * 자동 숨김 스위치 요청 함수를 만든다(K17). 성공하면 응답의 enabled를 바로 상태에 넣고, 실패하면 서버 상태를 다시 읽는다.
 * 왜: 실시간 연결이 끊긴 동안에는 status 방송이 오지 않는다. 응답 값을 버리면 스위치가 옛 값(꺼짐)에 머물러,
 * 다음 누름이 끄기 대신 켜기를 다시 보내 이 기기로는 자동 숨김을 끌 수 없다.
 * 마지막으로 보낸 요청의 응답만 넣는다: 늦게 온 앞 요청의 응답이 뒤에 보낸 요청의 결과를 덮지 않게 한다.
 * @param send 요청 함수
 * @param sync 상태 반영·다시 읽기
 */
function createAutoHideSender(send: SendAction, sync: AutoHideSync): (enabled: boolean) => Promise<string | null> {
  return async (enabled) => {
    const request = ++sync.sequence.latest;
    const response = await send("/api/auto-hide", { enabled }).catch((error: unknown) => {
      // 로그인 화면으로 가는 중이면 다시 읽지 않는다(어차피 버려지는 요청이다).
      if (!requiresSignIn(error)) sync.reload();
      throw error;
    });
    if (request === sync.sequence.latest) applyToggleResponse(response, sync);
    return response.note ?? null;
  };
}

/**
 * 스위치 응답 값을 넣는다. 응답에 값이 없으면(모르는 응답 모양) 추측하지 않고 서버 상태를 다시 읽는다.
 * @param response 스위치 응답
 * @param sync 상태 반영·다시 읽기
 */
function applyToggleResponse(response: ActionResponse, sync: AutoHideSync): void {
  if (typeof response.enabled === "boolean") sync.apply(response.enabled);
  else sync.reload();
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
 * @param autoHideSync 스위치 응답을 서버 상태에 넣거나 다시 읽는다(K17)
 */
function createCandidateActions(onSignedOut: (message: string | null) => void, autoHideSync: AutoHideSync): CandidateActions {
  const send: SendAction = (path, body) =>
    apiSend<ActionResponse>("POST", path, body).catch((error: unknown) => {
      if (requiresSignIn(error)) onSignedOut(error.message);
      throw error;
    });
  return {
    hide: async (verdict) => (await send(`/api/verdicts/${verdict.id}/hide`)).note ?? HIDE_DONE,
    // 판정 번호만 보낸다. 채팅 채널은 서버가 저장된 판정에서 읽는다(S13). 묶음에는 판정이 늘 하나 이상 있다(groupBySender).
    temporaryRestrict: async (group) =>
      (await send(`/api/senders/${encodeURIComponent(group.senderChannelId)}/temporary-restrict`, { verdictId: group.verdicts[0]?.id })).note ?? TEMPORARY_RESTRICT_DONE,
    ignore: async (verdict) => (await send(`/api/verdicts/${verdict.id}/ignore`)).note ?? IGNORE_DONE,
    reportFalsePositive: async (verdict) => (await send(`/api/verdicts/${verdict.id}/false-positive`)).note ?? FALSE_POSITIVE_DONE,
    setAutoHide: createAutoHideSender(send, autoHideSync),
  };
}

/** 시스템이 끈 이유별 이름. manual(매니저가 직접)은 안내하지 않으므로 없다. */
const SYSTEM_OFF_REASON_LABELS: Readonly<Record<Exclude<AutoHideOffReason, "manual">, string>> = { breaker: "1분 한도 초과", failure_rate: "치지직 호출 실패 증가" };
/** 감사 기록을 볼 수 있는 매니저(view_audit)에게만 붙이는 안내. 볼 수 없는 매니저에게 가리키면 막다른 길이다. */
const AUDIT_HINT = "기록·설정 → 감사 기록에서 확인하세요.";

/**
 * 시스템 꺼짐 안내 문구를 만든다.
 * @param reason 서버가 알린 이유. 재시작 뒤처럼 모르면 null이라 이유 없이 알린다
 * @param canViewAudit 감사 기록 안내를 붙일지
 */
function describeSystemDisable(reason: Exclude<AutoHideOffReason, "manual"> | null, canViewAudit: boolean): string {
  const headline = reason === null ? "자동 숨김이 꺼졌습니다." : `자동 숨김이 꺼졌습니다(${SYSTEM_OFF_REASON_LABELS[reason]}).`;
  return canViewAudit ? `${headline} ${AUDIT_HINT}` : headline;
}

/** useSystemDisableNotice 결과. */
interface SystemDisableNotice {
  /** 보여 줄 안내 문구. 없으면 null. */
  message: string | null;
  /** 안내를 닫는다(렌더마다 같은 함수). */
  dismiss(): void;
}

/**
 * 자동 숨김이 켜짐→꺼짐으로 바뀌었고 그 이유가 manual이 아니면(1분 한도 초과·치지직 호출 실패 증가) 이유를 밝힌 안내를 띄운다(F8·B19-3).
 * 왜: 서버가 스위치를 끄면 이유는 푸시와 감사 기록에만 남아, 화면을 보던 매니저는 왜 꺼졌는지 모른다.
 * 이유를 서버 상태(autoHideOffReason)로 받으므로, 이 기기든 다른 매니저든 손으로 끈 것에는 안내하지 않는다.
 * 처음 받은 상태(모름→값)는 바뀐 것으로 보지 않는다. 다시 켜지면 낡은 안내를 지운다.
 * @param status 서버 상태(모르면 null)
 * @param canViewAudit 감사 기록 안내를 붙일지(view_audit)
 */
function useSystemDisableNotice(status: ServerStatus | null, canViewAudit: boolean): SystemDisableNotice {
  const [message, setMessage] = useState<string | null>(null);
  const previousRef = useRef<boolean | null>(null);
  const enabled = status?.autoHideEnabled ?? null;
  const reason = status?.autoHideOffReason ?? null;
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = enabled;
    if (enabled === null || previous === null || previous === enabled) return;
    setMessage(enabled || reason === "manual" ? null : describeSystemDisable(reason, canViewAudit));
  }, [enabled, reason, canViewAudit]);
  const dismiss = useCallback(() => setMessage(null), []);
  return { message, dismiss };
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
  const { state, reload, reconnect, applyAutoHide } = useServerState();
  const now = useNow(NOW_REFRESH_MS);
  // 스위치 요청 순번(K17). 동작 묶음이 다시 만들어져도 이어져야 늦게 온 앞 요청의 응답을 가려내므로 ref에 둔다.
  const autoHideSequence = useRef({ latest: 0 });
  const actions = useMemo(
    () => createCandidateActions(onSignedOut, { apply: applyAutoHide, reload, sequence: autoHideSequence.current }),
    [onSignedOut, applyAutoHide, reload],
  );
  const systemDisableNotice = useSystemDisableNotice(state.status, me.permissions.includes("view_audit"));
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
          systemDisableNotice={systemDisableNotice.message} onDismissSystemDisableNotice={systemDisableNotice.dismiss} />
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
