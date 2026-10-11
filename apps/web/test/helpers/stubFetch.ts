import { vi } from "vitest";

/**
 * "메서드 경로" 키로 응답을 정하는 가짜 fetch. 등록하지 않은 요청은 바로 실패해 빠뜨린 호출을 드러낸다.
 * 예: stubFetch({ "GET /api/me": () => json(200, me) })
 * @param routes "메서드 경로" → 응답을 만드는 함수
 * @returns 호출 기록을 확인할 수 있는 fetch 모의 함수
 */
export function stubFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const route = routes[key];
    if (!route) throw new Error(`stubFetch: 준비되지 않은 요청 ${key}`);
    return route(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** JSON 응답을 만든다. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
