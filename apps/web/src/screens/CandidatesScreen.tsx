import type { MeDto, ServerStatus, VerdictDto, VerdictStatus } from "@zzirit-guard/shared";
import { memo, useCallback, useRef, useState } from "react";
import { ApiError, describeApiError } from "../api/client";
import { ActionToast, type ActionFeedback } from "../components/ActionToast";
import { AutoHiddenList, AutoHidePendingList, RestrictedAutoHideList } from "../components/AutoHideLists";
import { AutoHideToggle } from "../components/AutoHideToggle";
import { CandidateGroupCard, type GroupKind } from "../components/CandidateGroupCard";
import { StatusBanner } from "../components/StatusBanner";
import { countActionable, findVerdictStatus, MAX_LISTED_ROWS, type CandidateSections, type SenderGroup } from "../domain/candidates";
import { autoHideLockKey, useActionLocks, type ActionLocks } from "../state/useActionLocks";
import { useStableSections } from "../state/useStableSections";
import { useTimeoutHolds, type TimeoutHolds } from "../state/useTimeoutHolds";

/** 후보 화면이 부르는 동작. 성공하면 화면에 보여 줄 안내(없으면 null)를 돌려준다. MainScreen이 API로 채우고, 테스트는 가짜를 넘긴다. */
export interface CandidateActions {
  /** 메시지 하나를 숨긴다. */
  hide(verdict: VerdictDto): Promise<string | null>;
  /** 사람 단위 임시 제한. */
  temporaryRestrict(group: SenderGroup): Promise<string | null>;
  /** 후보를 무시로 표시한다(대기 중인 것만). */
  ignore(verdict: VerdictDto): Promise<string | null>;
  /** 오판으로 신고한다(오판 검토 목록에 오른다). */
  reportFalsePositive(verdict: VerdictDto): Promise<string | null>;
  /** 자동 숨김 스위치를 켜거나 끈다. */
  setAutoHide(enabled: boolean): Promise<string | null>;
}

/**
 * 동작 하나를 실행하고 결과(안내 또는 오류)를 화면에 남기는 함수.
 * lockKey가 같은 동작이 진행 중이면 실행하지 않는다(두 번 보내기 방지). 열쇠가 다른 동작은 서로 막지 않는다(F2).
 * watchedVerdictId를 주면 시간이 초과됐을 때 그 판정의 상태가 바뀔 때까지(최대 60초) 잠금을 붙잡는다(B19-7).
 * shouldHoldAfterDone이 참이면 성공하거나 시간이 초과된 뒤 상태 변화와 관계없이 60초 동안 잠금을 붙잡는다(사람 단위 임시 제한, W2).
 * 자동 숨김 스위치에는 둘 다 주지 않는다: 끄기(안전장치)는 늦더라도 바로 다시 누를 수 있어야 한다.
 */
export type ActionRunner = (lockKey: string, task: () => Promise<string | null>, watchedVerdictId?: number, shouldHoldAfterDone?: boolean) => void;

/** 후보 화면 속성. */
export interface CandidatesScreenProps {
  /** 로그인한 매니저(권한으로 버튼을 켠다). */
  me: MeDto;
  /** 서버 상태. 아직 모르면 null. */
  status: ServerStatus | null;
  /** MainScreen이 한 번 계산한 구역(탭 배지와 같은 값을 쓰려고 위에서 받는다). */
  sections: CandidateSections;
  /** 실시간 연결이 살아 있는지. */
  realtimeConnected: boolean;
  /** 후보 화면 동작. */
  actions: CandidateActions;
  /** 서버에서 상태·후보를 다시 읽는다(iOS 홈 화면 앱에는 새로고침이 없다). */
  onReload(): void;
  /** 시스템(1분 한도·실패율)이 자동 숨김을 껐다는 안내 문구(F8·B19-3). 없으면 null. MainScreen이 상태 변화와 이유를 보고 정한다. */
  systemDisableNotice: string | null;
  /** 그 안내를 닫는다. memo가 깨지지 않게 렌더마다 같은 함수여야 한다. */
  onDismissSystemDisableNotice(): void;
}


/**
 * 사람 단위 구역의 제목·종류·그릴 최대 묶음 수(null이면 모두). 순서가 화면 순서다(스펙 5.1: 섀도는 후보 목록 위).
 * 섀도만 줄이는 이유: 처리하지 않아도 되는 정보라 떼도배 때 수백 명이 쌓여도 다 그릴 필요가 없다(F4). 도움 필요·후보는 매니저가 처리해야 해서 모두 그린다.
 */
