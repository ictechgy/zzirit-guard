import type { MeDto, ServerStatus } from "@zzirit-guard/shared";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MainScreen } from "../../src/screens/MainScreen";
import { initialServerState, type ServerState } from "../../src/state/serverReducer";
import { stubFetch } from "../helpers/stubFetch";

/** 훅이 돌려줄 서버 상태와, 렌더마다 같은 함수(실제 훅의 useCallback처럼). 테스트마다 상태를 바꾼다. */
const hook = vi.hoisted(() => ({ state: null as ServerState | null, reload: () => undefined, reconnect: () => undefined, applyAutoHide: (_enabled: boolean) => undefined }));
/** 상태 배너가 그려진 횟수. 후보 화면이 다시 그려졌는지 재는 데 쓴다(배너는 후보 화면 안에만 있다). */
const renders = vi.hoisted(() => ({ statusBanner: 0 }));

vi.mock("../../src/state/useServerState", () => ({
  /** 고정 상태를 돌려주는 가짜 훅. reload·reconnect·applyAutoHide는 렌더마다 같은 함수다. */
  useServerState: () => ({ state: hook.state, reload: hook.reload, reconnect: hook.reconnect, applyAutoHide: hook.applyAutoHide }),
}));
vi.mock("../../src/components/StatusBanner", () => ({
  /** 그려진 횟수만 세는 가짜 배너. */
  StatusBanner: () => {
    renders.statusBanner += 1;
    return null;
  },
}));

/** 채팅 운영자. */
const me: MeDto = { channelId: "m1", channelName: "매니저1", role: "STREAMING_CHAT_MANAGER", permissions: ["disable_auto_hide", "hide_message"] };
/** 정상 상태. */
const status: ServerStatus = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, autoHideOffReason: null, lastChatAt: null, pendingActions: 0 };

afterEach(() => {
  vi.unstubAllGlobals();
  renders.statusBanner = 0;
});

describe("MainScreen 다시 그리기(F4)", () => {
  it("채팅 묶음(chat_batch)만 바뀌면 후보 화면을 다시 그리지 않는다", () => {
    stubFetch({});
    hook.state = { ...initialServerState, status, realtimeConnected: true };
    const onSignedOut = vi.fn();
    const { rerender } = render(<MainScreen me={me} onSignedOut={onSignedOut} />);
    const rendersBefore = renders.statusBanner;
    expect(rendersBefore).toBeGreaterThan(0);
    hook.state = { ...hook.state, chatLines: [{ senderNickname: "시청자", content: "안녕", messageTime: 1, decision: "pass", seq: 0 }], nextChatSeq: 1 };
    rerender(<MainScreen me={me} onSignedOut={onSignedOut} />);
    expect(renders.statusBanner).toBe(rendersBefore);
  });
});
