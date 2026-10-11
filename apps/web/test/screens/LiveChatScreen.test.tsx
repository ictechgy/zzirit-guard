import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LiveChatScreen } from "../../src/screens/LiveChatScreen";
import type { ChatLineEntry } from "../../src/state/serverReducer";

/** 판정별 줄을 만든다. 본문은 판정마다 다르게 두어 찾기 쉽게 한다. */
function entry(seq: number, decision: ChatLineEntry["decision"], overrides: Partial<ChatLineEntry> = {}): ChatLineEntry {
  return { seq, senderNickname: "시청자", content: `본문${seq}-${decision}`, messageTime: seq, decision, ...overrides };
}

/** 채팅 줄 예시. */
const lines: ChatLineEntry[] = [
  { senderNickname: "시청자1", content: "안녕하세요", messageTime: 1, decision: "pass", seq: 0 },
  { senderNickname: "악플러", content: "<b>나쁜 말</b>", messageTime: 2, decision: "candidate", seq: 1 },
];

/** 본문 텍스트가 들어 있는 줄(li) 요소를 찾는다. */
function rowOf(content: string): HTMLElement {
  const row = screen.getByText(content).closest("li");
  if (!row) throw new Error(`줄 요소를 찾지 못했습니다: ${content}`);
  return row;
}

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

  it("섀도·자동 숨김·도움 필요는 이름표를 달고, 위험한 것만 볼 때도 남는다", async () => {
    const decisions = [entry(0, "pass"), entry(1, "shadow"), entry(2, "auto_hide"), entry(3, "needs_care")];
    render(<LiveChatScreen lines={decisions} />);
    expect(within(rowOf("본문1-shadow")).getByText("섀도")).toBeTruthy();
    expect(within(rowOf("본문2-auto_hide")).getByText("자동 숨김")).toBeTruthy();
    expect(within(rowOf("본문3-needs_care")).getByText("도움 필요")).toBeTruthy();

    await userEvent.click(screen.getByRole("checkbox", { name: "위험한 것만 보기" }));
    expect(screen.queryByText("본문0-pass")).toBeNull();
    expect(screen.getByText("본문1-shadow")).toBeTruthy();
    expect(screen.getByText("본문2-auto_hide")).toBeTruthy();
    expect(screen.getByText("본문3-needs_care")).toBeTruthy();
  });

  it("최신 줄이 위로 온다", () => {
    render(<LiveChatScreen lines={[entry(0, "pass"), entry(1, "candidate"), entry(2, "pass")]} />);
    const contents = screen.getAllByRole("listitem").map((row) => row.querySelector(".content")?.textContent);
    expect(contents).toEqual(["본문2-pass", "본문1-candidate", "본문0-pass"]);
  });

  it("표시할 줄이 없으면 빈 안내를 보여 준다", () => {
    const { unmount } = render(<LiveChatScreen lines={[]} />);
    expect(screen.getByText("표시할 채팅이 없습니다.")).toBeTruthy();
    unmount();

    render(<LiveChatScreen lines={[entry(0, "pass")]} />);
    expect(screen.queryByText("표시할 채팅이 없습니다.")).toBeNull();
  });

  it("위험한 것만 볼 때 위험한 줄이 하나도 없으면 빈 안내를 보여 준다", async () => {
    render(<LiveChatScreen lines={[entry(0, "pass")]} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "위험한 것만 보기" }));
    expect(screen.getByText("표시할 채팅이 없습니다.")).toBeTruthy();
  });

  it("줄에 판정별 chat-<판정> 클래스를 붙인다", () => {
    render(<LiveChatScreen lines={[entry(0, "auto_hide"), entry(1, "pass")]} />);
    expect(rowOf("본문0-auto_hide").classList.contains("chat-auto_hide")).toBe(true);
    expect(rowOf("본문1-pass").classList.contains("chat-pass")).toBe(true);
  });

  it("통과 줄에는 이름표가 없다", () => {
    render(<LiveChatScreen lines={[entry(0, "pass")]} />);
    expect(rowOf("본문0-pass").querySelector(".tag")).toBeNull();
  });

  it("같은 시각의 줄도 모두 보인다", () => {
    render(<LiveChatScreen lines={[entry(0, "pass", { messageTime: 5 }), entry(1, "candidate", { messageTime: 5 })]} />);
    expect(screen.getByText("본문0-pass")).toBeTruthy();
    expect(screen.getByText("본문1-candidate")).toBeTruthy();
  });

  it("줄이 추가돼도 기존 줄의 행 요소는 다시 만들어지지 않는다", () => {
    const { rerender } = render(<LiveChatScreen lines={[entry(0, "pass")]} />);
    const before = rowOf("본문0-pass");
    rerender(<LiveChatScreen lines={[entry(0, "pass"), entry(1, "candidate")]} />);
    expect(rowOf("본문0-pass")).toBe(before);
  });
});
