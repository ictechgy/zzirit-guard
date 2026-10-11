import type { MeDto, ServerStatus, VerdictDto } from "@zzirit-guard/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/client";
import { buildSections } from "../../src/domain/candidates";
import { CandidatesScreen, type CandidateActions } from "../../src/screens/CandidatesScreen";

/** 채팅 운영자. */
const chatManager: MeDto = { channelId: "m1", channelName: "매니저1", role: "STREAMING_CHAT_MANAGER", permissions: ["disable_auto_hide", "hide_message", "temporary_restrict"] };
/** 정상 상태. */
const status: ServerStatus = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, lastChatAt: null, pendingActions: 0 };
/** 기준 시각. */
const NOW = 1_000_000;

/** 판정 예시. */
function verdict(id: number, overrides: Partial<VerdictDto> = {}): VerdictDto {
  return { id, chatChannelId: "chat-1", senderChannelId: "bad", senderNickname: "악플러", content: `나쁜 말 ${id}`, messageTime: id, decision: "candidate", reason: "rule:weak:1", status: "pending", createdAt: NOW - id * 1000, ...overrides };
}

/** 모든 동작이 안내 없이 성공하는 가짜. */
function fakeActions(overrides: Partial<CandidateActions> = {}): CandidateActions {
  const succeed = async () => null;
  return { hide: vi.fn(succeed), temporaryRestrict: vi.fn(succeed), ignore: vi.fn(succeed), reportFalsePositive: vi.fn(succeed), setAutoHide: vi.fn(succeed), ...overrides };
}

/** 화면을 그린다. status를 null로 넘기면 서버 상태를 아직 모르는 경우다. */
function renderScreen(verdicts: VerdictDto[], actions = fakeActions(), currentStatus: ServerStatus | null = status) {
  const onReload = vi.fn();
  render(<CandidatesScreen me={chatManager} status={currentStatus} sections={buildSections(verdicts, NOW)} realtimeConnected actions={actions} onReload={onReload} />);
  return { actions, onReload };
}

describe("CandidatesScreen", () => {
  it("사람 단위로 묶어 건수와 메시지를 보여 주고, 섀도는 따로 보여 준다", () => {
    renderScreen([verdict(1), verdict(2), verdict(3, { decision: "shadow", senderNickname: "도배러", senderChannelId: "spam" })]);
    expect(screen.getByText("악플러")).toBeTruthy();
    expect(screen.getByText("2건")).toBeTruthy();
    expect(screen.getByText("나쁜 말 1")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /켜져 있었으면 숨겼을 메시지/ })).toBeTruthy();
  });

  it("판정마다 이유(규칙 번호)를 보여 준다(R-5)", () => {
    renderScreen([verdict(1, { reason: "rule:strong_spanning:4" })]);
    expect(screen.getByText("금칙어 강(띄어 쓰거나 단어를 걸침) #4")).toBeTruthy();
  });

  it("숨기기를 누르면 그 판정으로 동작을 부른다", async () => {
    const { actions } = renderScreen([verdict(1)]);
    await userEvent.click(screen.getByRole("button", { name: "숨기기" }));
    expect(actions.hide).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("채팅 운영자는 자동 숨김을 켤 수 없다(버튼 비활성)", () => {
    renderScreen([]);
    expect((screen.getByRole("button", { name: /자동 숨김: 꺼짐/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("서버 상태를 아직 모르면 스위치를 누를 수 없다", () => {
    renderScreen([], fakeActions(), null);
    expect((screen.getByRole("button", { name: "자동 숨김: 확인 중" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("실패하면 서버가 준 이유를 보여 준다", async () => {
    renderScreen([verdict(1)], fakeActions({ hide: async () => { throw new ApiError(502, "chzzk_failed", "치지직 호출 한도를 넘었습니다. 잠시 뒤 다시 시도하세요."); } }));
    await userEvent.click(screen.getByRole("button", { name: "숨기기" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/호출 한도/));
  });

  it("성공하면 서버 안내(note)를 보여 준다(R-13)", async () => {
    renderScreen([verdict(1)], fakeActions({ hide: async () => "이미 사라진 메시지입니다" }));
    await userEvent.click(screen.getByRole("button", { name: "숨기기" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("이미 사라진 메시지입니다"));
  });

  it("이미 처리된 판정(409 already_handled)이면 이유를 보여 주고 목록을 다시 읽는다(R-13)", async () => {
    const conflict = new ApiError(409, "already_handled", "이미 다른 조치가 끝난 판정입니다. 화면을 새로고침해 현재 상태를 확인하세요.");
    const { onReload } = renderScreen([verdict(1)], fakeActions({ ignore: async () => { throw conflict; } }));
    await userEvent.click(screen.getByRole("button", { name: "무시" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/이미 다른 조치가 끝난 판정/));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("'다시 불러오기'를 누르면 목록을 다시 읽는다(iOS 홈 화면 앱에는 새로고침이 없다)", async () => {
    const { onReload } = renderScreen([]);
    await userEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("아직 숨겨지지 않은 자동 숨김은 '숨김 대기·실패'에 숨기기 버튼과 함께, 숨겨진 것만 '자동 숨김됨'에 보여 준다(R-4)", async () => {
    const { actions } = renderScreen([
      verdict(1, { decision: "auto_hide", content: "못 숨긴 광고" }),
      verdict(2, { decision: "auto_hide", status: "hidden", content: "숨긴 광고" }),
    ]);
    const pendingSection = screen.getByRole("heading", { name: /숨김 대기·실패\(1건\)/ }).closest("section") as HTMLElement;
    expect(pendingSection.textContent).toContain("못 숨긴 광고");
    expect(pendingSection.textContent).not.toContain("숨긴 광고 ");
    expect(screen.getByText(/자동 숨김됨\(최근 10분, 1건\)/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "숨기기" }));
    expect(actions.hide).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("후보가 없으면 안내 문구", () => {
    renderScreen([]);
    expect(screen.getByText(/지금 확인할 후보가 없습니다/)).toBeTruthy();
  });
});
