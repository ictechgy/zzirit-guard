import type { ServerStatus } from "@zzirit-guard/shared";

/** StatusBanner 속성. */
export interface StatusBannerProps {
  /** 서버 상태. 아직 모르면 null. */
  status: ServerStatus | null;
  /** 실시간 연결이 살아 있는지. */
  realtimeConnected: boolean;
}

/** 지금 상태에서 매니저가 알아야 할 문제를 고른다. 없으면 빈 배열. */
function problemsOf(status: ServerStatus | null, realtimeConnected: boolean): string[] {
  if (!status) return ["서버 상태를 불러오는 중입니다."];
  const problems: string[] = [];
  if (!realtimeConnected) problems.push("서버와의 실시간 연결이 끊겼습니다. 다시 연결하는 중입니다.");
  if (!status.channelConnected) problems.push("연결된 채널이 없습니다. 스트리머가 채널을 연결해야 합니다.");
  else if (status.writeLocked) problems.push("치지직 토큰이 만료돼 숨김·제재를 할 수 없습니다. 스트리머가 다시 연결해야 합니다.");
  if (status.channelConnected && !status.chatConnected) problems.push("치지직 채팅 연결이 끊겼습니다. 다시 연결하는 중입니다(끊긴 동안의 채팅은 놓칩니다).");
  return problems;
}

/** 화면 맨 위의 상태 배너(스펙 6장). 늘 떠 있는 status 영역 안에서 문구만 바뀌어야 스크린리더가 변화를 읽는다. */
export function StatusBanner({ status, realtimeConnected }: StatusBannerProps) {
  const problems = problemsOf(status, realtimeConnected);
  return (
    <div role="status" aria-label="서버 상태">
      {problems.length === 0 ? (
        <p className="banner banner-ok">정상 동작 중</p>
      ) : (
        <ul className="banner banner-warning">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
