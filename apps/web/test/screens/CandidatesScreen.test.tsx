import type { MeDto, ServerStatus, VerdictDto } from "@zzirit-guard/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/client";
import { formatClockTime } from "../../src/domain/timeFormat";
import { buildSections } from "../../src/domain/candidates";
import { CandidatesScreen, type CandidateActions } from "../../src/screens/CandidatesScreen";
import { TIMEOUT_LOCK_MS } from "../../src/state/useTimeoutHolds";

/** 채팅 운영자. */
const chatManager: MeDto = { channelId: "m1", channelName: "매니저1", role: "STREAMING_CHAT_MANAGER", permissions: ["disable_auto_hide", "hide_message", "temporary_restrict"] };
/** 정상 상태. */
const status: ServerStatus = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, autoHideOffReason: null, lastChatAt: null, pendingActions: 0 };
/** 기준 시각. */
const NOW = 1_000_000;
/** 시스템 꺼짐 안내를 띄우지 않는 속성(F8 안내는 MainScreen 테스트가 다룬다). */
const noNotice = { systemDisableNotice: null, onDismissSystemDisableNotice: () => undefined };

/** 판정 예시. */
function verdict(id: number, overrides: Partial<VerdictDto> = {}): VerdictDto {
  return { id, chatChannelId: "chat-1", senderChannelId: "bad", senderNickname: "악플러", content: `나쁜 말 ${id}`, messageTime: id, decision: "candidate", reason: "rule:weak:1", status: "pending", createdAt: NOW - id * 1000, ...overrides };
}

/** 모든 동작이 안내 없이 성공하는 가짜. */
function fakeActions(overrides: Partial<CandidateActions> = {}): CandidateActions {
  const succeed = async () => null;
  return { hide: vi.fn(succeed), temporaryRestrict: vi.fn(succeed), ignore: vi.fn(succeed), reportFalsePositive: vi.fn(succeed), setAutoHide: vi.fn(succeed), ...overrides };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "scrollY");
  Reflect.deleteProperty(document, "visibilityState");
});

/**
 * 판정이 바뀌는 화면을 그린다. update로 새 판정 목록을 넣어 실시간 이벤트를 흉내 낸다(다른 속성은 그대로).
 * @param verdicts 처음 판정 목록
 */
function renderLive(verdicts: VerdictDto[]) {
  const actions = fakeActions();
  const onReload = vi.fn();
  const screenFor = (next: VerdictDto[]) => <CandidatesScreen me={chatManager} status={status} sections={buildSections(next, NOW)} realtimeConnected actions={actions} onReload={onReload} {...noNotice} />;
  const { rerender } = render(screenFor(verdicts));
  return { update: (next: VerdictDto[]) => rerender(screenFor(next)) };
}

/** 화면에 보이는 사람 묶음 카드의 닉네임을 위에서부터 읽는다. */
function cardOrder(): string[] {
  return screen.queryAllByRole("article").map((card) => card.querySelector("strong")?.textContent ?? "");
}

/** 목록 영역 안의 요소(누르기 시작하는 곳). */
function listElement(): HTMLElement {
  return screen.getAllByRole("article")[0] as HTMLElement;
}

/**
 * 작업 결과 알림(성공·안내 토스트)을 찾는다. 없으면 null.
 * 왜 이름으로 찾지 않나: 알림에 이름(aria-label)을 붙이면 스크린리더가 내용 대신 이름을 읽어, 알림에는 이름을 두지 않는다(W4).
 */
function actionToast(): HTMLElement | null {
  return screen.queryAllByRole("status").find((element) => element.classList.contains("toast")) ?? null;
}

