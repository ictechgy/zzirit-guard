import type { ServerStatus } from "@zzirit-guard/shared";
import { useApiResource } from "../api/useApiResource";
import { formatDateTime } from "../domain/timeFormat";

/**
 * 상태 점검을 다시 읽는 간격(15초).
 * 왜 실시간 status를 쓰지 않나: 서버는 연결·잠금·스위치가 바뀔 때만 status를 방송하고, 마지막 채팅 수신·처리 대기 건수가 바뀔 때는 보내지 않는다(R-7).
 */
const STATUS_REFRESH_MS = 15_000;

/** 표에 보여 줄 행(이름, 값). */
function rowsOf(status: ServerStatus): Array<[string, string]> {
  return [
    ["채널", status.channelName ?? "연결 안 됨"],
    ["치지직 채팅 연결", status.chatConnected ? "연결됨" : "끊김"],
    ["숨김·제재 가능", status.writeLocked ? "불가(스트리머 재연결 필요)" : "가능"],
    ["자동 숨김", status.autoHideEnabled ? "켜짐" : "꺼짐"],
    ["토큰 만료 예정", formatDateTime(status.accessExpiresAt)],
    ["마지막 채팅 수신", formatDateTime(status.lastChatAt)],
    ["처리 대기 중인 조치", `${status.pendingActions}건`],
  ];
}

/** 방송 전 상태 점검(스펙 6장 ③, 10장). 열릴 때와 15초마다 서버에서 다시 읽는다. */
export function StatusSection() {
  const status = useApiResource<ServerStatus>("/api/status", STATUS_REFRESH_MS);
  return (
    <section>
      <h2>상태 점검</h2>
      {status.error && <p className="error" role="alert">{status.error}</p>}
      {status.data ? (
        <dl className="rows">
          {rowsOf(status.data).map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
        </dl>
      ) : (
        !status.error && <p>불러오는 중…</p>
      )}
    </section>
  );
}
