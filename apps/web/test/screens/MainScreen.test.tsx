import type { ServerStatus } from "@zzirit-guard/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MainScreen } from "../../src/screens/MainScreen";
import { initialServerState, type ServerState } from "../../src/state/serverReducer";
import { json, stubFetch } from "../helpers/stubFetch";

/** 훅이 돌려줄 서버 상태. 테스트마다 바꾼다. */
const hookState = vi.hoisted(() => ({ current: null as ServerState | null }));

vi.mock("../../src/state/useServerState", () => ({
  /** 고정 상태를 돌려주는 가짜 훅(연결·조회는 useServerState 테스트가 다룬다). */
  useServerState: () => ({ state: hookState.current, reload: () => undefined, reconnect: () => undefined }),
}));

/** 채팅 운영자 내 정보. */
const me = { channelId: "m1", channelName: "매니저1", role: "STREAMING_CHAT_MANAGER" as const, permissions: [] };
/** 자동 숨김을 끌 수 있는 채팅 운영자. */
const switchManager = { ...me, permissions: ["disable_auto_hide" as const] };
/** 정상 서버 상태(자동 숨김 켜짐). */
const enabledStatus: ServerStatus = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: true, lastChatAt: null, pendingActions: 0 };
/** 시스템이 자동 숨김을 껐을 때의 안내(F8). */
const SYSTEM_DISABLED_TEXT = "자동 숨김이 꺼졌습니다(1분 한도 초과 또는 치지직 호출 실패 증가). 기록·설정 → 감사 기록에서 이유를 확인하세요.";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MainScreen", () => {
  it("빈 문자열 이유의 세션 종료도 로그인 화면으로 보낸다", () => {
    stubFetch({});
    hookState.current = { ...initialServerState, sessionEndedReason: "" };
    const onSignedOut = vi.fn();
    render(<MainScreen me={me} onSignedOut={onSignedOut} />);
    expect(onSignedOut).toHaveBeenCalledWith("");
  });

  it("세션 종료 이유가 없으면 로그인 화면으로 보내지 않는다", () => {
    stubFetch({});
    hookState.current = { ...initialServerState };
    const onSignedOut = vi.fn();
    render(<MainScreen me={me} onSignedOut={onSignedOut} />);
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("탭을 오가도 실시간 채팅의 '위험한 것만 보기' 필터가 유지된다", async () => {
    stubFetch({ "GET /api/status": () => json(500, { error: "x", message: "x" }) });
    hookState.current = { ...initialServerState };
    render(<MainScreen me={me} onSignedOut={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: /실시간 채팅/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: "위험한 것만 보기" }));
    await userEvent.click(screen.getByRole("button", { name: /^후보/ }));
    await userEvent.click(screen.getByRole("button", { name: /실시간 채팅/ }));
    expect((screen.getByRole("checkbox", { name: "위험한 것만 보기" }) as HTMLInputElement).checked).toBe(true);
  });

  it("처음 열 때까지 설정 화면을 마운트하지 않아 설정 API를 부르지 않는다", () => {
    const fetchMock = stubFetch({});
    hookState.current = { ...initialServerState };
    render(<MainScreen me={me} onSignedOut={() => undefined} />);
    const paths = fetchMock.mock.calls.map(([url]) => String(url));
    expect(paths.filter((path) => /chat-settings|audit|rules|settings|stats|false-positives/.test(path))).toEqual([]);
  });

  it("설정 탭을 다시 열거나 '새로 고침'을 누르면 통계·오판·감사·규칙·설정만 다시 읽고, 치지직을 부르는 채팅 설정은 다시 읽지 않는다(F6)", async () => {
    const fetchMock = stubFetch({});
    hookState.current = { ...initialServerState };
    const manager = { ...me, role: "STREAMING_CHANNEL_MANAGER" as const, permissions: ["view_audit" as const] };
    render(<MainScreen me={manager} onSignedOut={() => undefined} />);
    const count = (path: string) => fetchMock.mock.calls.filter(([url]) => String(url) === path).length;
    const refreshed = ["/api/stats?sinceMinutes=60", "/api/false-positives?limit=20", "/api/audit?limit=50", "/api/settings"];
    await userEvent.click(screen.getByRole("button", { name: "기록·설정" }));
    await waitFor(() => expect(refreshed.map(count)).toEqual([1, 1, 1, 1]));
    const rulesAfterFirstVisit = count("/api/rules");
    expect(count("/api/chat-settings")).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: /^후보/ }));
    await userEvent.click(screen.getByRole("button", { name: "기록·설정" }));
    await waitFor(() => expect(refreshed.map(count)).toEqual([2, 2, 2, 2]));
    expect(count("/api/rules")).toBe(rulesAfterFirstVisit * 2);
    await userEvent.click(screen.getByRole("button", { name: "새로 고침" }));
    await waitFor(() => expect(refreshed.map(count)).toEqual([3, 3, 3, 3]));
    expect(count("/api/rules")).toBe(rulesAfterFirstVisit * 3);
    expect(count("/api/chat-settings")).toBe(1);
    expect(document.querySelector(".settings")).not.toBeNull();
  });
});

