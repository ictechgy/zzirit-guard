import type { ChatLine } from "@zzirit-guard/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LiveChatScreen } from "../../src/screens/LiveChatScreen";

/** 채팅 줄 예시. */
const lines: ChatLine[] = [
  { senderNickname: "시청자1", content: "안녕하세요", messageTime: 1, decision: "pass" },
  { senderNickname: "악플러", content: "<b>나쁜 말</b>", messageTime: 2, decision: "candidate" },
];

describe("LiveChatScreen", () => {
  it("채팅을 텍스트로만 보여 주고 위험한 줄을 표시한다", () => {
    render(<LiveChatScreen lines={lines} />);
    expect(screen.getByText("<b>나쁜 말</b>")).toBeTruthy();
    expect(screen.getByText("후보")).toBeTruthy();
  });

  it("위험한 것만 보기", async () => {
    render(<LiveChatScreen lines={lines} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "위험한 것만 보기" }));
    expect(screen.queryByText("안녕하세요")).toBeNull();
    expect(screen.getByText("<b>나쁜 말</b>")).toBeTruthy();
  });
});