/** 화면을 그린다. status를 null로 넘기면 서버 상태를 아직 모르는 경우다. */
function renderScreen(verdicts: VerdictDto[], actions = fakeActions(), currentStatus: ServerStatus | null = status) {
  const onReload = vi.fn();
  render(<CandidatesScreen me={chatManager} status={currentStatus} sections={buildSections(verdicts, NOW)} realtimeConnected actions={actions} onReload={onReload} {...noNotice} />);
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
    await waitFor(() => expect(actionToast()?.textContent).toBe("이미 사라진 메시지입니다"));
  });

  it("이미 처리된 판정(409 already_handled)이면 빨간 오류가 아니라 안내로 알리고 목록을 다시 읽는다(R-13·B19-6)", async () => {
    const conflict = new ApiError(409, "already_handled", "이미 다른 조치가 끝난 판정입니다. '다시 불러오기'를 눌러 지금 상태를 확인하세요.");
    const { onReload } = renderScreen([verdict(1)], fakeActions({ ignore: async () => { throw conflict; } }));
    await userEvent.click(screen.getByRole("button", { name: /^악플러의 .+ 메시지 무시$/ }));
    await waitFor(() => expect(actionToast()?.textContent).toBe("이미 처리된 항목입니다. 목록을 다시 불러왔습니다."));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(actionToast()?.classList.contains("error")).toBe(false);
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
    render(<CandidatesScreen me={admin} status={status} sections={buildSections([], NOW)} realtimeConnected actions={actions} onReload={vi.fn()} {...noNotice} />);
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

  it("카드에는 처음에 메시지를 3건만 보여 주고, '더 보기 (N건)'을 누르면 그 사람의 대기 중 판정을 모두 보여 준다(W2, X34)", async () => {
    renderScreen([verdict(1), verdict(2), verdict(3), verdict(4), verdict(5)]);
    expect(screen.getByText("5건")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ })).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "더 보기 (2건)" }));
    expect(screen.getAllByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ })).toHaveLength(5);
    expect(screen.getByText("나쁜 말 5")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "접기" }));
    expect(screen.getAllByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ })).toHaveLength(3);
  });

  it("3건 이하면 '더 보기'를 두지 않는다", () => {
    renderScreen([verdict(1), verdict(2), verdict(3)]);
    expect(screen.queryByRole("button", { name: /더 보기/ })).toBeNull();
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
    const { unmount } = render(<CandidatesScreen me={chatManager} status={{ ...status, writeLocked: true }} sections={buildSections([], NOW)} realtimeConnected actions={fakeActions()} onReload={vi.fn()} {...noNotice} />);
    expect(screen.queryByRole("link", { name: "채널 다시 연결" })).toBeNull();
    unmount();
    const owner: MeDto = { ...chatManager, role: "STREAMING_CHANNEL_OWNER", permissions: [...chatManager.permissions, "connect_channel"] };
    render(<CandidatesScreen me={owner} status={{ ...status, writeLocked: true }} sections={buildSections([], NOW)} realtimeConnected actions={fakeActions()} onReload={vi.fn()} {...noNotice} />);
    expect(within(screen.getByRole("status", { name: "서버 상태" })).getByRole("link", { name: "채널 다시 연결" })).toBeTruthy();
  });

  it("자동 숨김됨·사용자 제한됨 목록은 최근 50건만 그리고 나머지는 '외 N건'으로 줄인다(F4)", () => {
    const hidden = Array.from({ length: 60 }, (_unused, index) => verdict(index + 1, { decision: "auto_hide", status: "hidden" }));
    const restricted = Array.from({ length: 55 }, (_unused, index) => verdict(index + 101, { decision: "auto_hide", status: "restricted", createdAt: NOW - index * 10 - 5 }));
    renderScreen([...hidden, ...restricted]);
    const hiddenDetails = screen.getByText(/자동 숨김됨\(최근 10분, 60건\)/).closest("details") as HTMLElement;
    expect(within(hiddenDetails).getAllByRole("listitem")).toHaveLength(50);
    expect(within(hiddenDetails).getByText("외 10건")).toBeTruthy();
    expect(within(hiddenDetails).getByText(/나쁜 말 1$/)).toBeTruthy();
    const restrictedDetails = screen.getByText(/사용자 제한됨/).closest("details") as HTMLElement;
    expect(within(restrictedDetails).getAllByRole("listitem")).toHaveLength(50);
    expect(within(restrictedDetails).getByText("외 5건")).toBeTruthy();
  });

  it("섀도 구역은 최근 50명만 그리고 나머지는 '외 N명'으로 줄인다(F4)", () => {
    const shadows = Array.from({ length: 53 }, (_unused, index) => verdict(index + 1, { decision: "shadow", senderChannelId: `s${index}`, senderNickname: `도배러${index}` }));
    renderScreen(shadows);
    const section = screen.getByRole("heading", { name: /켜져 있었으면 숨겼을 메시지/ }).closest("section") as HTMLElement;
    expect(within(section).getAllByRole("article")).toHaveLength(50);
    expect(within(section).getByText("외 3명")).toBeTruthy();
    expect(within(section).getByText("도배러0")).toBeTruthy();
  });

  it("후보가 없으면 안내 문구", () => {
    renderScreen([]);
    expect(screen.getByText(/지금 확인할 후보가 없습니다/)).toBeTruthy();
  });
});

