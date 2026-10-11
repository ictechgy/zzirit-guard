import type { ChatSettingsDto, MeDto } from "@zzirit-guard/shared";
import { useState } from "react";
import { apiGet, apiSend, describeApiError } from "../api/client";
import { useApiResource } from "../api/useApiResource";
import { useBusyTask } from "../api/useBusyTask";

/**
 * 치지직이 허용하는 저속 모드 값(초). 서버 ALLOWED_SLOW_MODE_SECONDS(apps/server/src/http/routes.ts)와 같아야 한다.
 * shared는 타입만 내보내 런타임 값을 옮길 수 없어 복사했다(R-20). 서버가 다시 검사하므로 어긋나도 400 문구가 보인다.
 */
const SLOW_MODE_OPTIONS: readonly number[] = [0, 3, 5, 10, 30, 60, 120, 300];

/** 채팅 설정 주소. 서버가 치지직 API를 직접 부른다. */
const CHAT_SETTINGS_PATH = "/api/chat-settings";

/**
 * 저속 모드만 바꿔 보낸다. 보내기 직전에 설정을 다시 읽어 그 위에 얹는다.
 * 왜: 서버(치지직)는 설정 전체를 받으므로, 화면을 연 때의 값을 그대로 보내면 그사이 다른 사람이 바꾼 설정(팔로워 전용 등)을 옛 값으로 되돌린다(F5).
 * 다시 읽기가 실패하면 보내지 않는다(오류는 호출한 쪽이 보여 준다).
 * @param seconds 바꿀 저속 모드 초
 */
async function updateSlowMode(seconds: number): Promise<void> {
  const latest = await apiGet<ChatSettingsDto>(CHAT_SETTINGS_PATH);
  await apiSend("PUT", CHAT_SETTINGS_PATH, { ...latest, chatSlowModeSec: seconds } satisfies ChatSettingsDto);
}

/** 치지직 채팅 설정 중 저속 모드(도배가 몰릴 때 바로 쓰는 수단). 수정 권한(edit_chat_settings)이 없으면 값만 보인다. */
export function ChatSettingsSection({ me }: { me: MeDto }) {
  const settings = useApiResource<ChatSettingsDto>(CHAT_SETTINGS_PATH);
  const [message, setMessage] = useState<string | null>(null);
  const busy = useBusyTask();
  const canEdit = me.permissions.includes("edit_chat_settings");
  const change = (seconds: number) => {
    if (!settings.data) return;
    setMessage(null);
    busy.run(() => updateSlowMode(seconds)).then(
      (started) => {
        if (!started) return;
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
          <select value={settings.data.chatSlowModeSec} disabled={!canEdit || busy.isBusy} onChange={(event) => change(Number(event.target.value))}>
            {SLOW_MODE_OPTIONS.map((seconds) => <option key={seconds} value={seconds}>{seconds === 0 ? "끔" : `${seconds}초`}</option>)}
          </select>
        </label>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
