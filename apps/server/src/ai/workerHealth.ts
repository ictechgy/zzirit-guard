import type { AiWorkerState, AiWorkerStatus } from "@zzirit-guard/shared";

/**
 * AI 워커 하나의 상태(계획 R15).
 * - 호출이나 상태 확인이 실패하면 down, 성공하면 ok다. 시작 직후는 unknown이다.
 * - 조용한 채널에서도 워커가 죽은 것을 알도록, 일정 시간 아무 호출이 없으면 상태 확인이 필요하다고 알려 준다.
 * - down이 30초 넘게 이어지면 알림을 한 번만 보내게 한다(짧은 재시작에 알림이 쏟아지지 않게). ok로 돌아오면 다시 보낼 수 있다.
 */
export interface WorkerHealth {
  status(): AiWorkerStatus;
  /** 계약에 맞는 응답을 받았다(모델 식별자를 갱신한다). */
  recordSuccess(model: string, now: number): void;
  /** 워커가 응답했지만 요청을 거절하거나 바빴다(4xx·503). 살아 있다. */
  recordAlive(now: number): void;
  /** 워커에 닿지 못했거나 계약에 어긋난 응답이었다. */
  recordFailure(now: number): void;
  /** 상태 확인이 필요한지: 진행 중인 확인이 없고, 마지막 호출에서 idleProbeMs가 지났다. */
  needsProbe(now: number): boolean;
  /** 상태 확인을 시작한다고 표시한다(겹쳐 보내지 않게). */
  markProbing(now: number): void;
  /** 상태 확인이 끝났다고 표시한다. */
  clearProbing(): void;
  /** down이 알림 기준 시간을 넘었고 아직 알리지 않았으면 true(그리고 알린 것으로 표시한다). */
  takeDownNotice(now: number): boolean;
}

/** 아무 호출이 없을 때 상태를 확인하는 간격(ms). */
export const IDLE_PROBE_MS = 10_000;
/** down이 이 시간(ms) 넘게 이어지면 알린다. */
export const DOWN_NOTICE_MS = 30_000;

/**
 * 워커 상태를 만든다.
 * @param startedAt 시작 시각(ms). unknown 상태의 since다
 * @param idleProbeMs 상태 확인 간격
 * @param downNoticeMs 알림 기준 시간
 */
export function createWorkerHealth(startedAt: number, idleProbeMs = IDLE_PROBE_MS, downNoticeMs = DOWN_NOTICE_MS): WorkerHealth {
  let state: AiWorkerState = "unknown";
  let since = startedAt;
  let model: string | null = null;
  let lastActivityAt = Number.NEGATIVE_INFINITY;
  let isProbing = false;
  let hasNotified = false;
  const moveTo = (next: AiWorkerState, now: number): void => {
    if (state === next) return;
    state = next;
    since = now;
    if (next === "ok") hasNotified = false;
  };
  return {
    status: () => ({ state, model, since }),
    recordSuccess(nextModel, now) {
      model = nextModel;
      lastActivityAt = now;
      moveTo("ok", now);
    },
    recordAlive(now) {
      lastActivityAt = now;
      moveTo("ok", now);
    },
    recordFailure(now) {
      lastActivityAt = now;
      moveTo("down", now);
    },
    needsProbe: (now) => !isProbing && now - lastActivityAt >= idleProbeMs,
    markProbing(now) {
      isProbing = true;
      lastActivityAt = now;
    },
    clearProbing: () => void (isProbing = false),
    takeDownNotice(now) {
      if (state !== "down" || hasNotified || now - since < downNoticeMs) return false;
      hasNotified = true;
      return true;
    },
  };
}
