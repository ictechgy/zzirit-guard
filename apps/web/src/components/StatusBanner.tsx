import type { ServerStatus } from "@zzirit-guard/shared";
import { API_BASE } from "../api/client";

/** StatusBanner 속성. */
export interface StatusBannerProps {
  /** 서버 상태. 아직 모르면 null. */
  status: ServerStatus | null;
  /** 실시간 연결이 살아 있는지. */
  realtimeConnected: boolean;
  /**
   * 채널 연결 권한(connect_channel, 스트리머)이 있는지. 쓰기가 잠기거나 채널 연결이 없을 때 '채널 다시 연결' 링크를 보여 준다.
   * 왜: iOS 홈 화면 앱에는 주소 표시줄이 없어, 링크가 없으면 로그아웃해야만 재연결할 수 있다. 로그아웃하면 장애 알림 구독과 스트리머 한도 예외(B10)도 잃는다(F1).
   */
  canReconnectChannel: boolean;
  /**
   * 실시간 연결이 스스로 다시 연결하지 않고 멈춰 있는지(거듭 거절·다른 창에 밀림). 생략하면 멈추지 않은 것으로 본다.
   * 왜: 멈췄는데 "다시 연결하는 중"이라고 하면, 매니저가 위 안내의 '다시 연결'을 누르지 않고 기다리기만 한다.
   */
  isRealtimePaused?: boolean;
}

/** 실시간 연결이 끊겨 스스로 다시 연결하는 중일 때의 문구. */
const REALTIME_RECONNECTING = "서버와의 실시간 연결이 끊겼습니다. 다시 연결하는 중입니다.";
/** 실시간 연결이 멈춰 매니저가 다시 연결해야 할 때의 문구. 안내와 '다시 연결'은 화면 맨 위에 있다(MainScreen). */
const REALTIME_PAUSED = "서버와의 실시간 연결이 멈췄습니다. 위 안내의 '다시 연결'을 누르세요.";

/** 스트리머가 채널을 다시 연결해야 하는 상태인지(쓰기 잠김 또는 채널 연결 없음). */
function needsChannelReconnect(status: ServerStatus | null): boolean {
  return status !== null && (status.writeLocked || !status.channelConnected);
}

/** 지금 상태에서 매니저가 알아야 할 문제를 고른다. 없으면 빈 배열. */
function problemsOf(status: ServerStatus | null, realtimeConnected: boolean, isRealtimePaused: boolean): string[] {
  if (!status) return ["서버 상태를 불러오는 중입니다."];
  const problems: string[] = [];
  if (!realtimeConnected) problems.push(isRealtimePaused ? REALTIME_PAUSED : REALTIME_RECONNECTING);
  if (!status.channelConnected) problems.push("연결된 채널이 없습니다. 스트리머가 채널을 연결해야 합니다.");
  else if (status.writeLocked) problems.push("치지직 토큰이 만료돼 숨김·제재를 할 수 없습니다. 스트리머가 다시 연결해야 합니다.");
  if (status.channelConnected && !status.chatConnected) problems.push("치지직 채팅 연결이 끊겼습니다. 다시 연결하는 중입니다(끊긴 동안의 채팅은 놓칩니다).");
  return problems;
}

/**
 * 화면 맨 위의 상태 배너(스펙 6장). 늘 떠 있는 status 영역 안에서 문구만 바뀌어야 스크린리더가 변화를 읽는다.
 * 스트리머에게는 재연결이 필요할 때 '채널 다시 연결' 링크를 함께 둔다(F1).
 */
export function StatusBanner({ status, realtimeConnected, canReconnectChannel, isRealtimePaused = false }: StatusBannerProps) {
  const problems = problemsOf(status, realtimeConnected, isRealtimePaused);
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
      {canReconnectChannel && needsChannelReconnect(status) && <a className="button primary" href={`${API_BASE}/auth/connect`}>채널 다시 연결</a>}
    </div>
  );
}
