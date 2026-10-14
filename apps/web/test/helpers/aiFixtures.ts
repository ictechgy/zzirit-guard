import type { AiStatus } from "@zzirit-guard/shared";

/** AI를 끈 배포의 상태(서버 disabledAiStatus와 같은 모양). 상태 고정 데이터에 붙인다. */
export const AI_OFF: AiStatus = {
  enabled: false,
  stage1: { state: "unknown", model: null, since: 0 },
  stage2: { state: "unknown", model: null, since: 0 },
  queueLength: 0,
  uncheckedLastMinute: { dropped: 0, unchecked: 0 },
};

/** 규칙 판정의 AI 칸(없음). 판정 고정 데이터에 붙인다. */
export const NO_AI = { aiProbability: null, aiCategory: null, sure: false } as const;
