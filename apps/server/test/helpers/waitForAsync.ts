/** 비동기 조건이 참이 될 때까지 50ms 간격으로 기다린다(HTTP 조회로 상태를 확인할 때). */
export async function waitForAsync(condition: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`waitForAsync: ${timeoutMs}ms 안에 조건이 충족되지 않았습니다`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