const GROUP_SECTIONS: ReadonlyArray<{ key: "care" | "shadow" | "candidates"; kind: GroupKind; title: string; limit: number | null }> = [
  { key: "care", kind: "care", title: "도움 필요(자해·자살 신호)", limit: null },
  { key: "shadow", kind: "shadow", title: "켜져 있었으면 숨겼을 메시지", limit: MAX_LISTED_ROWS },
  { key: "candidates", kind: "candidate", title: "후보", limit: null },
];

/**
 * 이미 처리된 판정(409 already_handled)일 때의 안내(B19-6). 실패가 아니라 화면이 낡았던 것이라 빨간 오류로 보이지 않는다.
 * 서버 문구 대신 이 문구를 쓰는 이유: 목록은 이미 다시 읽으므로, 매니저가 할 일이 없다고 알리면 된다.
 */
const ALREADY_HANDLED_NOTICE = "이미 처리된 항목입니다. 목록을 다시 불러왔습니다.";

/** 시간이 초과돼 잠금을 붙잡을 때 오류 문구 뒤에 붙이는 안내(B19-7). 다시 누르면 같은 조치가 두 번 갈 수 있다. */
const TIMEOUT_HOLD_SUFFIX = "다시 누르지 마세요.";

/** 동작 실행기가 쓰는 화면 쪽 도구. */
interface RunnerContext {
  /** 결과를 화면에 남긴다. */
  setFeedback(feedback: ActionFeedback): void;
  /** 목록을 다시 읽는다. */
  onReload(): void;
  /** 열쇠별 잠금(같은 열쇠의 동작만 막는다). */
  locks: ActionLocks;
  /** 시간 초과된 조치의 잠금 붙잡기. */
  holds: TimeoutHolds;
  /** 판정의 지금 상태(최신 구역 기준, 없으면 null). */
  statusOf(verdictId: number): VerdictStatus | null;
}

/**
 * 동작 실행기를 만든다. 성공하면 안내를, 실패하면 서버 문구를 남긴다.
 * 이미 처리된 판정(409 already_handled)이면 화면이 낡은 것이므로 목록을 다시 읽고 안내(info)로 알린다(R-13·B19-6).
 * 시간이 초과되면(지켜볼 판정이 있을 때) 잠금을 바로 풀지 않고 붙잡는다(B19-7).
 * @param context 결과 표시·다시 읽기·잠금·판정 상태 조회
 */
function createRunner(context: RunnerContext): ActionRunner {
  return (lockKey, task, watchedVerdictId, shouldHoldAfterDone = false) => {
    if (!context.locks.tryLock(lockKey)) return;
    const statusAtStart = watchedVerdictId === undefined ? null : context.statusOf(watchedVerdictId);
    context.setFeedback(null);
    let isHeld = false;
    startTask(task).then(
      (message) => {
        if (shouldHoldAfterDone) {
          context.holds.holdFor(lockKey);
          isHeld = true;
        }
        context.setFeedback(message ? { kind: "ok", message } : null);
      },
      (error: unknown) => {
        isHeld = holdAfterTimeout(context, error, { lockKey, watchedVerdictId, statusAtStart, shouldHoldAfterDone });
        reportFailure(context, error, isHeld);
      },
    ).finally(() => {
      if (!isHeld) context.locks.unlock(lockKey);
    });
  };
}

/** 시간 초과 뒤 붙잡기에 필요한 실행 정보. 필드 뜻은 ActionRunner와 같다. */
interface TimeoutHoldRequest {
  lockKey: string;
  watchedVerdictId: number | undefined;
  statusAtStart: VerdictStatus | null;
  shouldHoldAfterDone: boolean;
}

/**
 * 처리 결과를 알 수 없는 오류인지 본다: 요청 시간 초과(timeout)이거나, 코드가 result_unknown인 것.
 * result_unknown은 서버가 치지직 처리 결과를 알 수 없다고 알린 것(502·409, N4)과, 숨기기·임시 제한의 네트워크 오류를 MainScreen이 바꾼 것(K18)이다.
 * 모두 조치가 이미 처리됐을 수 있어 곧바로 다시 보내면 두 번 간다.
 * @param error 동작이 던진 오류
 */
function isOutcomeUnknown(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "timeout" || error.code === "result_unknown");
}

