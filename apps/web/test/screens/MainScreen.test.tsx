import type { MeDto, ServerStatus } from "@zzirit-guard/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MainScreen } from "../../src/screens/MainScreen";
import { initialServerState, type ServerState } from "../../src/state/serverReducer";
import { json, stubFetch } from "../helpers/stubFetch";

/** 훅이 돌려줄 서버 상태. 테스트마다 바꾼다. */
const hookState = vi.hoisted(() => ({ current: null as ServerState | null }));
/** 훅이 돌려줄 함수들. 실제 훅의 useCallback처럼 렌더마다 같은 함수다. */
const hookStable = vi.hoisted(() => ({ reload: () => undefined, reconnect: () => undefined, applyAutoHide: (_enabled: boolean) => undefined }));

vi.mock("../../src/state/useServerState", () => ({
  /** 고정 상태를 돌려주는 가짜 훅(연결·조회는 useServerState 테스트가 다룬다). */
  useServerState: () => ({ state: hookState.current, reload: hookStable.reload, reconnect: hookStable.reconnect, applyAutoHide: hookStable.applyAutoHide }),
}));

/** 내 정보 다시 읽기 자리 채움. 다시 읽기 동작(K23)은 따로 확인한다. */
const noRefresh = () => undefined;
/** 채팅 운영자 내 정보. */
const me = { channelId: "m1", channelName: "매니저1", role: "STREAMING_CHAT_MANAGER" as const, permissions: [] };
/** 자동 숨김을 끌 수 있는 채팅 운영자. */
const switchManager = { ...me, permissions: ["disable_auto_hide" as const] };
/** 자동 숨김을 끌 수 있고 감사 기록도 볼 수 있는 채널 관리자. */
const auditManager = { ...switchManager, role: "STREAMING_CHANNEL_MANAGER" as const, permissions: ["disable_auto_hide" as const, "view_audit" as const] };
/** 정상 서버 상태(자동 숨김 켜짐). */
const enabledStatus: ServerStatus = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: true, autoHideOffReason: null, lastChatAt: null, pendingActions: 0 };
/** 작업 결과 알림(성공·안내 토스트)을 찾는다. 알림에는 이름을 붙이지 않으므로(W4) 역할과 클래스로 찾는다. */
function actionToast(): HTMLElement | null {
  return screen.queryAllByRole("status").find((element) => element.classList.contains("toast")) ?? null;
}
/** 감사 기록을 볼 수 있는 매니저에게만 붙이는 안내(B19-3). */
const AUDIT_HINT = "기록·설정 → 감사 기록에서 확인하세요.";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MainScreen", () => {
  it("빈 문자열 이유의 세션 종료도 로그인 화면으로 보낸다", () => {
    stubFetch({});
    hookState.current = { ...initialServerState, sessionEndedReason: "" };
    const onSignedOut = vi.fn();
    render(<MainScreen me={me} onSignedOut={onSignedOut} onRefreshMe={noRefresh} />);
    expect(onSignedOut).toHaveBeenCalledWith("");
  });

  it("세션 종료 이유가 없으면 로그인 화면으로 보내지 않는다", () => {
    stubFetch({});
    hookState.current = { ...initialServerState };
    const onSignedOut = vi.fn();
    render(<MainScreen me={me} onSignedOut={onSignedOut} onRefreshMe={noRefresh} />);
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("탭을 오가도 실시간 채팅의 '위험한 것만 보기' 필터가 유지된다", async () => {
    stubFetch({ "GET /api/status": () => json(500, { error: "x", message: "x" }) });
    hookState.current = { ...initialServerState };
    render(<MainScreen me={me} onSignedOut={() => undefined} onRefreshMe={noRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: /실시간 채팅/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: "위험한 것만 보기" }));
    await userEvent.click(screen.getByRole("button", { name: /^후보/ }));
    await userEvent.click(screen.getByRole("button", { name: /실시간 채팅/ }));
    expect((screen.getByRole("checkbox", { name: "위험한 것만 보기" }) as HTMLInputElement).checked).toBe(true);
  });

  it("처음 열 때까지 설정 화면을 마운트하지 않아 설정 API를 부르지 않는다", () => {
    const fetchMock = stubFetch({});
    hookState.current = { ...initialServerState };
    render(<MainScreen me={me} onSignedOut={() => undefined} onRefreshMe={noRefresh} />);
    const paths = fetchMock.mock.calls.map(([url]) => String(url));
    expect(paths.filter((path) => /chat-settings|audit|rules|settings|stats|false-positives/.test(path))).toEqual([]);
  });

  it("설정 탭을 다시 열거나 '새로 고침'을 누르면 통계·오판·감사·규칙·설정만 다시 읽고, 치지직을 부르는 채팅 설정은 다시 읽지 않는다(F6)", async () => {
    const fetchMock = stubFetch({});
    hookState.current = { ...initialServerState };
    const manager = { ...me, role: "STREAMING_CHANNEL_MANAGER" as const, permissions: ["view_audit" as const] };
    render(<MainScreen me={manager} onSignedOut={() => undefined} onRefreshMe={noRefresh} />);
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

describe("MainScreen 시스템이 자동 숨김을 껐을 때(F8·B19-3, 스모크 S2)", () => {
  /** 켜짐 상태로 그린 뒤, 꺼짐 상태(이유 포함)로 바꿔 다시 그린다. */
  function renderThenDisable(manager: MeDto, autoHideOffReason: ServerStatus["autoHideOffReason"]) {
    stubFetch({});
    hookState.current = { ...initialServerState, status: enabledStatus };
    const onSignedOut = vi.fn();
    const { rerender } = render(<MainScreen me={manager} onSignedOut={onSignedOut} onRefreshMe={noRefresh} />);
    expect(screen.queryByRole("alert")).toBeNull();
    hookState.current = { ...initialServerState, status: { ...enabledStatus, autoHideEnabled: false, autoHideOffReason } };
    rerender(<MainScreen me={manager} onSignedOut={onSignedOut} onRefreshMe={noRefresh} />);
  }

  it("1분 한도 초과로 꺼지면 그 이유를 밝힌 안내를 목록을 밀지 않는 층에 띄우고, 닫으면 사라진다", async () => {
    renderThenDisable(auditManager, "breaker");
    const alert = screen.getByRole("alert");
    expect(alert.querySelector("p")?.textContent).toBe(`자동 숨김이 꺼졌습니다(1분 한도 초과). ${AUDIT_HINT}`);
    // 안내는 목록을 밀지 않는 고정 위치 층에 뜬다: 배너 바로 다음은 여전히 도구 막대다(B19-4).
    expect(alert.closest(".overlay-bottom")).not.toBeNull();
    expect(screen.getByRole("status", { name: "서버 상태" }).nextElementSibling?.classList.contains("toolbar")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("치지직 호출 실패 증가로 꺼지면 그 이유를 밝힌다", () => {
    renderThenDisable(auditManager, "failure_rate");
    expect(screen.getByRole("alert").querySelector("p")?.textContent).toBe(`자동 숨김이 꺼졌습니다(치지직 호출 실패 증가). ${AUDIT_HINT}`);
  });

  it("감사 기록을 볼 수 없는 매니저에게는 감사 기록 안내를 붙이지 않는다", () => {
    renderThenDisable(switchManager, "breaker");
    expect(screen.getByRole("alert").querySelector("p")?.textContent).toBe("자동 숨김이 꺼졌습니다(1분 한도 초과).");
  });

  it("다른 매니저가 손으로 끈 것(manual)이면 안내를 띄우지 않는다", () => {
    renderThenDisable(auditManager, "manual");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("이 기기에서 끈 것(manual)이면 안내를 띄우지 않는다", async () => {
    const fetchMock = stubFetch({ "POST /api/auto-hide": () => json(200, { enabled: false }) });
    hookState.current = { ...initialServerState, status: enabledStatus };
    const onSignedOut = vi.fn();
    const { rerender } = render(<MainScreen me={switchManager} onSignedOut={onSignedOut} onRefreshMe={noRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: "자동 숨김: 켜짐" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    hookState.current = { ...initialServerState, status: { ...enabledStatus, autoHideEnabled: false, autoHideOffReason: "manual" } };
    rerender(<MainScreen me={switchManager} onSignedOut={onSignedOut} onRefreshMe={noRefresh} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("처음 받은 상태가 꺼짐이면 안내를 띄우지 않는다", () => {
    stubFetch({});
    hookState.current = { ...initialServerState, status: { ...enabledStatus, autoHideEnabled: false, autoHideOffReason: "breaker" } };
    render(<MainScreen me={auditManager} onSignedOut={vi.fn()} onRefreshMe={noRefresh} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("MainScreen 기본 성공 안내(F9)", () => {
  it("서버가 안내(note)를 주지 않으면 숨기기·무시에 기본 안내를 보여 준다", async () => {
    const verdict = (id: number) => ({ id, chatChannelId: "c", senderChannelId: `s${id}`, senderNickname: `시청자${id}`, content: `메시지${id}`, messageTime: id, decision: "candidate" as const, reason: "rule:weak:1", status: "pending" as const, createdAt: Date.now() - id });
    stubFetch({ "POST /api/verdicts/1/hide": () => json(200, { ok: true, note: null }), "POST /api/verdicts/2/ignore": () => json(200, { ok: true }) });
    hookState.current = { ...initialServerState, status: { ...enabledStatus, autoHideEnabled: false }, verdicts: [verdict(1), verdict(2)] };
    render(<MainScreen me={{ ...me, permissions: ["hide_message"] }} onSignedOut={vi.fn()} onRefreshMe={noRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: /^시청자1의 .+ 메시지 숨기기$/ }));
    await waitFor(() => expect(actionToast()?.textContent).toBe("숨겼습니다."));
    await userEvent.click(screen.getByRole("button", { name: /^시청자2의 .+ 메시지 무시$/ }));
    await waitFor(() => expect(actionToast()?.textContent).toBe("무시했습니다."));
  });
});

describe("MainScreen 임시 제한 요청(S13)", () => {
  it("판정 번호만 보내고 채팅 채널은 보내지 않는다(서버가 판정에서 읽는다)", async () => {
    const verdict = { id: 7, chatChannelId: "chat-1", senderChannelId: "bad", senderNickname: "악플러", content: "나쁜 말", messageTime: 1, decision: "candidate" as const, reason: "rule:weak:1", status: "pending" as const, createdAt: Date.now() };
    const fetchMock = stubFetch({ "POST /api/senders/bad/temporary-restrict": () => json(200, { ok: true, note: null }) });
    hookState.current = { ...initialServerState, status: { ...enabledStatus, autoHideEnabled: false }, verdicts: [verdict] };
    render(<MainScreen me={{ ...me, permissions: ["temporary_restrict"] }} onSignedOut={vi.fn()} onRefreshMe={noRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: "악플러 임시 제한" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ verdictId: 7 });
  });
});

describe("MainScreen 자동 숨김 스위치 응답(K17)", () => {
  it("늦게 온 앞 요청(켜기)의 응답은 뒤에 보낸 요청(끄기)의 결과를 덮지 않는다", async () => {
    const applied = vi.spyOn(hookStable, "applyAutoHide");
    let resolveEnable: (response: Response) => void = () => undefined;
    const enableResponse = new Promise<Response>((resolve) => {
      resolveEnable = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled ? enableResponse : Promise.resolve(json(200, { enabled: false }))));
    vi.stubGlobal("confirm", vi.fn(() => true));
    const admin = { ...switchManager, permissions: ["enable_auto_hide" as const, "disable_auto_hide" as const] };
    hookState.current = { ...initialServerState, status: { ...enabledStatus, autoHideEnabled: false } };
    const { rerender } = render(<MainScreen me={admin} onSignedOut={vi.fn()} onRefreshMe={noRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: "자동 숨김: 꺼짐" }));
    // 켜기 응답보다 실시간 status가 먼저 와서 켜짐으로 보이고, 매니저가 바로 끈다.
    hookState.current = { ...initialServerState, status: enabledStatus };
    rerender(<MainScreen me={admin} onSignedOut={vi.fn()} onRefreshMe={noRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: "자동 숨김: 켜짐" }));
    await waitFor(() => expect(applied).toHaveBeenCalledWith(false));
    await act(async () => resolveEnable(json(200, { enabled: true })));
    expect(applied.mock.calls).toEqual([[false]]);
  });
});

describe("MainScreen 네트워크 오류로 끝난 되돌릴 수 없는 조치(K18)", () => {
  /** 숨기기·임시 제한·무시를 할 수 있는 채팅 운영자. */
  const actor = { ...me, permissions: ["hide_message" as const, "temporary_restrict" as const] };
  /** 판정 예시. */
  const verdict = { id: 7, chatChannelId: "chat-1", senderChannelId: "bad", senderNickname: "악플러", content: "나쁜 말", messageTime: 1, decision: "candidate" as const, reason: "rule:weak:1", status: "pending" as const, createdAt: Date.now() };
  /** 서버에 닿지 못한 fetch 거절(브라우저는 TypeError로 거절한다). */
  const networkFailure = (): Response => {
    throw new TypeError("Failed to fetch");
  };

  it.each([
    ["숨기기", "POST /api/verdicts/7/hide", /^악플러의 .+ 메시지 숨기기$/],
    ["임시 제한", "POST /api/senders/bad/temporary-restrict", /^악플러 임시 제한$/],
  ])("%s 요청이 네트워크 오류로 끝나면 결과를 알 수 없음으로 보아 잠금을 붙잡고 다시 보내지 않는다", async (_label, route, name) => {
    const fetchMock = stubFetch({ [route]: networkFailure });
    hookState.current = { ...initialServerState, status: { ...enabledStatus, autoHideEnabled: false }, verdicts: [verdict] };
    render(<MainScreen me={actor} onSignedOut={vi.fn()} onRefreshMe={noRefresh} />);
    await userEvent.click(screen.getByRole("button", { name }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/처리 결과를 알 수 없습니다.*다시 누르지 마세요/));
    const button = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await userEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("무시는 네트워크 오류여도 붙잡지 않는다(되돌릴 수 있고, 다시 보내도 서버가 409로 막는다)", async () => {
    stubFetch({ "POST /api/verdicts/7/ignore": networkFailure });
    hookState.current = { ...initialServerState, status: { ...enabledStatus, autoHideEnabled: false }, verdicts: [verdict] };
    render(<MainScreen me={actor} onSignedOut={vi.fn()} onRefreshMe={noRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: /^악플러의 .+ 메시지 무시$/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/서버에 연결할 수 없습니다/));
    expect(screen.getByRole("alert").textContent).not.toMatch(/다시 누르지 마세요/);
    await waitFor(() => expect((screen.getByRole("button", { name: /^악플러의 .+ 메시지 무시$/ }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("MainScreen 내 정보 다시 읽기(K23)", () => {
  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("실시간 연결이 열릴 때마다(첫 연결 포함) 내 정보를 다시 읽는다(티켓 발급 때 서버가 역할을 다시 확인한다)", () => {
    stubFetch({});
    const onRefreshMe = vi.fn();
    const onSignedOut = vi.fn();
    const renderWith = (realtimeConnected: boolean) => {
      hookState.current = { ...initialServerState, realtimeConnected };
      return <MainScreen me={me} onSignedOut={onSignedOut} onRefreshMe={onRefreshMe} />;
    };
    const { rerender } = render(renderWith(false));
    expect(onRefreshMe).not.toHaveBeenCalled();
    rerender(renderWith(true));
    expect(onRefreshMe).toHaveBeenCalledTimes(1);
    rerender(renderWith(false));
    rerender(renderWith(true));
    expect(onRefreshMe).toHaveBeenCalledTimes(2);
  });

  it("화면이 다시 보이면 내 정보를 다시 읽는다", () => {
    stubFetch({});
    const onRefreshMe = vi.fn();
    hookState.current = { ...initialServerState };
    render(<MainScreen me={me} onSignedOut={vi.fn()} onRefreshMe={onRefreshMe} />);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(onRefreshMe).toHaveBeenCalledTimes(1);
  });

  it("감사 기록 권한을 잃으면 떠 있는 시스템 꺼짐 안내에서 감사 기록 안내를 바로 뺀다", () => {
    stubFetch({});
    hookState.current = { ...initialServerState, status: enabledStatus };
    const onSignedOut = vi.fn();
    const { rerender } = render(<MainScreen me={auditManager} onSignedOut={onSignedOut} onRefreshMe={vi.fn()} />);
    hookState.current = { ...initialServerState, status: { ...enabledStatus, autoHideEnabled: false, autoHideOffReason: "breaker" } };
    rerender(<MainScreen me={auditManager} onSignedOut={onSignedOut} onRefreshMe={vi.fn()} />);
    expect(screen.getByRole("alert").querySelector("p")?.textContent).toBe(`자동 숨김이 꺼졌습니다(1분 한도 초과). ${AUDIT_HINT}`);
    rerender(<MainScreen me={switchManager} onSignedOut={onSignedOut} onRefreshMe={vi.fn()} />);
    expect(screen.getByRole("alert").querySelector("p")?.textContent).toBe("자동 숨김이 꺼졌습니다(1분 한도 초과).");
  });
});
