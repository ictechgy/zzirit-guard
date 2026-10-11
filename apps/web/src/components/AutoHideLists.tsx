import type { VerdictDto } from "@zzirit-guard/shared";
import { formatClockTime } from "../domain/timeFormat";
import { describeReason } from "../domain/verdictReason";
import type { ActionRunner, CandidateActions } from "../screens/CandidatesScreen";

/** 자동 숨김 목록 속성. */
export interface AutoHideListProps {
  /** 보여 줄 자동 숨김 판정(최신순). */
  verdicts: readonly VerdictDto[];
  /** 숨기기·오판 권한(hide_message)이 있는지. */
  canHide: boolean;
  /** 동작 실행기. */
  run: ActionRunner;
  /** 다른 동작이 진행 중인지. 진행 중에는 모든 버튼을 잠가 같은 요청이 두 번 가지 않게 한다. */
  isBusy: boolean;
  /** 후보 화면 동작. */
  actions: CandidateActions;
}

/** 판정 한 건의 시각·보낸 사람·원문·이유. 원문은 텍스트로만 넣는다. */
function VerdictSummary({ verdict }: { verdict: VerdictDto }) {
  return (
    <>
      <span className="time">{formatClockTime(verdict.createdAt)}</span>
      <span className="content">{verdict.senderNickname}: {verdict.content}</span>
      <span className="reason">{describeReason(verdict.reason)}</span>
    </>
  );
}

/**
 * 자동 숨김 판정인데 아직 숨겨지지 않은 것(실행 대기·스위치가 꺼져 취소·재시도 실패, R-4).
 * 펼쳐 두고 숨기기 버튼을 준다: 접어 두면 숨겨지지 않은 메시지를 매니저가 놓친다.
 */
export function AutoHidePendingList({ verdicts, canHide, run, isBusy, actions }: AutoHideListProps) {
  if (verdicts.length === 0) return null;
  return (
    <section className="section section-auto-pending">
      <h2>숨김 대기·실패({verdicts.length}건)</h2>
      <p className="hint">자동 숨김이 아직 처리 중이거나, 스위치가 꺼져 취소됐거나, 실패한 메시지입니다. 필요하면 직접 숨기세요.</p>
      <ul className="messages">
        {verdicts.map((verdict) => (
          <li key={verdict.id} className="message">
            <VerdictSummary verdict={verdict} />
            <span className="buttons">
              <button type="button" aria-label={`${verdict.senderNickname}의 메시지 숨기기`} disabled={!canHide || isBusy} onClick={() => run(() => actions.hide(verdict))}>숨기기</button>
              <button type="button" aria-label={`${verdict.senderNickname}의 메시지 오판 신고`} disabled={!canHide || isBusy} onClick={() => run(() => actions.reportFalsePositive(verdict))}>오판</button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 최근 10분 동안 실제로 숨겨진 자동 숨김. 잘못 숨겼으면 오판으로 신고해 규칙을 검토하게 한다(스펙 5.5). */
export function AutoHiddenList({ verdicts, canHide, run, isBusy, actions }: AutoHideListProps) {
  if (verdicts.length === 0) return null;
  return (
    <details className="section section-auto">
      <summary>자동 숨김됨(최근 10분, {verdicts.length}건)</summary>
      <ul className="messages">
        {verdicts.map((verdict) => (
          <li key={verdict.id} className="message">
            <VerdictSummary verdict={verdict} />
            <button type="button" aria-label={`${verdict.senderNickname}의 메시지 오판 신고`} disabled={!canHide || isBusy} onClick={() => run(() => actions.reportFalsePositive(verdict))}>오판</button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * 자동 숨김 판정인데 보낸 사람이 임시 제한된 것. 메시지가 숨겨졌는지는 알 수 없다(서버가 hidden을 restricted로 덮어쓴다).
 * 숨기기 버튼은 없다: 서버가 restricted 판정의 숨기기를 409로 거절한다. 오판 신고만 둔다.
 */
export function RestrictedAutoHideList({ verdicts, canHide, run, isBusy, actions }: AutoHideListProps) {
  if (verdicts.length === 0) return null;
  return (
    <details className="section section-auto-restricted">
      <summary>사용자 제한됨 (메시지는 아직 보일 수 있음) {verdicts.length}건</summary>
      <ul className="messages">
        {verdicts.map((verdict) => (
          <li key={verdict.id} className="message">
            <VerdictSummary verdict={verdict} />
            <button type="button" aria-label={`${verdict.senderNickname}의 메시지 오판 신고`} disabled={!canHide || isBusy} onClick={() => run(() => actions.reportFalsePositive(verdict))}>오판</button>
          </li>
        ))}
      </ul>
    </details>
  );
}
