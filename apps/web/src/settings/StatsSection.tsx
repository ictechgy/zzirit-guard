import type { MinuteStatDto } from "@zzirit-guard/shared";
import { useApiResource } from "../api/useApiResource";

/** 합계로 보여 줄 항목과 이름. */
const TOTAL_FIELDS: ReadonlyArray<[keyof Omit<MinuteStatDto, "minute">, string]> = [
  ["received", "받은 채팅"], ["skipped", "가벼운 반응(ㅋㅋ 등)"], ["deduplicated", "중복 문장"], ["candidates", "후보"],
  ["shadow", "섀도"], ["auto_hidden", "자동 숨김"], ["invalid_events", "형식 오류 이벤트"],
];

/**
 * AI(2단계) 항목과 이름. AI를 켠 배포에서만 보인다(켜 두고 아직 0이어도 보여, 꺼짐과 구분되게).
 * 1차 미만으로 통과한 채팅은 따로 세지 않는다(받은 채팅에서 나머지를 뺀 값에 들어 있다).
 */
const AI_FIELDS: ReadonlyArray<[keyof Omit<MinuteStatDto, "minute">, string]> = [
  ["stage1_forwarded", "AI 2차로 보낸 채팅"], ["stage2_done", "AI 2차 판정"],
  ["stage2_dropped", "AI 미검사(과부하)"], ["ai_unchecked", "AI 미검사(장애·너무 긴 문장)"],
];

/** 항목 합계. */
function totalOf(rows: readonly MinuteStatDto[], field: keyof Omit<MinuteStatDto, "minute">): number {
  return rows.reduce((sum, row) => sum + row[field], 0);
}

/** 가장 바빴던 1분의 초당 채팅 수. reduce로 구한다(Math.max 펼치기는 행이 많으면 인자 개수 한도로 실패한다, F4). */
function peakPerSecond(rows: readonly MinuteStatDto[]): number {
  return rows.reduce((peak, row) => Math.max(peak, row.received), 0) / 60;
}

/** 최근 1시간 통계 속성. */
export interface StatsSectionProps {
  /** 바뀌면 서버에서 다시 읽는다(설정 탭을 다시 열거나 '새로 고침', F6). 생략하면 처음 한 번만 읽는다. */
  refreshKey?: number;
  /** 서버가 AI 단계를 켰는지. 켜져 있을 때만 AI 항목을 보인다. 생략하면 꺼짐으로 본다. */
  aiEnabled?: boolean;
}

/** 최근 1시간 통계. 1단계의 핵심 측정값(초당 채팅량·건너뛰기·중복 비율)을 보여 준다(스펙 15장). */
export function StatsSection({ refreshKey = 0, aiEnabled = false }: StatsSectionProps) {
  const stats = useApiResource<MinuteStatDto[]>("/api/stats?sinceMinutes=60", null, refreshKey);
  if (stats.error) return <section><h2>최근 1시간</h2><p className="error" role="alert">{stats.error}</p></section>;
  const rows = stats.data ?? [];
  const shownFields = aiEnabled ? [...TOTAL_FIELDS, ...AI_FIELDS] : TOTAL_FIELDS;
  return (
    <section>
      <h2>최근 1시간</h2>
      <dl className="rows">
        {shownFields.map(([field, label]) => (
          <div key={field}><dt>{label}</dt><dd>{totalOf(rows, field)}</dd></div>
        ))}
        <div><dt>가장 바빴던 1분의 초당 채팅</dt><dd>{peakPerSecond(rows).toFixed(1)}</dd></div>
      </dl>
    </section>
  );
}
