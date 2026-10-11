import type { MeDto } from "@zzirit-guard/shared";
import { useState } from "react";
import { ApiError, apiSend, describeApiError, requiresSignIn } from "../api/client";
import { useBusyTask } from "../api/useBusyTask";
import { ApiNotice } from "../components/ApiNotice";
import { disablePush, enablePush } from "../push/pushSubscription";

/** 역할 이름. */
const ROLE_LABELS: Record<MeDto["role"], string> = {
  STREAMING_CHANNEL_OWNER: "스트리머", STREAMING_CHANNEL_MANAGER: "채널 관리자", STREAMING_CHAT_MANAGER: "채팅 운영자",
};
/** 채널 연결 해제 확인 문구. 서버가 모든 세션을 지우고 수신을 멈춘다(app.ts disconnectChannel). 규칙·설정은 남는다. */
const DISCONNECT_CONFIRMATION = "채널 연결을 해제하면 모든 매니저가 로그아웃되고 자동 기능이 멈춥니다(규칙·설정은 남습니다). 해제할까요?";

/** 오류 문구: 서버 오류(ApiError)는 서버 문구, 일반 Error(알림 미지원·권한 거부·준비 시간 초과)는 자기 문구. */
function messageOf(error: unknown): string {
  return error instanceof Error && !(error instanceof ApiError) ? error.message : describeApiError(error);
}

/**
 * 이 기기의 알림 구독을 푼다(스펙 11장 "해지 시 삭제", R-14). 실패해도 로그아웃·연결 해제는 계속하고, 원인은 콘솔에 남긴다.
 * 왜 계속하나: 구독 해지 실패로 로그아웃이 막히면 안 되고, 남은 구독은 푸시 서비스가 끊긴 주소를 알려 줄 때 서버가 지운다.
 */
function releasePush(): Promise<void> {
  return disablePush().catch((error: unknown) => console.warn("알림 구독 해지에 실패했습니다(로그아웃은 계속합니다)", error));
}

/** 계정·장애 알림·로그아웃·(스트리머) 채널 연결 해제. */
export function AccountSection({ me, onSignedOut }: { me: MeDto; onSignedOut(message: string | null): void }) {
  const [message, setMessage] = useState<string | null>(null);
  const busy = useBusyTask();
  /** 한 번에 하나만 실행한다. 로그인이 이미 풀린 오류(401·no_channel)는 목적이 이뤄진 것이라 로컬 로그아웃을 마친다. */
  const exit = (request: string, signedOutMessage: string | null) => {
    busy.run(() => releasePush().then(() => apiSend("POST", request))).then(
      (started) => started && onSignedOut(signedOutMessage),
      (error: unknown) => (requiresSignIn(error) ? onSignedOut(signedOutMessage) : setMessage(messageOf(error))),
    );
  };
  const enableAlerts = () => busy.run(() => enablePush()).then((started) => started && setMessage("장애 알림을 켰습니다."), (error: unknown) => setMessage(messageOf(error)));
  const logout = () => exit("/api/logout", null);
  const disconnect = () => {
    if (!window.confirm(DISCONNECT_CONFIRMATION)) return;
    exit("/api/channel/disconnect", "채널 연결을 해제했습니다.");
  };
  return (
    <section>
      <h2>계정</h2>
      <p>{me.channelName} · {ROLE_LABELS[me.role]}</p>
      <button type="button" disabled={busy.isBusy} onClick={() => void enableAlerts()}>장애 알림 받기</button>
      <button type="button" disabled={busy.isBusy} onClick={logout}>로그아웃</button>
      {me.permissions.includes("connect_channel") && <button type="button" className="danger" disabled={busy.isBusy} onClick={disconnect}>채널 연결 해제</button>}
      {message && <p role="status">{message}</p>}
      <ApiNotice />
    </section>
  );
}
