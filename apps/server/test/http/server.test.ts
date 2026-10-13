import type { FalsePositiveReviewDto } from "@zzirit-guard/shared";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createDecisionHandler } from "../../src/actions/decisionHandler.js";
import { toSocketSink } from "../../src/http/server.js";
import { silentLogger } from "../../src/logger.js";
import { AuthError } from "../../src/managers/authFlow.js";
import { createHttpHarness, mutatingHeaders, ORIGIN } from "../helpers/httpHarness.js";

let harness: Awaited<ReturnType<typeof createHttpHarness>>;
beforeEach(async () => {
  harness = await createHttpHarness();
});
afterEach(async () => harness.close());

/** 예시 후보 판정을 넣는다. */
function insertCandidate() {
  return harness.verdicts.insert({
    channelId: "c1", chatChannelId: "chat-1", messageTime: 5, senderChannelId: "bad", senderNickname: "악플러",
    content: "나쁜 말", decision: "candidate", reason: "rule:weak:1",
  });
}

describe("인증과 요청 출처", () => {
  it("로그인하지 않으면 401", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized", message: "로그인이 필요합니다." });
  });

  it("내 역할과 권한을 돌려준다", async () => {
    const rawId = harness.login("STREAMING_CHANNEL_OWNER");
    const response = await harness.app.inject({ method: "GET", url: "/api/me", headers: { cookie: `zg_session=${rawId}` } });
    expect(response.json()).toMatchObject({ role: "STREAMING_CHANNEL_OWNER", permissions: expect.arrayContaining(["connect_channel"]) });
  });

  it("표식 헤더가 없거나 다른 출처의 상태 변경 요청은 403", async () => {
    const rawId = harness.login("STREAMING_CHANNEL_OWNER");
    const noMarker = await harness.app.inject({ method: "POST", url: "/api/auto-hide", headers: { cookie: `zg_session=${rawId}` }, payload: { enabled: true } });
    expect(noMarker.statusCode).toBe(403);
    // 홈 화면 앱에는 새로고침이 없어, 할 수 있는 방법(앱을 다시 열기)을 안내한다(F10).
    expect(noMarker.json().message).toBe("요청 출처를 확인할 수 없습니다. 앱을 닫았다가 다시 연 뒤 시도하세요.");
    const foreign = await harness.app.inject({ method: "POST", url: "/api/auto-hide", headers: { ...mutatingHeaders(rawId), origin: "https://evil.example" }, payload: { enabled: true } });
    expect(foreign.statusCode).toBe(403);
  });

  it("보안 헤더를 붙인다", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/me" });
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("API·인증 응답의 캐시 금지(K12)", () => {
  it("/api/* 응답은 성공·오류 모두 Cache-Control: no-store다", async () => {
    const cookie = `zg_session=${harness.login("STREAMING_CHAT_MANAGER")}`;
    const responses = await Promise.all([
      harness.app.inject({ method: "GET", url: "/api/candidates", headers: { cookie } }),
      harness.app.inject({ method: "GET", url: "/api/me" }),
      harness.app.inject({ method: "GET", url: "/api/no-such-route", headers: { cookie } }),
      harness.app.inject({ method: "POST", url: "/api/auto-hide", headers: { cookie }, payload: { enabled: false } }),
      harness.app.inject({ method: "GET", url: "/api/verdicts/abc", headers: { cookie } }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 401, 404, 403, 404]);
    expect(responses.map((response) => response.headers["cache-control"])).toEqual(Array(5).fill("no-store"));
  });

  it("/auth/* 응답(치지직으로 보내기·오류로 돌려보내기)도 no-store다", async () => {
    const start = await harness.app.inject({ method: "GET", url: "/auth/login" });
    const callback = await harness.app.inject({ method: "GET", url: "/auth/callback" });
    expect([start.statusCode, callback.statusCode]).toEqual([302, 302]);
    expect([start.headers["cache-control"], callback.headers["cache-control"]]).toEqual(["no-store", "no-store"]);
  });

  it("인코딩한 경로로 API 라우트에 닿아도 no-store다", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/%61pi/me", headers: { cookie: `zg_session=${harness.login("STREAMING_CHAT_MANAGER")}` } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

describe("자동 숨김 스위치 권한", () => {
  it("채팅 운영자는 끌 수만 있고, 채널 관리자는 켤 수 있다", async () => {
    const chatManager = harness.login("STREAMING_CHAT_MANAGER");
    const enable = await harness.app.inject({ method: "POST", url: "/api/auto-hide", headers: mutatingHeaders(chatManager), payload: { enabled: true } });
    expect(enable.statusCode).toBe(403);
    const disable = await harness.app.inject({ method: "POST", url: "/api/auto-hide", headers: mutatingHeaders(chatManager), payload: { enabled: false } });
    expect(disable.statusCode).toBe(200);
    const channelManager = harness.login("STREAMING_CHANNEL_MANAGER");
    const enabledByManager = await harness.app.inject({ method: "POST", url: "/api/auto-hide", headers: mutatingHeaders(channelManager), payload: { enabled: true } });
    expect(enabledByManager.json()).toEqual({ enabled: true });
    expect(harness.services.autoHide.isEnabled("c1")).toBe(true);
  });
});

describe("판정 조치", () => {
  it("숨김을 실행기로 보낸다", async () => {
    const verdict = insertCandidate();
    const rawId = harness.login("STREAMING_CHAT_MANAGER");
    const response = await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/hide`, headers: mutatingHeaders(rawId) });
    expect(response.json()).toEqual({ ok: true, note: null });
    expect(harness.submit).toHaveBeenCalledWith(
      "c1",
      { kind: "hide", target: { chatChannelId: "chat-1", messageTime: 5, senderChannelId: "bad" }, verdictId: verdict.id },
      { type: "manager", channelId: "STREAMING_CHAT_MANAGER-id" },
    );
  });

  it("치지직이 실패하면 502와 이유를 준다", async () => {
    harness.submit.mockResolvedValueOnce({ ok: false, message: "치지직 호출 한도를 넘었습니다. 잠시 뒤 다시 시도하세요." });
    const verdict = insertCandidate();
    const response = await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/hide`, headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")) });
    expect(response.statusCode).toBe(502);
    expect(response.json().message).toMatch(/호출 한도/);
  });

  it("없는 판정은 404", async () => {
    const response = await harness.app.inject({ method: "POST", url: "/api/verdicts/999/ignore", headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")) });
    expect(response.statusCode).toBe(404);
  });

  it.each(["hidden", "restricted"] as const)("이미 %s인 판정은 다시 숨기지 않고 409 already_handled(F9.2)", async (status) => {
    const verdict = insertCandidate();
    harness.verdicts.updateStatus(verdict.id, status);
    const response = await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/hide`, headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")) });
    expect(response.statusCode).toBe(409);
    // 홈 화면 앱에는 새로고침이 없어, 앱에 있는 '다시 불러오기'를 가리킨다(B19-6).
    expect(response.json()).toMatchObject({ error: "already_handled", message: "이미 다른 조치가 끝난 판정입니다. '다시 불러오기'를 눌러 지금 상태를 확인하세요." });
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it.each(["ignored", "false_positive"] as const)("%s인 판정도 숨기지 않고 409(S12): 숨김은 대기 중(pending)에서만, 오판 표시는 다시 숨길 대상을 만들지 않는다", async (status) => {
    const verdict = insertCandidate();
    harness.verdicts.updateStatus(verdict.id, status);
    const response = await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/hide`, headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "already_handled" });
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it("두 매니저가 거의 동시에 숨기기를 눌러도 실행기에는 한 번만 보내고, 늦은 쪽은 409 already_handled(S12, M10)", async () => {
    // 실행기가 응답을 늦게 주는 동안 두 번째 클릭이 들어오게 한다. 받은 요청은 모두 한꺼번에 끝낸다.
    const releases: Array<() => void> = [];
    harness.submit.mockImplementation(() => new Promise((resolve) => void releases.push(() => resolve({ ok: true, note: null }))));
    const release = () => releases.forEach((finish) => finish());
    const verdict = insertCandidate();
    const url = `/api/verdicts/${verdict.id}/hide`;
    const first = harness.app.inject({ method: "POST", url, headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")) });
    const second = harness.app.inject({ method: "POST", url, headers: mutatingHeaders(harness.login("STREAMING_CHANNEL_MANAGER")) });
    await vi.waitFor(() => expect(harness.submit).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const statuses = (await Promise.all([first, second])).map((response) => response.statusCode).sort();
    expect(statuses).toEqual([200, 409]);
    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it("자동 숨김이 숨기는 중인 판정은 숨기기·무시를 409 in_progress와 안내 문구로 거절한다(S12, N4)", async () => {
    const verdict = insertCandidate();
    harness.services.claims.tryClaim(verdict.id, "auto_hide");
    const headers = mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER"));
    const hide = await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/hide`, headers });
    const ignore = await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/ignore`, headers });
    expect([hide.statusCode, ignore.statusCode]).toEqual([409, 409]);
    expect(hide.json()).toEqual({ error: "in_progress", message: "자동 숨김이 진행 중입니다. 잠시 뒤 결과가 반영됩니다." });
    expect(ignore.json()).toMatchObject({ error: "in_progress" });
    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.verdicts.get(verdict.id)?.status).toBe("pending");
  });

  it("다른 매니저가 숨기는 중인 판정은 409 already_handled다(S12)", async () => {
    const verdict = insertCandidate();
    harness.services.claims.tryClaim(verdict.id, "manager");
    const response = await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/hide`, headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "already_handled" });
  });

  it("치지직 처리 결과를 알 수 없으면 502 result_unknown으로 알린다(N4)", async () => {
    harness.submit.mockResolvedValueOnce({ ok: false, message: "치지직 응답을 받지 못해 처리 결과를 알 수 없습니다.", isResultUnknown: true });
    const verdict = insertCandidate();
    const response = await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/hide`, headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")) });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "result_unknown", message: "치지직 응답을 받지 못해 처리 결과를 알 수 없습니다." });
  });

  it("숨김 결과를 알 수 없으면 같은 판정의 다음 숨기기는 실행기로 보내지 않고 409 result_unknown과 확인 안내를 준다(K1)", async () => {
    harness.submit.mockResolvedValueOnce({ ok: false, message: "치지직 응답을 받지 못해 처리 결과를 알 수 없습니다.", isResultUnknown: true });
    const verdict = insertCandidate();
    const url = `/api/verdicts/${verdict.id}/hide`;
    const headers = mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER"));
    expect((await harness.app.inject({ method: "POST", url, headers })).statusCode).toBe(502);
    const second = await harness.app.inject({ method: "POST", url, headers: mutatingHeaders(harness.login("STREAMING_CHANNEL_MANAGER")) });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({
      error: "result_unknown",
      message: "숨김 결과를 알 수 없습니다. 치지직 채팅에서 숨겨졌는지 확인하고, 숨겨지지 않았다면 치지직 기본 도구로 숨기세요.",
    });
    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it("자동 숨김 결과를 알 수 없으면 매니저 숨기기도 409 result_unknown이다(K1)", async () => {
    harness.submit.mockResolvedValueOnce({ ok: false, message: "치지직 응답을 받지 못해 처리 결과를 알 수 없습니다.", isResultUnknown: true });
    const { services } = harness;
    const handler = createDecisionHandler({ verdicts: harness.verdicts, executor: services.executor, autoHide: services.autoHide, claims: services.claims, stats: services.stats, broadcaster: harness.hub, logger: silentLogger });
    services.autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    const ref = { chatChannelId: "chat-1", messageTime: 5, senderChannelId: "bad", nickname: "악플러", content: "느금마", privileged: false, isRoleUnknown: false };
    const event = { channelId: "c1", senderChannelId: "bad", chatChannelId: "chat-1", nickname: "악플러", userRoleCode: "common_user", content: "느금마", messageTime: 5, receivedAt: 5 };
    handler.handle(event, { decision: "auto_hide", reason: "rule:strong:1", ref, earlierFloodRefs: [], trivial: false, duplicate: false });
    await vi.waitFor(() => expect(services.claims.holderOf(harness.verdicts.listRecent("c1", 0)[0]?.id as number)).toBe("unknown"));
    const verdictId = harness.verdicts.listRecent("c1", 0)[0]?.id as number;
    const response = await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdictId}/hide`, headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "result_unknown" });
    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it.each(["ignore", "false-positive"] as const)("숨김 결과를 알 수 없는 판정도 %s로 정리할 수 있다(K1)", async (action) => {
    harness.submit.mockResolvedValueOnce({ ok: false, message: "치지직 응답을 받지 못해 처리 결과를 알 수 없습니다.", isResultUnknown: true });
    const verdict = insertCandidate();
    const headers = mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER"));
    await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/hide`, headers });
    const response = await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/${action}`, headers });
    expect(response.statusCode).toBe(200);
    expect(harness.verdicts.get(verdict.id)?.status).toBe(action === "ignore" ? "ignored" : "false_positive");
    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it("숨김이 실패하면 붙잡은 판정을 놓아 다시 숨길 수 있다(S12)", async () => {
    harness.submit.mockResolvedValueOnce({ ok: false, message: "치지직 서버 오류로 실패했습니다." });
    const verdict = insertCandidate();
    const headers = mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER"));
    expect((await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/hide`, headers })).statusCode).toBe(502);
    expect(harness.services.claims.isClaimed(verdict.id)).toBe(false);
    expect((await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/hide`, headers })).statusCode).toBe(200);
    expect(harness.submit).toHaveBeenCalledTimes(2);
  });

  it("대기 중인 판정만 무시할 수 있다(F9.2)", async () => {
    const verdict = insertCandidate();
    const rawId = harness.login("STREAMING_CHAT_MANAGER");
    expect((await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/ignore`, headers: mutatingHeaders(rawId) })).statusCode).toBe(200);
    expect(harness.verdicts.get(verdict.id)?.status).toBe("ignored");
    for (const status of ["ignored", "hidden", "restricted", "false_positive"] as const) {
      harness.verdicts.updateStatus(verdict.id, status);
      const response = await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/ignore`, headers: mutatingHeaders(rawId) });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "already_handled" });
      expect(harness.verdicts.get(verdict.id)?.status).toBe(status);
    }
  });

  it("오판 신고는 대기 중·숨김·제한된 판정에서 받는다(F9.2, S12)", async () => {
    const rawId = harness.login("STREAMING_CHAT_MANAGER");
    for (const status of ["pending", "hidden", "restricted"] as const) {
      const verdict = insertCandidate();
      harness.verdicts.updateStatus(verdict.id, status);
      const response = await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/false-positive`, headers: mutatingHeaders(rawId) });
      expect(response.statusCode).toBe(200);
      expect(harness.verdicts.get(verdict.id)?.status).toBe("false_positive");
    }
  });

  it.each(["ignored", "false_positive"] as const)("%s인 판정의 오판 신고는 409이고 상태를 그대로 둔다(S12)", async (status) => {
    const verdict = insertCandidate();
    harness.verdicts.updateStatus(verdict.id, status);
    const response = await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/false-positive`, headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "already_handled" });
    expect(harness.verdicts.get(verdict.id)?.status).toBe(status);
  });

  it("오판 신고는 상태를 바꾸고 감사 기록을 남긴다", async () => {
    const verdict = insertCandidate();
    await harness.app.inject({ method: "POST", url: `/api/verdicts/${verdict.id}/false-positive`, headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")) });
    expect(harness.verdicts.get(verdict.id)?.status).toBe("false_positive");
    expect(harness.auditLog.list("c1", 1, null)[0]).toMatchObject({ action: "false_positive", verdictId: verdict.id });
  });
});

describe("규칙·감사 기록", () => {
  it("잘못된 규칙은 400과 이유를 준다", async () => {
    const response = await harness.app.inject({ method: "POST", url: "/api/rules", headers: mutatingHeaders(harness.login("STREAMING_CHANNEL_MANAGER")), payload: { kind: "weak", pattern: "!!!" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/규칙이 비었습니다/);
  });

  it("한 단어·공용 접미사 허용 도메인은 400과 이유를 준다(K14)", async () => {
    const headers = mutatingHeaders(harness.login("STREAMING_CHANNEL_MANAGER"));
    for (const pattern of ["com", "co.kr", "https://com/"]) {
      const response = await harness.app.inject({ method: "POST", url: "/api/rules", headers, payload: { kind: "allow_domain", pattern } });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain("허용 도메인");
    }
  });

  it("감사 기록은 채팅 운영자에게 보이지 않는다", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/audit", headers: { cookie: `zg_session=${harness.login("STREAMING_CHAT_MANAGER")}` } });
    expect(response.statusCode).toBe(403);
  });
});

describe("로그인 콜백", () => {
  it("실패하면 이유를 담아 첫 화면으로 보낸다", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/auth/callback?code=c&state=test-state", headers: { cookie: "zg_oauth_state=test-state" } });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/?loginError=not_manager");
  });

  it("주소에는 정해진 코드만 싣는다: 코드 없는 AuthError와 그 밖의 오류는 failed이고 문구는 싣지 않는다(F10)", async () => {
    for (const thrown of [new AuthError("<a href=//evil>여기서 다시 로그인</a>"), new Error("내부 오류 상세")]) {
      await harness.close();
      harness = await createHttpHarness({ complete: async () => { throw thrown; } });
      const response = await harness.app.inject({ method: "GET", url: "/auth/callback?code=c&state=test-state", headers: { cookie: "zg_oauth_state=test-state" } });
      expect(response.headers.location).toBe("/?loginError=failed");
    }
  });

  it("치지직에서 code·state 없이 돌아오면 failed 코드로 보낸다(F10)", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/auth/callback", headers: { cookie: "zg_oauth_state=test-state" } });
    expect(response.headers.location).toBe("/?loginError=failed");
  });

  it("성공하면 HttpOnly·Secure·SameSite=Lax 쿠키를 준다", async () => {
    await harness.close();
    harness = await createHttpHarness({
      complete: async () => ({ rawId: "raw-session", session: { id: "h", managerChannelId: "m", managerChannelName: "m", role: "STREAMING_CHAT_MANAGER", expiresAt: 0, lastRoleCheckAt: 0 } }),
    });
    const response = await harness.app.inject({ method: "GET", url: "/auth/callback?code=c&state=test-state", headers: { cookie: "zg_oauth_state=test-state" } });
    expect(response.headers.location).toBe("/");
    const cookies = [response.headers["set-cookie"]].flat().map(String);
    const cookie = cookies.find((value) => value.startsWith("zg_session=")) ?? "";
    expect(cookie).toMatch(/^zg_session=raw-session;/);
    expect(cookies.find((value) => value.startsWith("zg_oauth_state="))).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    for (const attribute of [/;\s*HttpOnly/i, /;\s*Secure/i, /;\s*SameSite=Lax/i, /;\s*Path=\//i]) expect(cookie).toMatch(attribute);
  });
});

describe("인증 경로 요청 한도(F6·S3·g)", () => {
  /** 한도를 넘었을 때 첫 화면으로 보내는 주소(디코딩한 값). */
  const RATE_LIMITED_LOCATION = "/?loginError=rate_limited";
  /** complete가 던지는 AuthError가 만드는 주소(디코딩한 값). 토큰 교환까지 갔다는 표시다. */
  const NOT_MANAGER_LOCATION = "/?loginError=not_manager";

  /** 리다이렉트 주소를 사람이 읽는 형태로 바꾼다. */
  function locationOf(response: { headers: Record<string, unknown> }): string {
    return decodeURIComponent(String(response.headers.location));
  }

  /** 시계를 직접 움직이는 하네스로 바꾼다. complete는 매니저가 아니라는 AuthError를 던지고 호출 횟수를 센다. */
  async function useControlledClock() {
    await harness.close();
    const clock = { now: 1_000_000 };
    const complete = vi.fn(async () => {
      throw new AuthError("이 채널의 매니저가 아닙니다.", "not_manager");
    });
    harness = await createHttpHarness({ complete }, { clock: () => clock.now });
    return { clock, complete };
  }

  /** 요청을 보낸다. */
  function send(url: string, method: "GET" | "HEAD" = "GET", cookie?: string) {
    return harness.app.inject({ method, url, headers: cookie ? { cookie } : {} });
  }

  /** state 쿠키가 맞는 콜백 요청. */
  function validCallback() {
    return send("/auth/callback?code=c&state=test-state", "GET", "zg_oauth_state=test-state");
  }

  it("로그인 시작(connect·login)은 합쳐 1분에 30번까지 받고, 넘으면 JSON이 아니라 첫 화면으로 이유를 보내며, 시간이 지나면 다시 받는다(R-8)", async () => {
    const { clock } = await useControlledClock();
    for (let index = 0; index < 30; index += 1) {
      expect(String((await send(index % 2 === 0 ? "/auth/connect" : "/auth/login")).headers.location)).toMatch(/^https:\/\/chzzk\.example\//);
    }
    const limited = await send("/auth/login");
    expect(limited.statusCode).toBe(302);
    expect(locationOf(limited)).toBe(RATE_LIMITED_LOCATION);
    clock.now += 2_000;
    expect(String((await send("/auth/connect")).headers.location)).toMatch(/^https:\/\/chzzk\.example\//);
    expect(locationOf(await send("/auth/connect"))).toBe(RATE_LIMITED_LOCATION);
  });

  it("인코딩하거나 쿼리를 붙인 경로로 들어와도 같은 라우트의 한도를 쓴다(g)", async () => {
    await useControlledClock();
    for (let index = 0; index < 30; index += 1) await send(index % 2 === 0 ? "/auth/%6Cogin" : "/auth/login?x");
    expect(locationOf(await send("/auth/login"))).toBe(RATE_LIMITED_LOCATION);
    expect(locationOf(await send("/auth/%6Cogin"))).toBe(RATE_LIMITED_LOCATION);
  });

  it("라우트와 맞지 않는 변형(끝 슬래시·대문자·겹 슬래시)은 핸들러를 실행하지 않는다(g)", async () => {
    for (const url of ["/auth/login/", "/AUTH/login", "/auth//login"]) {
      const response = await send(url);
      expect(response.statusCode).toBe(404);
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("HEAD는 /auth 핸들러를 실행하지 않아 state 쿠키를 쓰지도, 토큰 교환을 하지도 않는다(g)", async () => {
    const { complete } = await useControlledClock();
    for (const url of ["/auth/login", "/auth/connect", "/auth/callback?code=c&state=s"]) {
      const response = await send(url, "HEAD", "zg_oauth_state=s");
      expect(response.statusCode).toBe(404);
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it("state 확인을 통과하지 못한 콜백은 콜백 한도를 쓰지 않는다(S3)", async () => {
    const { complete } = await useControlledClock();
    for (let index = 0; index < 100; index += 1) expect(locationOf(await send("/auth/callback?code=c&state=s"))).toBe("/?loginError=state_mismatch");
    expect(locationOf(await validCallback())).toBe(NOT_MANAGER_LOCATION);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("state를 통과한 콜백은 1분에 60번까지 토큰 교환을 하고, 넘으면 교환하지 않고 첫 화면으로 이유를 보낸다(S3)", async () => {
    const { clock, complete } = await useControlledClock();
    for (let index = 0; index < 60; index += 1) expect(locationOf(await validCallback())).toBe(NOT_MANAGER_LOCATION);
    expect(locationOf(await validCallback())).toBe(RATE_LIMITED_LOCATION);
    expect(complete).toHaveBeenCalledTimes(60);
    clock.now += 1_000;
    await validCallback();
    expect(complete).toHaveBeenCalledTimes(61);
  });

  it("서버가 발급하지 않은 state를 쿠키와 쿼리에 맞춰 보낸 위조 콜백은 콜백 한도를 쓰지 않아 뒤따르는 진짜 콜백을 막지 못한다(B9-1)", async () => {
    const { complete } = await useControlledClock();
    for (let index = 0; index < 70; index += 1) {
      expect(locationOf(await send("/auth/callback?code=c&state=forged", "GET", "zg_oauth_state=forged"))).toBe("/?loginError=state_mismatch");
    }
    expect(locationOf(await validCallback())).toBe(NOT_MANAGER_LOCATION);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("발급된 state의 콜백은 콜백 한도를 쓴다(B9-1)", async () => {
    await useControlledClock();
    for (let index = 0; index < 60; index += 1) await validCallback();
    expect(locationOf(await validCallback())).toBe(RATE_LIMITED_LOCATION);
  });

  it("바깥 상한이 쓰레기 요청으로 비어도 발급된 state의 콜백은 통과한다(B9-2a)", async () => {
    const { complete } = await useControlledClock();
    for (let index = 0; index < 120; index += 1) await send("/auth/callback?code=c&state=wrong");
    expect(locationOf(await send("/auth/login"))).toBe(RATE_LIMITED_LOCATION);
    expect(locationOf(await validCallback())).toBe(NOT_MANAGER_LOCATION);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("바깥 상한과 시작 한도가 비어도 유효한 세션이 있는 요청은 /auth/connect로 치지직에 갈 수 있다(B9-2b)", async () => {
    await useControlledClock();
    const rawId = harness.login("STREAMING_CHANNEL_OWNER");
    for (let index = 0; index < 120; index += 1) await send("/auth/callback?code=c&state=wrong");
    expect(locationOf(await send("/auth/connect"))).toBe(RATE_LIMITED_LOCATION);
    expect(String((await send("/auth/connect", "GET", `zg_session=${rawId}`)).headers.location)).toMatch(/^https:\/\/chzzk\.example\//);
    expect(locationOf(await send("/auth/connect", "GET", "zg_session=not-a-session"))).toBe(RATE_LIMITED_LOCATION);
  });

  it("스트리머가 아닌 세션은 시작 한도를 건너뛰지 못해, 대기 state를 상한까지 밀어내지 못한다(B10-1)", async () => {
    await useControlledClock();
    const rawId = harness.login("STREAMING_CHAT_MANAGER");
    let redirectedToChzzk = 0;
    for (let index = 0; index < 40; index += 1) {
      const response = await send("/auth/login", "GET", `zg_session=${rawId}`);
      if (String(response.headers.location).startsWith("https://chzzk.example/")) redirectedToChzzk += 1;
    }
    expect(redirectedToChzzk).toBe(30);
    expect(locationOf(await send("/auth/login", "GET", `zg_session=${rawId}`))).toBe(RATE_LIMITED_LOCATION);
  });

  it("스트리머 세션은 시작 한도가 비어도 치지직으로 갈 수 있다(B10-1)", async () => {
    await useControlledClock();
    const rawId = harness.login("STREAMING_CHANNEL_OWNER");
    for (let index = 0; index < 35; index += 1) await send("/auth/connect", "GET", `zg_session=${rawId}`);
    expect(String((await send("/auth/connect", "GET", `zg_session=${rawId}`)).headers.location)).toMatch(/^https:\/\/chzzk\.example\//);
  });

  it("콜백 한도가 비어도 스트리머 세션의 콜백은 통과하고, 다른 세션은 막힌다(B10-1)", async () => {
    const { complete } = await useControlledClock();
    const ownerId = harness.login("STREAMING_CHANNEL_OWNER");
    const managerId = harness.login("STREAMING_CHAT_MANAGER");
    for (let index = 0; index < 60; index += 1) await validCallback();
    expect(locationOf(await validCallback())).toBe(RATE_LIMITED_LOCATION);
    const callbackUrl = "/auth/callback?code=c&state=test-state";
    expect(locationOf(await send(callbackUrl, "GET", `zg_oauth_state=test-state; zg_session=${managerId}`))).toBe(RATE_LIMITED_LOCATION);
    expect(locationOf(await send(callbackUrl, "GET", `zg_oauth_state=test-state; zg_session=${ownerId}`))).toBe(NOT_MANAGER_LOCATION);
    expect(complete).toHaveBeenCalledTimes(61);
  });

  it("콜백이 아닌 경로에 발급된 state를 쿼리·쿠키로 맞춰 보내도 바깥 상한을 건너뛰지 못한다(B10-2)", async () => {
    await useControlledClock();
    for (let index = 0; index < 120; index += 1) await send("/auth/callback?code=c&state=wrong");
    expect(locationOf(await send("/auth/login?code=x&state=test-state", "GET", "zg_oauth_state=test-state"))).toBe(RATE_LIMITED_LOCATION);
  });

  it("모든 /auth 요청은 합쳐 1분에 120번까지만 받는다(값싼 바깥 상한, g)", async () => {
    const { complete } = await useControlledClock();
    for (let index = 0; index < 120; index += 1) await send("/auth/callback?code=c&state=wrong", "GET", "zg_oauth_state=s");
    expect(locationOf(await send("/auth/callback?code=c&state=x"))).toBe(RATE_LIMITED_LOCATION);
    expect(locationOf(await send("/auth/login"))).toBe(RATE_LIMITED_LOCATION);
    expect(complete).not.toHaveBeenCalled();
  });

  it("로그인 시작 한도를 다 써도 콜백은 따로 센다", async () => {
    const { complete } = await useControlledClock();
    for (let index = 0; index < 31; index += 1) await send("/auth/login");
    expect(locationOf(await send("/auth/login"))).toBe(RATE_LIMITED_LOCATION);
    await validCallback();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("인증 경로가 아닌 요청은 한도에 영향을 주지도 받지도 않는다", async () => {
    for (let index = 0; index < 31; index += 1) await send("/auth/login");
    expect(locationOf(await send("/auth/login"))).toBe(RATE_LIMITED_LOCATION);
    const rawId = harness.login("STREAMING_CHAT_MANAGER");
    expect((await harness.app.inject({ method: "GET", url: "/api/me", headers: { cookie: `zg_session=${rawId}` } })).statusCode).toBe(200);
  });
});

describe("WebSocket", () => {
  it("티켓으로 연결해 방송을 받는다", async () => {
    const rawId = harness.login("STREAMING_CHAT_MANAGER");
    const ticketResponse = await harness.app.inject({ method: "POST", url: "/api/ws-ticket", headers: mutatingHeaders(rawId) });
    const socket = await harness.app.injectWS(`/ws?ticket=${ticketResponse.json().ticket}`, { headers: { origin: ORIGIN } });
    const received = new Promise<string>((resolve) =>
      socket.on("message", (data) => {
        const text = String(data);
        if (text.includes("verdict_status")) resolve(text);
      }),
    );
    harness.hub.broadcast({ type: "verdict_status", verdictId: 1, status: "hidden" });
    expect(JSON.parse(await received)).toEqual({ type: "verdict_status", verdictId: 1, status: "hidden" });
    socket.terminate();
  });

  it("세션 만료 시각이 지나면 열린 소켓은 다음 방송 대신 만료 이유를 받고 4001로 닫힌다(K9)", async () => {
    await harness.close();
    const clock = { now: 1_000_000 };
    harness = await createHttpHarness({}, { clock: () => clock.now });
    const ticket = (await harness.app.inject({ method: "POST", url: "/api/ws-ticket", headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")) })).json().ticket as string;
    const messages: string[] = [];
    const closed = new Promise<number>((resolve) => {
      const onInit = (client: WebSocket) => {
        client.on("message", (data) => messages.push(String(data)));
        client.on("close", (code) => resolve(code));
      };
      void harness.app.injectWS(`/ws?ticket=${ticket}`, { headers: { origin: ORIGIN } }, { onInit });
    });
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    clock.now += 12 * 60 * 60 * 1000;
    harness.hub.broadcast({ type: "verdict_status", verdictId: 1, status: "hidden" });
    expect(await closed).toBe(4001);
    expect(messages.map((message) => JSON.parse(message).type)).toEqual(["status", "session_ended"]);
  });

  it("치지직에서 해임된 매니저는 티켓을 받지 못하고 세션이 지워진다", async () => {
    const rawId = harness.login("STREAMING_CHAT_MANAGER");
    harness.services.verifyRole = async () => null;
    const response = await harness.app.inject({ method: "POST", url: "/api/ws-ticket", headers: mutatingHeaders(rawId) });
    expect(response.statusCode).toBe(401);
    expect(harness.sessions.get(rawId)).toBeNull();
  });

  it("티켓을 받을 때 해임이 확인되면 그 매니저의 장애 알림 구독도 지운다(B19-5)", async () => {
    const rawId = harness.login("STREAMING_CHAT_MANAGER");
    const unsubscribeManager = vi.spyOn(harness.services.push, "unsubscribeManager");
    harness.services.verifyRole = async () => null;
    const response = await harness.app.inject({ method: "POST", url: "/api/ws-ticket", headers: mutatingHeaders(rawId) });
    expect(response.statusCode).toBe(401);
    expect(unsubscribeManager).toHaveBeenCalledWith("STREAMING_CHAT_MANAGER-id");
  });

  it("구독 삭제가 실패해도 해임 처리(세션 삭제·401)는 끝내고 오류를 기록한다(B19-5)", async () => {
    const rawId = harness.login("STREAMING_CHAT_MANAGER");
    vi.spyOn(harness.services.push, "unsubscribeManager").mockImplementation(() => {
      throw new Error("database is locked");
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    harness.services.logger = logger;
    harness.services.verifyRole = async () => null;
    const response = await harness.app.inject({ method: "POST", url: "/api/ws-ticket", headers: mutatingHeaders(rawId) });
    expect(response.statusCode).toBe(401);
    expect(response.json().message).toMatch(/매니저 권한이 해제되었습니다/);
    expect(harness.sessions.get(rawId)).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { error: "Error: database is locked" });
  });

  it("티켓은 세션마다 1분에 10번까지 주고, 넘으면 429 rate_limited로 거절한다(K8)", async () => {
    const headers = mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER"));
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) statuses.push((await harness.app.inject({ method: "POST", url: "/api/ws-ticket", headers })).statusCode);
    expect(statuses).toEqual([...Array(10).fill(200), 429]);
    const limited = await harness.app.inject({ method: "POST", url: "/api/ws-ticket", headers });
    expect(limited.json()).toEqual({ error: "rate_limited", message: expect.stringContaining("잠시 뒤") });
    const other = await harness.app.inject({ method: "POST", url: "/api/ws-ticket", headers: mutatingHeaders(harness.login("STREAMING_CHANNEL_MANAGER")) });
    expect(other.statusCode).toBe(200);
  });

  it("허브가 붙이지 않은 연결(상한 초과 등)에는 상태(status)를 보내지 않는다(K8)", async () => {
    // 허브가 거절만 하고 닫지는 않게 바꿔, 서버가 attach의 결과를 보고 상태 전송을 건너뛰는지 확인한다.
    vi.spyOn(harness.hub, "attach").mockReturnValue(false);
    const ticket = (await harness.app.inject({ method: "POST", url: "/api/ws-ticket", headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")) })).json().ticket as string;
    const messages: string[] = [];
    // 서버는 붙인 직후 상태를 보내므로, 열리기 전에 듣기 시작해야 놓치지 않는다.
    const onInit = (client: WebSocket) => void client.on("message", (data) => messages.push(String(data)));
    const socket = await harness.app.injectWS(`/ws?ticket=${ticket}`, { headers: { origin: ORIGIN } }, { onInit });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(messages).toEqual([]);
    socket.terminate();
  });

  it("잘못된 티켓은 4003으로 닫는다", async () => {
    // injectWS는 핸드셰이크 직후 서버가 닫으면 열림 이벤트를 놓쳐 멈추므로, 실제 로컬 포트에서 ws 클라이언트로 확인한다.
    const address = await harness.app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}/ws?ticket=wrong`, { headers: { origin: ORIGIN } });
    const code = await new Promise<number>((resolve) => socket.on("close", (closeCode) => resolve(closeCode)));
    expect(code).toBe(4003);
  });
});