describe("MainScreen 시스템이 자동 숨김을 껐을 때(F8, 스모크 S2)", () => {
  it("상태가 켜짐→꺼짐으로 바뀌었는데 이 기기가 끄지 않았으면 후보 화면에 이유 확인 안내를 띄우고, 닫으면 사라진다", async () => {
    stubFetch({});
    hookState.current = { ...initialServerState, status: enabledStatus };
    const onSignedOut = vi.fn();
    const { rerender } = render(<MainScreen me={switchManager} onSignedOut={onSignedOut} />);
    expect(screen.queryByText(SYSTEM_DISABLED_TEXT)).toBeNull();
    hookState.current = { ...initialServerState, status: { ...enabledStatus, autoHideEnabled: false } };
    rerender(<MainScreen me={switchManager} onSignedOut={onSignedOut} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(SYSTEM_DISABLED_TEXT);
    // 안내는 목록을 밀지 않는 고정 위치 층에 뜬다: 배너 바로 다음은 여전히 도구 막대다(B19-4).
    expect(alert.closest(".overlay-bottom")).not.toBeNull();
    expect(screen.getByRole("status", { name: "서버 상태" }).nextElementSibling?.classList.contains("toolbar")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByText(SYSTEM_DISABLED_TEXT)).toBeNull();
  });

  it("이 기기에서 끈 것이면 안내를 띄우지 않는다", async () => {
    const fetchMock = stubFetch({ "POST /api/auto-hide": () => json(200, { enabled: false }) });
    hookState.current = { ...initialServerState, status: enabledStatus };
    const onSignedOut = vi.fn();
    const { rerender } = render(<MainScreen me={switchManager} onSignedOut={onSignedOut} />);
    await userEvent.click(screen.getByRole("button", { name: "자동 숨김: 켜짐" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    hookState.current = { ...initialServerState, status: { ...enabledStatus, autoHideEnabled: false } };
    rerender(<MainScreen me={switchManager} onSignedOut={onSignedOut} />);
    expect(screen.queryByText(SYSTEM_DISABLED_TEXT)).toBeNull();
  });

  it("처음 받은 상태가 꺼짐이면 안내를 띄우지 않는다", () => {
    stubFetch({});
    hookState.current = { ...initialServerState, status: { ...enabledStatus, autoHideEnabled: false } };
    render(<MainScreen me={switchManager} onSignedOut={vi.fn()} />);
    expect(screen.queryByText(SYSTEM_DISABLED_TEXT)).toBeNull();
  });
});

describe("MainScreen 기본 성공 안내(F9)", () => {
  it("서버가 안내(note)를 주지 않으면 숨기기·무시에 기본 안내를 보여 준다", async () => {
    const verdict = (id: number) => ({ id, chatChannelId: "c", senderChannelId: `s${id}`, senderNickname: `시청자${id}`, content: `메시지${id}`, messageTime: id, decision: "candidate" as const, reason: "rule:weak:1", status: "pending" as const, createdAt: Date.now() - id });
    stubFetch({ "POST /api/verdicts/1/hide": () => json(200, { ok: true, note: null }), "POST /api/verdicts/2/ignore": () => json(200, { ok: true }) });
    hookState.current = { ...initialServerState, status: { ...enabledStatus, autoHideEnabled: false }, verdicts: [verdict(1), verdict(2)] };
    render(<MainScreen me={{ ...me, permissions: ["hide_message"] }} onSignedOut={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /^시청자1의 .+ 메시지 숨기기$/ }));
    expect((await screen.findByRole("status", { name: "작업 결과" })).textContent).toBe("숨겼습니다.");
    await userEvent.click(screen.getByRole("button", { name: /^시청자2의 .+ 메시지 무시$/ }));
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 결과" }).textContent).toBe("무시했습니다."));
  });
});