/**
 * 결과를 알 수 없으면(시간 초과·result_unknown) 잠금을 붙잡는다(B19-7, N4). 사람 단위 동작은 60초 고정으로,
 * 판정을 지켜보는 동작은 그 판정 상태가 바뀔 때까지(최대 60초) 붙잡는다.
 * @param context 붙잡기 도구(holds)
 * @param error 동작이 던진 오류
 * @param request 열쇠와 붙잡기 방식
 * @returns 붙잡았으면 true(호출부가 잠금을 풀지 않는다)
 */
function holdAfterTimeout(context: RunnerContext, error: unknown, request: TimeoutHoldRequest): boolean {
  if (!isOutcomeUnknown(error)) return false;
  if (request.shouldHoldAfterDone) context.holds.holdFor(request.lockKey);
  else if (request.watchedVerdictId !== undefined) context.holds.hold(request.lockKey, request.watchedVerdictId, request.statusAtStart);
  else return false;
  return true;
}

/**
 * 실패를 화면에 남긴다. 이미 처리된 판정이면 목록을 다시 읽고 안내로, 잠금을 붙잡았으면 다시 누르지 말라고 덧붙인다.
 * 자동 숨김이 진행 중(409 in_progress)이면 서버 문구를 그대로 안내로 보여 주고 다시 읽지 않는다(N4).
 * 왜: 자동 숨김이 끝나면 실시간으로 반영되고, 지금 다시 읽어도 대기 중으로 보여 "이미 처리됨"은 틀린 안내다.
 * @param context 결과 표시·다시 읽기
 * @param error 동작이 던진 오류
 * @param isHeld 시간 초과로 잠금을 붙잡았는지
 */
function reportFailure(context: RunnerContext, error: unknown, isHeld: boolean): void {
  if (error instanceof ApiError && error.code === "in_progress") {
    context.setFeedback({ kind: "info", message: error.message });
    return;
  }
  if (error instanceof ApiError && error.code === "already_handled") {
    context.setFeedback({ kind: "info", message: ALREADY_HANDLED_NOTICE });
    context.onReload();
    return;
  }
  const message = describeApiError(error);
  context.setFeedback({ kind: "error", message: isHeld ? `${message} ${TIMEOUT_HOLD_SUFFIX}` : message });
}

/**
 * 동작을 바로 시작하되, 동기 예외도 거절된 Promise로 바꿔 돌려준다.
 * 왜 필요한가: task가 동기로 던지면 .finally에 닿지 못해 진행 중 잠금이 풀리지 않고 오류도 화면에 남지 않는다.
 */
