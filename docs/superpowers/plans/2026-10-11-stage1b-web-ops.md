# 찌리릿 가드 1단계-B(PWA·운영) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 매니저가 휴대폰 브라우저(PWA)로 후보 처리·자동 숨김 스위치·실시간 채팅·규칙/설정·감사 기록·푸시 알림을 쓰게 하고, 맥 미니 운영(launchd·Funnel·백업·공지·합의서)을 문서와 스크립트로 갖춘다.

**Architecture:** React 19 + Vite 8 정적 빌드. 서버(1단계-A)가 같은 출처로 이 빌드를 제공한다. 화면은 REST로 처음 상태를 읽고 WebSocket(티켓 인증)으로 갱신을 받는다. 상태 변경은 순수 리듀서로 처리해 테스트한다. 화면 컴포넌트는 동작(actions)을 props로 받아 API와 분리한다.

**Tech Stack:** React 19.3.0, Vite 8.3.4, @vitejs/plugin-react 6.1.2, TypeScript 6.0.3, Vitest 5.0.3 + jsdom 30.1.2 + @testing-library/react 16.3.3(+ @testing-library/dom 10.4.2, user-event 14.6.7).

**Spec:** `docs/superpowers/specs/2026-10-11-zzirit-guard-design.md` (이 계획은 1단계 중 PWA와 운영 부분. 서버는 `2026-10-11-stage1a-server.md`가 먼저 끝나 있어야 한다)

## Global Constraints

- 1단계-A의 Global Constraints를 모두 따른다(한국어 주석·문서화 주석, 빈 catch 금지, Conventional Commits, 브랜치 `feature/stage1-web`).
- 채팅 텍스트는 **텍스트로만** 렌더링한다(`dangerouslySetInnerHTML` 금지). 서버 CSP가 인라인 스크립트를 막는다.
- 상태 변경 요청에는 `x-zzirit-request: 1` 헤더, 모든 요청에 `credentials: "include"`.
- API 주소 앞부분은 `import.meta.env.VITE_API_BASE`(기본 빈 문자열 = 같은 출처). 쿠키·토큰을 아는 코드는 `src/api/client.ts`와 `src/api/realtime.ts`에만 둔다(Cloudflare 전환 대비, 스펙 12장).
- WebSocket 닫기 코드 4001(세션 종료)은 로그인 화면으로, 그 밖의 끊김은 1·2·4…30초 백오프 재연결.
- 자동 숨김 **켜기**에는 확인을 받는다(숨긴 메시지는 되돌릴 수 없다). 끄기는 바로 한다.
- 화면에 치지직 로고를 쓰지 않는다. 로그인·설정 화면에 "치지직 Open API 사용, 비공식" 표시(약관 제7조④·14호).
- 서비스 워커는 푸시 표시와 알림 클릭만 한다. 오프라인 캐시는 하지 않는다(옛 화면으로 잘못 조치하지 않도록).

## Review Focus

- **몰려드는 채팅으로 화면이 멈춤**(초당 수십 건 + 휴대폰 성능): 채팅 줄은 최대 300개만 보관하고, 후보는 최근 10분만 묶는다 → Task 2에 테스트.
- **오래 열어 둔 화면**(세션 만료·역할 해제·서버 재시작): 4001이면 로그인으로, 티켓 발급 401이면 로그인으로, 그 밖에는 재연결 → Task 3에 테스트.
- **권한 없는 버튼**(채팅 운영자가 켜기·규칙 수정을 누름): 보이되 비활성, 서버 403 문구도 그대로 보여 준다 → Task 4·7에 테스트.
- **실패한 조치가 조용히 사라짐**(치지직 429·쓰기 잠금): 서버가 준 이유를 화면에 남긴다 → Task 4에 테스트.
- **iPhone에서 알림 미지원**(홈 화면에 추가하지 않음·iOS 16.4 미만): 안내 문구로 이유를 알려 준다 → Task 6에 테스트.

---

## 파일 구조

```
apps/web/
  package.json  tsconfig.json  vite.config.ts  index.html
  public/manifest.webmanifest  public/sw.js  public/icons/(logo.svg, icon-192.png, icon-512.png, apple-touch-icon.png)
  src/vite-env.d.ts                VITE_API_BASE 타입
  src/main.tsx                     진입점·서비스 워커 등록
  src/App.tsx                      로그인 여부 분기
  src/styles.css                   모바일 우선 스타일
  src/api/client.ts                REST 호출·ApiError·오류 문구
  src/api/realtime.ts              WebSocket 연결·재연결
  src/api/useApiResource.ts        조회용 훅
  src/domain/candidates.ts         후보 묶기·갱신(순수 함수)
  src/state/serverReducer.ts       서버 상태 리듀서(순수 함수)
  src/state/useServerState.ts      초기 조회 + 실시간 연결 훅
  src/state/useNow.ts              주기적 현재 시각
  src/push/pushSubscription.ts     푸시 구독
  src/components/ApiNotice.tsx  StatusBanner.tsx  AutoHideToggle.tsx  CandidateGroupCard.tsx  TabBar.tsx
  src/screens/LoginScreen.tsx  MainScreen.tsx  CandidatesScreen.tsx  LiveChatScreen.tsx  SettingsScreen.tsx
  src/settings/StatusSection.tsx  StatsSection.tsx  RulesSection.tsx  LimitsSection.tsx  ChatSettingsSection.tsx  AuditSection.tsx  AccountSection.tsx
  test/**/*.test.ts(x)  test/helpers/stubFetch.ts
ops/launchd/com.zzirit-guard.server.plist.template
ops/scripts/install-launchd.sh  ops/scripts/render-icons.sh
ops/newsyslog/zzirit-guard.conf
docs/operations/operator-guide.md  channel-notice-template.md  streamer-agreement-template.md  chzzk-inquiry-email.md  device-checklist.md
```

---

### Task 1: 웹 기반 구성과 API 클라이언트

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/src/vite-env.d.ts`, `apps/web/src/api/client.ts`
- Create: `apps/web/test/helpers/stubFetch.ts`
- Test: `apps/web/test/api/client.test.ts`

**Interfaces:**
- Produces: `API_BASE: string`, `class ApiError extends Error { status: number; code: string }`, `apiGet<T>(path: string): Promise<T>`, `apiSend<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T>`, `describeApiError(error: unknown): string`; 테스트용 `stubFetch(routes: Record<string, (init?: RequestInit) => Response>)`

- [ ] **Step 1: 브랜치 만들기**

```bash
git switch main && git pull --ff-only && git switch -c feature/stage1-web
```

- [ ] **Step 2: 패키지 설정 작성**

`apps/web/package.json`:
```json
{
  "name": "@zzirit-guard/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json && vite build",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": { "@zzirit-guard/shared": "*" }
}
```

`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "types": ["vite/client"],
    "noEmit": true
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

`apps/web/vite.config.ts`:
```ts
// 개발 서버는 /api·/auth·/ws를 로컬 서버(8710)로 넘긴다. 실제 로그인은 Secure 쿠키라 Funnel 주소로 확인한다.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8710",
      "/auth": "http://127.0.0.1:8710",
      "/ws": { target: "ws://127.0.0.1:8710", ws: true },
    },
  },
  // globals: React Testing Library가 테스트마다 화면을 자동 정리(cleanup)하려면 전역 afterEach가 필요하다.
  test: { environment: "jsdom", globals: true, include: ["test/**/*.test.{ts,tsx}"] },
});
```

`apps/web/src/vite-env.d.ts`:
```ts
/// <reference types="vite/client" />

/** 빌드 시 주입하는 환경 값. */
interface ImportMetaEnv {
  /** API 주소 앞부분. 비우면 같은 출처. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 3: 의존성 설치**

```bash
npm install --save-exact -w @zzirit-guard/web react@19.3.0 react-dom@19.3.0
npm install --save-dev --save-exact -w @zzirit-guard/web vite@8.3.4 @vitejs/plugin-react@6.1.2 vitest@5.0.3 jsdom@30.1.2 @types/react@19.3.0 @types/react-dom@19.3.0 @testing-library/react@16.3.3 @testing-library/dom@10.4.2 @testing-library/user-event@14.6.7
```

- [ ] **Step 4: 테스트 도우미와 실패하는 테스트 작성**

`apps/web/test/helpers/stubFetch.ts`:
```ts
import { vi } from "vitest";

/**
 * "메서드 경로" 키로 응답을 정하는 가짜 fetch. 등록하지 않은 요청은 바로 실패해 빠뜨린 호출을 드러낸다.
 * 예: stubFetch({ "GET /api/me": () => json(200, me) })
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
```

`apps/web/test/api/client.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, apiSend, describeApiError } from "../../src/api/client";
import { json, stubFetch } from "../helpers/stubFetch";

afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("GET은 쿠키를 함께 보내고 JSON을 돌려준다", async () => {
    const fetchMock = stubFetch({ "GET /api/me": () => json(200, { ok: 1 }) });
    await expect(apiGet("/api/me")).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledWith("/api/me", { method: "GET", credentials: "include" });
  });

  it("상태 변경 요청에 표식 헤더와 JSON 본문을 붙인다", async () => {
    const fetchMock = stubFetch({ "POST /api/auto-hide": () => json(200, { enabled: true }) });
    await apiSend("POST", "/api/auto-hide", { enabled: true });
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      method: "POST", credentials: "include",
      headers: { "x-zzirit-request": "1", "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }),
    });
  });

  it("서버 오류 본문을 ApiError로 바꾼다", async () => {
    stubFetch({ "POST /api/rules": () => json(403, { error: "forbidden", message: "이 기능을 쓸 권한이 없습니다(규칙 수정)." }) });
    const error = await apiSend("POST", "/api/rules", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "forbidden", message: "이 기능을 쓸 권한이 없습니다(규칙 수정)." });
  });

  it("네트워크 오류는 원인과 해결 방향을 담는다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(apiGet("/api/me")).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/서버에 연결할 수 없습니다/) });
  });

  it("JSON이 아닌 응답은 형식 오류", async () => {
    stubFetch({ "GET /api/me": () => new Response("<html>", { status: 200 }) });
    await expect(apiGet("/api/me")).rejects.toMatchObject({ code: "bad_response" });
  });

  it("오류 문구를 고른다", () => {
    expect(describeApiError(new ApiError(409, "write_locked", "다시 연결하세요"))).toBe("다시 연결하세요");
    expect(describeApiError(new Error("x"))).toMatch(/새로고침/);
  });
});
```

- [ ] **Step 5: 실패 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: FAIL — `Cannot find module '../../src/api/client'`

- [ ] **Step 6: 구현**

`apps/web/src/api/client.ts`:
```ts
import type { ApiErrorBody } from "@zzirit-guard/shared";

/** API 주소 앞부분. 같은 출처면 빈 문자열. 화면만 Cloudflare Pages로 옮길 때 빌드 값으로 바꾼다(스펙 12장). */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";

/** 서버가 돌려준 오류. message는 사용자에게 그대로 보여 준다. status 0은 네트워크 오류다. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 상태 변경 요청 표식. 서버의 REQUEST_MARKER_HEADER와 같아야 한다(CSRF 방지). */
const MARKER_HEADERS = { "x-zzirit-request": "1" } as const;

/** 상태를 바꾸는 메서드. */
type MutatingMethod = "POST" | "PUT" | "DELETE";

/** 조회 요청. */
export function apiGet<T>(path: string): Promise<T> {
  return request<T>("GET", path, undefined);
}

/** 상태 변경 요청. 본문이 없으면 빈 객체를 보낸다(서버가 JSON 본문을 기대한다). */
export function apiSend<T>(method: MutatingMethod, path: string, body: unknown = {}): Promise<T> {
  return request<T>(method, path, body);
}

/** 화면에 보여 줄 오류 문구를 고른다. */
export function describeApiError(error: unknown): string {
  return error instanceof ApiError ? error.message : "알 수 없는 오류가 발생했습니다. 앱을 새로고침하세요.";
}

/** 요청 → 응답 해석. 실패는 ApiError로 바꾼다. */
async function request<T>(method: "GET" | MutatingMethod, path: string, body: unknown): Promise<T> {
  const response = await fetchOrExplain(API_BASE + path, buildInit(method, body));
  const payload = parseBody(response.status, await response.text());
  if (!response.ok) throw toApiError(response.status, payload);
  return payload as T;
}

