import type { ServerStatus } from "@zzirit-guard/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBanner } from "../../src/components/StatusBanner";
import { AI_OFF } from "../helpers/aiFixtures";

/** 정상 상태. */
const status: ServerStatus = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, autoHideOffReason: null, lastChatAt: null, pendingActions: 0, ai: AI_OFF };

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

describe("StatusBanner AI 상태(로드맵 2단계)", () => {
  /** AI를 켠 상태. */
  const aiOn: ServerStatus["ai"] = { ...AI_OFF, enabled: true, stage1: { state: "ok", model: "k@1", since: 0 }, stage2: { state: "ok", model: "kanana@1", since: 0 } };

  it("AI를 끈 배포에서는 AI 문구가 없다", () => {
    render(<StatusBanner status={{ ...status, ai: { ...AI_OFF, stage2: { state: "down", model: null, since: 0 } } }} realtimeConnected canReconnectChannel={false} />);
    expect(screen.getByText("정상 동작 중")).toBeTruthy();
  });

  it("워커가 멈추면 'AI 중지'와 어느 단계인지 알리고, 규칙은 계속 동작한다고 알린다", () => {
    render(<StatusBanner status={{ ...status, ai: { ...aiOn, stage2: { state: "down", model: "kanana@1", since: 0 } } }} realtimeConnected canReconnectChannel={false} />);
    expect(screen.getByText("AI 중지(2차 워커 응답 없음). 규칙은 계속 동작합니다.")).toBeTruthy();
  });

  it("최근 1분 AI 미검사가 있으면 과부하와 장애를 나눠 알린다", () => {
    render(<StatusBanner status={{ ...status, ai: { ...aiOn, uncheckedLastMinute: { dropped: 3, unchecked: 2 } } }} realtimeConnected canReconnectChannel={false} />);
    expect(screen.getByText("최근 1분 AI 미검사 5건(과부하 3, 장애·너무 긴 문장 2).")).toBeTruthy();
  });

  it("AI가 정상이면 정상 문구만 보인다", () => {
    render(<StatusBanner status={{ ...status, ai: aiOn }} realtimeConnected canReconnectChannel={false} />);
    expect(screen.getByText("정상 동작 중")).toBeTruthy();
  });
});
