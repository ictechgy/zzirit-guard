import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { json, stubFetch } from "./helpers/stubFetch";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

/** 정상 서버 상태. */
const status = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, autoHideOffReason: null, lastChatAt: null, pendingActions: 0 };
/** not_manager 코드의 문구. */
const NOT_MANAGER_TEXT = "이 채널의 매니저가 아닙니다. 치지직에서 채널 관리자나 채팅 운영자로 등록돼 있어야 합니다.";
/** 일반 실패(failed·모르는 코드)의 문구. */
const FAILED_TEXT = "로그인 중 오류가 발생했습니다. 잠시 뒤 다시 시도하세요.";
/** 채팅 운영자 내 정보. */
const me = { channelId: "m1", channelName: "매니저1", role: "STREAMING_CHAT_MANAGER", permissions: ["disable_auto_hide", "hide_message", "temporary_restrict"] };

/** 열리자마자 서버처럼 status 메시지를 보내는 가짜 WebSocket(인증된 연결은 곧바로 status를 받는다). */
class FakeWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "status", status }) }), 0);
  }
  close(): void {
    this.onclose?.({ code: 1000 });
  }
}

describe("App", () => {
  it("로그인하지 않았으면 로그인 화면과, 이유 코드에 맞는 정해진 실패 문구를 보여 준다", async () => {
    window.history.pushState({}, "", "/?loginError=not_manager");
    stubFetch({ "GET /api/me": () => json(401, { error: "unauthorized", message: "로그인이 필요합니다." }) });
    render(<App />);
    expect(await screen.findByRole("link", { name: "매니저 로그인" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(NOT_MANAGER_TEXT);
  });

  it.each([
    ["rate_limited", "요청이 너무 많습니다. 잠시 뒤 다시 시도하세요."],
    ["state_mismatch", "로그인 요청이 만료되었거나 다른 브라우저에서 시작되었습니다. 처음부터 다시 시도하세요."],
    ["not_allowed_channel", "이 서버에 연결할 수 있는 채널이 아닙니다. 운영자가 설정한 스트리머 계정으로 로그인하세요."],
    ["no_channel", "아직 연결된 채널이 없습니다. 스트리머가 먼저 '채널 연결'을 해야 합니다."],
    ["failed", FAILED_TEXT],
  ])("이유 코드 %s는 정해진 문구로 보여 준다(F10)", async (code, text) => {
    window.history.pushState({}, "", `/?loginError=${code}`);
    stubFetch({ "GET /api/me": () => json(401, { error: "unauthorized", message: "로그인이 필요합니다." }) });
    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toBe(text);
  });

  it("모르는 코드나 주소에 넣은 임의 문구는 보여 주지 않고 일반 실패 문구로 바꾼다(피싱 문구 방지, F10)", async () => {
    window.history.pushState({}, "", `/?loginError=${encodeURIComponent("보안 점검: evil.example에서 다시 로그인하세요")}`);
    stubFetch({ "GET /api/me": () => json(401, { error: "unauthorized", message: "로그인이 필요합니다." }) });
    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toBe(FAILED_TEXT);
    expect(screen.queryByText(/evil\.example/)).toBeNull();
  });

  it("loginError는 한 번만 읽고 주소에서 지운다: 다시 그려도 낡은 이유가 되살아나지 않는다", async () => {
    window.history.pushState({}, "", "/?loginError=not_manager&keep=1#top");
    stubFetch({ "GET /api/me": () => json(401, { error: "unauthorized", message: "로그인이 필요합니다." }) });
    const { rerender } = render(<App />);
    expect(await screen.findByText(NOT_MANAGER_TEXT)).toBeTruthy();
    expect(window.location.search).toBe("?keep=1");
    expect(window.location.hash).toBe("#top");
    rerender(<App />);
    expect(screen.getByText(NOT_MANAGER_TEXT)).toBeTruthy();
    expect(window.location.search).not.toContain("loginError");
  });

  it("서버가 응답하지 않으면(503) 로그인 화면 대신 '서버에 연결하지 못했습니다'와 '다시 시도'를 보여 주고, 누르면 다시 확인한다(F10)", async () => {
    let calls = 0;
    const fetchMock = stubFetch({
      "GET /api/me": () => (++calls === 1 ? json(503, { error: "unavailable", message: "잠시 뒤 다시 시도하세요." }) : json(401, { error: "unauthorized", message: "로그인이 필요합니다." })),
    });
    render(<App />);
    expect(await screen.findByText("서버에 연결하지 못했습니다")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "매니저 로그인" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("link", { name: "매니저 로그인" })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/me")).toHaveLength(2);
  });

  it("네트워크 오류로 내 정보를 못 읽어도 다시 시도 화면을 보여 준다(F10)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    render(<App />);
    expect(await screen.findByText("서버에 연결하지 못했습니다")).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
  });

  it("로그인했으면 탭과 후보 화면을 보여 준다", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    stubFetch({
      "GET /api/me": () => json(200, me),
      "GET /api/status": () => json(200, status),
      "GET /api/candidates": () => json(200, []),
      "POST /api/ws-ticket": () => json(200, { ticket: "t1" }),
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: /실시간 채팅/ })).toBeTruthy();
    expect(await screen.findByText("정상 동작 중")).toBeTruthy();
  });

  it("실시간 연결이 열리면 상태·후보를 다시 읽어 끊긴 동안의 변화를 메운다(R-3)", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const fetchMock = stubFetch({
      "GET /api/me": () => json(200, me),
      "GET /api/status": () => json(200, status),
      "GET /api/candidates": () => json(200, []),
      "POST /api/ws-ticket": () => json(200, { ticket: "t1" }),
    });
    render(<App />);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === "/api/candidates").length).toBeGreaterThanOrEqual(2));
  });

  it("채널 연결이 사라지면(409 no_channel) 실시간을 멈추고 로그인 화면에 서버 문구를 보여 준다(R-12)", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const noChannel = () => json(409, { error: "no_channel", message: "연결된 채널이 없습니다. 스트리머가 먼저 채널을 연결하세요." });
    const fetchMock = stubFetch({ "GET /api/me": () => json(200, me), "GET /api/status": noChannel, "GET /api/candidates": noChannel, "POST /api/ws-ticket": noChannel });
    render(<App />);
    expect(await screen.findByRole("link", { name: "매니저 로그인" })).toBeTruthy();
    expect(screen.getByText(/연결된 채널이 없습니다/)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/ws-ticket").length).toBeLessThanOrEqual(1);
  });
});

