/**
 * 시·분·초 형식기. 모듈에서 한 번만 만들어 다시 쓴다.
 * 왜: toLocaleTimeString은 부를 때마다 로캘 형식기를 새로 만들어, 몰려드는 채팅에 목록 수백 줄을 다시 그리면 휴대폰에서 눈에 띄게 느려진다(F4).
 */
const CLOCK_TIME_FORMAT = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** 날짜·시각 형식기. 옵션은 toLocaleString("ko-KR")의 기본값(연·월·일·시·분·초)과 같게 둬 표시가 바뀌지 않게 한다. */
const DATE_TIME_FORMAT = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });

/** 시각을 "14:03:21"처럼 시·분·초로 보여 준다. 후보 카드처럼 최근 10분 안의 시각에 쓴다. */
export function formatClockTime(timestampMs: number): string {
  return CLOCK_TIME_FORMAT.format(timestampMs);
}

/** 날짜와 시각을 함께 보여 준다. 값이 없으면 "—". 상태 점검·감사 기록처럼 날짜가 다를 수 있는 시각에 쓴다. */
export function formatDateTime(timestampMs: number | null): string {
  return timestampMs ? DATE_TIME_FORMAT.format(timestampMs) : "—";
}
