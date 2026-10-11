import type { MinuteStatDto } from "@zzirit-guard/shared";
import { useApiResource } from "../api/useApiResource";

/** 합계로 보여 줄 항목과 이름. 2단계(AI) 항목은 1단계에서 늘 0이라 뺀다. */
const TOTAL_FIELDS: ReadonlyArray<[keyof Omit<MinuteStatDto, "minute">, string]> = [
  ["received", "받은 채팅"], ["skipped", "가벼운 반응(ㅋㅋ 등)"], ["deduplicated", "중복 문장"], ["candidates", "후보"],
  ["shadow", "섀도"], ["auto_hidden", "자동 숨김"], ["invalid_events", "형식 오류 이벤트"],
];

/** 가장 바빴던 1분의 초당 채팅 수. reduce로 구한다(Math.max 펼치기는 행이 많으면 인자 개수 한도로 실패한다, F4). */
function peakPerSecond(rows: readonly MinuteStatDto[]): number {
  return rows.reduce((peak, row) => Math.max(peak, row.received), 0) / 60;
}

/** 최근 1시간 통계. 1단계의 핵심 측정값(초당 채팅량·건너뛰기·중복 비율)을 보여 준다(스펙 15장). */
export function StatsSection() {
  const stats = useApiResource<MinuteStatDto[]>("/api/stats?sinceMinutes=60");
  if (stats.error) return <section><h2>최근 1시간</h2><p className="error" role="alert">{stats.error}</p></section>;
  const rows = stats.data ?? [];
  return (
    <section>
      <h2>최근 1시간</h2>
      <dl className="rows">
        {TOTAL_FIELDS.map(([field, label]) => (
          <div key={field}><dt>{label}</dt><dd>{rows.reduce((sum, row) => sum + row[field], 0)}</dd></div>
        ))}
        <div><dt>가장 바빴던 1분의 초당 채팅</dt><dd>{peakPerSecond(rows).toFixed(1)}</dd></div>
      </dl>
    </section>
  );
}
