import { API_BASE } from "../api/client";
import { ApiNotice } from "../components/ApiNotice";

/** 로그인 화면 속성. */
export interface LoginScreenProps {
  /** 서버 콜백이 주소에 넣은 로그인 실패 이유 코드(?loginError=)를 정해진 문구로 바꾼 것(describeLoginError). 한도 초과도 여기로 온다(R-8). */
  loginError: string | null;
  /** 세션 종료 이유 같은 안내. */
  message: string | null;
}

/** 로그인 화면. 매니저 로그인과 스트리머 채널 연결 두 길만 둔다. 링크는 최상위 이동이라 서버는 실패를 JSON이 아닌 loginError로 돌려준다. */
export function LoginScreen({ loginError, message }: LoginScreenProps) {
  return (
    <main className="login">
      <img src="/icons/logo.svg" alt="" width={96} height={96} />
      <h1>찌리릿 가드</h1>
      <p>치지직 채팅 관리 보조 도구</p>
      {loginError && <p className="error" role="alert">{loginError}</p>}
      {message && <p className="hint">{message}</p>}
      <a className="button primary" href={`${API_BASE}/auth/login`}>매니저 로그인</a>
      <a className="button" href={`${API_BASE}/auth/connect`}>스트리머: 채널 연결</a>
      <ApiNotice />
    </main>
  );
}
