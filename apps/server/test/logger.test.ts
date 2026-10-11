import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsoleLogger } from "../src/logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createConsoleLogger", () => {
  it("details에 message·level·time이 있어도 기록의 레벨·문구·시각을 덮어쓰지 않는다(F8)", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    createConsoleLogger().warn("쓰기 요청 실패", { message: "x", level: "debug", time: "가짜 시각", verdictId: 3 });
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ level: "warn", message: "쓰기 요청 실패", verdictId: 3 });
    expect(record.time).not.toBe("가짜 시각");
  });
});
