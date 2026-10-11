import type { ChatSettingsDto, MeDto, RuleEntryDto, SettingsDto } from "@zzirit-guard/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsScreen } from "../../src/screens/SettingsScreen";
import { ChatSettingsSection } from "../../src/settings/ChatSettingsSection";
import { LimitsSection } from "../../src/settings/LimitsSection";
import { RulesSection } from "../../src/settings/RulesSection";
import { StatusSection } from "../../src/settings/StatusSection";
import { json, stubFetch } from "../helpers/stubFetch";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 채널 관리자. */
const manager: MeDto = { channelId: "m1", channelName: "관리자", role: "STREAMING_CHANNEL_MANAGER", permissions: ["edit_rules", "edit_chat_settings", "view_audit"] };
/** 기본 설정값. */
const settings: SettingsDto = { breakerPerMinute: 30, retentionDaysContent: 7, retentionDaysAudit: 90 };

/** 응답하지 않는 요청을 가진 fetch. 진행 중 상태를 붙잡는다. */
function stubPending(getRoutes: Record<string, () => Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const route = getRoutes[`${init?.method ?? "GET"} ${String(input)}`];
    return route ? Promise.resolve(route()) : new Promise<Response>(() => undefined);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** 해당 메서드·경로로 나간 호출 수. */
function callsTo(fetchMock: ReturnType<typeof vi.fn>, method: string, path: string): number {
  return fetchMock.mock.calls.filter(([url, init]) => url === path && ((init as RequestInit | undefined)?.method ?? "GET") === method).length;
}

describe("중복 제출 방지", () => {
  it("규칙 추가: 두 번 눌러도 POST는 한 번이고 진행 중에는 버튼이 잠긴다", async () => {
    const fetchMock = stubPending({ "GET /api/rules": () => json(200, []) });
    render(<RulesSection me={manager} />);
    await userEvent.type(screen.getByLabelText("내용"), "예시");
    const button = screen.getByRole("button", { name: "추가" }) as HTMLButtonElement;
    await userEvent.dblClick(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(callsTo(fetchMock, "POST", "/api/rules")).toBe(1);
  });

  it("한도 저장: 두 번 눌러도 PUT은 한 번이고 버튼이 잠긴다", async () => {
    const fetchMock = stubPending({ "GET /api/settings": () => json(200, settings) });
    render(<LimitsSection me={manager} />);
    const button = (await screen.findByRole("button", { name: "저장" })) as HTMLButtonElement;
    await userEvent.dblClick(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(callsTo(fetchMock, "PUT", "/api/settings")).toBe(1);
  });
});

describe("LimitsSection 검증", () => {
  it.each([["", "비움"], ["0", "0"], ["1.5", "소수"]])("값이 %s이면 보내지 않고 항목 이름과 범위를 알린다(%s)", async (value) => {
    const fetchMock = stubFetch({ "GET /api/settings": () => json(200, settings) });
    render(<LimitsSection me={manager} />);
    const input = await screen.findByLabelText(/원문 보관 기간/);
    await userEvent.clear(input);
    if (value) await userEvent.type(input, value);
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(screen.getByRole("status").textContent).toMatch(/원문 보관 기간\(일\)은\(는\) 1에서 365 사이의 정수/);
    expect(callsTo(fetchMock, "PUT", "/api/settings")).toBe(0);
  });

  it("저장 메시지는 다시 고치면 사라진다", async () => {
    stubFetch({ "GET /api/settings": () => json(200, settings), "PUT /api/settings": () => json(200, settings) });
    render(<LimitsSection me={manager} />);
    await userEvent.click(await screen.findByRole("button", { name: "저장" }));
    expect(await screen.findByText("저장했습니다.")).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/원문 보관 기간/), "1");
    expect(screen.queryByText("저장했습니다.")).toBeNull();
  });
});

describe("ChatSettingsSection", () => {
  it("결과 메시지는 다시 바꾸기 시작하면 사라진다", async () => {
    const chat: ChatSettingsDto = { chatSlowModeSec: 0 } as ChatSettingsDto;
    const fetchMock = stubFetch({ "GET /api/chat-settings": () => json(200, chat), "PUT /api/chat-settings": () => json(200, chat) });
    render(<ChatSettingsSection me={manager} />);
    await userEvent.selectOptions(await screen.findByLabelText("저속 모드"), "10");
    expect(await screen.findByText("저속 모드를 10초로 바꿨습니다.")).toBeTruthy();
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => undefined));
    await userEvent.selectOptions(screen.getByLabelText("저속 모드"), "30");
    expect(screen.queryByText("저속 모드를 10초로 바꿨습니다.")).toBeNull();
  });
});

