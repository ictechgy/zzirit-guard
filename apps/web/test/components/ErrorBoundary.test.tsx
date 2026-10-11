import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../../src/components/ErrorBoundary";

afterEach(() => vi.restoreAllMocks());

/** 그리자마자 던지는 자식(예: 모르는 데이터로 화면 코드가 실패한 경우). */
function Broken(): never {
  throw new Error("그리기 실패");
}

describe("ErrorBoundary(F10)", () => {
  it("자식이 그리다 던지면 빈 화면 대신 안내와 '다시 불러오기'를 보여 주고, 누르면 다시 불러온다", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onReload = vi.fn();
    render(<ErrorBoundary onReload={onReload}><Broken /></ErrorBoundary>);
    expect(screen.getByRole("alert").textContent).toContain("문제가 생겼습니다");
    await userEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
  });

  it("문제가 없으면 자식을 그대로 그린다", () => {
    render(<ErrorBoundary><p>정상 화면</p></ErrorBoundary>);
    expect(screen.getByText("정상 화면")).toBeTruthy();
  });
});
