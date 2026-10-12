/**
 * 비동기 작업을 한 번에 하나만 돌게 감싼다. 앞선 실행이 끝나기 전에 다시 불리면 실행하지 않고 onSkip만 부른다(S15, M04).
 * 왜: setInterval·setTimeout은 앞선 비동기 실행을 기다리지 않아, 치지직이 느리거나 백업이 오래 걸리면 역할 재확인·정리·백업·토큰 갱신이
 * 겹쳐 돈다. 겹치면 치지직 호출이 쌓이고, 백업 두 개가 서로의 임시 파일을 지울 수 있다.
 * 작업이 던져도 다음 차례에는 다시 돌도록 finally에서 표시를 내린다. 오류는 호출자에게 그대로 전한다.
 * onSkip에는 연속으로 건너뛴 횟수를 넘긴다(실제로 다시 돌면 0부터 센다, N5). 호출자가 오래 멈춘 작업을 경고로 올리는 데 쓴다.
 * @param task 감쌀 비동기 작업
 * @param onSkip 이전 실행이 아직 돌고 있어 이번 차례를 건너뛸 때 부른다(연속 건너뜀 횟수, 1부터)
 * @returns 타이머 콜백으로 쓸 함수. 같은 작업의 모든 타이머(첫 실행·반복)가 이 함수 하나를 함께 써야 한다
 */
export function runOneAtATime(task: () => Promise<void>, onSkip: (consecutiveSkips: number) => void): () => Promise<void> {
  let isRunning = false;
  let consecutiveSkips = 0;
  return async () => {
    if (isRunning) {
      consecutiveSkips += 1;
      onSkip(consecutiveSkips);
      return;
    }
    isRunning = true;
    consecutiveSkips = 0;
    try {
      await task();
    } finally {
      isRunning = false;
    }
  };
}
