import { useCallback, useRef, useState } from "react";

/** 진행 중 작업 상태. */
export interface BusyTask {
  /** 작업이 진행 중인지(버튼·입력을 잠그는 데 쓴다). */
  isBusy: boolean;
  /**
   * 작업을 시작한다. 이미 진행 중이면 시작하지 않고 false를 돌려준다.
   * 성공하면 true, 작업이 실패하면 그 오류로 거절한다(호출한 쪽이 사용자 문구로 바꾼다).
   * 동기 예외도 거절된 Promise가 되고, 상태는 finally에서 풀려 버튼이 영구히 잠기지 않는다.
   */
  run(task: () => Promise<unknown>): Promise<boolean>;
}

/**
 * 중복 요청 방지. 왜 ref도 쓰나: state는 다음 렌더에야 바뀌어 같은 틱의 두 번째 클릭을 못 막는다.
 */
export function useBusyTask(): BusyTask {
  const busyRef = useRef(false);
  const [isBusy, setIsBusy] = useState(false);
  const run = useCallback(async (task: () => Promise<unknown>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setIsBusy(true);
    try {
      await new Promise((resolve) => resolve(task()));
      return true;
    } finally {
      busyRef.current = false;
      setIsBusy(false);
    }
  }, []);
  return { isBusy, run };
}
