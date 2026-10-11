import type { ServerStatus } from "@zzirit-guard/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBanner } from "../../src/components/StatusBanner";

/** 정상 상태. */
const status: ServerStatus = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, lastChatAt: null, pendingActions: 0 };

describe("StatusBanner 채널 다시 연결 링크(F1)", () => {
  it("쓰기가 잠기면 채널 연결 권한이 있는 스트리머에게 '채널 다시 연결' 링크를 보여 준다", () => {
    render(<StatusBanner status={{ ...status, writeLocked: true }} realtimeConnected canReconnectChannel />);
    expect(screen.getByRole("link", { name: "채널 다시 연결" }).getAttribute("href")).toBe("/auth/connect");
  });

  it("채널이 연결돼 있지 않아도 스트리머에게 링크를 보여 준다", () => {
    render(<StatusBanner status={{ ...status, channelConnected: false, writeLocked: true }} realtimeConnected canReconnectChannel />);
    expect(screen.getByRole("link", { name: "채널 다시 연결" })).toBeTruthy();
  });

  it("채널 연결 권한이 없는 매니저에게는 쓰기가 잠겨도 링크를 보여 주지 않는다", () => {
    render(<StatusBanner status={{ ...status, writeLocked: true }} realtimeConnected canReconnectChannel={false} />);
    expect(screen.queryByRole("link", { name: "채널 다시 연결" })).toBeNull();
  });

  it("정상 상태면 스트리머에게도 링크를 보여 주지 않는다", () => {
    render(<StatusBanner status={status} realtimeConnected canReconnectChannel />);
    expect(screen.queryByRole("link", { name: "채널 다시 연결" })).toBeNull();
  });
});