function startTask(task: () => Promise<string | null>): Promise<string | null> {
  try {
    return task();
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * 후보 화면(스펙 6장 ①): 상태 배너·스위치·구역별 사람 단위 묶음·자동 숨김 목록.
 * 왜 memo인가: MainScreen은 채팅 묶음(chat_batch)이 올 때마다(초당 최대 4번) 다시 그려지는데, 후보 화면의 속성은 그때 바뀌지 않는다.
 * 감싸지 않으면 판정 수천 건의 목록을 초당 4번 다시 그려 휴대폰이 멈춘다(F4). 속성은 MainScreen이 useMemo·useCallback으로 고정한다.
 * 목록을 만지는 동안에는 구역을 고정해 줄이 손가락 밑에서 움직이지 않게 한다(useStableSections, 스모크 S1).
 */
export const CandidatesScreen = memo(function CandidatesScreen({ me, status, sections, realtimeConnected, actions, onReload, systemDisableNotice, onDismissSystemDisableNotice }: CandidatesScreenProps) {
  const [feedback, setFeedback] = useState<ActionFeedback>(null);
  // 알림 닫기. ActionToast가 4초 타이머의 의존성으로 쓰므로 렌더마다 같은 함수여야 한다(아니면 타이머가 다시 시작된다).
  const dismissFeedback = useCallback(() => setFeedback(null), []);
  const locks = useActionLocks();
  const holds = useTimeoutHolds(sections, locks.unlock);
  const run = createRunner({ setFeedback, onReload, locks, holds, statusOf: (verdictId) => findVerdictStatus(sections, verdictId) });
  const { lockedKeys } = locks;
  const canHide = me.permissions.includes("hide_message");
  const autoHideEnabled = status?.autoHideEnabled ?? null;
  // 목록 영역: 이 안을 누르는 동안 구역을 고정한다(스위치·다시 불러오기는 바깥이라 고정하지 않는다).
  const listRef = useRef<HTMLDivElement>(null);
  const stable = useStableSections(sections, listRef);
  const shown = stable.sections;
  // 자동 숨김 목록 세 개가 함께 쓰는 속성.
  const rowProps = { canHide, run, lockedKeys, handledIds: stable.handledIds, actions };
  return (
    <section className="screen">
      <StatusBanner status={status} realtimeConnected={realtimeConnected} canReconnectChannel={me.permissions.includes("connect_channel")} />
      <div className="toolbar">
        <AutoHideToggle enabled={autoHideEnabled} canEnable={me.permissions.includes("enable_auto_hide")}
          canDisable={me.permissions.includes("disable_auto_hide")} isBusy={autoHideEnabled !== null && lockedKeys.has(autoHideLockKey(!autoHideEnabled))}
          onChange={(enabled) => run(autoHideLockKey(enabled), () => actions.setAutoHide(enabled))} />
        <button type="button" onClick={onReload}>다시 불러오기</button>
      </div>
      <div ref={listRef} className="candidate-list">
        {GROUP_SECTIONS.map(({ key, kind, title, limit }) => (
          <GroupSection key={key} title={title} groups={shown[key]} limit={limit} kind={kind} me={me} run={run} lockedKeys={lockedKeys} handledIds={stable.handledIds} actions={actions} />
        ))}
        {countActionable(shown) === 0 && <p className="empty">지금 확인할 후보가 없습니다.</p>}
        <AutoHidePendingList verdicts={shown.autoHidePending} {...rowProps} />
        <AutoHiddenList verdicts={shown.autoHidden} {...rowProps} />
        <RestrictedAutoHideList verdicts={shown.restrictedAfterAutoHide} {...rowProps} />
      </div>
      {/*
        떠 있는 층(position: fixed): 나타나고 사라져도 문서 흐름에 자리를 차지하지 않아 목록 줄이 손가락 밑에서 밀리지 않는다(B19-1·4).
        '새 항목' 버튼은 위(배너 아래 높이), 시스템 꺼짐 안내와 작업 결과는 탭 막대 위에 띄운다.
        왜 안내를 아래에 두나: 위에 오래 떠 있으면 상태 배너와 자동 숨김 스위치를 가린다. 아래는 이미 작업 결과가 잠깐 뜨는 자리다.
      */}
      <div className="overlay-top">
        {stable.newCount > 0 && <button type="button" className="new-items" onClick={stable.showLatest}>새 항목 {stable.newCount}개 — 보기</button>}
      </div>
      <div className="overlay-bottom">
        {systemDisableNotice && (
          <div className="system-notice error" role="alert">
            <p>{systemDisableNotice}</p>
            <button type="button" onClick={onDismissSystemDisableNotice}>닫기</button>
          </div>
        )}
        <ActionToast feedback={feedback} onDismiss={dismissFeedback} />
      </div>
    </section>
  );
});

/** 사람 단위 구역 하나의 속성. */
interface GroupSectionProps {
  /** 구역 제목. */
  title: string;
  /** 이 구역의 사람 묶음. */
  groups: readonly SenderGroup[];
  /** 그릴 최대 묶음 수. null이면 모두 그린다. 넘친 묶음은 "외 N명"으로 알린다. */
  limit: number | null;
  /** 카드 종류. */
  kind: GroupKind;
  /** 로그인한 매니저. */
  me: MeDto;
  /** 동작 실행기. */
  run: ActionRunner;
  /** 진행 중인 동작의 열쇠들(그 판정·사람의 버튼만 잠근다). */
  lockedKeys: ReadonlySet<string>;
  /** 고정한 화면에서 이미 처리된 판정 번호(흐리게 남기고 버튼을 잠근다, useStableSections). */
  handledIds: ReadonlySet<number>;
  /** 후보 화면 동작. */
  actions: CandidateActions;
}

/** 구역 하나. 비어 있으면 그리지 않는다. */
function GroupSection({ title, groups, limit, kind, me, run, lockedKeys, handledIds, actions }: GroupSectionProps) {
  if (groups.length === 0) return null;
  const shown = limit === null ? groups : groups.slice(0, limit);
  return (
    <section className={`section section-${kind}`}>
      <h2>{title}</h2>
      {shown.map((group) => (
        <CandidateGroupCard key={group.senderChannelId} group={group} kind={kind} permissions={me.permissions} run={run} lockedKeys={lockedKeys} handledIds={handledIds} actions={actions} />
      ))}
      {groups.length > shown.length && <p className="hint">외 {groups.length - shown.length}명</p>}
    </section>
  );
}
