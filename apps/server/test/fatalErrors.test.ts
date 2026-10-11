import { describe, expect, it, vi } from "vitest";
import { installFatalErrorHandlers } from "../src/fatalErrors.js";
import type { Logger } from "../src/logger.js";

/** 등록된 리스너를 이름별로 모으는 가짜 process. */
function fakeProcess() {
  const listeners = new Map<string, (value: unknown) => void>();
  return { listeners, on: (event: string, listener: (value: unknown) => void) => void listeners.set(event, listener) };
}

describe("installFatalErrorHandlers(F9.3)", () => {
  it.each([
    ["unhandledRejection", "처리되지 않은 비동기 오류로 서버를 끝냅니다"],
    ["uncaughtException", "처리되지 않은 예외로 서버를 끝냅니다"],
  ])("%s를 오류 로그로 남기고 종료 코드 1로 끝낸다", (event, message) => {
    const source = fakeProcess();
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const exit = vi.fn();
    installFatalErrorHandlers(source, logger, exit);
    source.listeners.get(event)?.(new TypeError("망가짐"));
    expect(logger.error).toHaveBeenCalledWith(message, { error: "TypeError: 망가짐" });
    expect(exit).toHaveBeenCalledWith(1);
  });
});
