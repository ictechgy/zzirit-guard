import type { LoginErrorCode } from "@zzirit-guard/shared";

/**
 * 로그인 실패 이유 코드별 문구. 서버가 "/?loginError=<코드>"로 보낸 코드를 이 문구로만 바꿔 보여 준다.
 * 왜: 주소의 글을 그대로 보여 주면 누구나 공식 주소에 임의의 안내(피싱 문구)를 띄울 수 있다(F10).
 * 문구는 서버가 예전에 주소에 싣던 한국어를 그대로 옮겼다(apps/server/src/http/server.ts·managers/authFlow.ts의 AuthError 코드와 짝).
 */
const LOGIN_ERROR_MESSAGES: Readonly<Record<LoginErrorCode, string>> = {
  state_mismatch: "로그인 요청이 만료되었거나 다른 브라우저에서 시작되었습니다. 처음부터 다시 시도하세요.",
  rate_limited: "요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.",
  not_manager: "이 채널의 매니저가 아닙니다. 치지직에서 채널 관리자나 채팅 운영자로 등록돼 있어야 합니다.",
  not_allowed_channel: "이 서버에 연결할 수 있는 채널이 아닙니다. 운영자가 설정한 스트리머 계정으로 로그인하세요.",
  no_channel: "아직 연결된 채널이 없습니다. 스트리머가 먼저 '채널 연결'을 해야 합니다.",
  failed: "로그인 중 오류가 발생했습니다. 잠시 뒤 다시 시도하세요.",
};

/**
 * 주소의 loginError 코드를 보여 줄 문구로 바꾼다. 모르는 코드(임의의 글 포함)는 일반 실패 문구로 바꾼다.
 * Object.hasOwn을 쓰는 이유: "toString" 같은 프로토타입 키가 함수를 꺼내 문구로 쓰이지 않게 한다.
 * @param code 주소의 loginError 값
 * @returns 정해진 한국어 문구
 */
export function describeLoginError(code: string): string {
  return Object.hasOwn(LOGIN_ERROR_MESSAGES, code) ? LOGIN_ERROR_MESSAGES[code as LoginErrorCode] : LOGIN_ERROR_MESSAGES.failed;
}
