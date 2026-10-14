import type { AiStatus } from "@zzirit-guard/shared";

/**
 * AI를 끈 배포(ZG_AI_ENABLED 미설정)의 상태. 화면은 enabled가 false면 AI 상태 줄·배너·설정을 보이지 않는다.
 * @param since 서버 시작 시각(ms)
 */
export function disabledAiStatus(since: number): AiStatus {
  return {
    enabled: false,
    stage1: { state: "unknown", model: null, since },
    stage2: { state: "unknown", model: null, since },
    queueLength: 0,
    uncheckedLastMinute: { dropped: 0, unchecked: 0 },
  };
}