describe("App 세션 종료(W1 확인)", () => {
  /** 상태를 보낸 뒤 곧 세션 종료를 알리는 가짜 WebSocket. */
  class EndingWebSocket extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "session_ended", reason: "로그아웃했습니다" }) }), 50);
    }
  }

  it("세션이 끝나면 본 화면 전체가 사라져 채팅 원문·닉네임이 남지 않는다", async () => {
    vi.stubGlobal("WebSocket", EndingWebSocket);
    const verdict = { id: 1, chatChannelId: "c", senderChannelId: "s1", senderNickname: "닉네임1", content: "남으면 안 되는 원문", messageTime: 1, decision: "candidate", reason: "rule:weak:1", status: "pending", createdAt: Date.now() };
    stubFetch({
      "GET /api/me": () => json(200, me),
      "GET /api/status": () => json(200, status),
      "GET /api/candidates": () => json(200, [verdict]),
      "POST /api/ws-ticket": () => json(200, { ticket: "t1" }),
    });
    render(<App />);
    expect(await screen.findByText("남으면 안 되는 원문")).toBeTruthy();
    expect(await screen.findByRole("link", { name: "매니저 로그인" })).toBeTruthy();
    expect(screen.queryByText("남으면 안 되는 원문")).toBeNull();
    expect(screen.queryByText("닉네임1")).toBeNull();
  });
});
