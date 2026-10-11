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
});
