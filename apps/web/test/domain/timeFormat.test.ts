import { afterEach, describe, expect, it, vi } from "vitest";
import { formatClockTime, formatDateTime } from "../../src/domain/timeFormat";

/** 기준 시각. */
const TIMESTAMP = Date.UTC(2026, 9, 12, 5, 3, 21);

afterEach(() => vi.restoreAllMocks());

describe("timeFormat(F4)", () => {
  it("시각 표시는 이전 toLocale* 결과와 같다", () => {
    expect(formatClockTime(TIMESTAMP)).toBe(new Date(TIMESTAMP).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    expect(formatDateTime(TIMESTAMP)).toBe(new Date(TIMESTAMP).toLocaleString("ko-KR"));
    expect(formatDateTime(null)).toBe("—");
  });

  it("부를 때마다 로캘 형식기를 새로 만들지 않고 모듈의 형식기를 다시 쓴다(몰려드는 목록에서 비싸다)", () => {
    const clock = vi.spyOn(Date.prototype, "toLocaleTimeString");
    const dateTime = vi.spyOn(Date.prototype, "toLocaleString");
    for (let index = 0; index < 3; index += 1) {
      formatClockTime(TIMESTAMP + index);
      formatDateTime(TIMESTAMP + index);
    }
    expect(clock).not.toHaveBeenCalled();
    expect(dateTime).not.toHaveBeenCalled();
  });
});
