/** 구조화 로그 기록기. 채팅 원문은 절대 넘기지 않는다(식별자만, Global Constraints). */
export interface Logger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

/** 표준 출력에 JSON 한 줄씩 쓴다. launchd가 로그 파일로 모은다. */
export function createConsoleLogger(): Logger {
  /** 레벨 하나에 대응하는 기록 함수를 만든다. 레벨마다 같은 JSON 형식을 쓰려고 한 곳에서 만든다. */
  const write = (level: string) => (message: string, details?: Record<string, unknown>) =>
    console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...details }));
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

/** 아무것도 쓰지 않는 기록기(테스트용). */
export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** 예외를 로그용 한 줄 문자열로 바꾼다. */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