/** 요청 설정. 쿠키는 항상 함께 보낸다(나중에 출처가 갈라져도 동작하도록 include). */
function buildInit(method: "GET" | MutatingMethod, body: unknown): RequestInit {
  if (method === "GET") return { method, credentials: "include" };
  return { method, credentials: "include", headers: { ...MARKER_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** fetch 자체가 실패하면(서버 꺼짐·네트워크) 원인과 해결 방향을 담아 바꾼다. */
async function fetchOrExplain(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new ApiError(0, "network", "서버에 연결할 수 없습니다. 맥 미니가 켜져 있는지, 네트워크가 연결돼 있는지 확인하세요.");
  }
}

/** 본문을 JSON으로 읽는다. 비어 있으면 null, JSON이 아니면 형식 오류. */
function parseBody(status: number, text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(status, "bad_response", "서버 응답 형식이 올바르지 않습니다. 앱을 새로고침하세요.");
  }
}

/** 오류 본문을 ApiError로 바꾼다. */
function toApiError(status: number, payload: unknown): ApiError {
  const body = payload as Partial<ApiErrorBody> | null;
  if (body && typeof body.error === "string" && typeof body.message === "string") return new ApiError(status, body.error, body.message);
  return new ApiError(status, "unknown", `요청이 실패했습니다(${status}). 잠시 뒤 다시 시도하세요.`);
}
```

- [ ] **Step 7: 통과 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: PASS (6 tests)

- [ ] **Step 8: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web package-lock.json
git commit -m "feat: 웹 기반 구성과 API 클라이언트 추가" -m "React·Vite·Vitest를 설정하고, 쿠키를 함께 보내며 상태 변경 요청에 표식 헤더를 붙이는 API 클라이언트를 만든다. 오류는 서버 문구 그대로 보여 줄 수 있게 ApiError로 바꾼다."
```

---

### Task 2: 후보 묶기와 서버 상태 리듀서

**Files:**
- Create: `apps/web/src/domain/candidates.ts`, `apps/web/src/state/serverReducer.ts`
- Test: `apps/web/test/domain/candidates.test.ts`, `apps/web/test/state/serverReducer.test.ts`

**Interfaces:**
- Produces: `CANDIDATE_WINDOW_MS`, `interface SenderGroup { senderChannelId; senderNickname; chatChannelId; verdicts: VerdictDto[]; latestAt }`, `interface CandidateSections { care: SenderGroup[]; shadow: SenderGroup[]; candidates: SenderGroup[]; autoHidden: VerdictDto[] }`, `buildSections(verdicts, now): CandidateSections`, `upsertVerdict(verdicts, verdict): VerdictDto[]`, `applyVerdictStatus(verdicts, verdictId, status): VerdictDto[]`; `MAX_CHAT_LINES = 300`, `interface ServerState { status: ServerStatus | null; verdicts: VerdictDto[]; chatLines: ChatLine[]; realtimeConnected: boolean; sessionEndedReason: string | null; loadError: string | null }`, `type ServerAction = { type: "loaded"; status; verdicts } | { type: "load_failed"; message } | { type: "event"; event: RealtimeEvent } | { type: "connection"; connected: boolean }`, `initialServerState`, `serverReducer(state, action): ServerState`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/test/domain/candidates.test.ts`:
```ts
import type { VerdictDto } from "@zzirit-guard/shared";
import { describe, expect, it } from "vitest";
import { applyVerdictStatus, buildSections, upsertVerdict } from "../../src/domain/candidates";

/** 판정 예시. */
function verdict(id: number, overrides: Partial<VerdictDto> = {}): VerdictDto {
  return {
    id, chatChannelId: "chat-1", senderChannelId: "viewer-1", senderNickname: "시청자1", content: `메시지${id}`,
    messageTime: id, decision: "candidate", reason: "rule:weak:1", status: "pending", createdAt: id * 1000, ...overrides,
  };
}

/** 기준 시각(10분 창 안에 모두 들어오게). */
const NOW = 100_000;

describe("buildSections", () => {
  it("결정별로 나누고, 같은 사람은 한 묶음으로 최신순", () => {
    const sections = buildSections(
      [verdict(1), verdict(2), verdict(3, { senderChannelId: "viewer-2", senderNickname: "시청자2" }), verdict(4, { decision: "shadow" }), verdict(5, { decision: "needs_care" }), verdict(6, { decision: "auto_hide", status: "hidden" })],
      NOW,
    );
    expect(sections.candidates.map((group) => [group.senderChannelId, group.verdicts.map((item) => item.id)])).toEqual([["viewer-2", [3]], ["viewer-1", [2, 1]]]);
    expect(sections.shadow.map((group) => group.verdicts.map((item) => item.id))).toEqual([[4]]);
    expect(sections.care).toHaveLength(1);
    expect(sections.autoHidden.map((item) => item.id)).toEqual([6]);
  });

  it("처리된 것과 10분이 지난 것은 뺀다(자동 숨김 목록은 처리 상태와 관계없이 10분 안의 것)", () => {
    const sections = buildSections([verdict(1, { status: "hidden" }), verdict(2, { createdAt: NOW - 11 * 60 * 1000 })], NOW);
    expect(sections.candidates).toEqual([]);
  });
});

describe("upsertVerdict·applyVerdictStatus", () => {
  it("새 판정은 더하고 같은 id는 바꾼다", () => {
    const list = upsertVerdict([verdict(1)], verdict(2));
    expect(upsertVerdict(list, verdict(1, { content: "바뀜" })).map((item) => item.content)).toEqual(["바뀜", "메시지2"]);
  });

  it("상태만 바꾼다", () => {
    expect(applyVerdictStatus([verdict(1)], 1, "ignored")[0]?.status).toBe("ignored");
    expect(applyVerdictStatus([verdict(1)], 9, "ignored")[0]?.status).toBe("pending");
  });
});
```

`apps/web/test/state/serverReducer.test.ts`:
```ts
import type { ChatLine, ServerStatus } from "@zzirit-guard/shared";
import { describe, expect, it } from "vitest";
import { initialServerState, MAX_CHAT_LINES, serverReducer } from "../../src/state/serverReducer";

/** 상태 예시. */
const status: ServerStatus = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, lastChatAt: null, pendingActions: 0 };

/** 채팅 줄 예시. */
function line(index: number): ChatLine {
  return { senderNickname: "n", content: `c${index}`, messageTime: index, decision: "pass" };
}

