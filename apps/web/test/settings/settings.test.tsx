import type { AuditEntryDto, FalsePositiveReviewDto, MeDto, RuleEntryDto, ServerStatus } from "@zzirit-guard/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditSection } from "../../src/settings/AuditSection";
import { FalsePositiveSection } from "../../src/settings/FalsePositiveSection";
import { RulesSection } from "../../src/settings/RulesSection";
import { StatsSection } from "../../src/settings/StatsSection";
import { StatusSection } from "../../src/settings/StatusSection";
import { json, stubFetch } from "../helpers/stubFetch";
import { AI_OFF, NO_AI } from "../helpers/aiFixtures";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 채널 관리자. */
const channelManager: MeDto = { channelId: "m1", channelName: "관리자", role: "STREAMING_CHANNEL_MANAGER", permissions: ["disable_auto_hide", "enable_auto_hide", "edit_rules", "hide_message", "temporary_restrict", "restrict", "edit_chat_settings", "view_audit"] };
/** 채팅 운영자. */
const chatManager: MeDto = { channelId: "m2", channelName: "운영자", role: "STREAMING_CHAT_MANAGER", permissions: ["disable_auto_hide", "hide_message", "temporary_restrict"] };
/** 공개 저장소에 둘 수 있는 중립 자리표시자 금칙어(R-10). */
const PLACEHOLDER_PATTERN = "금칙어예시";

describe("RulesSection", () => {
  it("종류별로 보여 주고, 추가하면 다시 불러온다", async () => {
    const rules: RuleEntryDto[] = [{ id: 1, kind: "strong", pattern: PLACEHOLDER_PATTERN, createdBy: "default", createdAt: 0 }];
    const fetchMock = stubFetch({
      "GET /api/rules": () => json(200, rules),
      "POST /api/rules": (init) => {
        const body = JSON.parse(String(init?.body)) as { kind: RuleEntryDto["kind"]; pattern: string };
        rules.push({ id: 2, kind: body.kind, pattern: body.pattern, createdBy: "m1", createdAt: 1 });
        return json(200, rules[1]);
      },
    });
    render(<RulesSection me={channelManager} />);
    expect(await screen.findByText(PLACEHOLDER_PATTERN)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "금칙어 강(자동 숨김)" })).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("종류"), "weak");
    await userEvent.type(screen.getByLabelText("내용"), "약한예시");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));
    expect(await screen.findByText("약한예시")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/rules")).toHaveLength(3);
  });

  it("규칙 수정 권한이 없으면 목록만 보인다", async () => {
    stubFetch({ "GET /api/rules": () => json(200, []) });
    render(<RulesSection me={chatManager} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "추가" })).toBeNull());
    expect(screen.getByText(/규칙은 채널 관리자 이상만 바꿀 수 있습니다/)).toBeTruthy();
  });
});

describe("AuditSection", () => {
  it("채팅 운영자에게는 조회하지 않고 이유만 보여 준다", () => {
    const fetchMock = stubFetch({});
    render(<AuditSection me={chatManager} />);
    expect(screen.getByText(/감사 기록은 채널 관리자 이상만/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("채널 관리자에게는 서버 동작 이름을 읽기 쉬운 이름으로 바꿔 보여 준다(R-9)", async () => {
    const entry = (id: number, action: string, overrides: Partial<AuditEntryDto> = {}): AuditEntryDto => ({
      id, actorType: "manager", actorChannelId: "m1", action, targetSenderChannelId: null, verdictId: null, result: "ok", error: null, createdAt: 0, ...overrides,
    });
    stubFetch({
      "GET /api/audit?limit=50": () => json(200, [
        entry(5, "ignored"), entry(4, "auto_hide_off:breaker", { actorType: "system", actorChannelId: null }), entry(3, "auto_hide_on:manual"),
        entry(2, "rule_add:weak"), entry(1, "hide", { result: "error", error: "치지직 오류(429): TOO_MANY_REQUESTS" }),
      ]),
    });
    render(<AuditSection me={channelManager} />);
    expect(await screen.findByText(/· 무시$/)).toBeTruthy();
    expect(screen.getByText(/시스템 · 자동 숨김 끔\(1분 한도 초과\)/)).toBeTruthy();
    expect(screen.getByText(/자동 숨김 켬\(수동\)/)).toBeTruthy();
    expect(screen.getByText(/규칙 추가\(금칙어 약\(후보\)\)/)).toBeTruthy();
    expect(screen.getByText(/실패: 치지직 오류\(429\)/)).toBeTruthy();
  });
});

describe("StatsSection", () => {
  it("최근 1시간 합계와 가장 바빴던 분을 초당으로 보여 준다", async () => {
    const minute = (received: number) => ({ minute: 0, received, skipped: 10, deduplicated: 5, stage1_forwarded: 0, stage2_done: 0, stage2_dropped: 0, candidates: 2, auto_hidden: 0, shadow: 1, invalid_events: 0 });
    stubFetch({ "GET /api/stats?sinceMinutes=60": () => json(200, [minute(600), minute(3000)]) });
    render(<StatsSection />);
    expect(await screen.findByText("3600")).toBeTruthy();
    expect(screen.getByText("50.0")).toBeTruthy();
  });
});

describe("StatusSection", () => {
  it("열릴 때 상태를 읽고 15초마다 다시 읽는다(마지막 채팅 수신·처리 대기는 실시간으로 오지 않는다, R-7)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const status: ServerStatus = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, autoHideOffReason: null, lastChatAt: null, pendingActions: 2, ai: AI_OFF };
    const fetchMock = stubFetch({ "GET /api/status": () => json(200, status) });
    render(<StatusSection />);
    expect(await screen.findByText("2건")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/status")).toHaveLength(2);
  });
});

describe("FalsePositiveSection", () => {
  it("오판이 나온 규칙을 규칙 내용과 건수로, 최근 오판을 이유와 함께 보여 준다(스펙 5.5, R-16)", async () => {
    const review: FalsePositiveReviewDto = {
      recent: [{ id: 9, chatChannelId: "c", senderChannelId: "s", senderNickname: "시청자", content: "정상 문장", messageTime: 1, decision: "candidate", reason: "rule:strong_spanning:3", status: "false_positive", createdAt: 0, ...NO_AI }],
      byReason: [{ reason: "rule:strong_spanning:3", count: 2 }, { reason: "rule:link", count: 1 }],
    };
    stubFetch({
      "GET /api/false-positives?limit=20": () => json(200, review),
      "GET /api/rules": () => json(200, [{ id: 3, kind: "strong", pattern: PLACEHOLDER_PATTERN, createdBy: "default", createdAt: 0 }]),
    });
    render(<FalsePositiveSection />);
    expect(await screen.findByText(`금칙어 강(띄어 쓰거나 단어를 걸침) #3 '${PLACEHOLDER_PATTERN}' — 2건`)).toBeTruthy();
    expect(screen.getByText("광고 링크 — 1건")).toBeTruthy();
    expect(screen.getByText("시청자: 정상 문장")).toBeTruthy();
  });
});
