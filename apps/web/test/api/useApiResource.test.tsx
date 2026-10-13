import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useApiResource } from "../../src/api/useApiResource";
import { json, stubFetch } from "../helpers/stubFetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 끝나지 않는 응답. 경로가 바뀐 직후(새 응답이 오기 전) 화면에 무엇이 남는지 보려고 쓴다. */
const never = () => new Promise<Response>(() => undefined) as unknown as Response;

describe("useApiResource 이전 응답 지우기(W1, C04)", () => {
  it("경로가 바뀌면 새 응답이 오기 전에도 이전 경로의 데이터를 보여 주지 않는다", async () => {
    stubFetch({ "GET /api/a": () => json(200, { secret: "채팅 원문" }), "GET /api/b": never });
    const { result, rerender } = renderHook(({ path }: { path: string | null }) => useApiResource<{ secret: string }>(path), { initialProps: { path: "/api/a" as string | null } });
    await waitFor(() => expect(result.current.data).toEqual({ secret: "채팅 원문" }));
    rerender({ path: "/api/b" });
    expect(result.current).toMatchObject({ data: null, error: null, loading: true });
  });

  it("경로가 null(권한 회수)이 되면 데이터를 지우고 불러오는 중으로 보이지 않는다", async () => {
    stubFetch({ "GET /api/audit": () => json(200, [{ id: 1 }]) });
    const { result, rerender } = renderHook(({ path }: { path: string | null }) => useApiResource<unknown[]>(path), { initialProps: { path: "/api/audit" as string | null } });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 1 }]));
    rerender({ path: null });
    expect(result.current).toMatchObject({ data: null, error: null, loading: false });
  });

  it("경로가 null이 되면 상태에서도 지워, 같은 경로로 돌아와도 새 응답 전에는 옛 데이터를 보여 주지 않는다(K23)", async () => {
    let calls = 0;
    stubFetch({ "GET /api/audit": () => (++calls === 1 ? json(200, [{ id: 1 }]) : never()) });
    const { result, rerender } = renderHook(({ path }: { path: string | null }) => useApiResource<unknown[]>(path), { initialProps: { path: "/api/audit" as string | null } });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 1 }]));
    rerender({ path: null });
    rerender({ path: "/api/audit" });
    expect(result.current).toMatchObject({ data: null, loading: true });
  });

  it.each([
    ["401", () => json(401, { error: "unauthorized", message: "로그인이 필요합니다." })],
    ["403", () => json(403, { error: "forbidden", message: "이 기능을 쓸 권한이 없습니다." })],
    ["409 no_channel", () => json(409, { error: "no_channel", message: "연결된 채널이 없습니다." })],
  ])("다시 읽다가 %s를 받으면 이전 데이터를 지우고 오류를 보여 준다", async (_label, failure) => {
    let calls = 0;
    stubFetch({ "GET /api/rules": () => (++calls === 1 ? json(200, [{ pattern: "금칙어" }]) : failure()) });
    const { result } = renderHook(() => useApiResource<unknown[]>("/api/rules"));
    await waitFor(() => expect(result.current.data).toEqual([{ pattern: "금칙어" }]));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).toBeNull();
  });

  it("일시 오류(5xx)면 같은 경로의 이전 데이터는 그대로 둔다(주기 조회 중 표가 사라지지 않게)", async () => {
    let calls = 0;
    stubFetch({ "GET /api/status": () => (++calls === 1 ? json(200, { ok: 1 }) : json(503, { error: "unavailable", message: "잠시 뒤 다시 시도하세요." })) });
    const { result } = renderHook(() => useApiResource<{ ok: number }>("/api/status"));
    await waitFor(() => expect(result.current.data).toEqual({ ok: 1 }));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).toBe("잠시 뒤 다시 시도하세요."));
    expect(result.current.data).toEqual({ ok: 1 });
  });
});
