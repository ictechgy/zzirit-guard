import type { VerdictStatus } from "@zzirit-guard/shared";
import { useCallback, useEffect, useRef } from "react";
import { findVerdictStatus, type CandidateSections } from "../domain/candidates";

/**
 * 시간이 초과된 조치의 잠금을 붙잡아 두는 최대 시간(60초, B19-7).
 * 왜: 응답이 늦었을 뿐 서버 실행기는 재시도까지 하며 조치를 끝낼 수 있다. 곧바로 잠금을 풀면 매니저가 다시 눌러 같은 조치가 두 번 간다.
 * 그 판정의 상태가 바뀌면(서버가 처리했으면) 이보다 먼저 푼다. 실행기의 재시도(1·2·4초)와 대기열을 넉넉히 덮는다.
 */
export const TIMEOUT_LOCK_MS = 60_000;

/** 붙잡아 둔 잠금 하나. */
interface HeldLock {
  /** 지켜볼 판정 번호. null이면 상태 변화로 일찍 풀지 않고 TIMEOUT_LOCK_MS가 지나야 푼다(holdFor). */
  verdictId: number | null;
  /** 조치를 시작할 때의 그 판정 상태(구역에 없었으면 null). 이 값에서 바뀌면 처리된 것으로 본다. */
  statusAtStart: VerdictStatus | null;
  /** TIMEOUT_LOCK_MS 뒤에 푸는 타이머. */
  timer: ReturnType<typeof setTimeout>;
}

/** useTimeoutHolds 결과. */
export interface TimeoutHolds {
  /**
   * 시간이 초과된 조치의 잠금을 붙잡아 둔다. 지켜볼 판정의 상태가 statusAtStart에서 바뀌거나 TIMEOUT_LOCK_MS가 지나면 푼다.
   * 붙잡을 때 이미 바뀌어 있으면(응답만 늦고 처리 알림은 먼저 왔으면) 바로 푼다.
   * @param lockKey 붙잡을 잠금 열쇠(useActionLocks)
   * @param verdictId 지켜볼 판정 번호
   * @param statusAtStart 조치를 시작할 때의 그 판정 상태
   */
  hold(lockKey: string, verdictId: number, statusAtStart: VerdictStatus | null): void;
  /**
   * 판정 상태와 관계없이 TIMEOUT_LOCK_MS 동안 잠금을 붙잡아 둔다(W2, M20).
   * 왜: 임시 제한은 사람 단위인데 서버는 묶음의 첫 판정만 restricted로 바꾼다. 상태 변화로 풀면 남은 판정 때문에 카드가 남아
   * 곧바로 같은 사람에게 임시 제한을 다시 보낼 수 있다.
   * @param lockKey 붙잡을 잠금 열쇠(useActionLocks)
   */
  holdFor(lockKey: string): void;
}

/**
 * 시간이 초과된 조치의 잠금을 판정 상태가 바뀔 때까지(최대 TIMEOUT_LOCK_MS) 붙잡는다(B19-7).
 * 상태 변화는 실시간 verdict_status 이벤트나 다시 읽은 목록이 최신 구역(latest)에 반영된 것으로 본다.
 * @param latest 최신 구역(고정 화면이 아니라 MainScreen이 계산한 값)
 * @param unlock 잠금을 푸는 함수(useActionLocks.unlock, 렌더마다 같은 함수)
 */
export function useTimeoutHolds(latest: CandidateSections, unlock: (lockKey: string) => void): TimeoutHolds {
  const heldRef = useRef(new Map<string, HeldLock>());
  const latestRef = useRef(latest);
  const release = useCallback((lockKey: string) => {
    const held = heldRef.current.get(lockKey);
    if (!held) return;
    clearTimeout(held.timer);
    heldRef.current.delete(lockKey);
    unlock(lockKey);
  }, [unlock]);
  const hold = useCallback((lockKey: string, verdictId: number, statusAtStart: VerdictStatus | null) => {
    if (findVerdictStatus(latestRef.current, verdictId) !== statusAtStart) return unlock(lockKey);
    heldRef.current.set(lockKey, { verdictId, statusAtStart, timer: setTimeout(() => release(lockKey), TIMEOUT_LOCK_MS) });
  }, [release, unlock]);
  const holdFor = useCallback((lockKey: string) => {
    clearTimeout(heldRef.current.get(lockKey)?.timer);
    heldRef.current.set(lockKey, { verdictId: null, statusAtStart: null, timer: setTimeout(() => release(lockKey), TIMEOUT_LOCK_MS) });
  }, [release]);
  useEffect(() => {
    latestRef.current = latest;
    for (const [lockKey, held] of heldRef.current) {
      if (held.verdictId !== null && findVerdictStatus(latest, held.verdictId) !== held.statusAtStart) release(lockKey);
    }
  }, [latest, release]);
  useEffect(() => () => {
    heldRef.current.forEach((held) => clearTimeout(held.timer));
    heldRef.current.clear();
  }, []);
  return { hold, holdFor };
}
