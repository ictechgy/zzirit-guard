import type { MeDto } from "@zzirit-guard/shared";
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiGet, describeApiError } from "./api/client";
import { LoginScreen } from "./screens/LoginScreen";
import { MainScreen } from "./screens/MainScreen";

/** 로그인 상태. signedOut의 message는 로그인 화면에 보여 줄 안내(세션 종료 이유, 409 no_channel 문구 등)다. */
type MeState = { kind: "loading" } | { kind: "signedOut"; message: string | null } | { kind: "signedIn"; me: MeDto };

/** 주소의 loginError(서버 콜백·한도 초과가 넣은 로그인 실패 이유)를 읽는다. */
function readLoginError(search: string): string | null {
  return new URLSearchParams(search).get("loginError");
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
  useEffect(() => {
    apiGet<MeDto>("/api/me").then(
      (me) => setMeState({ kind: "signedIn", me }),
      (error: unknown) => signOut(error instanceof ApiError && error.status === 401 ? null : describeApiError(error)),
    );
  }, [signOut]);
  if (meState.kind === "loading") return <p className="splash">불러오는 중…</p>;
  if (meState.kind === "signedOut") return <LoginScreen loginError={loginError} message={meState.message} />;
  return <MainScreen me={meState.me} onSignedOut={signOut} />;
}
