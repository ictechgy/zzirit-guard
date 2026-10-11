import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { json, stubFetch } from "./helpers/stubFetch";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

/** 정상 서버 상태. */
const status = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, lastChatAt: null, pendingActions: 0 };
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
  it("로그인하지 않았으면 로그인 화면과 실패 이유를 보여 준다", async () => {
    window.history.pushState({}, "", `/?loginError=${encodeURIComponent("이 채널의 매니저가 아닙니다.")}`);
    stubFetch({ "GET /api/me": () => json(401, { error: "unauthorized", message: "로그인이 필요합니다." }) });
    render(<App />);
    expect(await screen.findByRole("link", { name: "매니저 로그인" })).toBeTruthy();
    expect(screen.getByText("이 채널의 매니저가 아닙니다.")).toBeTruthy();
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
