import type { MeDto, ServerStatus, VerdictDto } from "@zzirit-guard/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/client";
import { formatClockTime } from "../../src/domain/timeFormat";
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
    await userEvent.click(screen.getByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ }));
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
    await userEvent.click(screen.getByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/호출 한도/));
  });

  it("성공하면 서버 안내(note)를 보여 준다(R-13)", async () => {
    renderScreen([verdict(1)], fakeActions({ hide: async () => "이미 사라진 메시지입니다" }));
    await userEvent.click(screen.getByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ }));
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 결과" }).textContent).toBe("이미 사라진 메시지입니다"));
  });

  it("이미 처리된 판정(409 already_handled)이면 이유를 보여 주고 목록을 다시 읽는다(R-13)", async () => {
    const conflict = new ApiError(409, "already_handled", "이미 다른 조치가 끝난 판정입니다. 화면을 새로고침해 현재 상태를 확인하세요.");
    const { onReload } = renderScreen([verdict(1)], fakeActions({ ignore: async () => { throw conflict; } }));
    await userEvent.click(screen.getByRole("button", { name: /^악플러의 .+ 메시지 무시$/ }));
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
      verdict(1, { decision: "auto_hide", content: "대기 항목" }),
      verdict(2, { decision: "auto_hide", status: "hidden", content: "완료 항목" }),
    ]);
    const pendingSection = screen.getByRole("heading", { name: /숨김 대기·실패\(1건\)/ }).closest("section") as HTMLElement;
    expect(within(pendingSection).getByText(/대기 항목/)).toBeTruthy();
    expect(within(pendingSection).queryByText(/완료 항목/)).toBeNull();
    const hiddenDetails = screen.getByText(/자동 숨김됨\(최근 10분, 1건\)/).closest("details") as HTMLElement;
    expect(within(hiddenDetails).getByText(/완료 항목/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ }));
    expect(actions.hide).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("사용자 제한된 자동 숨김은 '자동 숨김됨'이 아니라 별도 항목에, 숨기기 버튼 없이 오판만 보여 준다", async () => {
    const { actions } = renderScreen([verdict(1, { decision: "auto_hide", status: "restricted", content: "제한 항목" })]);
    const restrictedDetails = screen.getByText(/사용자 제한됨 \(메시지는 아직 보일 수 있음\)/).closest("details") as HTMLElement;
    expect(within(restrictedDetails).getByText(/제한 항목/)).toBeTruthy();
    expect(within(restrictedDetails).queryByRole("button", { name: /숨기기/ })).toBeNull();
    expect(screen.queryByText(/자동 숨김됨\(/)).toBeNull();
    await userEvent.click(within(restrictedDetails).getByRole("button", { name: /^악플러의 .+ 메시지 오판 신고$/ }));
    expect(actions.reportFalsePositive).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("동작이 끝나기 전에는 그 줄의 버튼이 잠기고 같은 동작이 두 번 가지 않는다", async () => {
    const hide = vi.fn(() => new Promise<string | null>(() => undefined));
    renderScreen([verdict(1)], fakeActions({ hide }));
    const button = screen.getByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ }) as HTMLButtonElement;
    await userEvent.dblClick(button);
    await userEvent.click(button);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
  });

  it("숨기기가 끝나지 않아도 자동 숨김 끄기는 바로 보낸다(안전장치, F2)", async () => {
    const hide = vi.fn(() => new Promise<string | null>(() => undefined));
    const actions = fakeActions({ hide });
    renderScreen([verdict(1)], actions, { ...status, autoHideEnabled: true });
    await userEvent.click(screen.getByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ }));
    const toggle = screen.getByRole("button", { name: /자동 숨김: 켜짐/ }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    await userEvent.click(toggle);
    expect(actions.setAutoHide).toHaveBeenCalledWith(false);
  });

  it("한 줄의 숨기기가 진행 중이어도 다른 줄의 숨기기는 보낸다(F2)", async () => {
    const hide = vi.fn((_target: VerdictDto) => new Promise<string | null>(() => undefined));
    renderScreen([verdict(1), verdict(2)], fakeActions({ hide }));
    const [first, second] = screen.getAllByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ }) as HTMLButtonElement[];
    await userEvent.click(first as HTMLButtonElement);
    expect((second as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(second as HTMLButtonElement);
    expect(hide.mock.calls.map(([target]) => target.id)).toEqual([1, 2]);
  });

  it("동작이 실패해도 버튼이 다시 풀린다", async () => {
    renderScreen([verdict(1)], fakeActions({ hide: async () => { throw new ApiError(502, "chzzk_failed", "실패"); } }));
    await userEvent.click(screen.getByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ }));
    await waitFor(() => expect((screen.getByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("자동 숨김 켜기는 확인 후 setAutoHide(true), 취소하면 부르지 않는다", async () => {
    const admin: MeDto = { ...chatManager, permissions: ["enable_auto_hide", "disable_auto_hide"] };
    const actions = fakeActions();
    render(<CandidatesScreen me={admin} status={status} sections={buildSections([], NOW)} realtimeConnected actions={actions} onReload={vi.fn()} />);
    const confirm = vi.spyOn(window, "confirm");
    confirm.mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole("button", { name: /자동 숨김: 꺼짐/ }));
    expect(actions.setAutoHide).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole("button", { name: /자동 숨김: 꺼짐/ }));
    expect(actions.setAutoHide).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: /자동 숨김: 꺼짐/ }).getAttribute("aria-pressed")).toBe("false");
    confirm.mockRestore();
  });

  it("임시 제한은 그 사람 묶음으로 부른다", async () => {
    const { actions } = renderScreen([verdict(1), verdict(2)]);
    await userEvent.click(screen.getByRole("button", { name: "악플러 임시 제한" }));
    expect(actions.temporaryRestrict).toHaveBeenCalledWith(expect.objectContaining({ senderChannelId: "bad" }));
  });

  it("카드에는 메시지를 최대 3건만 보여 준다", () => {
    renderScreen([verdict(1), verdict(2), verdict(3), verdict(4), verdict(5)]);
    expect(screen.getByText("5건")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ })).toHaveLength(3);
  });

  it("동기로 던지는 동작도 오류를 보여 주고 버튼을 풀며 다시 누를 수 있다", async () => {
    const hide = vi.fn((): Promise<string | null> => { throw new Error("동기 실패"); });
    renderScreen([verdict(1)], fakeActions({ hide }));
    const name = /^악플러의 .+ 메시지 숨기기$/;
    await userEvent.click(screen.getByRole("button", { name }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    await waitFor(() => expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole("button", { name }));
    expect(hide).toHaveBeenCalledTimes(2);
  });

  it("같은 사람의 두 줄은 접근성 이름이 서로 다르다", () => {
    renderScreen([verdict(1), verdict(2)]);
    const names = screen.getAllByRole("button", { name: /메시지 숨기기$/ }).map((button) => button.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(2);
    expect(names).toContain(`악플러의 ${formatClockTime(NOW - 1000)} 메시지 숨기기`);
  });

  it("상태 배너는 늘 떠 있는 status 영역 안에 있다", () => {
    renderScreen([]);
    expect(within(screen.getByRole("status", { name: "서버 상태" })).getByText("정상 동작 중")).toBeTruthy();
  });

  it("쓰기가 잠겨도 채팅 운영자의 배너에는 '채널 다시 연결' 링크가 없고, 스트리머에게는 있다(F1)", () => {
    const { unmount } = render(<CandidatesScreen me={chatManager} status={{ ...status, writeLocked: true }} sections={buildSections([], NOW)} realtimeConnected actions={fakeActions()} onReload={vi.fn()} />);
    expect(screen.queryByRole("link", { name: "채널 다시 연결" })).toBeNull();
    unmount();
    const owner: MeDto = { ...chatManager, role: "STREAMING_CHANNEL_OWNER", permissions: [...chatManager.permissions, "connect_channel"] };
    render(<CandidatesScreen me={owner} status={{ ...status, writeLocked: true }} sections={buildSections([], NOW)} realtimeConnected actions={fakeActions()} onReload={vi.fn()} />);
    expect(within(screen.getByRole("status", { name: "서버 상태" })).getByRole("link", { name: "채널 다시 연결" })).toBeTruthy();
  });

  it("후보가 없으면 안내 문구", () => {
    renderScreen([]);
    expect(screen.getByText(/지금 확인할 후보가 없습니다/)).toBeTruthy();
  });
});
