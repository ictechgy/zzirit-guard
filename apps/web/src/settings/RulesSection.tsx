import type { MeDto, RuleEntryDto, RuleKind } from "@zzirit-guard/shared";
import { useState, type FormEvent } from "react";
import { apiSend, describeApiError } from "../api/client";
import { useApiResource } from "../api/useApiResource";
import { useBusyTask } from "../api/useBusyTask";
import { EDITABLE_KINDS, KIND_LABELS } from "../domain/ruleKinds";

/**
 * 규칙 입력 최대 길이. 서버 MAX_PATTERN_LENGTH(apps/server/src/detection/ruleRepository.ts)와 같아야 한다.
 * shared는 타입만 내보내 런타임 값을 옮길 수 없어 복사했다(R-20). 서버가 다시 검사하므로 어긋나도 400 문구가 보인다.
 */
const MAX_PATTERN_LENGTH = 50;

/** 규칙 목록과 추가·삭제(스펙 6장 ③). 수정 권한(edit_rules)이 없으면 목록만 보인다. */
export function RulesSection({ me }: { me: MeDto }) {
  const rules = useApiResource<RuleEntryDto[]>("/api/rules");
  const [error, setError] = useState<string | null>(null);
  const canEdit = me.permissions.includes("edit_rules");
  const busy = useBusyTask();
  /** 작업을 한 번에 하나만 실행한다. 성공하면 목록을 다시 읽고 true, 실패하면 오류 문구를 보여 주고 false. */
  const run = (task: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    return busy.run(task).then(
      (started) => {
        if (started) rules.reload();
        return started;
      },
      (caught: unknown) => {
        setError(describeApiError(caught));
        return false;
      },
    );
  };
  return (
    <section>
      <h2>규칙</h2>
      {(error ?? rules.error) && <p className="error" role="alert">{error ?? rules.error}</p>}
      {canEdit ? <RuleForm isBusy={busy.isBusy} onAdd={(kind, pattern) => run(() => apiSend("POST", "/api/rules", { kind, pattern }))} /> : <p className="hint">규칙은 채널 관리자 이상만 바꿀 수 있습니다.</p>}
      {EDITABLE_KINDS.map((kind) => (
        <RuleGroup key={kind} kind={kind} rules={(rules.data ?? []).filter((rule) => rule.kind === kind)} canEdit={canEdit} isBusy={busy.isBusy}
          onRemove={(rule) => void run(() => apiSend("DELETE", `/api/rules/${rule.id}`))} />
      ))}
    </section>
  );
}

/** 규칙 추가 양식 속성. */
interface RuleFormProps {
  /** 요청이 진행 중인지(입력·버튼을 잠근다). */
  isBusy: boolean;
  /** 추가를 요청한다. 성공했을 때만 true(입력을 비우는 기준). */
  onAdd(kind: RuleKind, pattern: string): Promise<boolean>;
}

/** 규칙 추가 양식. 빈 입력은 보내지 않고 안내한다. 입력은 추가에 성공한 뒤에만 비워, 실패하면 다시 고쳐 보낼 수 있다. */
function RuleForm({ isBusy, onAdd }: RuleFormProps) {
  const [kind, setKind] = useState<RuleKind>("weak");
  const [pattern, setPattern] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!pattern.trim()) return setHint("규칙 내용을 입력하세요.");
    setHint(null);
    void onAdd(kind, pattern.trim()).then((isAdded) => isAdded && setPattern(""));
  };
  return (
    <form className="rule-form" onSubmit={submit}>
      <label>종류<select value={kind} disabled={isBusy} onChange={(event) => setKind(event.target.value as RuleKind)}>{EDITABLE_KINDS.map((option) => <option key={option} value={option}>{KIND_LABELS[option]}</option>)}</select></label>
      <label>내용<input value={pattern} disabled={isBusy} maxLength={MAX_PATTERN_LENGTH} onChange={(event) => { setPattern(event.target.value); setHint(null); }} /></label>
      <button type="submit" disabled={isBusy}>추가</button>
      {hint && <p className="hint" role="status">{hint}</p>}
    </form>
  );
}

/** 규칙 묶음 속성. */
interface RuleGroupProps {
  /** 이 묶음의 종류. */
  kind: RuleKind;
  /** 이 종류의 규칙. */
  rules: readonly RuleEntryDto[];
  /** 삭제 버튼을 보일지. */
  canEdit: boolean;
  /** 요청이 진행 중인지(삭제 버튼을 잠근다). */
  isBusy: boolean;
  /** 삭제를 누르면 부른다. */
  onRemove(rule: RuleEntryDto): void;
}

/** 종류 하나의 규칙 목록. 비어 있으면 그리지 않는다. */
function RuleGroup({ kind, rules, canEdit, isBusy, onRemove }: RuleGroupProps) {
  if (rules.length === 0) return null;
  return (
    <div className="rule-group">
      <h3>{KIND_LABELS[kind]}</h3>
      <ul>
        {rules.map((rule) => (
          <li key={rule.id}>
            <span>{rule.pattern}</span>
            {canEdit && <button type="button" disabled={isBusy} onClick={() => onRemove(rule)} aria-label={`${rule.pattern} 삭제`}>삭제</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
