import type { MeDto } from "@zzirit-guard/shared";
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiGet, describeApiError } from "./api/client";
import { describeLoginError } from "./domain/loginError";
import { LoginScreen } from "./screens/LoginScreen";
import { MainScreen } from "./screens/MainScreen";

/**
 * 로그인 상태. signedOut의 message는 로그인 화면에 보여 줄 안내(세션 종료 이유, 409 no_channel 문구 등)다.
 * unreachable은 서버에 닿지 못했거나(네트워크·시간 초과) 서버 오류(5xx)라 로그인 여부를 모르는 상태다.
 */
type MeState = { kind: "loading" } | { kind: "signedOut"; message: string | null } | { kind: "signedIn"; me: MeDto } | { kind: "unreachable"; message: string };

/**
 * 서버에 닿지 못한 오류인지 본다: 네트워크·시간 초과(status 0)이거나 서버 오류(5xx).
 * 왜 로그인 화면으로 보내지 않나: 맥 미니가 잠깐 꺼졌을 뿐인데 로그인 화면을 보여 주면 매니저가 로그인을 다시 하려다 막히고, 이유도 알 수 없다(F10).
 */
function isServerUnreachable(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}

/**
 * 주소의 loginError(서버 콜백·한도 초과가 넣은 로그인 실패 이유 코드)를 읽어 정해진 문구로 바꾼다. 없으면 null.
 * 주소의 글을 그대로 보여 주지 않는다: 모르는 값은 일반 실패 문구가 된다(F10).
 */
function readLoginError(search: string): string | null {
  const code = new URLSearchParams(search).get("loginError");
  return code === null ? null : describeLoginError(code);
}

/** 주소에서 loginError만 지운다(다른 쿼리·해시는 그대로). 주소 표시줄과 기록에 낡은 실패 이유가 남지 않게 한다. */
function removeLoginErrorFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("loginError")) return;
  url.searchParams.delete("loginError");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

/** 최상위: 내 정보를 읽어 로그인 화면과 본 화면을 고른다. 401은 안내 없이, 그 밖의 오류는 서버 문구와 함께 로그인 화면으로. */
export function App() {
  const [meState, setMeState] = useState<MeState>({ kind: "loading" });
  // 왜 처음 한 번만 읽는가: 주소의 loginError를 매 렌더 읽으면 새로고침·재진입 때 낡은 실패 이유가 다시 보인다. 읽은 뒤 주소에서 지운다.
  const [loginError] = useState(() => readLoginError(window.location.search));
  useEffect(() => removeLoginErrorFromUrl(), []);
  // 왜 useCallback인가: MainScreen의 effect가 이 함수를 의존하므로, 렌더마다 새 함수면 effect가 매번 다시 돈다.
  const signOut = useCallback((message: string | null) => setMeState({ kind: "signedOut", message }), []);
  // 내 정보를 읽는 횟수. '다시 시도'를 누르면 올려 다시 읽는다.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    apiGet<MeDto>("/api/me").then(
      (me) => setMeState({ kind: "signedIn", me }),
      (error: unknown) => {
        if (isServerUnreachable(error)) setMeState({ kind: "unreachable", message: error.message });
        else signOut(error instanceof ApiError && error.status === 401 ? null : describeApiError(error));
      },
    );
  }, [signOut, attempt]);
  const retry = useCallback(() => {
    setMeState({ kind: "loading" });
    setAttempt((value) => value + 1);
  }, []);
  if (meState.kind === "loading") return <p className="splash">불러오는 중…</p>;
  if (meState.kind === "unreachable") return <UnreachableScreen message={meState.message} onRetry={retry} />;
  if (meState.kind === "signedOut") return <LoginScreen loginError={loginError} message={meState.message} />;
  return <MainScreen me={meState.me} onSignedOut={signOut} />;
}

/** 서버에 닿지 못했을 때의 화면 속성. */
interface UnreachableScreenProps {
  /** 오류 문구(원인과 해결 방향, client.ts). */
  message: string;
  /** '다시 시도'를 누르면 부른다. */
  onRetry(): void;
}

/** 앱을 열 때 서버에 닿지 못했을 때(F10): 이유와 '다시 시도'. 홈 화면 앱에는 새로고침이 없어 버튼이 꼭 필요하다. */
function UnreachableScreen({ message, onRetry }: UnreachableScreenProps) {
  return (
    <main className="login">
      <h1>서버에 연결하지 못했습니다</h1>
      <p className="hint">{message}</p>
      <button type="button" className="button primary" onClick={onRetry}>다시 시도</button>
    </main>
  );
}
