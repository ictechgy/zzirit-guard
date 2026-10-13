import type { VerdictDto } from "@zzirit-guard/shared";
import { ACTIONABLE_PAGE_SIZE, MAX_LISTED_ROWS } from "../domain/candidates";
import { formatClockTime } from "../domain/timeFormat";
import { describeReason } from "../domain/verdictReason";
import type { ActionRunner, CandidateActions } from "../screens/CandidatesScreen";
import { verdictLockKey } from "../state/useActionLocks";
import { usePageLimit } from "../state/usePageLimit";

/** 자동 숨김 목록 속성. */
export interface AutoHideListProps {
  /** 보여 줄 자동 숨김 판정(최신순). */
  verdicts: readonly VerdictDto[];
  /** 숨기기·오판 권한(hide_message)이 있는지. */
  canHide: boolean;
  /** 동작 실행기. */
  run: ActionRunner;
  /** 진행 중인 동작의 열쇠들. 그 판정의 동작이 진행 중이면 그 줄의 버튼만 잠가 같은 요청이 두 번 가지 않게 한다. */
  lockedKeys: ReadonlySet<string>;
  /** 고정한 화면에서 이미 처리된 판정 번호. 그 줄은 "처리됨"으로 흐리게 남기고 버튼을 잠근다(useStableSections). */
  handledIds: ReadonlySet<number>;
  /** 후보 화면 동작. */
  actions: CandidateActions;
}

/** 판정 한 건의 시각·보낸 사람·원문·이유. 원문은 텍스트로만 넣는다. 처리된 줄이면 "처리됨"을 단다. */
function VerdictSummary({ verdict, isHandled }: { verdict: VerdictDto; isHandled: boolean }) {
  return (
    <>
      <span className="time">{formatClockTime(verdict.createdAt)}</span>
      <span className="content">{verdict.senderNickname}: {verdict.content}</span>
      <span className="reason">{describeReason(verdict.reason)}{isHandled && <span className="handled-label">처리됨</span>}</span>
    </>
  );
}

/** 버튼 종류: 숨기기·오판 신고. */
type RowButtonKind = "hide" | "falsePositive";

/** 버튼 이름표와 접근성 이름 끝말. */
const ROW_BUTTON_LABELS: Record<RowButtonKind, { text: string; accessibleSuffix: string }> = {
  hide: { text: "숨기기", accessibleSuffix: "메시지 숨기기" },
  falsePositive: { text: "오판", accessibleSuffix: "메시지 오판 신고" },
};

/** 목록 한 줄 속성. */
interface VerdictRowProps {
  /** 목록 속성(권한·잠금·처리됨·동작). */
  list: AutoHideListProps;
  /** 이 줄의 판정. */
  verdict: VerdictDto;
  /** 둘 버튼(순서대로). */
  buttons: readonly RowButtonKind[];
}

/**
 * 목록 한 줄: 요약과 버튼. 권한이 없거나, 그 판정의 동작이 진행 중이거나, 고정 화면에서 이미 처리된 줄이면 버튼을 잠근다.
 * 처리된 줄은 흐리게 남긴다(지우면 아래 줄이 손가락 밑으로 밀려 올라온다, F4).
 */
function VerdictRow({ list, verdict, buttons }: VerdictRowProps) {
  const lockKey = verdictLockKey(verdict.id);
  const isHandled = list.handledIds.has(verdict.id);
  const isDisabled = !list.canHide || list.lockedKeys.has(lockKey) || isHandled;
  const perform = (kind: RowButtonKind) => (kind === "hide" ? list.actions.hide(verdict) : list.actions.reportFalsePositive(verdict));
  return (
    <li className={isHandled ? "message message-handled" : "message"}>
      <VerdictSummary verdict={verdict} isHandled={isHandled} />
      <span className="buttons">
        {buttons.map((kind) => (
          <button key={kind} type="button" aria-label={`${verdict.senderNickname}의 ${formatClockTime(verdict.createdAt)} ${ROW_BUTTON_LABELS[kind].accessibleSuffix}`}
            disabled={isDisabled} onClick={() => list.run(lockKey, () => perform(kind), verdict.id)}>{ROW_BUTTON_LABELS[kind].text}</button>
        ))}
      </span>
    </li>
  );
}

