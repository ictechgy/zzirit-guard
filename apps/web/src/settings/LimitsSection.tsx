import type { MeDto, SettingsDto, Stage2Policy } from "@zzirit-guard/shared";
import { useEffect, useState } from "react";
import { apiSend, describeApiError } from "../api/client";
import { useApiResource } from "../api/useApiResource";
import { useBusyTask } from "../api/useBusyTask";

/** 정수 설정(한도·보관 기간). */
type IntegerKey = "breakerPerMinute" | "retentionDaysContent" | "retentionDaysAudit";

/** AI 임계값(비율). */
type FractionKey = "stage1Threshold" | "candidateThreshold" | "relaxedCandidateThreshold" | "sureThreshold";

/**
 * 정수 설정 항목 이름과 허용 범위. 범위는 서버 SETTING_RULES(apps/server/src/records/settingsRepository.ts)와 같아야 한다.
 * shared는 타입만 내보내 런타임 값을 옮길 수 없어 복사했다(R-20). 서버가 다시 검사하므로 어긋나도 400 문구가 보인다.
 */
const FIELDS: ReadonlyArray<{ key: IntegerKey; label: string; min: number; max: number }> = [
  { key: "breakerPerMinute", label: "자동 숨김 1분 한도(넘으면 스위치가 꺼짐)", min: 1, max: 1000 },
  { key: "retentionDaysContent", label: "원문 보관 기간(일)", min: 1, max: 365 },
  { key: "retentionDaysAudit", label: "감사 기록 보관 기간(일)", min: 1, max: 365 },
];

/**
 * AI 임계값 항목과 이름(로드맵 2단계 계획 R10). 0보다 크고 1보다 작다(확실은 1 이하). 범위는 서버와 같아야 한다.
 * 1차 임계값은 모델마다 맞는 값이 달라 운영자가 정한다(운영 안내서). AI를 켠 배포에서만 보인다.
 */
const AI_FIELDS: ReadonlyArray<{ key: FractionKey; label: string; includesOne: boolean }> = [
  { key: "stage1Threshold", label: "AI 1차 임계값(이 점수 이상이면 2차로 보냄)", includesOne: false },
  { key: "candidateThreshold", label: "AI 후보 임계값(2차 확률이 이 값 이상이면 후보)", includesOne: false },
  { key: "relaxedCandidateThreshold", label: "AI 완화 후보 임계값(선택한 2차 정책 대상에 적용)", includesOne: false },
  { key: "sureThreshold", label: "AI '확실' 임계값(2차 확률이 이 값 이상이면 확실 배지)", includesOne: true },
];

/** 운영자가 영향 범위를 비교할 수 있도록 세 정책과 설명을 항상 함께 보여 준다. */
const STAGE2_POLICIES: ReadonlyArray<{ value: Stage2Policy; label: string; description: string }> = [
  { value: "fixed", label: "고정", description: "모든 범주에 후보 기준을 그대로 씁니다." },
  { value: "keyword_route", label: "키워드 경로 완화", description: "키워드 경로로 온 채팅만 완화합니다." },
  { value: "category", label: "범주 완화", description: "S3·S4·S5 범주만 완화합니다." },
];

/**
 * 값이 맞지 않는 첫 항목의 안내 문구. 모두 맞으면 null. 서버에 보내기 전에 걸러 400 왕복을 줄인다.
 * @param draft 지금 입력
 * @param includeAi AI 임계값도 볼지(AI를 켰고 서버가 그 값을 보냈을 때만)
 */
function findInvalidField(draft: SettingsDto, includeAi: boolean): string | null {
  const field = FIELDS.find(({ key, min, max }) => !Number.isInteger(draft[key]) || draft[key] < min || draft[key] > max);
  if (field) return `${field.label}은(는) ${field.min}에서 ${field.max} 사이의 정수여야 합니다.`;
  if (!includeAi) return null;
  const fraction = AI_FIELDS.find(({ key, includesOne }) => !Number.isFinite(draft[key]) || draft[key] <= 0 || (includesOne ? draft[key] > 1 : draft[key] >= 1));
  if (fraction) return `${fraction.label}은(는) 0보다 크고 1${fraction.includesOne ? " 이하" : "보다 작은"} 수여야 합니다.`;
  if (!STAGE2_POLICIES.some(({ value }) => value === draft.stage2Policy)) return "AI 2차 후보 정책을 다시 선택하세요.";
  return draft.candidateThreshold > draft.sureThreshold ? "AI 후보 임계값은 확실 임계값보다 클 수 없습니다." : null;
}

/** 바꾼 항목이 없을 때의 안내. 보내지 않는다(빈 저장도 서버 감사 기록에 남는다). */
const NO_CHANGES_MESSAGE = "바꾼 값이 없습니다.";

/**
 * 서버 값(baseline)과 다른 항목만 모은다(K19).
 * 왜: 입력 전체를 보내면 화면을 연 뒤 다른 매니저가 바꾼 항목(예: 원문 보관 기간)을 이 화면의 옛 값으로 조용히 되돌린다.
 * 서버(PUT /api/settings)는 보낸 항목만 바꾼다.
 * @param baseline 서버에서 마지막으로 받은 값
 * @param draft 지금 입력
 */