describe("serverReducer", () => {
  it("처음 조회 결과를 넣는다", () => {
    expect(serverReducer(initialServerState, { type: "loaded", status, verdicts: [] })).toMatchObject({ status, verdicts: [], loadError: null });
  });

  it("채팅 줄은 최근 300개만 남긴다", () => {
    let state = initialServerState;
    for (let batch = 0; batch < 4; batch += 1) {
      const lines = Array.from({ length: 100 }, (_unused, index) => line(batch * 100 + index));
      state = serverReducer(state, { type: "event", event: { type: "chat_batch", lines } });
    }
    expect(state.chatLines).toHaveLength(MAX_CHAT_LINES);
    expect(state.chatLines[0]?.content).toBe("c100");
  });

  it("세션 종료·연결 상태·불러오기 실패를 기록한다", () => {
    const ended = serverReducer(initialServerState, { type: "event", event: { type: "session_ended", reason: "권한 해제" } });
    expect(ended.sessionEndedReason).toBe("권한 해제");
    expect(serverReducer(initialServerState, { type: "connection", connected: true }).realtimeConnected).toBe(true);
    expect(serverReducer(initialServerState, { type: "load_failed", message: "서버 오류" }).loadError).toBe("서버 오류");
  });

  it("판정 이벤트와 상태 이벤트를 반영한다", () => {
    const verdict = { id: 1, chatChannelId: "c", senderChannelId: "s", senderNickname: "n", content: "x", messageTime: 1, decision: "candidate" as const, reason: "r", status: "pending" as const, createdAt: 1 };
    const added = serverReducer(initialServerState, { type: "event", event: { type: "verdict", verdict } });
    const updated = serverReducer(added, { type: "event", event: { type: "verdict_status", verdictId: 1, status: "hidden" } });
    expect(updated.verdicts[0]?.status).toBe("hidden");
    expect(serverReducer(updated, { type: "event", event: { type: "status", status } }).status).toEqual(status);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/web/src/domain/candidates.ts`:
```ts
import type { VerdictDto, VerdictStatus } from "@zzirit-guard/shared";

/** 후보 화면에 보여 줄 기간(최근 10분, 스펙 6장). */
export const CANDIDATE_WINDOW_MS = 10 * 60 * 1000;

/** 한 사람의 판정 묶음. 매니저는 사람 단위로 제재한다. */
export interface SenderGroup {
  senderChannelId: string;
  senderNickname: string;
  chatChannelId: string;
  verdicts: VerdictDto[];
  latestAt: number;
}

/** 후보 화면의 구역. 도움 필요·섀도·후보는 처리 전(pending)만, 자동 숨김은 확인용으로 최근 것 전부. */
export interface CandidateSections {
  care: SenderGroup[];
  shadow: SenderGroup[];
  candidates: SenderGroup[];
  autoHidden: VerdictDto[];
}

/** 판정 목록을 화면 구역으로 나눈다. */
export function buildSections(verdicts: readonly VerdictDto[], now: number): CandidateSections {
  const recent = verdicts.filter((verdict) => verdict.createdAt >= now - CANDIDATE_WINDOW_MS);
  const pendingOf = (decision: VerdictDto["decision"]) => recent.filter((verdict) => verdict.decision === decision && verdict.status === "pending");
  return {
    care: groupBySender(pendingOf("needs_care")),
    shadow: groupBySender(pendingOf("shadow")),
    candidates: groupBySender(pendingOf("candidate")),
    autoHidden: recent.filter((verdict) => verdict.decision === "auto_hide").sort(newestFirst),
  };
}

/** 같은 id면 바꾸고, 없으면 뒤에 더한다. */
export function upsertVerdict(verdicts: readonly VerdictDto[], verdict: VerdictDto): VerdictDto[] {
  const exists = verdicts.some((item) => item.id === verdict.id);
  return exists ? verdicts.map((item) => (item.id === verdict.id ? verdict : item)) : [...verdicts, verdict];
}

/** 상태만 바꾼다. */
export function applyVerdictStatus(verdicts: readonly VerdictDto[], verdictId: number, status: VerdictStatus): VerdictDto[] {
  return verdicts.map((item) => (item.id === verdictId ? { ...item, status } : item));
}

/** 보낸 사람별로 묶고, 묶음과 묶음 안의 판정을 모두 최신순으로 정렬한다. */
function groupBySender(verdicts: readonly VerdictDto[]): SenderGroup[] {
  const groups = new Map<string, SenderGroup>();
  for (const verdict of [...verdicts].sort(newestFirst)) {
    const group = groups.get(verdict.senderChannelId) ?? {
      senderChannelId: verdict.senderChannelId, senderNickname: verdict.senderNickname, chatChannelId: verdict.chatChannelId, verdicts: [], latestAt: verdict.createdAt,
    };
    group.verdicts.push(verdict);
    groups.set(verdict.senderChannelId, group);
  }
  return [...groups.values()].sort((left, right) => right.latestAt - left.latestAt);
}

/** 최신순 비교. 같은 시각이면 id가 큰 것(나중에 저장된 것)이 앞. */
function newestFirst(left: VerdictDto, right: VerdictDto): number {
  return right.createdAt - left.createdAt || right.id - left.id;
}
```

`apps/web/src/state/serverReducer.ts`:
```ts
import type { ChatLine, RealtimeEvent, ServerStatus, VerdictDto } from "@zzirit-guard/shared";
import { applyVerdictStatus, upsertVerdict } from "../domain/candidates";

/** 실시간 채팅 화면에 남길 최대 줄 수. 초당 수십 건이어도 휴대폰이 버티게 한다. */
export const MAX_CHAT_LINES = 300;

/** 화면이 쓰는 서버 상태. */
export interface ServerState {
  status: ServerStatus | null;
  verdicts: VerdictDto[];
  chatLines: ChatLine[];
  realtimeConnected: boolean;
  sessionEndedReason: string | null;
  loadError: string | null;
}

/** 상태를 바꾸는 동작. */
export type ServerAction =
  | { type: "loaded"; status: ServerStatus; verdicts: VerdictDto[] }
  | { type: "load_failed"; message: string }
  | { type: "event"; event: RealtimeEvent }
  | { type: "connection"; connected: boolean };

/** 처음 상태. */
export const initialServerState: ServerState = {
  status: null, verdicts: [], chatLines: [], realtimeConnected: false, sessionEndedReason: null, loadError: null,
};

/** 순수 리듀서. 화면 로직을 테스트할 수 있게 부수 효과 없이 둔다. */
export function serverReducer(state: ServerState, action: ServerAction): ServerState {
  switch (action.type) {
    case "loaded":
      return { ...state, status: action.status, verdicts: action.verdicts, loadError: null };
    case "load_failed":
      return { ...state, loadError: action.message };
    case "connection":
      return { ...state, realtimeConnected: action.connected };
    case "event":
      return applyEvent(state, action.event);
  }
}

/** 실시간 이벤트 반영. */
function applyEvent(state: ServerState, event: RealtimeEvent): ServerState {
  switch (event.type) {
    case "verdict":
      return { ...state, verdicts: upsertVerdict(state.verdicts, event.verdict) };
    case "verdict_status":
      return { ...state, verdicts: applyVerdictStatus(state.verdicts, event.verdictId, event.status) };
    case "chat_batch":
      return { ...state, chatLines: [...state.chatLines, ...event.lines].slice(-MAX_CHAT_LINES) };
    case "status":
      return { ...state, status: event.status };
    case "session_ended":
      return { ...state, sessionEndedReason: event.reason };
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: PASS (14 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web/src/domain apps/web/src/state/serverReducer.ts apps/web/test/domain apps/web/test/state
git commit -m "feat: 후보 묶기와 서버 상태 리듀서 추가" -m "후보를 도움 필요·섀도·후보·자동 숨김 구역으로 나누고 같은 사람끼리 최신순으로 묶는다. 채팅 줄은 최근 300개만 남긴다."
```

---

### Task 3: 실시간 연결(WebSocket)

**Files:**
- Create: `apps/web/src/api/realtime.ts`
- Test: `apps/web/test/api/realtime.test.ts`

**Interfaces:**
- Consumes: `apiSend`·`ApiError`·`API_BASE`(Task 1)
- Produces: `interface SocketLike { onopen: (() => void) | null; onmessage: ((event: { data: unknown }) => void) | null; onclose: ((event: { code: number }) => void) | null; close(): void }`, `interface RealtimeOptions { onEvent(event: RealtimeEvent): void; onConnectionChange(connected: boolean): void; onSessionEnded(reason: string): void; issueTicket?: () => Promise<string>; openSocket?: (url: string) => SocketLike; schedule?: (callback: () => void, ms: number) => void }`, `reconnectDelayMs(attempt): number`, `websocketUrl(ticket, base?, origin?): string`, `class RealtimeConnection { constructor(options); start(): void; stop(): void }`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/test/api/realtime.test.ts`:
```ts
import type { RealtimeEvent } from "@zzirit-guard/shared";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/client";
import { RealtimeConnection, reconnectDelayMs, websocketUrl, type SocketLike } from "../../src/api/realtime";

/** 직접 조작하는 가짜 소켓. */
function fakeSocket(): SocketLike & { closed: boolean } {
  return { onopen: null, onmessage: null, onclose: null, closed: false, close() { this.closed = true; } };
}

/** 대기 중인 비동기 처리를 흘려보낸다. */
async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 테스트용 연결과 기록. */
function setup(issueTicket: () => Promise<string> = async () => "ticket-1") {
  const sockets: Array<SocketLike & { closed: boolean }> = [];
  const urls: string[] = [];
  const scheduled: number[] = [];
  const events: RealtimeEvent[] = [];
  const connection: { states: boolean[]; ended: string[] } = { states: [], ended: [] };
  let pending: (() => void) | null = null;
  const realtime = new RealtimeConnection({
    issueTicket,
    openSocket: (url) => {
      urls.push(url);
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: (callback, ms) => {
      scheduled.push(ms);
      pending = callback;
    },
    onEvent: (event) => events.push(event),
    onConnectionChange: (connected) => connection.states.push(connected),
    onSessionEnded: (reason) => connection.ended.push(reason),
  });
  return { realtime, sockets, urls, scheduled, events, connection, runPending: () => pending?.() };
}

describe("RealtimeConnection", () => {
  it("티켓으로 연결하고 이벤트를 넘긴다", async () => {
    const { realtime, sockets, urls, events, connection } = setup();
    realtime.start();
    await flushPromises();
    expect(urls[0]).toMatch(/\/ws\?ticket=ticket-1$/);
    sockets[0]?.onopen?.();
    sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "verdict_status", verdictId: 1, status: "hidden" }) });
    expect(connection.states).toEqual([true]);
    expect(events).toEqual([{ type: "verdict_status", verdictId: 1, status: "hidden" }]);
  });

  it("끊기면 백오프 뒤 새 티켓으로 다시 연결한다", async () => {
    const issueTicket = vi.fn(async () => "ticket");
    const { realtime, sockets, scheduled, runPending } = setup(issueTicket);
    realtime.start();
    await flushPromises();
    sockets[0]?.onclose?.({ code: 1006 });
    expect(scheduled).toEqual([1000]);
    runPending();
    await flushPromises();
    expect(issueTicket).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
  });

  it("세션 종료(메시지 또는 4001)면 다시 연결하지 않고 알린다", async () => {
    const { realtime, sockets, scheduled, connection } = setup();
    realtime.start();
    await flushPromises();
    sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "session_ended", reason: "권한 해제" }) });
    sockets[0]?.onclose?.({ code: 4001 });
    expect(connection.ended).toEqual(["권한 해제"]);
    expect(scheduled).toEqual([]);
  });

  it("티켓 발급이 401이면 로그인이 필요하다고 알린다", async () => {
    const { realtime, connection, scheduled } = setup(async () => { throw new ApiError(401, "unauthorized", "로그인이 필요합니다."); });
    realtime.start();
    await flushPromises();
    expect(connection.ended).toEqual(["로그인이 필요합니다."]);
    expect(scheduled).toEqual([]);
  });

  it("멈추면 소켓을 닫고 재연결하지 않는다", async () => {
    const { realtime, sockets, scheduled } = setup();
    realtime.start();
    await flushPromises();
    realtime.stop();
    sockets[0]?.onclose?.({ code: 1000 });
    expect(sockets[0]?.closed).toBe(true);
    expect(scheduled).toEqual([]);
  });
});

describe("도우미", () => {
  it("백오프는 1초부터 30초까지", () => {
    expect([0, 1, 4, 5, 8].map(reconnectDelayMs)).toEqual([1000, 2000, 16000, 30000, 30000]);
  });

  it("http(s) 출처를 ws(s)로 바꾼다", () => {
    expect(websocketUrl("a b", "", "https://guard.example")).toBe("wss://guard.example/ws?ticket=a%20b");
    expect(websocketUrl("t", "http://localhost:8710", "https://ignored")).toBe("ws://localhost:8710/ws?ticket=t");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/web/src/api/realtime.ts`:
```ts
import type { RealtimeEvent } from "@zzirit-guard/shared";
import { API_BASE, ApiError, apiSend } from "./client";

/** 연결에 필요한 WebSocket 기능. 테스트에서 가짜로 바꾼다. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  close(): void;
}

/** RealtimeConnection 옵션. issueTicket·openSocket·schedule은 테스트에서 바꿔 끼운다. */
export interface RealtimeOptions {
  onEvent(event: RealtimeEvent): void;
  onConnectionChange(connected: boolean): void;
  onSessionEnded(reason: string): void;
  issueTicket?: () => Promise<string>;
  openSocket?: (url: string) => SocketLike;
  schedule?: (callback: () => void, ms: number) => void;
}

/** 서버가 세션을 끝낼 때 쓰는 닫기 코드. */
const SESSION_ENDED_CLOSE_CODE = 4001;
/** 재연결 대기 시간(1초부터 두 배, 최대 30초). */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** n번째 재연결 대기 시간. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

/** 티켓을 붙인 WebSocket 주소. base가 비면 현재 화면의 출처를 쓴다. */
export function websocketUrl(ticket: string, base: string = API_BASE, origin: string = window.location.origin): string {
  return `${(base || origin).replace(/^http/, "ws")}/ws?ticket=${encodeURIComponent(ticket)}`;
}

/** 기본 티켓 발급. */
async function requestTicket(): Promise<string> {
  return (await apiSend<{ ticket: string }>("POST", "/api/ws-ticket")).ticket;
}

/** 서버와의 실시간 연결. 끊기면 새 티켓으로 다시 연결하고, 세션이 끝났으면 멈춘다. */
export class RealtimeConnection {
  private socket: SocketLike | null = null;
  private stopped = true;
  private attempt = 0;
  private readonly issueTicket: () => Promise<string>;
  private readonly openSocket: (url: string) => SocketLike;
  private readonly schedule: (callback: () => void, ms: number) => void;

  constructor(private readonly options: RealtimeOptions) {
    this.issueTicket = options.issueTicket ?? requestTicket;
    this.openSocket = options.openSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.schedule = options.schedule ?? ((callback, ms) => void setTimeout(callback, ms));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  /** 티켓을 받아 소켓을 연다. 401이면 세션 종료, 그 밖의 실패는 재연결. */
  private async connect(): Promise<void> {
    try {
      const ticket = await this.issueTicket();
      if (this.stopped) return;
      this.attach(this.openSocket(websocketUrl(ticket)));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return this.endSession(error.message);
      this.scheduleReconnect();
    }
  }

  /** 소켓 이벤트를 연결한다. */
  private attach(socket: SocketLike): void {
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.options.onConnectionChange(true);
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onclose = (event) => this.handleClose(socket, event.code);
  }

  /** 메시지 처리. 형식이 틀린 메시지는 콘솔에 남기고 버린다(연결은 유지). */
  private handleMessage(data: unknown): void {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(String(data)) as RealtimeEvent;
    } catch (error) {
      console.warn("실시간 메시지 형식 오류", error);
      return;
    }
    if (event.type === "session_ended") this.endSession(event.reason);
    else this.options.onEvent(event);
  }

  /** 닫힘 처리: 세션 종료 코드면 끝내고, 아니면 백오프 재연결. */
  private handleClose(socket: SocketLike, code: number): void {
    if (this.socket === socket) this.socket = null;
    this.options.onConnectionChange(false);
    if (this.stopped) return;
    if (code === SESSION_ENDED_CLOSE_CODE) return this.endSession("세션이 종료되었습니다. 다시 로그인하세요.");
    this.scheduleReconnect();
  }

  /** 세션 종료: 멈추고 한 번만 알린다. */
  private endSession(reason: string): void {
    if (this.stopped) return;
    this.stop();
    this.options.onSessionEnded(reason);
  }

  /** 재연결 예약. */
  private scheduleReconnect(): void {
    const delay = reconnectDelayMs(this.attempt);
    this.attempt += 1;
    this.schedule(() => {
      if (!this.stopped) void this.connect();
    }, delay);
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: PASS (21 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web/src/api/realtime.ts apps/web/test/api/realtime.test.ts
git commit -m "feat: 실시간 WebSocket 연결 추가" -m "일회용 티켓으로 연결하고 끊기면 1~30초 백오프로 새 티켓을 받아 다시 연결한다. 세션 종료(4001·session_ended·티켓 401)면 멈추고 로그인으로 보낸다."
```

---

### Task 4: 후보 화면

**Files:**
- Create: `apps/web/src/components/StatusBanner.tsx`, `apps/web/src/components/AutoHideToggle.tsx`, `apps/web/src/components/CandidateGroupCard.tsx`, `apps/web/src/screens/CandidatesScreen.tsx`
- Test: `apps/web/test/screens/CandidatesScreen.test.tsx`

**Interfaces:**
- Consumes: `buildSections`·`SenderGroup`(Task 2), `describeApiError`(Task 1), shared 타입
- Produces: `interface CandidateActions { hide(verdict: VerdictDto): Promise<void>; temporaryRestrict(group: SenderGroup): Promise<void>; ignore(verdict: VerdictDto): Promise<void>; reportFalsePositive(verdict: VerdictDto): Promise<void>; setAutoHide(enabled: boolean): Promise<void> }`, `CandidatesScreen(props: { me: MeDto; status: ServerStatus | null; verdicts: readonly VerdictDto[]; now: number; realtimeConnected: boolean; actions: CandidateActions })`, `StatusBanner(props: { status: ServerStatus | null; realtimeConnected: boolean })`, `AutoHideToggle(props: { enabled: boolean; canEnable: boolean; canDisable: boolean; onChange(enabled: boolean): void })`, `CandidateGroupCard(props: { group: SenderGroup; kind: "care" | "shadow" | "candidate"; permissions: readonly Permission[]; run(task: () => Promise<void>): void; actions: CandidateActions })`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/test/screens/CandidatesScreen.test.tsx`:
```tsx
import type { MeDto, ServerStatus, VerdictDto } from "@zzirit-guard/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/client";
import { CandidatesScreen, type CandidateActions } from "../../src/screens/CandidatesScreen";

/** 채팅 운영자. */
const chatManager: MeDto = { channelId: "m1", channelName: "매니저1", role: "STREAMING_CHAT_MANAGER", permissions: ["disable_auto_hide", "hide_message", "temporary_restrict"] };
/** 정상 상태. */
const status: ServerStatus = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, lastChatAt: null, pendingActions: 0 };
/** 기준 시각. */
const NOW = 1_000_000;

/** 판정 예시. */
function verdict(id: number, overrides: Partial<VerdictDto> = {}): VerdictDto {
  return { id, chatChannelId: "chat-1", senderChannelId: "bad", senderNickname: "악플러", content: `나쁜 말 ${id}`, messageTime: id, decision: "candidate", reason: "rule:weak:1", status: "pending", createdAt: NOW - id * 1000, ...overrides };
}

/** 모든 동작이 성공하는 가짜. */
function fakeActions(overrides: Partial<CandidateActions> = {}): CandidateActions {
  return { hide: vi.fn(async () => undefined), temporaryRestrict: vi.fn(async () => undefined), ignore: vi.fn(async () => undefined), reportFalsePositive: vi.fn(async () => undefined), setAutoHide: vi.fn(async () => undefined), ...overrides };
}

/** 화면을 그린다. */
function renderScreen(verdicts: VerdictDto[], actions = fakeActions(), me = chatManager) {
  render(<CandidatesScreen me={me} status={status} verdicts={verdicts} now={NOW} realtimeConnected actions={actions} />);
  return actions;
}

describe("CandidatesScreen", () => {
  it("사람 단위로 묶어 건수와 메시지를 보여 주고, 섀도는 따로 보여 준다", () => {
    renderScreen([verdict(1), verdict(2), verdict(3, { decision: "shadow", senderNickname: "도배러", senderChannelId: "spam" })]);
    expect(screen.getByText("악플러")).toBeTruthy();
    expect(screen.getByText("2건")).toBeTruthy();
    expect(screen.getByText("나쁜 말 1")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /켜져 있었으면 숨겼을 메시지/ })).toBeTruthy();
  });

  it("숨기기를 누르면 그 판정으로 동작을 부른다", async () => {
    const actions = renderScreen([verdict(1)]);
    await userEvent.click(screen.getByRole("button", { name: "숨기기" }));
    expect(actions.hide).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("채팅 운영자는 자동 숨김을 켤 수 없다(버튼 비활성)", () => {
    renderScreen([]);
    expect((screen.getByRole("button", { name: /자동 숨김: 꺼짐/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("실패하면 서버가 준 이유를 보여 준다", async () => {
    renderScreen([verdict(1)], fakeActions({ hide: async () => { throw new ApiError(502, "chzzk_failed", "치지직 호출 한도를 넘었습니다. 잠시 뒤 다시 시도하세요."); } }));
    await userEvent.click(screen.getByRole("button", { name: "숨기기" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/호출 한도/));
  });

  it("후보가 없으면 안내 문구", () => {
    renderScreen([]);
    expect(screen.getByText(/지금 확인할 후보가 없습니다/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/web/src/components/StatusBanner.tsx`:
```tsx
import type { ServerStatus } from "@zzirit-guard/shared";

/** StatusBanner 속성. */
export interface StatusBannerProps {
  status: ServerStatus | null;
  realtimeConnected: boolean;
}

/** 지금 상태에서 매니저가 알아야 할 문제를 고른다. 없으면 빈 배열. */
function problemsOf(status: ServerStatus | null, realtimeConnected: boolean): string[] {
  if (!status) return ["서버 상태를 불러오는 중입니다."];
  const problems: string[] = [];
  if (!realtimeConnected) problems.push("서버와의 실시간 연결이 끊겼습니다. 다시 연결하는 중입니다.");
  if (!status.channelConnected) problems.push("연결된 채널이 없습니다. 스트리머가 채널을 연결해야 합니다.");
  else if (status.writeLocked) problems.push("치지직 토큰이 만료돼 숨김·제재를 할 수 없습니다. 스트리머가 다시 연결해야 합니다.");
  if (status.channelConnected && !status.chatConnected) problems.push("치지직 채팅 연결이 끊겼습니다. 다시 연결하는 중입니다(끊긴 동안의 채팅은 놓칩니다).");
  return problems;
}

/** 화면 맨 위의 상태 배너(스펙 6장). */
export function StatusBanner({ status, realtimeConnected }: StatusBannerProps) {
  const problems = problemsOf(status, realtimeConnected);
  if (problems.length === 0) return <p className="banner banner-ok">정상 동작 중</p>;
  return (
    <ul className="banner banner-warning" aria-live="polite">
      {problems.map((problem) => (
        <li key={problem}>{problem}</li>
      ))}
    </ul>
  );
}
```

`apps/web/src/components/AutoHideToggle.tsx`:
```tsx
/** AutoHideToggle 속성. */
export interface AutoHideToggleProps {
  enabled: boolean;
  canEnable: boolean;
  canDisable: boolean;
  onChange(enabled: boolean): void;
}

/** 켜기 확인 문구. 숨긴 메시지는 되돌릴 수 없어서 한 번 더 묻는다. */
const ENABLE_CONFIRMATION = "자동 숨김을 켜면 규칙에 걸린 채팅이 바로 숨겨지고, 숨긴 채팅은 되돌릴 수 없습니다. 켤까요?";

/** 자동 숨김 스위치. 끄기는 바로, 켜기는 확인 후. 권한이 없으면 비활성. */
export function AutoHideToggle({ enabled, canEnable, canDisable, onChange }: AutoHideToggleProps) {
  const allowed = enabled ? canDisable : canEnable;
  const handleClick = () => {
    if (!enabled && !window.confirm(ENABLE_CONFIRMATION)) return;
    onChange(!enabled);
  };
  return (
    <button type="button" className={`toggle ${enabled ? "toggle-on" : "toggle-off"}`} disabled={!allowed} onClick={handleClick}
      title={allowed ? undefined : "이 기능을 쓸 권한이 없습니다"}>
      자동 숨김: {enabled ? "켜짐" : "꺼짐"}
    </button>
  );
}
```

`apps/web/src/components/CandidateGroupCard.tsx`:
```tsx
import type { Permission, VerdictDto } from "@zzirit-guard/shared";
import type { SenderGroup } from "../domain/candidates";
import type { CandidateActions } from "../screens/CandidatesScreen";

/** 묶음 카드 속성. kind로 버튼 구성을 정한다. run은 실패 시 오류 표시를 맡는 실행기다. */
export interface CandidateGroupCardProps {
  group: SenderGroup;
  kind: "care" | "shadow" | "candidate";
  permissions: readonly Permission[];
  run(task: () => Promise<void>): void;
  actions: CandidateActions;
}

/** 카드에 보여 줄 최근 메시지 수(스펙 6장). */
const VISIBLE_MESSAGES = 3;

/** 시각을 "14:03:21" 형태로. */
function formatTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** 한 사람의 후보 묶음 카드. 메시지별 숨기기·무시(또는 오판), 사람 단위 임시 제한. */
export function CandidateGroupCard({ group, kind, permissions, run, actions }: CandidateGroupCardProps) {
  const canHide = permissions.includes("hide_message");
  return (
    <article className={`card card-${kind}`}>
      <header className="card-header">
        <strong>{group.senderNickname}</strong>
        <span className="count">{group.verdicts.length}건</span>
        <button type="button" disabled={!permissions.includes("temporary_restrict")} onClick={() => run(() => actions.temporaryRestrict(group))}>
          임시 제한
        </button>
      </header>
      <ul className="messages">
        {group.verdicts.slice(0, VISIBLE_MESSAGES).map((verdict) => (
          <MessageRow key={verdict.id} verdict={verdict} kind={kind} canHide={canHide} run={run} actions={actions} />
        ))}
      </ul>
    </article>
  );
}

/** 메시지 한 줄과 버튼. 채팅 원문은 텍스트로만 넣는다(React가 이스케이프한다). */
function MessageRow({ verdict, kind, canHide, run, actions }: { verdict: VerdictDto; kind: CandidateGroupCardProps["kind"]; canHide: boolean; run: CandidateGroupCardProps["run"]; actions: CandidateActions }) {
  return (
    <li className="message">
      <span className="time">{formatTime(verdict.createdAt)}</span>
      <span className="content">{verdict.content}</span>
      <span className="buttons">
        <button type="button" disabled={!canHide} onClick={() => run(() => actions.hide(verdict))}>숨기기</button>
        {kind === "shadow" ? (
          <button type="button" disabled={!canHide} onClick={() => run(() => actions.reportFalsePositive(verdict))}>오판</button>
        ) : (
          <button type="button" disabled={!canHide} onClick={() => run(() => actions.ignore(verdict))}>무시</button>
        )}
      </span>
    </li>
  );
}
```

`apps/web/src/screens/CandidatesScreen.tsx`:
```tsx
import type { MeDto, ServerStatus, VerdictDto } from "@zzirit-guard/shared";
import { useState } from "react";
import { describeApiError } from "../api/client";
import { AutoHideToggle } from "../components/AutoHideToggle";
import { CandidateGroupCard } from "../components/CandidateGroupCard";
import { StatusBanner } from "../components/StatusBanner";
import { buildSections, type SenderGroup } from "../domain/candidates";

/** 후보 화면이 부르는 동작. MainScreen이 API로 채우고, 테스트는 가짜를 넘긴다. */
export interface CandidateActions {
  hide(verdict: VerdictDto): Promise<void>;
  temporaryRestrict(group: SenderGroup): Promise<void>;
  ignore(verdict: VerdictDto): Promise<void>;
  reportFalsePositive(verdict: VerdictDto): Promise<void>;
  setAutoHide(enabled: boolean): Promise<void>;
}

/** 후보 화면 속성. */
export interface CandidatesScreenProps {
  me: MeDto;
  status: ServerStatus | null;
  verdicts: readonly VerdictDto[];
  now: number;
  realtimeConnected: boolean;
  actions: CandidateActions;
}

/** 후보 화면(스펙 6장 ①): 상태 배너·스위치·구역별 사람 단위 묶음. */
export function CandidatesScreen({ me, status, verdicts, now, realtimeConnected, actions }: CandidatesScreenProps) {
  const [error, setError] = useState<string | null>(null);
  const sections = buildSections(verdicts, now);
  const run = (task: () => Promise<void>) => {
    setError(null);
    task().catch((caught: unknown) => setError(describeApiError(caught)));
  };
  const empty = sections.care.length + sections.shadow.length + sections.candidates.length === 0;
  return (
    <section className="screen">
      <StatusBanner status={status} realtimeConnected={realtimeConnected} />
      <AutoHideToggle enabled={status?.autoHideEnabled ?? false} canEnable={me.permissions.includes("enable_auto_hide")}
        canDisable={me.permissions.includes("disable_auto_hide")} onChange={(enabled) => run(() => actions.setAutoHide(enabled))} />
      {error && <p className="error" role="alert">{error}</p>}
      <GroupSection title="도움 필요(자해·자살 신호)" groups={sections.care} kind="care" me={me} run={run} actions={actions} />
      <GroupSection title="켜져 있었으면 숨겼을 메시지" groups={sections.shadow} kind="shadow" me={me} run={run} actions={actions} />
      <GroupSection title="후보" groups={sections.candidates} kind="candidate" me={me} run={run} actions={actions} />
      {empty && <p className="empty">지금 확인할 후보가 없습니다.</p>}
      <AutoHiddenList verdicts={sections.autoHidden} canReport={me.permissions.includes("hide_message")} run={run} actions={actions} />
    </section>
  );
}

/** 구역 하나. 비어 있으면 그리지 않는다. */
function GroupSection({ title, groups, kind, me, run, actions }: { title: string; groups: SenderGroup[]; kind: "care" | "shadow" | "candidate"; me: MeDto; run(task: () => Promise<void>): void; actions: CandidateActions }) {
  if (groups.length === 0) return null;
  return (
    <section className={`section section-${kind}`}>
      <h2>{title}</h2>
      {groups.map((group) => (
        <CandidateGroupCard key={group.senderChannelId} group={group} kind={kind} permissions={me.permissions} run={run} actions={actions} />
      ))}
    </section>
  );
}

/** 최근 10분 자동 숨김 목록. 잘못 숨겼으면 오판으로 신고해 규칙을 검토하게 한다. */
function AutoHiddenList({ verdicts, canReport, run, actions }: { verdicts: VerdictDto[]; canReport: boolean; run(task: () => Promise<void>): void; actions: CandidateActions }) {
  if (verdicts.length === 0) return null;
  return (
    <details className="section section-auto">
      <summary>자동 숨김됨(최근 10분, {verdicts.length}건)</summary>
      <ul className="messages">
        {verdicts.map((verdict) => (
          <li key={verdict.id} className="message">
            <span className="content">{verdict.senderNickname}: {verdict.content}</span>
            <button type="button" disabled={!canReport || verdict.status === "false_positive"} onClick={() => run(() => actions.reportFalsePositive(verdict))}>오판</button>
          </li>
        ))}
      </ul>
    </details>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: PASS (26 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web/src/components apps/web/src/screens/CandidatesScreen.tsx apps/web/test/screens/CandidatesScreen.test.tsx
git commit -m "feat: 후보 화면 추가" -m "상태 배너·자동 숨김 스위치·도움 필요/섀도/후보 구역을 사람 단위 묶음으로 보여 준다. 권한 없는 버튼은 비활성으로 두고, 실패하면 서버가 준 이유를 보여 준다."
```

---

### Task 5: 실시간 채팅 화면

**Files:**
- Create: `apps/web/src/screens/LiveChatScreen.tsx`
- Test: `apps/web/test/screens/LiveChatScreen.test.tsx`

**Interfaces:**
- Consumes: `ChatLine`(shared)
- Produces: `LiveChatScreen(props: { lines: readonly ChatLine[] })`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/test/screens/LiveChatScreen.test.tsx`:
```tsx
import type { ChatLine } from "@zzirit-guard/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LiveChatScreen } from "../../src/screens/LiveChatScreen";

/** 채팅 줄 예시. */
const lines: ChatLine[] = [
  { senderNickname: "시청자1", content: "안녕하세요", messageTime: 1, decision: "pass" },
  { senderNickname: "악플러", content: "<b>나쁜 말</b>", messageTime: 2, decision: "candidate" },
];

describe("LiveChatScreen", () => {
  it("채팅을 텍스트로만 보여 주고 위험한 줄을 표시한다", () => {
    render(<LiveChatScreen lines={lines} />);
    expect(screen.getByText("<b>나쁜 말</b>")).toBeTruthy();
    expect(screen.getByText("후보")).toBeTruthy();
  });

  it("위험한 것만 보기", async () => {
    render(<LiveChatScreen lines={lines} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "위험한 것만 보기" }));
    expect(screen.queryByText("안녕하세요")).toBeNull();
    expect(screen.getByText("<b>나쁜 말</b>")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/web/src/screens/LiveChatScreen.tsx`:
```tsx
import type { ChatLine, Decision } from "@zzirit-guard/shared";
import { useState } from "react";

/** 판정 표시 이름. 통과는 표시하지 않는다. */
const DECISION_LABELS: Record<Decision, string | null> = {
  pass: null, candidate: "후보", shadow: "섀도", auto_hide: "자동 숨김", needs_care: "도움 필요",
};

/** 실시간 채팅 화면(스펙 6장 ②): 위험 메시지 강조, 위험한 것만 보기. 최신 줄이 위로 온다. */
export function LiveChatScreen({ lines }: { lines: readonly ChatLine[] }) {
  const [riskyOnly, setRiskyOnly] = useState(false);
  const visible = (riskyOnly ? lines.filter((line) => line.decision !== "pass") : lines).slice().reverse();
  return (
    <section className="screen">
      <label className="filter">
        <input type="checkbox" checked={riskyOnly} onChange={(event) => setRiskyOnly(event.target.checked)} />
        위험한 것만 보기
      </label>
      {visible.length === 0 && <p className="empty">표시할 채팅이 없습니다.</p>}
      <ol className="chat-lines">
        {visible.map((line, index) => (
          <li key={`${line.messageTime}-${index}`} className={`chat-line chat-${line.decision}`}>
            <span className="nickname">{line.senderNickname}</span>
            <span className="content">{line.content}</span>
            {DECISION_LABELS[line.decision] && <span className="tag">{DECISION_LABELS[line.decision]}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: PASS (28 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web/src/screens/LiveChatScreen.tsx apps/web/test/screens/LiveChatScreen.test.tsx
git commit -m "feat: 실시간 채팅 화면 추가" -m "채팅을 텍스트로만 보여 주고 판정이 붙은 줄을 강조하며, 위험한 것만 걸러 볼 수 있다."
```

---

### Task 6: 푸시 구독과 PWA 파일

**Files:**
- Create: `apps/web/src/push/pushSubscription.ts`
- Create: `apps/web/public/manifest.webmanifest`, `apps/web/public/sw.js`, `ops/scripts/render-icons.sh`
- Create(스크립트 결과): `apps/web/public/icons/logo.svg`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`
- Test: `apps/web/test/push/pushSubscription.test.ts`

**Interfaces:**
- Consumes: `apiGet`·`apiSend`(Task 1)
- Produces: `base64UrlToUint8Array(value: string): Uint8Array`, `enablePush(): Promise<void>`(실패 시 이유를 담은 `Error`)

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/test/push/pushSubscription.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { base64UrlToUint8Array, enablePush } from "../../src/push/pushSubscription";

describe("pushSubscription", () => {
  it("VAPID 공개키(base64url)를 바이트로 바꾼다", () => {
    expect([...base64UrlToUint8Array("AQID-_8")]).toEqual([1, 2, 3, 251, 255]);
  });

  it("서비스 워커가 없는 브라우저면 이유와 해결 방법을 알려 준다", async () => {
    await expect(enablePush()).rejects.toThrow(/홈 화면에 추가/);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/web/src/push/pushSubscription.ts`:
```ts
import { apiGet, apiSend } from "../api/client";

/** 지원하지 않는 환경 안내. iPhone은 홈 화면에 추가한 PWA에서만 웹 푸시를 받는다(iOS 16.4 이상). */
const UNSUPPORTED_MESSAGE = "이 브라우저는 알림을 지원하지 않습니다. iPhone은 Safari 공유 버튼 → '홈 화면에 추가'로 연 앱에서 다시 시도하세요(iOS 16.4 이상).";

/** base64url 문자열을 바이트 배열로 바꾼다(PushManager가 VAPID 공개키를 바이트로 받는다). */
export function base64UrlToUint8Array(value: string): Uint8Array {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

/**
 * 알림 권한을 받고 푸시를 구독해 서버에 등록한다.
 * @throws Error 지원하지 않거나 권한이 거부되면 이유와 해결 방법을 담아 던진다
 */
export async function enablePush(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error(UNSUPPORTED_MESSAGE);
  if ((await Notification.requestPermission()) !== "granted") {
    throw new Error("알림 권한이 거부되었습니다. 브라우저(또는 iPhone 설정 → 알림)에서 이 앱의 알림을 허용하세요.");
  }
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await apiGet<{ publicKey: string }>("/api/push/public-key");
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(publicKey) });
  await apiSend("POST", "/api/push/subscriptions", subscription.toJSON());
}
```

`apps/web/public/manifest.webmanifest`:
```json
{
  "name": "찌리릿 가드",
  "short_name": "찌리릿 가드",
  "description": "치지직 채팅 관리 보조 도구(비공식)",
  "lang": "ko",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#17171F",
  "theme_color": "#17171F",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/logo.svg", "sizes": "any", "type": "image/svg+xml" }
  ]
}
```

`apps/web/public/sw.js`:
```js
// 서비스 워커: 푸시 알림 표시와 알림 클릭 시 앱 열기만 한다.
// 오프라인 캐시는 하지 않는다. 옛 화면을 보고 이미 처리된 후보에 조치하는 일을 막기 위해서다.

/** 푸시 내용을 읽는다. JSON이 아니면 본문 텍스트를 그대로 쓴다. */
function readPushMessage(data) {
  if (!data) return { title: "찌리릿 가드", body: "" };
  try {
    return data.json();
  } catch (error) {
    console.warn("푸시 내용이 JSON이 아닙니다", error);
    return { title: "찌리릿 가드", body: data.text() };
  }
}

self.addEventListener("push", (event) => {
  const message = readPushMessage(event.data);
  event.waitUntil(self.registration.showNotification(message.title, { body: message.body, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png" }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((windows) => (windows[0] ? windows[0].focus() : self.clients.openWindow("/"))),
  );
});
```

`ops/scripts/render-icons.sh`:
```sh
#!/bin/zsh
# 로고 SVG에서 PWA 아이콘(PNG)을 만든다. macOS의 qlmanage로 렌더링한다.
# 사용법: ops/scripts/render-icons.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SOURCE="$ROOT/assets/logo/zzirit-guard-mark.svg"
OUT="$ROOT/apps/web/public/icons"
WORK=$(mktemp -d)
mkdir -p "$OUT"
cp "$SOURCE" "$OUT/logo.svg"
for SIZE in 180 192 512; do
  /usr/bin/qlmanage -t -s "$SIZE" -o "$WORK" "$SOURCE" >/dev/null
  mv "$WORK/zzirit-guard-mark.svg.png" "$OUT/icon-$SIZE.png"
done
mv "$OUT/icon-180.png" "$OUT/apple-touch-icon.png"
rm -rf "$WORK"
echo "아이콘을 만들었습니다: $OUT"
```

- [ ] **Step 4: 아이콘 생성과 확인**

Run: `chmod +x ops/scripts/render-icons.sh && ops/scripts/render-icons.sh && sips -g pixelWidth apps/web/public/icons/*.png`
Expected: `apple-touch-icon.png` 180, `icon-192.png` 192, `icon-512.png` 512. `icon-512.png`를 열어 방패·번개가 보이는지 눈으로 확인한다.

- [ ] **Step 5: 통과 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: PASS (30 tests)

- [ ] **Step 6: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web/src/push apps/web/test/push apps/web/public ops/scripts/render-icons.sh
git commit -m "feat: 푸시 구독과 PWA 매니페스트·서비스 워커 추가" -m "알림 권한을 받아 푸시를 구독하고, 지원하지 않는 환경(홈 화면에 추가하지 않은 iPhone 등)은 이유를 알려 준다. 서비스 워커는 알림 표시만 하고 캐시는 하지 않는다."
```

---

### Task 7: 기록·설정 화면

**Files:**
- Create: `apps/web/src/api/useApiResource.ts`, `apps/web/src/components/ApiNotice.tsx`
- Create: `apps/web/src/settings/StatusSection.tsx`, `StatsSection.tsx`, `RulesSection.tsx`, `LimitsSection.tsx`, `ChatSettingsSection.tsx`, `AuditSection.tsx`, `AccountSection.tsx`
- Create: `apps/web/src/screens/SettingsScreen.tsx`
- Test: `apps/web/test/settings/settings.test.tsx`

**Interfaces:**
- Consumes: `apiGet`·`apiSend`·`describeApiError`(Task 1), `enablePush`(Task 6), shared 타입
- Produces: `useApiResource<T>(path: string | null): { data: T | null; error: string | null; loading: boolean; reload(): void }`, `ApiNotice()`, `SettingsScreen(props: { me: MeDto; status: ServerStatus | null; onSignedOut(message: string | null): void })`, 각 Section 컴포넌트(`StatusSection({ status })`, `StatsSection()`, `RulesSection({ me })`, `LimitsSection({ me })`, `ChatSettingsSection({ me })`, `AuditSection({ me })`, `AccountSection({ me, onSignedOut })`)

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/test/settings/settings.test.tsx`:
```tsx
import type { MeDto, RuleEntryDto } from "@zzirit-guard/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditSection } from "../../src/settings/AuditSection";
import { RulesSection } from "../../src/settings/RulesSection";
import { StatsSection } from "../../src/settings/StatsSection";
import { json, stubFetch } from "../helpers/stubFetch";

afterEach(() => vi.unstubAllGlobals());

/** 채널 관리자. */
const channelManager: MeDto = { channelId: "m1", channelName: "관리자", role: "STREAMING_CHANNEL_MANAGER", permissions: ["disable_auto_hide", "enable_auto_hide", "edit_rules", "hide_message", "temporary_restrict", "restrict", "edit_chat_settings", "view_audit"] };
/** 채팅 운영자. */
const chatManager: MeDto = { channelId: "m2", channelName: "운영자", role: "STREAMING_CHAT_MANAGER", permissions: ["disable_auto_hide", "hide_message", "temporary_restrict"] };

describe("RulesSection", () => {
  it("종류별로 보여 주고, 추가하면 다시 불러온다", async () => {
    const rules: RuleEntryDto[] = [{ id: 1, kind: "strong", pattern: "홍어", createdBy: "default", createdAt: 0 }];
    const fetchMock = stubFetch({
      "GET /api/rules": () => json(200, rules),
      "POST /api/rules": (init) => {
        const body = JSON.parse(String(init?.body)) as { kind: RuleEntryDto["kind"]; pattern: string };
        rules.push({ id: 2, kind: body.kind, pattern: body.pattern, createdBy: "m1", createdAt: 1 });
        return json(200, rules[1]);
      },
    });
    render(<RulesSection me={channelManager} />);
    expect(await screen.findByText("홍어")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "금칙어 강(자동 숨김)" })).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("종류"), "weak");
    await userEvent.type(screen.getByLabelText("내용"), "바보");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));
    expect(await screen.findByText("바보")).toBeTruthy();
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

  it("채널 관리자에게는 목록을 보여 준다", async () => {
    stubFetch({
      "GET /api/audit?limit=50": () => json(200, [{ id: 1, actorType: "manager", actorChannelId: "m1", action: "hide", targetSenderChannelId: "bad", verdictId: 3, result: "ok", error: null, createdAt: 0 }]),
    });
    render(<AuditSection me={channelManager} />);
    expect(await screen.findByText(/숨김/)).toBeTruthy();
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
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/web/src/api/useApiResource.ts`:
```ts
import { useCallback, useEffect, useState } from "react";
import { apiGet, describeApiError } from "./client";

/** 조회 결과 상태. */
export interface ApiResource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): void;
}

/**
 * 경로를 조회하고 결과를 상태로 돌려준다. path가 null이면 조회하지 않는다(권한이 없을 때).
 * 화면이 사라진 뒤 도착한 응답은 버린다.
 */
export function useApiResource<T>(path: string | null): ApiResource<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: path !== null });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    apiGet<T>(path).then(
      (data) => !cancelled && setState({ data, error: null, loading: false }),
      (error: unknown) => !cancelled && setState({ data: null, error: describeApiError(error), loading: false }),
    );
    return () => {
      cancelled = true;
    };
  }, [path, version]);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { ...state, reload };
}
```

`apps/web/src/components/ApiNotice.tsx`:
```tsx
/** 치지직 API 사용·비공식 표시(약관 제7조④·14호). 정확한 표시 방식은 0단계에서 치지직에 확인한다. */
export function ApiNotice() {
  return <p className="notice">이 앱은 치지직 Open API를 사용합니다. 네이버·치지직과 관계없는 비공식 프로젝트입니다.</p>;
}
```

`apps/web/src/settings/StatusSection.tsx`:
```tsx
import type { ServerStatus } from "@zzirit-guard/shared";

/** 시각 표시. 없으면 "—". */
function formatTime(timestampMs: number | null): string {
  return timestampMs ? new Date(timestampMs).toLocaleString("ko-KR") : "—";
}

/** 방송 전 상태 점검(스펙 6장 ③, 10장). */
export function StatusSection({ status }: { status: ServerStatus | null }) {
  if (!status) return <section><h2>상태 점검</h2><p>불러오는 중…</p></section>;
  const rows: Array<[string, string]> = [
    ["채널", status.channelName ?? "연결 안 됨"],
    ["치지직 채팅 연결", status.chatConnected ? "연결됨" : "끊김"],
    ["숨김·제재 가능", status.writeLocked ? "불가(스트리머 재연결 필요)" : "가능"],
    ["토큰 만료 예정", formatTime(status.accessExpiresAt)],
    ["마지막 채팅 수신", formatTime(status.lastChatAt)],
    ["처리 대기 중인 조치", `${status.pendingActions}건`],
  ];
  return (
    <section>
      <h2>상태 점검</h2>
      <dl className="rows">
        {rows.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
    </section>
  );
}
```

`apps/web/src/settings/StatsSection.tsx`:
```tsx
import { useApiResource } from "../api/useApiResource";

/** 분당 통계 한 행(서버 minute_stat). */
interface MinuteStat {
  minute: number;
  received: number;
  skipped: number;
  deduplicated: number;
  candidates: number;
  shadow: number;
  auto_hidden: number;
  invalid_events: number;
}

/** 합계로 보여 줄 항목과 이름. */
const TOTAL_FIELDS: Array<[keyof Omit<MinuteStat, "minute">, string]> = [
  ["received", "받은 채팅"], ["skipped", "가벼운 반응(ㅋㅋ 등)"], ["deduplicated", "중복 문장"], ["candidates", "후보"],
  ["shadow", "섀도"], ["auto_hidden", "자동 숨김"], ["invalid_events", "형식 오류 이벤트"],
];

/** 최근 1시간 통계. 1단계의 핵심 측정값(초당 채팅량·건너뛰기·중복 비율)을 보여 준다(스펙 15장). */
export function StatsSection() {
  const stats = useApiResource<MinuteStat[]>("/api/stats?sinceMinutes=60");
  if (stats.error) return <section><h2>최근 1시간</h2><p className="error" role="alert">{stats.error}</p></section>;
  const rows = stats.data ?? [];
  const peakPerSecond = Math.max(0, ...rows.map((row) => row.received)) / 60;
  return (
    <section>
      <h2>최근 1시간</h2>
      <dl className="rows">
        {TOTAL_FIELDS.map(([field, label]) => (
          <div key={field}><dt>{label}</dt><dd>{rows.reduce((sum, row) => sum + row[field], 0)}</dd></div>
        ))}
        <div><dt>가장 바빴던 1분의 초당 채팅</dt><dd>{peakPerSecond.toFixed(1)}</dd></div>
      </dl>
    </section>
  );
}
```

`apps/web/src/settings/RulesSection.tsx`:
```tsx
import type { MeDto, RuleEntryDto, RuleKind } from "@zzirit-guard/shared";
import { useState, type FormEvent } from "react";
import { apiSend, describeApiError } from "../api/client";
import { useApiResource } from "../api/useApiResource";

/** 규칙 종류 이름. */
const KIND_LABELS: Record<RuleKind, string> = {
  strong: "금칙어 강(자동 숨김)", weak: "금칙어 약(후보)", exception: "예외 단어", allow: "허용어(메시지 전체 일치)",
  allow_domain: "허용 도메인", threat: "협박 표현(후보)", keyword_route: "AI 키워드 경로",
};
/** 1단계에서 추가할 수 있는 종류(AI 키워드 경로는 2단계). */
const EDITABLE_KINDS: RuleKind[] = ["strong", "weak", "exception", "allow", "allow_domain", "threat"];

/** 규칙 목록과 추가·삭제(스펙 6장 ③). */
export function RulesSection({ me }: { me: MeDto }) {
  const rules = useApiResource<RuleEntryDto[]>("/api/rules");
  const [error, setError] = useState<string | null>(null);
  const canEdit = me.permissions.includes("edit_rules");
  const run = (task: () => Promise<unknown>) => {
    setError(null);
    task().then(rules.reload, (caught: unknown) => setError(describeApiError(caught)));
  };
  return (
    <section>
      <h2>규칙</h2>
      {(error ?? rules.error) && <p className="error" role="alert">{error ?? rules.error}</p>}
      {canEdit ? <RuleForm onAdd={(kind, pattern) => run(() => apiSend("POST", "/api/rules", { kind, pattern }))} /> : <p className="hint">규칙은 채널 관리자 이상만 바꿀 수 있습니다.</p>}
      {EDITABLE_KINDS.map((kind) => (
        <RuleGroup key={kind} kind={kind} rules={(rules.data ?? []).filter((rule) => rule.kind === kind)} canEdit={canEdit}
          onRemove={(rule) => run(() => apiSend("DELETE", `/api/rules/${rule.id}`))} />
      ))}
    </section>
  );
}

/** 규칙 추가 양식. */
function RuleForm({ onAdd }: { onAdd(kind: RuleKind, pattern: string): void }) {
  const [kind, setKind] = useState<RuleKind>("weak");
  const [pattern, setPattern] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!pattern.trim()) return;
    onAdd(kind, pattern.trim());
    setPattern("");
  };
  return (
    <form className="rule-form" onSubmit={submit}>
      <label>종류<select value={kind} onChange={(event) => setKind(event.target.value as RuleKind)}>{EDITABLE_KINDS.map((option) => <option key={option} value={option}>{KIND_LABELS[option]}</option>)}</select></label>
      <label>내용<input value={pattern} maxLength={50} onChange={(event) => setPattern(event.target.value)} /></label>
      <button type="submit">추가</button>
    </form>
  );
}

/** 종류 하나의 규칙 목록. 비어 있으면 그리지 않는다. */
function RuleGroup({ kind, rules, canEdit, onRemove }: { kind: RuleKind; rules: RuleEntryDto[]; canEdit: boolean; onRemove(rule: RuleEntryDto): void }) {
  if (rules.length === 0) return null;
  return (
    <div className="rule-group">
      <h3>{KIND_LABELS[kind]}</h3>
      <ul>
        {rules.map((rule) => (
          <li key={rule.id}>
            <span>{rule.pattern}</span>
            {canEdit && <button type="button" onClick={() => onRemove(rule)} aria-label={`${rule.pattern} 삭제`}>삭제</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

`apps/web/src/settings/LimitsSection.tsx`:
```tsx
import type { MeDto, SettingsDto } from "@zzirit-guard/shared";
import { useEffect, useState } from "react";
import { apiSend, describeApiError } from "../api/client";
import { useApiResource } from "../api/useApiResource";

/** 설정 항목 이름과 허용 범위(서버 SETTING_RULES와 같다). */
const FIELDS: Array<{ key: keyof SettingsDto; label: string; min: number; max: number }> = [
  { key: "breakerPerMinute", label: "자동 숨김 1분 한도(넘으면 스위치가 꺼짐)", min: 1, max: 1000 },
  { key: "retentionDaysContent", label: "원문 보관 기간(일)", min: 1, max: 365 },
  { key: "retentionDaysAudit", label: "감사 기록 보관 기간(일)", min: 1, max: 365 },
];

/** 한도·보관 기간 설정(스펙 5.5·9장). */
export function LimitsSection({ me }: { me: MeDto }) {
  const settings = useApiResource<SettingsDto>("/api/settings");
  const [draft, setDraft] = useState<SettingsDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canEdit = me.permissions.includes("edit_rules");
  useEffect(() => setDraft(settings.data), [settings.data]);
  const save = () => {
    if (!draft) return;
    apiSend<SettingsDto>("PUT", "/api/settings", draft).then(() => setMessage("저장했습니다."), (error: unknown) => setMessage(describeApiError(error)));
  };
  if (!draft) return <section><h2>한도·보관 기간</h2><p>{settings.error ?? "불러오는 중…"}</p></section>;
  return (
    <section>
      <h2>한도·보관 기간</h2>
      {FIELDS.map((field) => (
        <label key={field.key} className="field">
          {field.label}
          <input type="number" min={field.min} max={field.max} value={draft[field.key]} disabled={!canEdit}
            onChange={(event) => setDraft({ ...draft, [field.key]: Number(event.target.value) })} />
        </label>
      ))}
      {canEdit && <button type="button" onClick={save}>저장</button>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
```

`apps/web/src/settings/ChatSettingsSection.tsx`:
```tsx
import type { ChatSettingsDto, MeDto } from "@zzirit-guard/shared";
import { useState } from "react";
import { apiSend, describeApiError } from "../api/client";
import { useApiResource } from "../api/useApiResource";

/** 치지직이 허용하는 저속 모드 값(초). */
const SLOW_MODE_OPTIONS = [0, 3, 5, 10, 30, 60, 120, 300];

/** 치지직 채팅 설정 중 저속 모드(도배가 몰릴 때 바로 쓰는 수단). */
export function ChatSettingsSection({ me }: { me: MeDto }) {
  const settings = useApiResource<ChatSettingsDto>("/api/chat-settings");
  const [message, setMessage] = useState<string | null>(null);
  const canEdit = me.permissions.includes("edit_chat_settings");
  const change = (seconds: number) => {
    if (!settings.data) return;
    apiSend("PUT", "/api/chat-settings", { ...settings.data, chatSlowModeSec: seconds }).then(
      () => { setMessage(seconds === 0 ? "저속 모드를 껐습니다." : `저속 모드를 ${seconds}초로 바꿨습니다.`); settings.reload(); },
      (error: unknown) => setMessage(describeApiError(error)),
    );
  };
  return (
    <section>
      <h2>채팅 설정</h2>
      {settings.error && <p className="error" role="alert">{settings.error}</p>}
      {settings.data && (
        <label className="field">
          저속 모드
          <select value={settings.data.chatSlowModeSec} disabled={!canEdit} onChange={(event) => change(Number(event.target.value))}>
            {SLOW_MODE_OPTIONS.map((seconds) => <option key={seconds} value={seconds}>{seconds === 0 ? "끔" : `${seconds}초`}</option>)}
          </select>
        </label>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
```

`apps/web/src/settings/AuditSection.tsx`:
```tsx
import type { AuditEntryDto, MeDto } from "@zzirit-guard/shared";
import { useApiResource } from "../api/useApiResource";

/** 감사 기록 동작 이름. 접두어(예: auto_hide_off:breaker)로 고른다. */
const ACTION_LABELS: Array<[string, string]> = [
  ["hide", "숨김"], ["temporary_restrict", "임시 제한"], ["restrict", "활동 제한"], ["unrestrict", "활동 제한 해제"],
  ["update_chat_settings", "채팅 설정 변경"], ["auto_hide_on", "자동 숨김 켬"], ["auto_hide_off", "자동 숨김 끔"],
  ["ignore", "무시"], ["false_positive", "오판 신고"], ["rule_add", "규칙 추가"], ["rule_remove", "규칙 삭제"], ["settings_update", "설정 변경"],
];
/** 행위자 이름. */
const ACTOR_LABELS: Record<AuditEntryDto["actorType"], string> = { manager: "매니저", rule: "자동 규칙", system: "시스템" };

/** 동작 문자열을 읽기 쉬운 이름으로. */
function describeAction(action: string): string {
  const match = ACTION_LABELS.find(([prefix]) => action === prefix || action.startsWith(`${prefix}:`));
  const detail = action.includes(":") ? ` (${action.split(":").slice(1).join(":")})` : "";
  return match ? `${match[1]}${detail}` : action;
}

/** 감사 기록(스펙 6장 ③). 채널 관리자 이상만 본다. */
export function AuditSection({ me }: { me: MeDto }) {
  const canView = me.permissions.includes("view_audit");
  const entries = useApiResource<AuditEntryDto[]>(canView ? "/api/audit?limit=50" : null);
  if (!canView) return <section><h2>감사 기록</h2><p className="hint">감사 기록은 채널 관리자 이상만 볼 수 있습니다.</p></section>;
  return (
    <section>
      <h2>감사 기록</h2>
      {entries.error && <p className="error" role="alert">{entries.error}</p>}
      <ol className="audit">
        {(entries.data ?? []).map((entry) => (
          <li key={entry.id} className={entry.result === "error" ? "audit-error" : undefined}>
            <time>{new Date(entry.createdAt).toLocaleString("ko-KR")}</time> {ACTOR_LABELS[entry.actorType]} · {describeAction(entry.action)}
            {entry.result === "error" && <span className="error"> 실패: {entry.error}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
```

`apps/web/src/settings/AccountSection.tsx`:
```tsx
import type { MeDto } from "@zzirit-guard/shared";
import { useState } from "react";
import { ApiError, apiSend, describeApiError } from "../api/client";
import { ApiNotice } from "../components/ApiNotice";
import { enablePush } from "../push/pushSubscription";

/** 역할 이름. */
const ROLE_LABELS: Record<MeDto["role"], string> = {
  STREAMING_CHANNEL_OWNER: "스트리머", STREAMING_CHANNEL_MANAGER: "채널 관리자", STREAMING_CHAT_MANAGER: "채팅 운영자",
};

/** 오류 문구: 서버 오류(ApiError)는 서버 문구, 일반 Error(알림 미지원·권한 거부)는 자기 문구. */
function messageOf(error: unknown): string {
  return error instanceof Error && !(error instanceof ApiError) ? error.message : describeApiError(error);
}

/** 계정·장애 알림·로그아웃·(스트리머) 채널 연결 해제. */
export function AccountSection({ me, onSignedOut }: { me: MeDto; onSignedOut(message: string | null): void }) {
  const [message, setMessage] = useState<string | null>(null);
  const enableAlerts = () => enablePush().then(() => setMessage("장애 알림을 켰습니다."), (error: unknown) => setMessage(messageOf(error)));
  const logout = () => apiSend("POST", "/api/logout").then(() => onSignedOut(null), (error: unknown) => setMessage(messageOf(error)));
  const disconnect = () => {
    if (!window.confirm("채널 연결을 해제하면 모든 매니저가 로그아웃되고 자동 기능이 멈춥니다. 해제할까요?")) return;
    apiSend("POST", "/api/channel/disconnect").then(() => onSignedOut("채널 연결을 해제했습니다."), (error: unknown) => setMessage(messageOf(error)));
  };
  return (
    <section>
      <h2>계정</h2>
      <p>{me.channelName} · {ROLE_LABELS[me.role]}</p>
      <button type="button" onClick={() => void enableAlerts()}>장애 알림 받기</button>
      <button type="button" onClick={() => void logout()}>로그아웃</button>
      {me.permissions.includes("connect_channel") && <button type="button" className="danger" onClick={disconnect}>채널 연결 해제</button>}
      {message && <p role="status">{message}</p>}
      <ApiNotice />
    </section>
  );
}
```

`apps/web/src/screens/SettingsScreen.tsx`:
```tsx
import type { MeDto, ServerStatus } from "@zzirit-guard/shared";
import { AccountSection } from "../settings/AccountSection";
import { AuditSection } from "../settings/AuditSection";
import { ChatSettingsSection } from "../settings/ChatSettingsSection";
import { LimitsSection } from "../settings/LimitsSection";
import { RulesSection } from "../settings/RulesSection";
import { StatsSection } from "../settings/StatsSection";
import { StatusSection } from "../settings/StatusSection";

/** 기록·설정 화면(스펙 6장 ③). */
export function SettingsScreen({ me, status, onSignedOut }: { me: MeDto; status: ServerStatus | null; onSignedOut(message: string | null): void }) {
  return (
    <section className="screen settings">
      <StatusSection status={status} />
      <StatsSection />
      <RulesSection me={me} />
      <LimitsSection me={me} />
      <ChatSettingsSection me={me} />
      <AuditSection me={me} />
      <AccountSection me={me} onSignedOut={onSignedOut} />
    </section>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: PASS (35 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web/src/api/useApiResource.ts apps/web/src/components/ApiNotice.tsx apps/web/src/settings apps/web/src/screens/SettingsScreen.tsx apps/web/test/settings
git commit -m "feat: 기록·설정 화면 추가" -m "상태 점검·최근 1시간 통계(초당 피크)·규칙·한도·저속 모드·감사 기록·계정을 한 화면에 둔다. 권한이 없으면 조회하지 않거나 수정 버튼을 숨긴다."
```

---

### Task 8: 앱 골격과 빌드

**Files:**
- Create: `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles.css`
- Create: `apps/web/src/screens/LoginScreen.tsx`, `apps/web/src/screens/MainScreen.tsx`, `apps/web/src/components/TabBar.tsx`
- Create: `apps/web/src/state/useServerState.ts`, `apps/web/src/state/useNow.ts`
- Test: `apps/web/test/App.test.tsx`

**Interfaces:**
- Consumes: Task 1~7의 모든 모듈
- Produces: `App()`, `LoginScreen(props: { loginError: string | null; message: string | null })`, `MainScreen(props: { me: MeDto; onSignedOut(message: string | null): void })`, `TabBar(props: { active: Tab; onChange(tab: Tab): void; pendingCount: number })`, `type Tab = "candidates" | "chat" | "settings"`, `useServerState(): ServerState`, `useNow(intervalMs: number): number`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/test/App.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { json, stubFetch } from "./helpers/stubFetch";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

/** 열리자마자 open을 알리는 가짜 WebSocket. */
class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    setTimeout(() => this.onopen?.(), 0);
  }
  close(): void {
    this.onclose?.({ code: 1000 });
  }
}

describe("App", () => {
  it("로그인하지 않았으면 로그인 화면과 실패 이유를 보여 준다", async () => {
    window.history.pushState({}, "", `/?loginError=${encodeURIComponent("이 채널의 매니저가 아닙니다.")}`);
    stubFetch({ "GET /api/me": () => json(401, { error: "unauthorized", message: "로그인이 필요합니다." }) });
    render(<App />);
    expect(await screen.findByRole("link", { name: "매니저 로그인" })).toBeTruthy();
    expect(screen.getByText("이 채널의 매니저가 아닙니다.")).toBeTruthy();
  });

  it("로그인했으면 탭과 후보 화면을 보여 준다", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    stubFetch({
      "GET /api/me": () => json(200, { channelId: "m1", channelName: "매니저1", role: "STREAMING_CHAT_MANAGER", permissions: ["disable_auto_hide", "hide_message", "temporary_restrict"] }),
      "GET /api/status": () => json(200, { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, lastChatAt: null, pendingActions: 0 }),
      "GET /api/candidates": () => json(200, []),
      "POST /api/ws-ticket": () => json(200, { ticket: "t1" }),
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: /실시간 채팅/ })).toBeTruthy();
    expect(await screen.findByText("정상 동작 중")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: FAIL — `Cannot find module '../src/App'`

- [ ] **Step 3: 구현**

`apps/web/index.html`:
```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#17171F" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icons/logo.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
    <title>찌리릿 가드</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

/** 서비스 워커를 등록한다(푸시 알림용). 실패해도 앱은 동작하므로 경고만 남긴다. */
function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch((error: unknown) => console.warn("서비스 워커 등록 실패(장애 알림을 받을 수 없습니다)", error));
}

registerServiceWorker();
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`apps/web/src/App.tsx`:
```tsx
import type { MeDto } from "@zzirit-guard/shared";
import { useEffect, useState } from "react";
import { ApiError, apiGet, describeApiError } from "./api/client";
import { LoginScreen } from "./screens/LoginScreen";
import { MainScreen } from "./screens/MainScreen";

/** 로그인 상태. signedOut의 message는 로그인 화면에 보여 줄 안내(세션 종료 이유 등)다. */
type MeState = { kind: "loading" } | { kind: "signedOut"; message: string | null } | { kind: "signedIn"; me: MeDto };

/** 주소의 loginError(서버 콜백이 넣은 로그인 실패 이유)를 읽는다. */
function readLoginError(search: string): string | null {
  return new URLSearchParams(search).get("loginError");
}

/** 최상위: 내 정보를 읽어 로그인 화면과 본 화면을 고른다. */
export function App() {
  const [meState, setMeState] = useState<MeState>({ kind: "loading" });
  useEffect(() => {
    apiGet<MeDto>("/api/me").then(
      (me) => setMeState({ kind: "signedIn", me }),
      (error: unknown) => setMeState({ kind: "signedOut", message: error instanceof ApiError && error.status === 401 ? null : describeApiError(error) }),
    );
  }, []);
  if (meState.kind === "loading") return <p className="splash">불러오는 중…</p>;
  if (meState.kind === "signedOut") return <LoginScreen loginError={readLoginError(window.location.search)} message={meState.message} />;
  return <MainScreen me={meState.me} onSignedOut={(message) => setMeState({ kind: "signedOut", message })} />;
}
```

`apps/web/src/screens/LoginScreen.tsx`:
```tsx
import { API_BASE } from "../api/client";
import { ApiNotice } from "../components/ApiNotice";

/** 로그인 화면. 매니저 로그인과 스트리머 채널 연결 두 길만 둔다. */
export function LoginScreen({ loginError, message }: { loginError: string | null; message: string | null }) {
  return (
    <main className="login">
      <img src="/icons/logo.svg" alt="" width={96} height={96} />
      <h1>찌리릿 가드</h1>
      <p>치지직 채팅 관리 보조 도구</p>
      {loginError && <p className="error" role="alert">{loginError}</p>}
      {message && <p className="hint">{message}</p>}
      <a className="button primary" href={`${API_BASE}/auth/login`}>매니저 로그인</a>
      <a className="button" href={`${API_BASE}/auth/connect`}>스트리머: 채널 연결</a>
      <ApiNotice />
    </main>
  );
}
```

`apps/web/src/components/TabBar.tsx`:
```tsx
/** 본 화면의 탭. */
export type Tab = "candidates" | "chat" | "settings";

/** 탭 이름. */
const TAB_LABELS: Record<Tab, string> = { candidates: "후보", chat: "실시간 채팅", settings: "기록·설정" };

/** 아래쪽 탭 막대. 후보 탭에는 처리할 건수를 붙인다. */
export function TabBar({ active, onChange, pendingCount }: { active: Tab; onChange(tab: Tab): void; pendingCount: number }) {
  return (
    <nav className="tab-bar">
      {(Object.keys(TAB_LABELS) as Tab[]).map((tab) => (
        <button key={tab} type="button" aria-pressed={tab === active} onClick={() => onChange(tab)}>
          {TAB_LABELS[tab]}
          {tab === "candidates" && pendingCount > 0 && <span className="badge">{pendingCount}</span>}
        </button>
      ))}
    </nav>
  );
}
```

`apps/web/src/state/useNow.ts`:
```ts
import { useEffect, useState } from "react";

/** intervalMs마다 갱신되는 현재 시각. 후보 10분 창을 화면이 스스로 넘기게 한다. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
```

`apps/web/src/state/useServerState.ts`:
```ts
import type { ServerStatus, VerdictDto } from "@zzirit-guard/shared";
import { useEffect, useReducer, type Dispatch } from "react";
import { apiGet, describeApiError } from "../api/client";
import { RealtimeConnection } from "../api/realtime";
import { initialServerState, serverReducer, type ServerAction, type ServerState } from "./serverReducer";

/** 처음 상태를 REST로 읽고, 이후 변화는 WebSocket으로 받는다. */
export function useServerState(): ServerState {
  const [state, dispatch] = useReducer(serverReducer, initialServerState);
  useEffect(() => {
    let cancelled = false;
    void loadInitial(dispatch, () => cancelled);
    const connection = new RealtimeConnection({
      onEvent: (event) => dispatch({ type: "event", event }),
      onConnectionChange: (connected) => dispatch({ type: "connection", connected }),
      onSessionEnded: (reason) => dispatch({ type: "event", event: { type: "session_ended", reason } }),
    });
    connection.start();
    return () => {
      cancelled = true;
      connection.stop();
    };
  }, []);
  return state;
}

/** 상태와 최근 후보를 함께 읽는다. 화면이 사라졌으면 결과를 버린다. */
async function loadInitial(dispatch: Dispatch<ServerAction>, isCancelled: () => boolean): Promise<void> {
  try {
    const [status, verdicts] = await Promise.all([apiGet<ServerStatus>("/api/status"), apiGet<VerdictDto[]>("/api/candidates")]);
    if (!isCancelled()) dispatch({ type: "loaded", status, verdicts });
  } catch (error) {
    if (!isCancelled()) dispatch({ type: "load_failed", message: describeApiError(error) });
  }
}
```

`apps/web/src/screens/MainScreen.tsx`:
```tsx
import type { MeDto } from "@zzirit-guard/shared";
import { useEffect, useMemo, useState } from "react";
import { apiSend } from "../api/client";
import { TabBar, type Tab } from "../components/TabBar";
import { buildSections } from "../domain/candidates";
import { useNow } from "../state/useNow";
import { useServerState } from "../state/useServerState";
import { CandidatesScreen, type CandidateActions } from "./CandidatesScreen";
import { LiveChatScreen } from "./LiveChatScreen";
import { SettingsScreen } from "./SettingsScreen";

/** 후보 시각 창을 다시 계산하는 간격(15초). */
const NOW_REFRESH_MS = 15_000;

/** 후보 화면 동작을 API로 채운다. 결과는 서버가 WebSocket으로 다시 알려 화면이 바뀐다. */
function createCandidateActions(): CandidateActions {
  return {
    hide: async (verdict) => void (await apiSend("POST", `/api/verdicts/${verdict.id}/hide`)),
    temporaryRestrict: async (group) =>
      void (await apiSend("POST", `/api/senders/${encodeURIComponent(group.senderChannelId)}/temporary-restrict`, { chatChannelId: group.chatChannelId, verdictId: group.verdicts[0]?.id ?? null })),
    ignore: async (verdict) => void (await apiSend("POST", `/api/verdicts/${verdict.id}/ignore`)),
    reportFalsePositive: async (verdict) => void (await apiSend("POST", `/api/verdicts/${verdict.id}/false-positive`)),
    setAutoHide: async (enabled) => void (await apiSend("POST", "/api/auto-hide", { enabled })),
  };
}

/** 로그인 뒤 본 화면: 탭 3개(스펙 6장). 세션이 끝나면 로그인 화면으로 돌아간다. */
export function MainScreen({ me, onSignedOut }: { me: MeDto; onSignedOut(message: string | null): void }) {
  const [tab, setTab] = useState<Tab>("candidates");
  const state = useServerState();
  const now = useNow(NOW_REFRESH_MS);
  const actions = useMemo(createCandidateActions, []);
  useEffect(() => {
    if (state.sessionEndedReason) onSignedOut(state.sessionEndedReason);
  }, [state.sessionEndedReason, onSignedOut]);
  const sections = buildSections(state.verdicts, now);
  const pendingCount = sections.care.length + sections.shadow.length + sections.candidates.length;
  return (
    <div className="app">
      {state.loadError && <p className="error" role="alert">{state.loadError}</p>}
      {tab === "candidates" && <CandidatesScreen me={me} status={state.status} verdicts={state.verdicts} now={now} realtimeConnected={state.realtimeConnected} actions={actions} />}
      {tab === "chat" && <LiveChatScreen lines={state.chatLines} />}
      {tab === "settings" && <SettingsScreen me={me} status={state.status} onSignedOut={onSignedOut} />}
      <TabBar active={tab} onChange={setTab} pendingCount={pendingCount} />
    </div>
  );
}
```

`apps/web/src/styles.css`:
```css
/* 모바일 우선 스타일. 어두운 바탕에 노란 강조(로고 색). */
:root {
  --background: #17171f;
  --surface: #23232e;
  --text: #f2f2f5;
  --muted: #a0a0b0;
  --accent: #ffd21f;
  --danger: #ff5c5c;
  --care: #6ec1ff;
  color-scheme: dark;
  font-family: system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif;
  background: var(--background);
  color: var(--text);
}
body { margin: 0; }
button, .button { min-height: 44px; padding: 0 14px; border-radius: 10px; border: 1px solid #3a3a48; background: var(--surface); color: var(--text); font-size: 15px; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
button:disabled { opacity: 0.4; }
.button.primary { background: var(--accent); color: #17171f; border-color: var(--accent); font-weight: 700; }
.danger { border-color: var(--danger); color: var(--danger); }
.app { padding: 12px 12px 76px; }
.screen { display: flex; flex-direction: column; gap: 12px; }
.banner { margin: 0; padding: 10px 12px; border-radius: 10px; list-style: none; }
.banner-ok { background: #1f3a2a; }
.banner-warning { background: #4a2a1a; }
.toggle-on { background: var(--accent); color: #17171f; font-weight: 700; }
.error { color: var(--danger); }
.hint, .notice, .empty { color: var(--muted); font-size: 13px; }
.card { background: var(--surface); border-radius: 12px; padding: 10px; }
.card-care { border-left: 4px solid var(--care); }
.card-shadow { border-left: 4px solid var(--accent); }
.card-header { display: flex; align-items: center; gap: 8px; }
.card-header .count { color: var(--muted); margin-right: auto; }
.messages { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.message { display: grid; grid-template-columns: auto 1fr; gap: 4px 8px; }
.message .buttons { grid-column: 1 / -1; display: flex; gap: 8px; }
.message .time { color: var(--muted); font-size: 12px; }
.content { overflow-wrap: anywhere; }
.chat-lines { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.chat-line { padding: 4px 6px; border-radius: 6px; }
.chat-candidate, .chat-shadow { background: #3a3220; }
.chat-auto_hide { background: #3a2020; text-decoration: line-through; }
.chat-needs_care { background: #1f2f3f; }
.chat-line .nickname { color: var(--muted); margin-right: 6px; }
.chat-line .tag { margin-left: 6px; font-size: 12px; color: var(--accent); }
.tab-bar { position: fixed; bottom: 0; left: 0; right: 0; display: grid; grid-template-columns: repeat(3, 1fr); background: var(--surface); padding-bottom: env(safe-area-inset-bottom); }
.tab-bar button { border: none; border-radius: 0; background: transparent; }
.tab-bar button[aria-pressed="true"] { color: var(--accent); font-weight: 700; }
.badge { margin-left: 6px; background: var(--danger); color: white; border-radius: 999px; padding: 0 6px; font-size: 12px; }
.login { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px 20px; text-align: center; }
.login .button { width: 100%; max-width: 320px; }
.rows div { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #2c2c38; }
.rows dt { color: var(--muted); }
.rows dd { margin: 0; }
.field, .rule-form label { display: flex; flex-direction: column; gap: 4px; margin: 6px 0; }
input, select { min-height: 40px; border-radius: 8px; border: 1px solid #3a3a48; background: #101018; color: var(--text); padding: 0 8px; font-size: 15px; }
.splash { padding: 48px; text-align: center; color: var(--muted); }
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: PASS (37 tests)

- [ ] **Step 5: 빌드 확인**

Run: `npm run build -w @zzirit-guard/web && ls apps/web/dist/index.html apps/web/dist/sw.js apps/web/dist/manifest.webmanifest`
Expected: 오류 없음, 세 파일 존재. `grep -c "<script>" apps/web/dist/index.html`이 0(인라인 스크립트 없음 — 서버 CSP와 맞음).

- [ ] **Step 6: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web
git commit -m "feat: PWA 앱 골격과 로그인·탭 화면 추가" -m "내 정보로 로그인 화면과 본 화면을 고르고, 본 화면은 후보·실시간 채팅·기록·설정 탭을 둔다. 처음 상태는 REST로, 변화는 WebSocket으로 받으며 세션이 끝나면 로그인 화면으로 돌아간다."
```

---

### Task 9: 운영 스크립트와 문서

**Files:**
- Create: `ops/launchd/com.zzirit-guard.server.plist.template`, `ops/scripts/install-launchd.sh`, `ops/newsyslog/zzirit-guard.conf`
- Create: `docs/operations/operator-guide.md`, `docs/operations/channel-notice-template.md`, `docs/operations/streamer-agreement-template.md`, `docs/operations/chzzk-inquiry-email.md`, `docs/operations/device-checklist.md`
- Modify: `README.md`(설치 안내 링크 추가)

**Interfaces:** 없음(문서·스크립트)

- [ ] **Step 1: launchd 템플릿과 설치 스크립트 작성**

`ops/launchd/com.zzirit-guard.server.plist.template`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- 찌리릿 가드 서버 LaunchAgent 템플릿. install-launchd.sh가 __표시__를 실제 경로로 바꿔 설치한다. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>com.zzirit-guard.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>__NODE__</string>
    <string>--env-file=__ENV_FILE__</string>
    <string>__REPO__/apps/server/dist/main.js</string>
  </array>
  <key>WorkingDirectory</key><string>__REPO__/apps/server</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>__LOG_DIR__/server.log</string>
  <key>StandardErrorPath</key><string>__LOG_DIR__/server.err.log</string>
</dict>
</plist>
```

`ops/scripts/install-launchd.sh`:
```sh
#!/bin/zsh
# 서버를 로그인 사용자 LaunchAgent로 설치(또는 갱신)하고 시작한다.
# 사용법: ops/scripts/install-launchd.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LABEL=com.zzirit-guard.server
DATA_DIR="$HOME/Library/Application Support/zzirit-guard"
ENV_FILE="$DATA_DIR/.env"
LOG_DIR="$HOME/Library/Logs/zzirit-guard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=$(command -v node)

if [[ ! -f "$ENV_FILE" ]]; then
  echo "환경 파일이 없습니다: $ENV_FILE — ops/env.example을 복사해 채운 뒤 chmod 600 하세요." >&2
  exit 1
fi
if [[ ! -f "$ROOT/apps/server/dist/main.js" ]]; then
  echo "서버 빌드가 없습니다. 먼저 npm run build -w @zzirit-guard/server 를 실행하세요." >&2
  exit 1
fi
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE|g" -e "s|__ENV_FILE__|$ENV_FILE|g" -e "s|__REPO__|$ROOT|g" -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$ROOT/ops/launchd/$LABEL.plist.template" > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || echo "이전에 실행 중인 서버가 없습니다(처음 설치)."
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "설치했습니다: $PLIST (node: $NODE)"
echo "상태 확인: launchctl print gui/$(id -u)/$LABEL | grep state"
echo "로그: tail -f \"$LOG_DIR/server.log\""
```

`ops/newsyslog/zzirit-guard.conf`:
```
# 찌리릿 가드 로그 회전(채팅 원문은 로그에 없다). 설치: sudo cp ops/newsyslog/zzirit-guard.conf /etc/newsyslog.d/
# 사용자 이름(<사용자>)을 실제 계정으로 바꿔 넣는다. 1MB마다, 7개 보관, 압축.
/Users/<사용자>/Library/Logs/zzirit-guard/server.log      <사용자>:staff  640  7  1024  *  JN
/Users/<사용자>/Library/Logs/zzirit-guard/server.err.log  <사용자>:staff  640  7  1024  *  JN
```

- [ ] **Step 2: 운영 안내서 작성**

`docs/operations/operator-guide.md`:
````markdown
# 찌리릿 가드 운영 안내서

맥 미니 한 대에 서버를 설치해 채널 1곳을 운영하는 절차다. 스펙: `docs/superpowers/specs/2026-10-11-zzirit-guard-design.md`.

## 1. 준비물
- macOS 맥 미니(전원 연결, **FileVault 켬**), Node.js 22.12 이상, git
- Tailscale 계정과 맥 미니 설치(Funnel 사용 가능해야 함)
- 치지직 개발자 센터 계정(운영자 본인 네이버 계정)

## 2. 치지직 개발자 앱 등록
1. https://developers.chzzk.naver.com 에서 애플리케이션을 만든다. **이름에 chzzk·치지직·naver·네이버를 넣을 수 없다**(예: "찌리릿 가드").
2. 로그인 리디렉션 URL: `https://<기기이름>.<tailnet>.ts.net/auth/callback` (Funnel 주소, 4장 참고)
3. API Scope: 유저 정보 조회, 채널 관리자 조회, 채팅 메시지 조회, 채팅 메시지 쓰기, 채팅 설정 조회, 채팅 설정 변경, 활동제한 조회, 활동제한 쓰기
4. 발급된 Client ID·Secret은 6장의 `.env`에만 적는다. **누구와도 공유하지 않는다**(약관 제7조②11호·③).
5. 90일 동안 API 사용이 없으면 앱이 삭제된다. 비시즌에도 한 달에 한 번은 서버를 켜 둔다.

## 3. 설치와 빌드
```bash
git clone https://github.com/<계정>/zzirit-guard.git ~/Developer/zzirit-guard
cd ~/Developer/zzirit-guard
npm ci
npm run build -w @zzirit-guard/server
npm run build -w @zzirit-guard/web
```

## 4. 외부 접속(Tailscale Funnel)
```bash
tailscale funnel --bg 8710
tailscale funnel status   # https://<기기이름>.<tailnet>.ts.net → 127.0.0.1:8710 확인
```
- 명령 형식은 Tailscale 버전에 따라 다를 수 있다. `tailscale funnel --help`로 확인한다.
- 이 주소를 2장의 리디렉션 URL과 6장의 `ZG_PUBLIC_ORIGIN`에 똑같이 쓴다.

## 5. 비밀값
```bash
ops/scripts/setup-keychain.sh                       # 토큰 암호화 키(키체인)
npx -w @zzirit-guard/server web-push generate-vapid-keys   # 푸시 알림 키
```

## 6. 환경 파일
```bash
mkdir -p ~/Library/Application\ Support/zzirit-guard
cp ops/env.example ~/Library/Application\ Support/zzirit-guard/.env
chmod 600 ~/Library/Application\ Support/zzirit-guard/.env
```
`.env`를 채운다: `ZG_PUBLIC_ORIGIN`(Funnel 주소), `ZG_CHANNEL_ID`(스트리머 채널 ID: 채널 주소 `chzzk.naver.com/<채널ID>`의 끝부분), Client ID·Secret, `ZG_DATA_DIR`, `ZG_WEB_DIST`(`<저장소>/apps/web/dist`), VAPID 키 3개.

## 7. 서버 시작과 잠자기 끄기
```bash
ops/scripts/install-launchd.sh
sudo pmset -a sleep 0 disksleep 0     # 방송 중 잠들지 않게
sudo pmset -a autorestart 1           # 정전 후 자동으로 켜지게
sudo cp ops/newsyslog/zzirit-guard.conf /etc/newsyslog.d/   # 파일 안의 <사용자>를 먼저 바꾼다
```
- 서버는 로그인한 사용자 세션에서 돈다(키체인을 읽어야 해서). 맥 미니에 자동 로그인을 켜 두거나, 재부팅 후 한 번 로그인한다.
- 재시작: `launchctl kickstart -k gui/$(id -u)/com.zzirit-guard.server`
- 로그: `~/Library/Logs/zzirit-guard/server.log`(채팅 원문은 남지 않는다)

## 8. 첫 연결(스트리머)
1. 스트리머와 **운영 합의서**(`streamer-agreement-template.md`)를 먼저 주고받는다.
2. 스트리머가 `https://<Funnel 주소>`에서 "스트리머: 채널 연결"을 누르고 치지직 동의 화면에서 허용한다.
3. 채널 공지에 `channel-notice-template.md`를 채워 올린다(개인정보보호법 제37조의2).

## 9. 매니저 안내
1. 치지직에서 채널 관리자 또는 채팅 운영자로 등록돼 있어야 한다.
2. 휴대폰으로 Funnel 주소 → "매니저 로그인".
3. iPhone: Safari 공유 → "홈 화면에 추가" 후 그 앱에서 "기록·설정 → 장애 알림 받기"(iOS 16.4 이상).

## 10. 방송 전 점검(기록·설정 → 상태 점검)
- 채널: 연결됨 / 치지직 채팅 연결: 연결됨 / 숨김·제재 가능: 가능 / 마지막 채팅 수신: 방금
- 하나라도 아니면 11장.

## 11. 장애 대응
| 증상 | 조치 |
|---|---|
| "숨김·제재 불가(재연결 필요)" | 스트리머가 "스트리머: 채널 연결"을 다시 한다 |
| 채팅 연결 끊김이 계속 | 로그 확인 → 서버 재시작(7장) |
| 화면이 안 열림 | `tailscale funnel status`, 서버 상태(`launchctl print …`) 확인 |
| 자동 숨김이 저절로 꺼짐 | 기록·설정 → 감사 기록에서 이유(1분 한도·호출 실패) 확인 후 규칙을 고친다 |

## 12. 백업과 복원
- 매일 `$ZG_DATA_DIR/backups/`에 최근 7개를 남긴다.
- 복원: 서버를 멈추고(`launchctl bootout gui/$(id -u)/com.zzirit-guard.server`) `zzirit-guard.sqlite`를 백업 파일로 바꾼 뒤 `install-launchd.sh`로 다시 시작한다. 같은 맥(같은 키체인 키)에서만 토큰을 읽을 수 있다.

## 13. 자동 숨김을 켜기 전에(로드맵 3단계)
- 섀도 판정 중 매니저가 동의(숨기기)한 비율이 95% 이상인 규칙부터 켠다(스펙 14장).
- 오판 신고가 나온 규칙은 예외 단어·허용어를 먼저 손본다.
````

- [ ] **Step 3: 공지·합의서·문의 메일·기기 점검표 작성**

`docs/operations/channel-notice-template.md`:
```markdown
# 채널 공지 문안(초안)

> 개인정보보호법 제37조의2 ④(자동화된 결정의 기준·절차 공개)를 위한 초안이다. 시행령이 정한 적용 범위는 아직 확인하지 않았다. 올리기 전에 [ ] 부분을 채운다.

**[채팅 관리 안내]**

이 채널은 채팅 관리를 돕는 도구 '찌리릿 가드'를 씁니다.

- **자동으로 숨기는 채팅**(자동 숨김을 켠 동안만): 채널이 정한 금칙어(혐오 표현·패드립 등), 여러 사람이 같은 문장을 반복하는 도배, 광고·외부 링크, 전화번호
- **매니저가 확인하는 채팅**: 일반 욕설, 짧은 시간의 반복 채팅, 협박·주소로 보이는 표현
- **제재(임시 제한·활동 제한)는 매니저가 직접 판단**합니다. 자동으로 제재하지 않습니다.
- 채팅은 외부 AI나 다른 회사로 보내지 않습니다. 문제로 판정된 채팅만 [30]일 보관한 뒤 지웁니다.
- 잘못 숨겨졌다고 생각하면 [이의 제기 경로: 예) 디스코드 #문의, 이메일 ___]로 알려 주세요. 숨겨진 채팅은 되돌릴 수 없지만, 기록을 바로잡고 제재가 있었다면 해제합니다.
```

`docs/operations/streamer-agreement-template.md`:
```markdown
# 운영 합의서(초안)

> 법률 검토 전 초안이다. 누가 개인정보처리자이고 누가 수탁자인지는 법률 검토를 받아 확정한다(스펙 9장).

- **당사자**: 스트리머 [채널명] / 운영자 [이름]
- **목적**: [채널명] 방송 채팅의 악플·도배 대응 보조(찌리릿 가드 운영)
- **처리하는 정보**: 방송 채팅(닉네임·채널 ID·내용·시각). 문제로 판정되지 않은 채팅은 저장하지 않는다.
- **처리 장소**: 운영자의 맥 미니(FileVault 암호화). 외부 AI·다른 회사로 보내지 않는다. 외부 접속은 Tailscale Funnel(중계 서버는 암호화된 트래픽만 전달)로 한다.
- **보관 기간**: 판정된 채팅 원문 [30]일, 원문 없는 조치 기록 [180]일. 기간이 지나면 자동 삭제.
- **토큰**: 스트리머 치지직 토큰은 암호화해 보관하고, 숨김·제재·채팅 설정 외의 용도로 쓰지 않는다.
- **제재 원칙**: 자동 숨김은 스트리머·채널 관리자가 켠 동안만, 제재는 사람만.
- **유료화 없음**: 치지직 약관 제7조②13호에 따라 대가를 받지 않는다.
- **종료**: 어느 쪽이든 알리면 종료한다. 종료 시 운영자는 채널 연결을 해제하고 DB·백업을 [7]일 안에 지운다.
- **연락처**: 스트리머 [ ] / 운영자 [ ]
```

`docs/operations/chzzk-inquiry-email.md`:
```markdown
# 치지직 문의 메일(초안)

- 받는 곳: 치지직 개발자 문의 창구(개발자 센터의 '치지직 제휴 문의' 안내를 따른다. 조사 당시 확인한 주소: dl_chzzk@navercorp.com)
- 제목: [문의] Open API를 이용한 채팅 관리 보조 도구(비공식·무료)의 약관 해석

안녕하세요. Open API로 스트리머·매니저용 채팅 관리 보조 도구 '찌리릿 가드'(비공식, 무료)를 만들고 있습니다. 다음을 여쭙습니다.

1. **오픈소스 공개**: Client ID·Secret·토큰은 공개하지 않고, 공개 문서의 API 경로를 호출하는 소스 코드만 공개하려 합니다. 약관 제7조②11호("API 등 정보"의 공개)에 해당하지 않는지요.
2. **API 사용 표시(제7조④)**: "회사가 지정하는 방식"이 따로 있는지요. 지금은 로그인·설정 화면에 "치지직 Open API를 사용하는 비공식 프로젝트"라고 텍스트로 표시합니다(로고 미사용).
3. **앱 이름**: '찌리릿 가드'가 제7조②14호(치지직으로 오인될 앱)나 개발자 센터 명칭 규정에 문제가 없는지요.
4. **판정 모델 학습(제8조)**: 수신한 채팅을 식별 정보(닉네임·채널 ID·시각)를 지우고 문장과 판정만 남겨, 운영자 PC에서 돌리는 판정 모델의 재학습에 써도 되는지요. 외부로는 보내지 않습니다.
5. **향후 유료화(제7조②13호)**: 나중에 다른 채널에 유료로 제공하려면 어떤 제휴 절차가 필요한지요.
6. **호출 한도**: 채팅 숨기기(blind-message)·임시 제한 API의 호출 한도 수치를 알 수 있을지요.
7. **세션 구독**: 이벤트 구독 API의 sessionKey는 쿼리 파라미터로 보내는 것이 맞는지요.

감사합니다.
[이름 / 연락처 / 개발자 센터 애플리케이션 이름]
```

`docs/operations/device-checklist.md`:
```markdown
# 실기기 점검표(스펙 13장)

iPhone(Safari, 홈 화면 앱)과 Android(Chrome) 각각에서 확인한다. 날짜·기기·결과를 적는다.

| 항목 | iPhone | Android |
|---|---|---|
| Funnel 주소 접속, 로그인 화면·로고 표시 | | |
| 매니저 로그인 → 후보 탭 표시 | | |
| 매니저가 아닌 계정 로그인 → 이유 문구 표시 | | |
| 상태 배너 "정상 동작 중" | | |
| 테스트 채팅(금칙어 약) → 후보에 사람 단위로 표시 | | |
| 숨기기 → 치지직 방송 화면에서 실제로 숨겨짐 | | |
| 임시 제한 → 치지직에서 실제로 제한됨 | | |
| 무시·오판 → 후보에서 사라짐, 감사 기록에 남음 | | |
| 자동 숨김 켜기 확인 창, 채팅 운영자는 켜기 비활성 | | |
| 실시간 채팅 탭: 위험한 것만 보기 | | |
| 규칙 추가·삭제(채널 관리자), 채팅 운영자는 목록만 | | |
| 저속 모드 변경이 치지직에 반영 | | |
| 홈 화면 추가 후 "장애 알림 받기" → 알림 수신 | | |
| 서버 재시작 중 화면 → 재연결 후 정상 | | |
| 치지직에서 매니저 해제 → 5분 안에 로그인 화면으로 | | |
```

- [ ] **Step 4: README에 안내 링크 추가**

`README.md`의 "## 운영하려는 분께(구현 후)" 제목을 "## 운영하려는 분께"로 바꾸고, 그 아래 목록 앞에 다음 줄을 넣는다:
```markdown
설치·운영 절차는 [운영 안내서](docs/operations/operator-guide.md)를 따른다.
```

- [ ] **Step 5: 스크립트 문법 확인**

Run: `chmod +x ops/scripts/install-launchd.sh && zsh -n ops/scripts/install-launchd.sh && plutil -lint <(sed 's/__[A-Z_]*__/x/g' ops/launchd/com.zzirit-guard.server.plist.template)`
Expected: 문법 오류 없음, `OK`

- [ ] **Step 6: 커밋**

```bash
git add ops docs/operations README.md
git commit -m "docs: 운영 안내서·launchd 설치·공지·합의서·문의 메일 초안 추가" -m "맥 미니 한 대로 채널 1곳을 운영하는 절차(앱 등록·Funnel·키체인·launchd·잠자기·백업)와 채널 공지(제37조의2)·운영 합의서·치지직 문의 메일 초안, 실기기 점검표를 둔다."
```

---

### Task 10: 전체 검사·실기기 확인·PR

- [ ] **Step 1: 전체 검사**

Run: `npm run check && npm run build -w @zzirit-guard/server && npm run build -w @zzirit-guard/web`
Expected: lint 0건, typecheck 통과, 서버·웹 테스트 전부 통과, 빌드 성공

- [ ] **Step 2: 실제 환경 확인(사람이 함께)**

운영 안내서 2~8장대로 맥 미니에 설치하고, 스트리머 계정으로 채널을 연결한 뒤 `docs/operations/device-checklist.md`를 채운다. 실패 항목은 이슈로 남기고 원인을 고친 뒤 다시 확인한다. 특히 다음 두 가지를 실연결로 확인하고 결과를 PR에 적는다.
- sessionKey 쿼리 전달로 채팅 구독이 되는지(가짜 서버는 쿼리로 가정)
- CHAT 페이로드가 객체로 오는지 문자열로 오는지(둘 다 처리하지만 실제 형식을 기록)

- [ ] **Step 3: 점검표 커밋과 PR**

```bash
git add docs/operations/device-checklist.md
git commit -m "docs: 1단계 실기기 점검 결과 기록" -m "iPhone·Android에서 로그인·후보 처리·숨김·제재·스위치·알림·재연결을 확인한 결과를 남긴다."
git push -u origin feature/stage1-web
gh pr create --base main --title "feat: 1단계-B PWA·운영" --body "$(cat <<'EOF'
## 요약
- 매니저 PWA: 후보(사람 단위·섀도·도움 필요)·실시간 채팅·기록/설정, 자동 숨김 스위치(켜기 확인), 푸시 알림
- 운영: launchd 설치 스크립트, Funnel·키체인·잠자기·백업 안내, 채널 공지·운영 합의서·치지직 문의 메일 초안

## 실기기 점검
docs/operations/device-checklist.md 참고

## 실연결로 확인한 치지직 동작
- sessionKey 전달 방식:
- CHAT 페이로드 형식:

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
