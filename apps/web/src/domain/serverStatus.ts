import type { AiStatus, ServerStatus } from "@zzirit-guard/shared";

/** AI 칸이 없는 서버 상태(AI 단계 이전 서버)에 채우는 'AI 꺼짐'. */
export const AI_DISABLED: AiStatus = {
  enabled: false,
  stage1: { state: "unknown", model: null, since: 0 },
  stage2: { state: "unknown", model: null, since: 0 },
  queueLength: 0,
  uncheckedLastMinute: { dropped: 0, unchecked: 0 },
};

/**
 * 서버 상태의 AI 칸을 채운다. REST·WebSocket으로 받은 상태를 화면 상태에 넣기 전에 부른다.
 * 왜: 열려 있던 화면이 되돌린(롤백한) 서버나 이전 판의 응답을 받으면 ai가 없다. 그대로 쓰면 화면 전체가 오류 경계로 떨어져
 * 매니저가 후보를 볼 수 없게 된다. 없으면 'AI 꺼짐'으로 본다.
 * @param status 서버가 보낸 상태
 */
export function withAiStatus(status: ServerStatus): ServerStatus {
  const ai: unknown = (status as Partial<ServerStatus>).ai;
  return typeof ai === "object" && ai !== null ? status : { ...status, ai: AI_DISABLED };
}
