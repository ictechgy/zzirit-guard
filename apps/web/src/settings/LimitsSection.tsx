import type { MeDto, SettingsDto } from "@zzirit-guard/shared";
import { useEffect, useState } from "react";
import { apiSend, describeApiError } from "../api/client";
import { useApiResource } from "../api/useApiResource";

/**
 * 설정 항목 이름과 허용 범위. 범위는 서버 SETTING_RULES(apps/server/src/records/settingsRepository.ts)와 같아야 한다.
 * shared는 타입만 내보내 런타임 값을 옮길 수 없어 복사했다(R-20). 서버가 다시 검사하므로 어긋나도 400 문구가 보인다.
 */
const FIELDS: ReadonlyArray<{ key: keyof SettingsDto; label: string; min: number; max: number }> = [
  { key: "breakerPerMinute", label: "자동 숨김 1분 한도(넘으면 스위치가 꺼짐)", min: 1, max: 1000 },
  { key: "retentionDaysContent", label: "원문 보관 기간(일)", min: 1, max: 365 },
  { key: "retentionDaysAudit", label: "감사 기록 보관 기간(일)", min: 1, max: 365 },
];

/** 한도·보관 기간 설정(스펙 5.5·9장). 수정 권한(edit_rules)이 없으면 값만 보인다. */
export function LimitsSection({ me }: { me: MeDto }) {
  const settings = useApiResource<SettingsDto>("/api/settings");
  const [draft, setDraft] = useState<SettingsDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canEdit = me.permissions.includes("edit_rules");
  useEffect(() => setDraft(settings.data), [settings.data]);
  const save = () => {
    if (!draft) return;
    apiSend<SettingsDto>("PUT", "/api/settings", draft).then(() => setMessage("저장했습니다."), (error: unknown) => setMessage(describeApiError(error)));
  };
  if (!draft) return <section><h2>한도·보관 기간</h2><p>{settings.error ?? "불러오는 중…"}</p></section>;
  return (
    <section>
      <h2>한도·보관 기간</h2>
      {FIELDS.map((field) => (
        <label key={field.key} className="field">
          {field.label}
          <input type="number" min={field.min} max={field.max} value={draft[field.key]} disabled={!canEdit}
            onChange={(event) => setDraft({ ...draft, [field.key]: Number(event.target.value) })} />
        </label>
      ))}
      {canEdit && <button type="button" onClick={save}>저장</button>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
