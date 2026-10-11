/**
 * 조건이 참이 될 때까지 20ms 간격으로 기다린다. 비동기 소켓 이벤트를 테스트하려는 것이다.
 * @throws 제한 시간 안에 참이 되지 않으면 예외
 */
export async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waitFor: ${timeoutMs}ms 안에 조건이 충족되지 않았습니다`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