describe("ChatSettingsSection 최신 값 병합(F5)", () => {
  /** 화면을 처음 열 때 읽은 설정(A). */
  const opened: ChatSettingsDto = { chatAvailableCondition: "NONE", chatAvailableGroup: "ALL", minFollowerMinute: 0, allowSubscriberInFollowerMode: false, chatSlowModeSec: 0, chatEmojiMode: false };
  /** 그사이 다른 사람이 치지직에서 바꾼 설정(B). */
  const changedElsewhere: ChatSettingsDto = { ...opened, chatAvailableGroup: "FOLLOWER", minFollowerMinute: 10, chatEmojiMode: true };

  it("보내기 직전에 설정을 다시 읽어, 바꾼 저속 모드만 최신 값(B) 위에 얹어 보낸다", async () => {
    const reads = [opened, changedElsewhere];
    const fetchMock = stubFetch({
      "GET /api/chat-settings": () => json(200, reads.shift() ?? changedElsewhere),
      "PUT /api/chat-settings": (init) => json(200, JSON.parse(String(init?.body))),
    });
    render(<ChatSettingsSection me={manager} />);
    await userEvent.selectOptions(await screen.findByLabelText("저속 모드"), "10");
    expect(await screen.findByText("저속 모드를 10초로 바꿨습니다.")).toBeTruthy();
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ ...changedElsewhere, chatSlowModeSec: 10 });
  });

  it("다시 읽기가 실패하면 보내지 않고 오류를 보여 준다", async () => {
    let reads = 0;
    const fetchMock = stubFetch({
      "GET /api/chat-settings": () => (reads++ === 0 ? json(200, opened) : json(502, { error: "chzzk_failed", message: "치지직 설정을 읽지 못했습니다." })),
    });
    render(<ChatSettingsSection me={manager} />);
    await userEvent.selectOptions(await screen.findByLabelText("저속 모드"), "10");
    expect(await screen.findByText("치지직 설정을 읽지 못했습니다.")).toBeTruthy();
    expect(callsTo(fetchMock, "PUT", "/api/chat-settings")).toBe(0);
  });
});

describe("RulesSection 삭제 확인(F10)", () => {
  /** 지울 규칙(중립 자리표시자, R-10). */
  const rule: RuleEntryDto = { id: 7, kind: "weak", pattern: "금칙어예시", createdBy: "m1", createdAt: 0 };

  it("삭제는 규칙 내용을 보여 주며 먼저 묻고, 취소하면 DELETE를 보내지 않는다", async () => {
    const fetchMock = stubFetch({ "GET /api/rules": () => json(200, [rule]) });
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<RulesSection me={manager} />);
    await userEvent.click(await screen.findByRole("button", { name: "금칙어예시 삭제" }));
    expect(confirm).toHaveBeenCalledWith("'금칙어예시' 규칙을 지울까요?");
    expect(callsTo(fetchMock, "DELETE", "/api/rules/7")).toBe(0);
  });

  it("확인하면 DELETE를 보낸다", async () => {
    const fetchMock = stubFetch({ "GET /api/rules": () => json(200, [rule]), "DELETE /api/rules/7": () => json(200, { ok: true }) });
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<RulesSection me={manager} />);
    await userEvent.click(await screen.findByRole("button", { name: "금칙어예시 삭제" }));
    await waitFor(() => expect(callsTo(fetchMock, "DELETE", "/api/rules/7")).toBe(1));
  });
});

describe("RulesSection 입력", () => {
  it("추가가 400으로 실패하면 입력한 글자가 남고 오류가 보인다", async () => {
    stubFetch({
      "GET /api/rules": () => json(200, [] as RuleEntryDto[]),
      "POST /api/rules": () => json(400, { error: "invalid", message: "내용이 올바르지 않습니다." }),
    });
    render(<RulesSection me={manager} />);
    await userEvent.type(screen.getByLabelText("내용"), "예시");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));
    expect(await screen.findByText("내용이 올바르지 않습니다.")).toBeTruthy();
    expect((screen.getByLabelText("내용") as HTMLInputElement).value).toBe("예시");
  });

  it("빈 입력이면 조용히 버리지 않고 안내한다", async () => {
    const fetchMock = stubFetch({ "GET /api/rules": () => json(200, []) });
    render(<RulesSection me={manager} />);
    await userEvent.type(screen.getByLabelText("내용"), "   ");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));
    expect(screen.getByText("규칙 내용을 입력하세요.")).toBeTruthy();
    expect(callsTo(fetchMock, "POST", "/api/rules")).toBe(0);
  });
});

describe("StatusSection", () => {
  it("화면이 사라진 뒤에는 15초가 지나도 다시 읽지 않는다(R-7)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = stubFetch({ "GET /api/status": () => json(500, { error: "x", message: "오류" }) });
    const { unmount } = render(<StatusSection />);
    await screen.findByText("오류");
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(callsTo(fetchMock, "GET", "/api/status")).toBe(1);
  });
});

describe("SettingsScreen", () => {
  it("영구 제한·해제 안내를 보여 준다", () => {
    stubFetch({});
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<SettingsScreen me={manager} onSignedOut={vi.fn()} refreshKey={0} onRefresh={vi.fn()} />);
    expect(screen.getByText("영구 제한·해제는 치지직 기본 도구에서 합니다.")).toBeTruthy();
  });
});