function changedFields(baseline: SettingsDto, draft: SettingsDto, includeAi: boolean): Partial<SettingsDto> {
  const patch: Partial<SettingsDto> = {};
  for (const { key } of [...FIELDS, ...(includeAi ? AI_FIELDS : [])]) if (draft[key] !== baseline[key]) patch[key] = draft[key];
  if (includeAi && draft.stage2Policy !== baseline.stage2Policy) patch.stage2Policy = draft.stage2Policy;
  return patch;
}

/**
 * AI 임계값을 보이고 보낼지: AI를 켰고, 서버가 임계값을 보냈을 때만이다.
 * 왜 둘 다 보나: AI 단계 이전 서버는 임계값을 보내지 않고, 모르는 키를 거절한다. 없는 값을 검사·전송하면 다른 설정까지 저장하지 못한다.
 * @param aiEnabled 서버가 AI 단계를 켰는지
 * @param settings 서버가 보낸 설정
 */
function shouldIncludeAi(aiEnabled: boolean, settings: SettingsDto): boolean {
  return aiEnabled && AI_FIELDS.every(({ key }) => typeof settings[key] === "number")
    && STAGE2_POLICIES.some(({ value }) => value === settings.stage2Policy);
}

/** 한도·보관 기간 속성. */
export interface LimitsSectionProps {
  /** 로그인한 매니저(edit_rules 권한으로 수정 여부를 정한다). */
  me: MeDto;
  /** 바뀌면 서버에서 다시 읽는다(설정 탭을 다시 열거나 '새로 고침', F6). 생략하면 처음 한 번만 읽는다. */
  refreshKey?: number;
  /** 서버가 AI 단계를 켰는지. 켜져 있을 때만 AI 임계값 칸을 보인다. 생략하면 꺼짐으로 본다. */
  aiEnabled?: boolean;
}

/**
 * 한도·보관 기간 설정(스펙 5.5·9장). 수정 권한(edit_rules)이 없으면 값만 보인다.
 * 다시 읽으면 저장하지 않은 입력은 서버 값으로 바뀐다(탭을 떠났다 돌아온 경우라 최신 값이 낫다).
 * 저장은 바꾼 항목만 보내고, 성공하면 응답(서버의 지금 값)을 새 기준과 입력으로 삼는다(K19).
 */
export function LimitsSection({ me, refreshKey = 0, aiEnabled = false }: LimitsSectionProps) {
  const settings = useApiResource<SettingsDto>("/api/settings", null, refreshKey);
  // 서버에서 마지막으로 받은 값. 바꾼 항목을 가려내는 기준이다(K19).
  const [baseline, setBaseline] = useState<SettingsDto | null>(null);
  const [draft, setDraft] = useState<SettingsDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const busy = useBusyTask();
  const canEdit = me.permissions.includes("edit_rules");
  const adopt = (latest: SettingsDto | null) => {
    setBaseline(latest);
    setDraft(latest);
  };
  useEffect(() => adopt(settings.data), [settings.data]);
  const save = () => {
    if (!draft || !baseline) return;
    const includeAi = shouldIncludeAi(aiEnabled, baseline);
    const invalid = findInvalidField(draft, includeAi);
    if (invalid) return setMessage(invalid);
    const patch = changedFields(baseline, draft, includeAi);
    if (Object.keys(patch).length === 0) return setMessage(NO_CHANGES_MESSAGE);
    busy.run(() => apiSend<SettingsDto>("PUT", "/api/settings", patch).then(adopt)).then(
      (started) => started && setMessage("저장했습니다."),
      (error: unknown) => setMessage(describeApiError(error)),
    );
  };
  if (!draft) return <section><h2>한도·보관 기간</h2><p>{settings.error ?? "불러오는 중…"}</p></section>;
  return (
    <section>
      <h2>한도·보관 기간</h2>
      {FIELDS.map((field) => (
        <label key={field.key} className="field">
          {field.label}
          <input type="number" min={field.min} max={field.max} value={draft[field.key]} disabled={!canEdit || busy.isBusy}
            onChange={(event) => { setMessage(null); setDraft({ ...draft, [field.key]: Number(event.target.value) }); }} />
        </label>
      ))}
      {baseline && shouldIncludeAi(aiEnabled, baseline) && <>
        <fieldset disabled={!canEdit || busy.isBusy}>
          <legend>AI 2차 후보 정책</legend>
          {STAGE2_POLICIES.map((policy) => (
            <label key={policy.value} className="field">
              <span><input type="radio" name="stage2-policy" value={policy.value} aria-label={policy.label} checked={draft.stage2Policy === policy.value}
                onChange={() => { setMessage(null); setDraft({ ...draft, stage2Policy: policy.value }); }} />{policy.label}</span>
              <small>{policy.description}</small>
            </label>
          ))}
        </fieldset>
        {AI_FIELDS.map((field) => (
          <label key={field.key} className="field">
            {field.label}
            <input type="number" min={0} max={1} step={0.001} value={draft[field.key]} disabled={!canEdit || busy.isBusy}
              onChange={(event) => { setMessage(null); setDraft({ ...draft, [field.key]: Number(event.target.value) }); }} />
          </label>
        ))}
      </>}
      {canEdit && <button type="button" disabled={busy.isBusy} onClick={save}>저장</button>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