/**
 * 자동 숨김 판정인데 아직 숨겨지지 않은 것(실행 대기·스위치가 꺼져 취소·재시도 실패, R-4).
 * 펼쳐 두고 숨기기 버튼을 준다: 접어 두면 숨겨지지 않은 메시지를 매니저가 놓친다.
 * 처리해야 하는 목록이라 잘라 버리지 않고, ACTIONABLE_PAGE_SIZE씩 '더 보기'로 나눠 그린다(K21: 스위치가 꺼져 취소된 판정이 수천 건 쌓일 수 있다).
 */
export function AutoHidePendingList(props: AutoHideListProps) {
  const page = usePageLimit(ACTIONABLE_PAGE_SIZE);
  if (props.verdicts.length === 0) return null;
  const remaining = props.verdicts.length - page.limit;
  return (
    <section className="section section-auto-pending">
      <h2>숨김 대기·실패({props.verdicts.length}건)</h2>
      <p className="hint">자동 숨김이 아직 처리 중이거나, 스위치가 꺼져 취소됐거나, 실패한 메시지입니다. 필요하면 직접 숨기세요.</p>
      <ul className="messages">
        {props.verdicts.slice(0, page.limit).map((verdict) => <VerdictRow key={verdict.id} list={props} verdict={verdict} buttons={["hide", "falsePositive"]} />)}
      </ul>
      {remaining > 0 && <button type="button" className="more" onClick={page.showMore}>더 보기 ({remaining}건)</button>}
    </section>
  );
}

/**
 * 목록이 MAX_LISTED_ROWS를 넘었을 때 그리지 않은 건수를 알린다. 넘지 않으면 그리지 않는다.
 * @param total 전체 건수
 */
function OmittedCount({ total }: { total: number }) {
  if (total <= MAX_LISTED_ROWS) return null;
  return <p className="hint">외 {total - MAX_LISTED_ROWS}건</p>;
}

/** 최근 10분 동안 실제로 숨겨진 자동 숨김(최근 MAX_LISTED_ROWS건만 그린다). 잘못 숨겼으면 오판으로 신고해 규칙을 검토하게 한다(스펙 5.5). */
export function AutoHiddenList(props: AutoHideListProps) {
  if (props.verdicts.length === 0) return null;
  return (
    <details className="section section-auto">
      <summary>자동 숨김됨(최근 10분, {props.verdicts.length}건)</summary>
      <ul className="messages">
        {props.verdicts.slice(0, MAX_LISTED_ROWS).map((verdict) => <VerdictRow key={verdict.id} list={props} verdict={verdict} buttons={["falsePositive"]} />)}
      </ul>
      <OmittedCount total={props.verdicts.length} />
    </details>
  );
}

/**
 * 자동 숨김 판정인데 보낸 사람이 임시 제한된 것(최근 MAX_LISTED_ROWS건만 그린다). 메시지가 숨겨졌는지는 알 수 없다(서버가 hidden을 restricted로 덮어쓴다).
 * 숨기기 버튼은 없다: 서버가 restricted 판정의 숨기기를 409로 거절한다. 오판 신고만 둔다.
 */
export function RestrictedAutoHideList(props: AutoHideListProps) {
  if (props.verdicts.length === 0) return null;
  return (
    <details className="section section-auto-restricted">
      <summary>사용자 제한됨 (메시지는 아직 보일 수 있음) {props.verdicts.length}건</summary>
      <ul className="messages">
        {props.verdicts.slice(0, MAX_LISTED_ROWS).map((verdict) => <VerdictRow key={verdict.id} list={props} verdict={verdict} buttons={["falsePositive"]} />)}
      </ul>
      <OmittedCount total={props.verdicts.length} />
    </details>
  );
}
