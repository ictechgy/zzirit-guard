/** 세션 쿠키 이름. */
export const SESSION_COOKIE = "zg_session";
/**
 * 상태 변경 요청에 붙여야 하는 표식 헤더. 다른 사이트의 form은 임의 헤더를 붙일 수 없어 CSRF를 막는다
 * (다른 출처의 fetch는 CORS 사전 요청에서 막힌다. 이 서버는 CORS를 허용하지 않는다).
 */
export const REQUEST_MARKER_HEADER = "x-zzirit-request";
/** 후보 목록에 보여 줄 기간(최근 10분, 스펙 6장). */
export const CANDIDATE_WINDOW_MS = 10 * 60 * 1000;
/**
 * OAuth state를 시작한 브라우저에 묶는 쿠키 이름.
 * 왜: 공격자가 자기 계정의 콜백 주소를 피해자에게 열게 하는 로그인 CSRF·세션 고정을 막으려면, 콜백이 시작한 브라우저와 같은지 확인해야 한다.
 */
export const OAUTH_STATE_COOKIE = "zg_oauth_state";
