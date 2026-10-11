/** 시각을 "14:03:21"처럼 시·분·초로 보여 준다. 후보 카드처럼 최근 10분 안의 시각에 쓴다. */
export function formatClockTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** 날짜와 시각을 함께 보여 준다. 값이 없으면 "—". 상태 점검·감사 기록처럼 날짜가 다를 수 있는 시각에 쓴다. */
export function formatDateTime(timestampMs: number | null): string {
  return timestampMs ? new Date(timestampMs).toLocaleString("ko-KR") : "—";
}