describe("CSRF 경로 우회", () => {
  it("인코딩된 경로로도 표식 없는 상태 변경은 403", async () => {
    const verdict = insertCandidate();
    const headers = { cookie: `zg_session=${harness.login("STREAMING_CHANNEL_OWNER")}`, origin: "https://evil.example" };
    const hide = await harness.app.inject({ method: "POST", url: `/%61pi/verdicts/${verdict.id}/hide`, headers });
    const disconnect = await harness.app.inject({ method: "POST", url: "/%61pi/channel/disconnect", headers });
    const logout = await harness.app.inject({ method: "POST", url: "/%61pi/logout", headers });
    expect([hide.statusCode, disconnect.statusCode, logout.statusCode]).toEqual([403, 403, 403]);
    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.services.disconnectChannel).not.toHaveBeenCalled();
  });
});

describe("세션 종료와 소켓", () => {
  it("로그아웃하면 그 세션의 소켓을 닫도록 알린다", async () => {
    const rawId = harness.login("STREAMING_CHAT_MANAGER");
    const sessionId = harness.sessions.get(rawId)?.id;
    await harness.app.inject({ method: "POST", url: "/api/logout", headers: mutatingHeaders(rawId) });
    expect(harness.services.endSessions).toHaveBeenCalledWith([sessionId], "로그아웃했습니다");
    expect(harness.sessions.get(rawId)).toBeNull();
  });

  it("권한이 해제된 매니저의 티켓 요청은 소켓 종료를 알린다", async () => {
    const rawId = harness.login("STREAMING_CHAT_MANAGER");
    const sessionId = harness.sessions.get(rawId)?.id;
    harness.services.verifyRole = async () => null;
    const response = await harness.app.inject({ method: "POST", url: "/api/ws-ticket", headers: mutatingHeaders(rawId) });
    expect(response.statusCode).toBe(401);
    expect(harness.services.endSessions).toHaveBeenCalledWith([sessionId], "매니저 권한이 해제되었습니다");
  });
});

