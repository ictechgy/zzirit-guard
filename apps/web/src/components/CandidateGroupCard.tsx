import type { Permission, VerdictDto } from "@zzirit-guard/shared";
import type { SenderGroup } from "../domain/candidates";
import { formatClockTime } from "../domain/timeFormat";
import { describeReason } from "../domain/verdictReason";
import type { ActionRunner, CandidateActions } from "../screens/CandidatesScreen";
import { senderLockKey, verdictLockKey } from "../state/useActionLocks";

/** 묶음 카드의 종류. 버튼 구성을 정한다. */
export type GroupKind = "care" | "shadow" | "candidate";

/** 묶음 카드 속성. */
export interface CandidateGroupCardProps {
  /** 한 사람의 판정 묶음. */
  group: SenderGroup;
  /** 카드 종류. 섀도는 '무시' 대신 '오판'을 둔다(켜져 있었으면 숨겼을 판정에 동의하지 않는다는 뜻이라). */
  kind: GroupKind;
  /** 로그인한 매니저의 권한. 없는 권한의 버튼은 보이되 비활성으로 둔다. */
  permissions: readonly Permission[];
  /** 동작 실행기. 결과 안내와 오류 표시를 맡는다. */
  run: ActionRunner;
  /** 진행 중인 동작의 열쇠들. 이 사람(임시 제한)·이 판정(숨기기·무시·오판)의 동작이 진행 중이면 그 버튼만 잠근다. */
  lockedKeys: ReadonlySet<string>;
  /** 후보 화면 동작. */
  actions: CandidateActions;
}

/** 메시지 한 줄 속성. */
interface MessageRowProps {
  /** 보여 줄 판정. */
  verdict: VerdictDto;
  /** 카드 종류(버튼 구성). */
  kind: GroupKind;
  /** 숨기기·무시·오판 권한(hide_message)이 있는지. */
  canHide: boolean;
  /** 동작 실행기. */
  run: ActionRunner;
  /** 이 판정의 동작이 진행 중인지(이 줄의 버튼만 잠근다). */
  isLocked: boolean;
  /** 후보 화면 동작. */
  actions: CandidateActions;
}

/** 카드에 보여 줄 최근 메시지 수(스펙 6장). */
const VISIBLE_MESSAGES = 3;

/** 한 사람의 후보 묶음 카드. 메시지별 숨기기·무시(또는 오판), 사람 단위 임시 제한. */
export function CandidateGroupCard({ group, kind, permissions, run, lockedKeys, actions }: CandidateGroupCardProps) {
  const canHide = permissions.includes("hide_message");
  const restrictKey = senderLockKey(group.senderChannelId);
  return (
    <article className={`card card-${kind}`}>
      <header className="card-header">
        <strong>{group.senderNickname}</strong>
        <span className="count">{group.verdicts.length}건</span>
        <button type="button" aria-label={`${group.senderNickname} 임시 제한`} disabled={!permissions.includes("temporary_restrict") || lockedKeys.has(restrictKey)} onClick={() => run(restrictKey, () => actions.temporaryRestrict(group))}>
          임시 제한
        </button>
      </header>
      <ul className="messages">
        {group.verdicts.slice(0, VISIBLE_MESSAGES).map((verdict) => (
          <MessageRow key={verdict.id} verdict={verdict} kind={kind} canHide={canHide} run={run} isLocked={lockedKeys.has(verdictLockKey(verdict.id))} actions={actions} />
        ))}
      </ul>
    </article>
  );
}

/** 메시지 한 줄과 이유·버튼. 채팅 원문은 텍스트로만 넣는다(React가 이스케이프한다). */
function MessageRow({ verdict, kind, canHide, run, isLocked, actions }: MessageRowProps) {
  const lockKey = verdictLockKey(verdict.id);
  return (
    <li className="message">
      <span className="time">{formatClockTime(verdict.createdAt)}</span>
      <span className="content">{verdict.content}</span>
      <span className="reason">{describeReason(verdict.reason)}</span>
      <span className="buttons">
        <button type="button" aria-label={`${verdict.senderNickname}의 ${formatClockTime(verdict.createdAt)} 메시지 숨기기`} disabled={!canHide || isLocked} onClick={() => run(lockKey, () => actions.hide(verdict))}>숨기기</button>
        {kind === "shadow" ? (
          <button type="button" aria-label={`${verdict.senderNickname}의 ${formatClockTime(verdict.createdAt)} 메시지 오판 신고`} disabled={!canHide || isLocked} onClick={() => run(lockKey, () => actions.reportFalsePositive(verdict))}>오판</button>
        ) : (
          <button type="button" aria-label={`${verdict.senderNickname}의 ${formatClockTime(verdict.createdAt)} 메시지 무시`} disabled={!canHide || isLocked} onClick={() => run(lockKey, () => actions.ignore(verdict))}>무시</button>
        )}
      </span>
    </li>
  );
}
