import { useCallback, useRef, useState } from "react";

/**
 * 진행 중인 동작의 열쇠별 잠금.
 * 왜 열쇠별인가: 서버 실행기는 요청을 하나씩, 재시도·대기까지 하며 처리하고 요청에는 시간 제한(15초)이 있어,
 * 잠금 하나를 모든 버튼이 함께 쓰면 숨기기 한 건이 다른 줄의 조치와 자동 숨김 끄기(안전장치, 스펙 5.5·7장)까지 수십 초 막는다(F2).
 * 같은 열쇠(같은 판정·같은 사람·같은 스위치 방향)만 막아 두 번 보내기는 그대로 막는다.
 */
export interface ActionLocks {
  /** 지금 잠긴 열쇠들. 버튼을 잠그는 데 쓴다(바뀔 때만 새 집합이 된다). */
  lockedKeys: ReadonlySet<string>;
  /**
   * 열쇠가 비어 있으면 잠그고 true, 이미 잠겨 있으면 false.
   * @param key verdictLockKey·senderLockKey·autoHideLockKey가 만든 열쇠
   */
  tryLock(key: string): boolean;
  /**
   * 열쇠를 푼다(성공·실패 모두).
   * @param key tryLock에 넘긴 열쇠
   */
  unlock(key: string): void;
}

/**
 * 판정 하나에 대한 동작(숨기기·무시·오판)의 열쇠.
 * @param verdictId 판정 번호
 */
export function verdictLockKey(verdictId: number): string {
  return `verdict:${verdictId}`;
}

/**
 * 사람 단위 동작(임시 제한)의 열쇠.
 * @param senderChannelId 보낸 사람 채널 ID
 */
export function senderLockKey(senderChannelId: string): string {
  return `sender:${senderChannelId}`;
}

/**
 * 자동 숨김 스위치의 열쇠. 방향별로 나눈다.
 * 왜: 켜기 요청이 늦게 끝나는 동안에도 끄기(안전장치)는 바로 보내야 하고, 같은 방향을 두 번 누르는 것만 막으면 된다.
 * @param enabled 바꾸려는 값(true=켜기, false=끄기)
 */
export function autoHideLockKey(enabled: boolean): string {
  return `auto-hide:${enabled ? "on" : "off"}`;
}

/**
 * 열쇠별 잠금을 만든다. 왜 ref도 쓰나: state는 다음 렌더에야 바뀌어 같은 틱의 두 번째 클릭을 막지 못한다.
 * tryLock·unlock은 렌더마다 같은 함수라 자식에게 넘겨도 다시 그리게 만들지 않는다.
 */
export function useActionLocks(): ActionLocks {
  const lockedRef = useRef<Set<string>>(new Set());
  const [lockedKeys, setLockedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const tryLock = useCallback((key: string): boolean => {
    if (lockedRef.current.has(key)) return false;
    lockedRef.current.add(key);
    setLockedKeys(new Set(lockedRef.current));
    return true;
  }, []);
  const unlock = useCallback((key: string): void => {
    if (!lockedRef.current.delete(key)) return;
    setLockedKeys(new Set(lockedRef.current));
  }, []);
  return { lockedKeys, tryLock, unlock };
}
