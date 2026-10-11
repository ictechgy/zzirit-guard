import { render, screen } from "@testing-library/react";
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

  it("설정 탭을 한 번 연 뒤에는 다른 탭으로 가도 마운트를 유지해 다시 읽지 않는다", async () => {
    const fetchMock = stubFetch({});
    hookState.current = { ...initialServerState };
    render(<MainScreen me={me} onSignedOut={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "기록·설정" }));
    const callsAfterFirstVisit = fetchMock.mock.calls.length;
    expect(callsAfterFirstVisit).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: /^후보/ }));
    await userEvent.click(screen.getByRole("button", { name: "기록·설정" }));
    expect(fetchMock.mock.calls).toHaveLength(callsAfterFirstVisit);
    expect(document.querySelector(".settings")).not.toBeNull();
  });
});
