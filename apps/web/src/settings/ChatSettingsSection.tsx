import type { ChatSettingsDto, MeDto } from "@zzirit-guard/shared";
import { useState } from "react";
import { apiSend, describeApiError } from "../api/client";
import { useApiResource } from "../api/useApiResource";

/**
 * 치지직이 허용하는 저속 모드 값(초). 서버 ALLOWED_SLOW_MODE_SECONDS(apps/server/src/http/routes.ts)와 같아야 한다.
 * shared는 타입만 내보내 런타임 값을 옮길 수 없어 복사했다(R-20). 서버가 다시 검사하므로 어긋나도 400 문구가 보인다.
 */
const SLOW_MODE_OPTIONS: readonly number[] = [0, 3, 5, 10, 30, 60, 120, 300];

/** 치지직 채팅 설정 중 저속 모드(도배가 몰릴 때 바로 쓰는 수단). 수정 권한(edit_chat_settings)이 없으면 값만 보인다. */
export function ChatSettingsSection({ me }: { me: MeDto }) {
  const settings = useApiResource<ChatSettingsDto>("/api/chat-settings");
  const [message, setMessage] = useState<string | null>(null);
  const canEdit = me.permissions.includes("edit_chat_settings");
  const change = (seconds: number) => {
    if (!settings.data) return;
    apiSend("PUT", "/api/chat-settings", { ...settings.data, chatSlowModeSec: seconds }).then(
      () => {
        setMessage(seconds === 0 ? "저속 모드를 껐습니다." : `저속 모드를 ${seconds}초로 바꿨습니다.`);
        settings.reload();
      },
      (error: unknown) => setMessage(describeApiError(error)),
    );
  };
  return (
    <section>
      <h2>채팅 설정</h2>
      {settings.error && <p className="error" role="alert">{settings.error}</p>}
      {settings.data && (
        <label className="field">
          저속 모드
          <select value={settings.data.chatSlowModeSec} disabled={!canEdit} onChange={(event) => change(Number(event.target.value))}>
            {SLOW_MODE_OPTIONS.map((seconds) => <option key={seconds} value={seconds}>{seconds === 0 ? "끔" : `${seconds}초`}</option>)}
          </select>
        </label>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
