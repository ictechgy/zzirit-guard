import { describeError, type Logger } from "./logger.js";

/** 처리되지 않은 오류 이벤트를 내는 대상. 실제로는 process이고, 테스트에서는 가짜로 바꾼다. */
export interface FatalErrorSource {
  on(event: "unhandledRejection" | "uncaughtException", listener: (error: unknown) => void): unknown;
}

/**
 * 처리되지 않은 거부·예외를 구조화 로그로 남기고 종료 코드 1로 끝내게 한다.
 * 왜: 기본 동작은 stderr에 스택만 찍고 죽어 운영 로그(JSON)에 원인이 남지 않는다. 로그를 남기고 끝내면 launchd가 다시 띄우고,
 * 운영자는 무엇 때문에 다시 시작됐는지 볼 수 있다(F9.3). 계속 돌리지 않는 이유는 처리되지 않은 예외 뒤의 메모리 상태(대기열·타이머)를 믿을 수 없어서다.
 * 주의: 오류 메시지만 남기고 채팅 원문·토큰은 넘기지 않는다(describeError는 이름과 메시지만 쓴다).
 * @param source 이벤트를 받을 대상(process)
 * @param logger 구조화 로그 기록기
 * @param exit 종료 함수(process.exit). 테스트에서 실제로 끝내지 않으려고 주입한다.
 */
export function installFatalErrorHandlers(source: FatalErrorSource, logger: Logger, exit: (code: number) => void): void {
  source.on("unhandledRejection", (reason) => {
    logger.error("처리되지 않은 비동기 오류로 서버를 끝냅니다", { error: describeError(reason) });
    exit(1);
  });
  source.on("uncaughtException", (error) => {
    logger.error("처리되지 않은 예외로 서버를 끝냅니다", { error: describeError(error) });
    exit(1);
  });
}