describe("로그인 state 묶기", () => {
  it("로그인 시작 시 state를 HttpOnly 쿠키로 묶는다", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/auth/login" });
    expect(response.statusCode).toBe(302);
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toMatch(/^zg_oauth_state=test-state;/);
    for (const attribute of [/;\s*HttpOnly/i, /;\s*Secure/i, /;\s*SameSite=Lax/i, /;\s*Path=\/auth/i, /;\s*Max-Age=600/i]) expect(cookie).toMatch(attribute);
  });

  it("쿠키가 없거나 다르면 complete를 부르지 않고 안내한다", async () => {
    await harness.close();
    const complete = vi.fn();
    harness = await createHttpHarness({ complete });
    for (const headers of [{}, { cookie: "zg_oauth_state=other" }]) {
      const response = await harness.app.inject({ method: "GET", url: "/auth/callback?code=c&state=s", headers });
      expect(response.headers.location).toBe("/?loginError=state_mismatch");
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it("기존 세션 쿠키가 있으면 로그인 성공 때 그 세션을 지운다", async () => {
    await harness.close();
    harness = await createHttpHarness({
      complete: async () => ({ rawId: "new-session", session: { id: "h", managerChannelId: "m", managerChannelName: "m", role: "STREAMING_CHAT_MANAGER", expiresAt: 0, lastRoleCheckAt: 0 } }),
    });
    const oldRawId = harness.login("STREAMING_CHAT_MANAGER");
    const oldId = harness.sessions.get(oldRawId)?.id;
    await harness.app.inject({ method: "GET", url: "/auth/callback?code=c&state=test-state", headers: { cookie: `zg_oauth_state=test-state; zg_session=${oldRawId}` } });
    expect(harness.sessions.get(oldRawId)).toBeNull();
    expect(harness.services.endSessions).toHaveBeenCalledWith([oldId], "새로 로그인했습니다");
  });
});

describe("임시 제한의 채팅 채널(S13, M12)", () => {
  const temporaryUrl = "/api/senders/bad/temporary-restrict";

  it("판정 ID가 없으면 400이고 실행하지 않는다", async () => {
    const headers = mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER"));
    const missing = await harness.app.inject({ method: "POST", url: temporaryUrl, headers, payload: { chatChannelId: "chat-1" } });
    const nullId = await harness.app.inject({ method: "POST", url: temporaryUrl, headers, payload: { chatChannelId: "chat-1", verdictId: null } });
    expect([missing.statusCode, nullId.statusCode]).toEqual([400, 400]);
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it("채팅 채널은 저장된 판정의 값을 쓰고, 본문에 다른 값을 넣어도 따르지 않는다", async () => {
    const verdict = insertCandidate();
    const headers = mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER"));
    const response = await harness.app.inject({ method: "POST", url: temporaryUrl, headers, payload: { chatChannelId: "attacker-chat", verdictId: verdict.id } });
    expect(response.statusCode).toBe(200);
    expect(harness.submit).toHaveBeenCalledWith("c1", { kind: "temporary_restrict", targetChannelId: "bad", chatChannelId: "chat-1", verdictId: verdict.id }, expect.anything());
  });

  it("판정 ID만 보내도 된다", async () => {
    const verdict = insertCandidate();
    const response = await harness.app.inject({ method: "POST", url: temporaryUrl, headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")), payload: { verdictId: verdict.id } });
    expect(response.statusCode).toBe(200);
    expect(harness.submit).toHaveBeenCalledWith("c1", expect.objectContaining({ chatChannelId: "chat-1" }), expect.anything());
  });
});

describe("판정 ID 검증", () => {
  const restrictUrl = "/api/senders/bad/restrict";

  it("다른 사용자의 판정이면 400이고 실행하지 않는다", async () => {
    const other = harness.verdicts.insert({ channelId: "c1", chatChannelId: "chat-1", messageTime: 6, senderChannelId: "other", senderNickname: "다른이", content: "x", decision: "candidate", reason: "rule:weak:1" });
    const headers = mutatingHeaders(harness.login("STREAMING_CHANNEL_MANAGER"));
    const restrict = await harness.app.inject({ method: "POST", url: restrictUrl, headers, payload: { verdictId: other.id } });
    const temporary = await harness.app.inject({ method: "POST", url: "/api/senders/bad/temporary-restrict", headers, payload: { chatChannelId: "chat-1", verdictId: other.id } });
    expect([restrict.statusCode, temporary.statusCode]).toEqual([400, 400]);
    expect(restrict.json()).toMatchObject({ error: "verdict_mismatch", message: "판정의 보낸 사람과 대상 사용자가 다릅니다. '다시 불러오기'를 누른 뒤 다시 시도하세요." });
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it("없는 판정이면 404", async () => {
    const response = await harness.app.inject({ method: "POST", url: restrictUrl, headers: mutatingHeaders(harness.login("STREAMING_CHANNEL_MANAGER")), payload: { verdictId: 999 } });
    expect(response.statusCode).toBe(404);
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it("보낸 사람이 같은 판정이면 실행기로 넘긴다", async () => {
    const verdict = insertCandidate();
    const response = await harness.app.inject({ method: "POST", url: restrictUrl, headers: mutatingHeaders(harness.login("STREAMING_CHANNEL_MANAGER")), payload: { verdictId: verdict.id } });
    expect(response.statusCode).toBe(200);
    expect(harness.submit).toHaveBeenCalledWith("c1", { kind: "restrict", targetChannelId: "bad", verdictId: verdict.id }, expect.anything());
  });
});

describe("사람 단위 제재 중복 막기(K2)", () => {
  /** 제재 종류별 주소와 역할(임시 제한은 채팅 운영자도, 활동 제한은 채널 관리자부터). */
  const ROUTES = [
    { kind: "temporary_restrict", url: "/api/senders/bad/temporary-restrict", role: "STREAMING_CHAT_MANAGER" },
    { kind: "restrict", url: "/api/senders/bad/restrict", role: "STREAMING_CHANNEL_MANAGER" },
  ] as const;

  /** 결과를 알 수 없는 실행 결과. */
  const UNKNOWN_OUTCOME = { ok: false as const, message: "치지직 응답을 받지 못해 처리 결과를 알 수 없습니다.", isResultUnknown: true as const };

  /** 시계를 직접 움직이는 하네스로 바꾼다. */
  async function useControlledClock() {
    await harness.close();
    const clock = { now: 1_000_000 };
    harness = await createHttpHarness({}, { clock: () => clock.now });
    return clock;
  }

  /** 제재 요청을 보낸다. */
  function send(route: (typeof ROUTES)[number], verdictId: number) {
    return harness.app.inject({ method: "POST", url: route.url, headers: mutatingHeaders(harness.login(route.role)), payload: { verdictId } });
  }

  it.each(ROUTES)("$kind: 두 요청이 거의 동시에 와도 실행기에는 한 번만 보내고, 늦은 쪽은 409 already_handled", async (route) => {
    const releases: Array<() => void> = [];
    harness.submit.mockImplementation(() => new Promise((resolve) => void releases.push(() => resolve({ ok: true, note: null }))));
    const verdict = insertCandidate();
    const first = send(route, verdict.id);
    const second = send(route, verdict.id);
    await vi.waitFor(() => expect(harness.submit).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    releases.forEach((finish) => finish());
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json()).toMatchObject({ error: "already_handled" });
    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it.each(ROUTES)("$kind: 성공한 뒤 60초 안에 다시 보내면 409 already_handled이고, 60초가 지나면 다시 보낸다", async (route) => {
    const clock = await useControlledClock();
    const verdict = insertCandidate();
    expect((await send(route, verdict.id)).statusCode).toBe(200);
    clock.now += 59_999;
    const repeated = await send(route, verdict.id);
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toMatchObject({ error: "already_handled", message: expect.stringMatching(/^방금 제한했습니다/) });
    clock.now += 1;
    expect((await send(route, verdict.id)).statusCode).toBe(200);
    expect(harness.submit).toHaveBeenCalledTimes(2);
  });

  it.each(ROUTES)("$kind: 결과를 알 수 없으면 다음 요청은 실행기로 보내지 않고 409 result_unknown", async (route) => {
    harness.submit.mockResolvedValueOnce(UNKNOWN_OUTCOME);
    const verdict = insertCandidate();
    expect((await send(route, verdict.id)).json()).toMatchObject({ error: "result_unknown" });
    const repeated = await send(route, verdict.id);
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toEqual({ error: "result_unknown", message: "제한 결과를 알 수 없습니다. 치지직 채팅에서 제한됐는지 확인하고, 제한되지 않았다면 치지직 기본 도구로 제한하세요." });
    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it("실패로 끝나면 막지 않아 바로 다시 보낼 수 있다", async () => {
    harness.submit.mockResolvedValueOnce({ ok: false, message: "치지직 서버 오류로 실패했습니다." });
    const verdict = insertCandidate();
    expect((await send(ROUTES[0], verdict.id)).statusCode).toBe(502);
    expect((await send(ROUTES[0], verdict.id)).statusCode).toBe(200);
    expect(harness.submit).toHaveBeenCalledTimes(2);
  });

  /** 활동 제한 해제를 보낸다. */
  function unrestrict() {
    return harness.app.inject({ method: "DELETE", url: "/api/senders/bad/restrict", headers: mutatingHeaders(harness.login("STREAMING_CHANNEL_MANAGER")) });
  }

  it("활동 제한 해제가 성공하면 그 사람의 활동 제한 막기를 지워 바로 다시 제한할 수 있다(K2b)", async () => {
    const verdict = insertCandidate();
    expect((await send(ROUTES[1], verdict.id)).statusCode).toBe(200);
    expect((await unrestrict()).statusCode).toBe(200);
    expect((await send(ROUTES[1], verdict.id)).statusCode).toBe(200);
    expect(harness.submit).toHaveBeenCalledTimes(3);
  });

  it("활동 제한 해제가 성공해도 임시 제한 막기는 그대로다(K2b)", async () => {
    const verdict = insertCandidate();
    expect((await send(ROUTES[0], verdict.id)).statusCode).toBe(200);
    expect((await unrestrict()).statusCode).toBe(200);
    expect((await send(ROUTES[0], verdict.id)).json()).toMatchObject({ error: "already_handled" });
  });

  it("활동 제한 해제가 실패하면 활동 제한 막기를 지우지 않는다(K2b)", async () => {
    const verdict = insertCandidate();
    expect((await send(ROUTES[1], verdict.id)).statusCode).toBe(200);
    harness.submit.mockResolvedValueOnce({ ok: false, message: "치지직 서버 오류로 실패했습니다." });
    expect((await unrestrict()).statusCode).toBe(502);
    expect((await send(ROUTES[1], verdict.id)).statusCode).toBe(409);
  });
});

describe("오류 가림과 정적 폴백", () => {
  it("5xx 예외의 메시지는 사용자에게 보이지 않는다", async () => {
    harness.services.getChatSettings = async () => { throw Object.assign(new Error("secret internals"), { statusCode: 503 }); };
    const response = await harness.app.inject({ method: "GET", url: "/api/chat-settings", headers: { cookie: `zg_session=${harness.login("STREAMING_CHAT_MANAGER")}` } });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("secret internals");
    expect(response.json().message).toBe("서버 오류가 발생했습니다. 잠시 뒤 다시 시도하세요.");
  });
});

describe("푸시 구독 입력", () => {
  const validKeys = { p256dh: "key", auth: "auth" };

  it("허용된 푸시 서비스 주소는 등록된다", async () => {
    const response = await harness.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")), payload: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: validKeys } });
    expect(response.json()).toEqual({ ok: true });
  });

  it("구독 해제는 요청한 매니저의 구독만 지운다(S14, M13)", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/owner";
    const owner = mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER"));
    const other = mutatingHeaders(harness.login("STREAMING_CHANNEL_MANAGER"));
    await harness.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: owner, payload: { endpoint, keys: validKeys } });
    const foreign = await harness.app.inject({ method: "DELETE", url: "/api/push/subscriptions", headers: other, payload: { endpoint } });
    expect(foreign.statusCode).toBe(200);
    const rows = () => harness.database.prepare("SELECT manager_channel_id AS owner FROM push_subscription").all() as Array<{ owner: string }>;
    expect(rows()).toEqual([{ owner: "STREAMING_CHAT_MANAGER-id" }]);
    await harness.app.inject({ method: "DELETE", url: "/api/push/subscriptions", headers: owner, payload: { endpoint } });
    expect(rows()).toEqual([]);
  });

  it("허용 목록에 없는 주소는 400과 이유를 준다", async () => {
    const response = await harness.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")), payload: { endpoint: "http://127.0.0.1/x", keys: validKeys } });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toEqual(expect.any(String));
  });

  it("전체 구독이 상한(100개)이면 새 기기 등록은 409와 이유를 준다(K10)", async () => {
    const insert = harness.database.prepare("INSERT INTO push_subscription (manager_channel_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, 'p', 'a', 0)");
    for (let index = 0; index < 100; index += 1) insert.run(`m${Math.floor(index / 5)}`, `https://fcm.googleapis.com/fcm/send/${index}`);
    const response = await harness.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")), payload: { endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: validKeys } });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("100");
  });

  it("너무 긴 주소는 400", async () => {
    const endpoint = `https://fcm.googleapis.com/${"a".repeat(2100)}`;
    const headers = mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER"));
    const subscribe = await harness.app.inject({ method: "POST", url: "/api/push/subscriptions", headers, payload: { endpoint, keys: validKeys } });
    expect(subscribe.statusCode).toBe(400);
    const remove = await harness.app.inject({ method: "DELETE", url: "/api/push/subscriptions", headers, payload: { endpoint } });
    expect(remove.statusCode).toBe(400);
  });

  it("너무 긴 키는 400", async () => {
    const response = await harness.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: mutatingHeaders(harness.login("STREAMING_CHAT_MANAGER")), payload: { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "k".repeat(257), auth: "a" } } });
    expect(response.statusCode).toBe(400);
  });
});

describe("toSocketSink", () => {
  it("ws 소켓의 bufferedAmount와 readyState를 그때그때 읽어 준다", () => {
    const fake = { readyState: 1, bufferedAmount: 0 };
    const sink = toSocketSink(fake as unknown as WebSocket);
    fake.bufferedAmount = 2_000_000;
    fake.readyState = 2;
    expect(sink.bufferedAmount).toBe(2_000_000);
    expect(sink.readyState).toBe(2);
  });
});

describe("오판 검토 목록(스펙 5.5, R-16)", () => {
  /** 이유를 정해 판정을 넣고 오판으로 표시한다. */
  function reportFalsePositive(reason: string) {
    const verdict = harness.verdicts.insert({
      channelId: "c1", chatChannelId: "chat-1", messageTime: 5, senderChannelId: "viewer", senderNickname: "시청자",
      content: "정상 문장", decision: "candidate", reason,
    });
    harness.verdicts.updateStatus(verdict.id, "false_positive");
    return verdict.id;
  }

  it("로그인한 매니저라면 역할과 관계없이 최근 오판과 이유별 건수를 본다", async () => {
    reportFalsePositive("rule:strong:3");
    const second = reportFalsePositive("rule:weak:7");
    const third = reportFalsePositive("rule:strong:3");
    const response = await harness.app.inject({ method: "GET", url: "/api/false-positives?limit=2", headers: { cookie: `zg_session=${harness.login("STREAMING_CHAT_MANAGER")}` } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as FalsePositiveReviewDto;
    expect(body.recent.map((verdict) => verdict.id)).toEqual([third, second]);
    expect(body.recent[0]).toMatchObject({ reason: "rule:strong:3", status: "false_positive" });
    expect(body.byReason).toEqual([{ reason: "rule:strong:3", count: 2 }, { reason: "rule:weak:7", count: 1 }]);
  });

  it("limit을 생략하면 50개까지, 범위를 벗어나면 400", async () => {
    const cookie = `zg_session=${harness.login("STREAMING_CHAT_MANAGER")}`;
    expect((await harness.app.inject({ method: "GET", url: "/api/false-positives", headers: { cookie } })).statusCode).toBe(200);
    for (const limit of ["0", "201", "abc"]) {
      const response = await harness.app.inject({ method: "GET", url: `/api/false-positives?limit=${limit}`, headers: { cookie } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_input" });
    }
  });

  it("로그인하지 않으면 401", async () => {
    expect((await harness.app.inject({ method: "GET", url: "/api/false-positives" })).statusCode).toBe(401);
  });
});

describe("정적 파일 서버의 JSON 404 경로", () => {
  it("/api/·/auth/·/ws 접두사는 대소문자와 관계없이 index.html이 아니라 JSON 404를 준다(B9-4)", async () => {
    await harness.close();
    const directory = mkdtempSync(join(tmpdir(), "zzirit-web-"));
    writeFileSync(join(directory, "index.html"), "<html></html>");
    try {
      harness = await createHttpHarness({}, { webDistDirectory: directory });
      for (const url of ["/AUTH/login", "/Api/nothing", "/WS", "/auth/nothing"]) {
        const response = await harness.app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: "not_found" });
      }
      expect((await harness.app.inject({ method: "GET", url: "/some/screen" })).body).toBe("<html></html>");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
