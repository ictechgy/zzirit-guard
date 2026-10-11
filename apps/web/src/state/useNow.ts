import { useEffect, useState } from "react";

/** intervalMs마다 갱신되는 현재 시각. 후보 10분 창을 화면이 스스로 넘기게 한다. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
