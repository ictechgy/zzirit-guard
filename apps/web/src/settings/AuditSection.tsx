import type { AuditEntryDto, MeDto } from "@zzirit-guard/shared";
import { useApiResource } from "../api/useApiResource";
import { describeRuleKind } from "../domain/ruleKinds";
import { formatDateTime } from "../domain/timeFormat";

/**
 * 감사 기록 동작 이름. 키는 서버가 남기는 action에서 ':' 앞부분이다:
 * 실행기 kind(executor.ts), auto_hide_on/off(autoHideSwitch.ts), ignored·false_positive·rule_add·rule_remove·settings_update(routes.ts).
 */
const ACTION_LABELS: ReadonlyMap<string, string> = new Map([
  ["hide", "숨김"], ["temporary_restrict", "임시 제한"], ["restrict", "활동 제한"], ["unrestrict", "활동 제한 해제"],
  ["update_chat_settings", "채팅 설정 변경"], ["auto_hide_on", "자동 숨김 켬"], ["auto_hide_off", "자동 숨김 끔"],
  ["ignored", "무시"], ["false_positive", "오판 신고"], ["rule_add", "규칙 추가"], ["rule_remove", "규칙 삭제"], ["settings_update", "설정 변경"],
]);
/** 스위치를 켜고 끈 이유(autoHideSwitch.ts·app.ts가 넘기는 reason). */
const SWITCH_REASON_LABELS: ReadonlyMap<string, string> = new Map([["manual", "수동"], ["breaker", "1분 한도 초과"], ["failure_rate", "치지직 호출 실패 증가"]]);
/** 행위자 이름. */
const ACTOR_LABELS: Record<AuditEntryDto["actorType"], string> = { manager: "매니저", rule: "자동 규칙", system: "시스템" };

/** 동작 문자열을 읽기 쉬운 이름으로. 예: "auto_hide_off:breaker" → "자동 숨김 끔(1분 한도 초과)". 모르는 동작은 그대로 둔다. */
function describeAction(action: string): string {
  const separator = action.indexOf(":");
  const name = separator < 0 ? action : action.slice(0, separator);
  const label = ACTION_LABELS.get(name);
  if (!label) return action;
  return separator < 0 ? label : `${label}(${describeDetail(name, action.slice(separator + 1))})`;
}

/** 동작 뒤에 붙은 세부 값(규칙 종류 또는 스위치 이유)을 이름으로. */
function describeDetail(name: string, detail: string): string {
  return name === "rule_add" ? describeRuleKind(detail) : (SWITCH_REASON_LABELS.get(detail) ?? detail);
}

/** 감사 기록 속성. */
export interface AuditSectionProps {
  /** 로그인한 매니저(view_audit 권한으로 조회 여부를 정한다). */
  me: MeDto;
  /** 바뀌면 서버에서 다시 읽는다(설정 탭을 다시 열거나 '새로 고침', F6). 생략하면 처음 한 번만 읽는다. */
  refreshKey?: number;
}

/** 감사 기록(스펙 6장 ③). 채널 관리자 이상(view_audit)만 본다. */
export function AuditSection({ me, refreshKey = 0 }: AuditSectionProps) {
  const canView = me.permissions.includes("view_audit");
  const entries = useApiResource<AuditEntryDto[]>(canView ? "/api/audit?limit=50" : null, null, refreshKey);
  if (!canView) return <section><h2>감사 기록</h2><p className="hint">감사 기록은 채널 관리자 이상만 볼 수 있습니다.</p></section>;
  return (
    <section>
      <h2>감사 기록</h2>
      {entries.error && <p className="error" role="alert">{entries.error}</p>}
      <ol className="audit">
        {(entries.data ?? []).map((entry) => (
          <li key={entry.id} className={entry.result === "error" ? "audit-error" : undefined}>
            <time>{formatDateTime(entry.createdAt)}</time> {ACTOR_LABELS[entry.actorType]} · {describeAction(entry.action)}
            {entry.result === "error" && <span className="error"> 실패: {entry.error}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