describe("CandidatesScreen 조작 중 목록 고정(F4, 스모크 S1)", () => {
  /** 새로 들어온 다른 사람의 판정(기존 것보다 새것이라 원래는 맨 위로 온다). */
  const newcomer = verdict(9, { senderChannelId: "new", senderNickname: "새사람", createdAt: NOW });

  it("목록을 누르고 있는 동안 새 판정이 와도 순서를 바꾸지 않고 '새 항목 N개 — 보기'를 보여 준다", () => {
    const { update } = renderLive([verdict(1)]);
    fireEvent.pointerDown(listElement());
    update([verdict(1), newcomer]);
    expect(cardOrder()).toEqual(["악플러"]);
    expect(screen.getByRole("button", { name: "새 항목 1개 — 보기" })).toBeTruthy();
  });

  it("'보기'를 누르면 최신 순서를 보여 주고 맨 위로 올린다", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const { update } = renderLive([verdict(1)]);
    fireEvent.pointerDown(listElement());
    update([verdict(1), newcomer]);
    await userEvent.click(screen.getByRole("button", { name: "새 항목 1개 — 보기" }));
    expect(cardOrder()).toEqual(["새사람", "악플러"]);
    expect(screen.queryByRole("button", { name: /새 항목/ })).toBeNull();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it("얼린 화면에서 처리된 줄은 지우지 않고 '처리됨'으로 흐리게 남기며 버튼을 잠근다", () => {
    const { update } = renderLive([verdict(1), verdict(2)]);
    fireEvent.pointerDown(listElement());
    update([verdict(1, { status: "hidden" }), verdict(2)]);
    const handledRow = screen.getByText("나쁜 말 1").closest("li") as HTMLElement;
    expect(handledRow.classList.contains("message-handled")).toBe(true);
    expect(within(handledRow).getByText("처리됨")).toBeTruthy();
    expect(within(handledRow).getAllByRole("button").every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    const pendingRow = screen.getByText("나쁜 말 2").closest("li") as HTMLElement;
    expect(within(pendingRow).queryByText("처리됨")).toBeNull();
    expect((within(pendingRow).getByRole("button", { name: /숨기기$/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("손을 뗀 뒤 1.5초가 지나면 최신 목록을 보여 준다", () => {
    vi.useFakeTimers();
    const { update } = renderLive([verdict(1)]);
    fireEvent.pointerDown(listElement());
    update([verdict(1), newcomer]);
    fireEvent.pointerUp(document);
    act(() => vi.advanceTimersByTime(1_499));
    expect(cardOrder()).toEqual(["악플러"]);
    act(() => vi.advanceTimersByTime(1));
    expect(cardOrder()).toEqual(["새사람", "악플러"]);
  });

  it("누른 채 다른 앱으로 넘어가면(화면이 숨겨지면) 손을 뗀 것으로 보아, 고정이 붙은 채 남지 않는다(B19-8)", () => {
    vi.useFakeTimers();
    const { update } = renderLive([verdict(1)]);
    fireEvent.pointerDown(listElement());
    update([verdict(1), newcomer]);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => vi.advanceTimersByTime(1_499));
    expect(cardOrder()).toEqual(["악플러"]);
    act(() => vi.advanceTimersByTime(1));
    expect(cardOrder()).toEqual(["새사람", "악플러"]);
  });

  it("목록을 아래로 내려 본 동안(80px 넘게)도 고정하고, 맨 위로 돌아오면 최신 목록을 보여 준다", () => {
    const { update } = renderLive([verdict(1)]);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 200 });
    act(() => window.dispatchEvent(new Event("scroll")));
    update([verdict(1), newcomer]);
    expect(cardOrder()).toEqual(["악플러"]);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(cardOrder()).toEqual(["새사람", "악플러"]);
  });

  it("'새 항목' 버튼은 목록 흐름 밖(고정 위치 층)에 떠서, 나타나도 첫 줄 앞에 아무것도 끼어들지 않는다(B19-1)", () => {
    const { update } = renderLive([verdict(1)]);
    const list = document.querySelector(".candidate-list") as HTMLElement;
    const firstBefore = list.firstElementChild;
    fireEvent.pointerDown(listElement());
    update([verdict(1), newcomer]);
    const button = screen.getByRole("button", { name: "새 항목 1개 — 보기" });
    expect(button.closest(".overlay-top")).not.toBeNull();
    expect(button.closest(".candidate-list")).toBeNull();
    expect(list.firstElementChild).toBe(firstBefore);
  });

  it("고정하지 않은 동안에는 새 판정을 바로 반영한다", () => {
    const { update } = renderLive([verdict(1)]);
    update([verdict(1), newcomer]);
    expect(cardOrder()).toEqual(["새사람", "악플러"]);
    expect(screen.queryByRole("button", { name: /새 항목/ })).toBeNull();
  });
});

describe("CandidatesScreen 작업 결과 알림(F9, 스모크 S3)", () => {
  /** 숨기기 버튼. */
  const hideButton = () => screen.getByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ });

  it("성공 안내는 아래쪽 알림(작업 결과)으로 보이고 4초 뒤 사라진다", async () => {
    vi.useFakeTimers();
    renderScreen([verdict(1)], fakeActions({ hide: async () => "숨겼습니다." }));
    fireEvent.click(hideButton());
    await act(async () => undefined);
    const toast = actionToast();
    expect(toast?.textContent).toBe("숨겼습니다.");
    act(() => vi.advanceTimersByTime(3_999));
    expect(actionToast()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(actionToast()).toBeNull();
  });

  it("알림에는 이름(aria-label·aria-labelledby)을 붙이지 않아 스크린리더가 결과 문구를 읽는다(W4, X33)", async () => {
    renderScreen([verdict(1)], fakeActions({ hide: async () => "숨겼습니다." }));
    fireEvent.click(hideButton());
    await waitFor(() => expect(actionToast()).not.toBeNull());
    const toast = actionToast() as HTMLElement;
    expect(toast.hasAttribute("aria-label")).toBe(false);
    expect(toast.hasAttribute("aria-labelledby")).toBe(false);
    expect(screen.getByRole("status", { name: "" }).textContent).toBe("숨겼습니다.");
  });

  it("오류는 시간이 지나도 남고, 닫아야 사라진다", async () => {
    vi.useFakeTimers();
    renderScreen([verdict(1)], fakeActions({ hide: async () => { throw new ApiError(502, "chzzk_failed", "치지직 서버 오류로 실패했습니다."); } }));
    fireEvent.click(hideButton());
    await act(async () => undefined);
    act(() => vi.advanceTimersByTime(60_000));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/치지직 서버 오류로 실패했습니다/);
    expect(alert.closest(".toast")).not.toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "작업 결과 닫기" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("CandidatesScreen 시간 초과 뒤 다시 누르기 막기(B19-7)", () => {
  /** 시간 초과 오류(client.ts가 AbortSignal.timeout으로 만든다). */
  const timeoutError = () => new ApiError(0, "timeout", "응답이 늦습니다. 결과는 잠시 뒤 목록에 반영됩니다.");

  it("숨기기가 시간 초과되면 '다시 누르지 마세요'를 알리고, 60초가 지날 때까지 같은 줄을 다시 보내지 않는다", async () => {
    vi.useFakeTimers();
    const hide = vi.fn(async (_target: VerdictDto): Promise<string | null> => { throw timeoutError(); });
    renderScreen([verdict(1)], fakeActions({ hide }));
    const hideButton = () => screen.getByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ }) as HTMLButtonElement;
    fireEvent.click(hideButton());
    await act(async () => undefined);
    expect(screen.getByRole("alert").textContent).toMatch(/응답이 늦습니다.*다시 누르지 마세요/);
    fireEvent.click(hideButton());
    act(() => vi.advanceTimersByTime(TIMEOUT_LOCK_MS - 1));
    fireEvent.click(hideButton());
    expect(hide).toHaveBeenCalledTimes(1);
    expect(hideButton().disabled).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(hideButton().disabled).toBe(false);
    fireEvent.click(hideButton());
    await act(async () => undefined);
    expect(hide).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["성공한", async (): Promise<string | null> => null],
    ["시간 초과된", async (): Promise<string | null> => { throw timeoutError(); }],
  ])("%s 임시 제한은 첫 판정의 상태가 바뀌어도 60초 동안 그 사람의 임시 제한을 다시 보내지 않는다(W2, M20)", async (_label, outcome) => {
    vi.useFakeTimers();
    const temporaryRestrict = vi.fn(outcome);
    const actions = fakeActions({ temporaryRestrict });
    const screenFor = (verdicts: VerdictDto[]) => <CandidatesScreen me={chatManager} status={status} sections={buildSections(verdicts, NOW)} realtimeConnected actions={actions} onReload={vi.fn()} {...noNotice} />;
    const { rerender } = render(screenFor([verdict(1), verdict(2)]));
    const restrictButton = () => screen.getByRole("button", { name: "악플러 임시 제한" }) as HTMLButtonElement;
    fireEvent.click(restrictButton());
    await act(async () => undefined);
    expect(restrictButton().disabled).toBe(true);
    // 서버가 첫 판정만 restricted로 바꾸므로, 남은 판정 때문에 묶음 카드는 그대로 남는다.
    rerender(screenFor([verdict(1, { status: "restricted" }), verdict(2)]));
    act(() => vi.advanceTimersByTime(TIMEOUT_LOCK_MS - 1));
    fireEvent.click(restrictButton());
    expect(temporaryRestrict).toHaveBeenCalledTimes(1);
    expect(restrictButton().disabled).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(restrictButton().disabled).toBe(false);
  });

  it("서버가 처리 결과를 알 수 없다고 하면(502 result_unknown) 시간 초과와 같이 60초 동안 같은 줄을 다시 보내지 않는다(N4)", async () => {
    vi.useFakeTimers();
    const resultUnknown = () => new ApiError(502, "result_unknown", "치지직 응답을 받지 못해 처리 결과를 알 수 없습니다.");
    const hide = vi.fn(async (_target: VerdictDto): Promise<string | null> => { throw resultUnknown(); });
    renderScreen([verdict(1)], fakeActions({ hide }));
    const hideButton = () => screen.getByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ }) as HTMLButtonElement;
    fireEvent.click(hideButton());
    await act(async () => undefined);
    expect(screen.getByRole("alert").textContent).toMatch(/결과를 알 수 없습니다.*다시 누르지 마세요/);
    act(() => vi.advanceTimersByTime(TIMEOUT_LOCK_MS - 1));
    fireEvent.click(hideButton());
    expect(hide).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(hideButton().disabled).toBe(false);
  });

  it("자동 숨김이 진행 중이라는 409(in_progress)는 서버 문구를 안내(info)로 보여 주고 다시 불러오지 않는다(N4)", async () => {
    const hide = vi.fn(async (_target: VerdictDto): Promise<string | null> => { throw new ApiError(409, "in_progress", "자동 숨김이 진행 중입니다. 잠시 뒤 결과가 반영됩니다."); });
    const { onReload } = renderScreen([verdict(1, { decision: "auto_hide" })], fakeActions({ hide }));
    fireEvent.click(screen.getByRole("button", { name: /^악플러의 .+ 메시지 숨기기$/ }));
    await waitFor(() => expect(actionToast()?.textContent).toBe("자동 숨김이 진행 중입니다. 잠시 뒤 결과가 반영됩니다."));
    expect(actionToast()?.classList.contains("info")).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/이미 처리된 항목입니다/)).toBeNull();
    expect(onReload).not.toHaveBeenCalled();
  });

  it("자동 숨김 끄기는 시간 초과돼도 붙잡지 않는다(안전장치는 바로 다시 누를 수 있어야 한다)", async () => {
    const setAutoHide = vi.fn(async (): Promise<string | null> => { throw timeoutError(); });
    renderScreen([], fakeActions({ setAutoHide }), { ...status, autoHideEnabled: true });
    await userEvent.click(screen.getByRole("button", { name: /자동 숨김: 켜짐/ }));
    await waitFor(() => expect((screen.getByRole("button", { name: /자동 숨김: 켜짐/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("alert").textContent).not.toMatch(/다시 누르지 마세요/);
  });
});
