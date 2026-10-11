import type { MeDto } from "@zzirit-guard/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disablePush } from "../../src/push/pushSubscription";
import { AccountSection } from "../../src/settings/AccountSection";
import { json, stubFetch } from "../helpers/stubFetch";

vi.mock("../../src/push/pushSubscription", () => ({ enablePush: vi.fn(async () => undefined), disablePush: vi.fn(async () => undefined) }));

afterEach(() => vi.unstubAllGlobals());

/** 채팅 운영자. */
const chatManager: MeDto = { channelId: "m2", channelName: "운영자", role: "STREAMING_CHAT_MANAGER", permissions: ["disable_auto_hide", "hide_message", "temporary_restrict"] };

describe("AccountSection", () => {
  it("로그아웃하면 먼저 이 기기의 알림 구독을 풀고 로그아웃한다(스펙 11장, R-14)", async () => {
    const fetchMock = stubFetch({ "POST /api/logout": () => json(200, { ok: true }) });
    const onSignedOut = vi.fn();
    render(<AccountSection me={chatManager} onSignedOut={onSignedOut} />);
    await userEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledWith(null));
    expect(vi.mocked(disablePush).mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0] as number);
  });

  it("알림 구독 해지가 실패해도 로그아웃은 끝까지 진행한다(Task 6 리뷰)", async () => {
    vi.mocked(disablePush).mockRejectedValueOnce(new Error("getSubscription 실패"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubFetch({ "POST /api/logout": () => json(200, { ok: true }) });
    const onSignedOut = vi.fn();
    render(<AccountSection me={chatManager} onSignedOut={onSignedOut} />);
    await userEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledWith(null));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("연결 해제 확인을 취소하면 아무 요청도 보내지 않는다", async () => {
    const fetchMock = stubFetch({});
    vi.stubGlobal("confirm", vi.fn(() => false));
    const owner: MeDto = { ...chatManager, permissions: [...chatManager.permissions, "connect_channel"] };
    render(<AccountSection me={owner} onSignedOut={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "채널 연결 해제" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("로그아웃 요청이 401이어도 로컬 로그아웃을 마친다", async () => {
    stubFetch({ "POST /api/logout": () => json(401, { error: "unauthorized", message: "세션이 끝났습니다." }) });
    const onSignedOut = vi.fn();
    render(<AccountSection me={chatManager} onSignedOut={onSignedOut} />);
    await userEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledWith(null));
  });

  it("로그아웃이 진행 중이면 버튼이 잠기고 두 번 눌러도 요청은 한 번이다", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountSection me={chatManager} onSignedOut={vi.fn()} />);
    const button = screen.getByRole("button", { name: "로그아웃" });
    await userEvent.dblClick(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
