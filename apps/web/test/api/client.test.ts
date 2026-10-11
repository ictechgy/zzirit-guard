import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, apiSend, describeApiError, REQUEST_TIMEOUT_MS, requiresSignIn } from "../../src/api/client";
import { json, stubFetch } from "../helpers/stubFetch";

afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("GET은 쿠키를 함께 보내고 JSON을 돌려준다", async () => {
    const fetchMock = stubFetch({ "GET /api/me": () => json(200, { ok: 1 }) });
    await expect(apiGet("/api/me")).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledWith("/api/me", { method: "GET", credentials: "include", signal: expect.any(AbortSignal) });
  });

  it("상태 변경 요청에 표식 헤더와 JSON 본문을 붙인다", async () => {
    const fetchMock = stubFetch({ "POST /api/auto-hide": () => json(200, { enabled: true }) });
    await apiSend("POST", "/api/auto-hide", { enabled: true });
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      method: "POST", credentials: "include", signal: expect.any(AbortSignal),
      headers: { "x-zzirit-request": "1", "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }),
    });
  });

  it("서버 오류 본문을 ApiError로 바꾼다", async () => {
    stubFetch({ "POST /api/rules": () => json(403, { error: "forbidden", message: "이 기능을 쓸 권한이 없습니다(규칙 수정)." }) });
    const error = await apiSend("POST", "/api/rules", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "forbidden", message: "이 기능을 쓸 권한이 없습니다(규칙 수정)." });
  });

  it("네트워크 오류는 원인과 해결 방향을 담고, 원래 오류를 cause로 남긴다", async () => {
    const original = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn(async () => { throw original; }));
    const error = await apiGet("/api/me").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 0, code: "network", message: expect.stringMatching(/서버에 연결할 수 없습니다/) });
    expect((error as ApiError).cause).toBe(original);
  });

  it("응답이 REQUEST_TIMEOUT_MS(15초) 안에 오지 않으면 timeout ApiError로 바꾸고 원래 오류를 cause로 남긴다(F2)", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })));
    const pending = apiSend("POST", "/api/verdicts/1/hide").catch((caught: unknown) => caught);
    const reason = new DOMException("signal timed out", "TimeoutError");
    controller.abort(reason);
    const error = await pending;
    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    expect(REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(error).toMatchObject({ status: 0, code: "timeout", message: "응답이 늦습니다. 결과는 잠시 뒤 목록에 반영됩니다." });
    expect((error as ApiError).cause).toBe(reason);
    timeout.mockRestore();
  });

  it("JSON이 아닌 응답은 형식 오류이고, 해석 오류를 cause로 남긴다", async () => {
    stubFetch({ "GET /api/me": () => new Response("<html>", { status: 200 }) });
    const error = await apiGet("/api/me").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "bad_response" });
    expect((error as ApiError).cause).toBeInstanceOf(SyntaxError);
  });

  it("오류 문구를 고른다", () => {
    expect(describeApiError(new ApiError(409, "write_locked", "다시 연결하세요"))).toBe("다시 연결하세요");
    expect(describeApiError(new Error("x"))).toMatch(/새로고침/);
  });

  it("세션이 끝났거나(401) 채널 연결이 사라진(409 no_channel) 오류만 로그인이 필요하다고 본다(R-12)", () => {
    expect(requiresSignIn(new ApiError(401, "unauthorized", "로그인이 필요합니다."))).toBe(true);
    expect(requiresSignIn(new ApiError(409, "no_channel", "연결된 채널이 없습니다."))).toBe(true);
    expect(requiresSignIn(new ApiError(409, "already_handled", "이미 처리됨"))).toBe(false);
    expect(requiresSignIn(new Error("x"))).toBe(false);
  });
});
