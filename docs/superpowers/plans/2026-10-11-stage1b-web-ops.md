# 찌리릿 가드 1단계-B(PWA·운영) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 매니저가 휴대폰 브라우저(PWA)로 후보 처리·자동 숨김 스위치·실시간 채팅·규칙/설정·감사 기록·오판 검토·푸시 알림을 쓰게 하고, 맥 미니 운영(launchd·Funnel·백업·공지·합의서)을 문서와 스크립트로 갖춘다. 그 앞에 1단계-A 서버에 남은 후속(로그인 한도·필터 품질·오판 목록 조회)을 끝낸다.

**Architecture:** React 19 + Vite 8 정적 빌드. 서버(1단계-A, main에 머지됨)가 같은 출처로 이 빌드를 제공한다. 화면은 REST로 상태를 읽고 WebSocket(티켓 인증)으로 갱신을 받으며, 실시간 연결이 (다시) 열릴 때마다 REST로 다시 읽어 병합한다. 상태 변경은 순수 리듀서로 처리해 테스트한다. 화면 컴포넌트는 동작(actions)을 props로 받아 API와 분리한다.

**Tech Stack:** React 19.3.0, Vite 8.3.4, @vitejs/plugin-react 6.1.2, TypeScript 6.0.3, Vitest 5.0.3 + jsdom 30.1.2 + @testing-library/react 16.3.3(+ @testing-library/dom 10.4.2, user-event 14.6.7). 서버 쪽(Task 0)은 1단계-A와 같다(Fastify 5.12.5, zod 4.6.5, better-sqlite3 13.0.3).

**Spec:** `docs/superpowers/specs/2026-10-11-zzirit-guard-design.md` (이 계획은 1단계 중 PWA와 운영 부분. 서버는 `2026-10-11-stage1a-server.md`로 만들어 main `edba314`에 머지됐다)

**개정(2026-10-12):** 초판을 1단계-A의 실제 코드(main `edba314`)와 사전 점검(`.superpowers/sdd/2026-10-11-stage1b-web-ops/preflight-scan.md`)·컨트롤러 판정 B1~B7(같은 폴더 `progress.md`, 둘 다 커밋하지 않는 로컬 작업 기록)에 맞췄다. 본문의 (R-n)은 사전 점검 권고 번호, (A·B·X n)은 점검 표의 행, (F·S n)은 1단계-A 기록의 판정 번호다. 모든 코드는 개정 때 저장소 사본(scratch)에서 lint·typecheck·테스트·빌드를 통과시켜 확인했다. 실제 저장소에는 아직 적용하지 않았다.

## Global Constraints

- 1단계-A의 Global Constraints를 따른다: Node 22.12 이상·TypeScript·ESM, 한국어 주석·문서화 주석, 영어 식별자, 빈 catch 금지, Conventional Commits(본문 한국어), 채팅 원문을 로그에 남기지 않음. 서버 코드의 import는 `.js` 확장자를 붙이고, 웹(`apps/web`)은 Bundler 해석이라 확장자 없이 쓴다.
- **브랜치:** `feature/stage1b-web-ops`(main `edba314`에서 분기, 이미 체크아웃됨, B1). 브랜치를 만들거나 바꾸지 않는다. **base는 main이다. push와 PR은 구현자가 하지 않고 컨트롤러가 마지막에 한다**(B6, 1단계-A R3 선례).
- 커밋 전에 `npm run lint && npm run typecheck`와 해당 워크스페이스 테스트를 통과시킨다. 커밋 메시지 끝에 `Co-Authored-By: <실제 모델 이름> <noreply@anthropic.com>`을 붙인다.
- **문서화 주석(R-23):** 모든 함수·컴포넌트·타입·인터페이스 필드·props·클래스 멤버(private 포함)·모듈 상수 위에 한국어 문서화 주석(역할과 이유)을 단다. 1단계-A 리뷰가 같은 항목을 Important로 돌려보냈다(R9·R31).
- **오류를 버리지 않는다(R-23):** catch에서 다른 오류로 바꿔 던질 때는 `{ cause }`로 원래 오류를 남기고, 삼킬 때는 `console.warn(이유, error)`로 남긴다. 사용자 문구와 개발자 기록을 나눈다.
- 채팅 텍스트는 **텍스트로만** 렌더링한다(`dangerouslySetInnerHTML` 금지). 서버 CSP가 인라인 스크립트를 막는다.
- 상태 변경 요청에는 `x-zzirit-request: 1` 헤더, 모든 요청에 `credentials: "include"`.
- API 주소 앞부분은 `import.meta.env.VITE_API_BASE`(기본 빈 문자열 = 같은 출처). 쿠키·토큰을 아는 코드는 `src/api/client.ts`와 `src/api/realtime.ts`에만 둔다(Cloudflare 전환 대비, 스펙 12장).
- **로그인 화면으로 돌아가는 오류:** 401과 409 `no_channel`(`requiresSignIn`, R-12). 채널이 없으면 `/api/status`·`/api/candidates`·`/api/ws-ticket`이 모두 409라, 본 화면에 남으면 배너가 멈추고 티켓 요청이 끝없이 되풀이된다.
- **실시간 연결:** 닫기 코드 4001(메시지 없이 와도)이면 로그인 화면으로. 4003이 3번 이어지면 멈추고 `/api/me`를 다시 확인한 뒤 이유를 보여 준다(R-6). 그 밖의 끊김은 1·2·4…30초 백오프로 재연결하고, 백오프는 **열린 뒤 첫 메시지를 받았을 때만** 처음으로 되돌린다(서버는 업그레이드 뒤에 티켓·출처를 확인한다). 연결이 (다시) 열릴 때마다 `/api/status`·`/api/candidates`를 다시 읽어 id로 병합한다(R-3).
- **서버 계약:** DTO는 `@zzirit-guard/shared` 타입을 쓰고 웹에 인터페이스를 복사하지 않는다(`MinuteStatDto`는 Task 0에서 추가, R-20). shared는 타입만 내보내 런타임 값을 옮길 수 없으므로, 웹에 복사한 서버 상수(설정 범위·저속 모드 값·후보 창·규칙 길이)에는 출처 파일을 주석으로 단다.
- 자동 숨김 **켜기**에는 확인을 받는다(숨긴 메시지는 되돌릴 수 없다). 끄기는 바로 한다. 서버 상태를 아직 모르면 스위치를 누를 수 없다.
- **영구 제한(활동 제한)과 그 해제는 화면을 만들지 않는다**(B4, 스펙 6장 후보 화면 버튼은 숨김·임시 제한·무시). 운영 안내서·공지·합의서에 "치지직 기본 도구로 한다"를 적는다. 서버 라우트(`/api/senders/:id/restrict`)는 그대로 둔다.
- 화면에 치지직 로고를 쓰지 않는다. 로그인·설정 화면에 "치지직 Open API 사용, 비공식" 표시(약관 제7조④·14호).
- 서비스 워커는 푸시 표시와 알림 클릭만 한다. 오프라인 캐시는 하지 않는다(옛 화면으로 잘못 조치하지 않도록).
- Vite 개발 서버에는 프록시를 두지 않는다(R-21): 로그인 콜백 주소·Secure 쿠키·Origin 검사 때문에 `localhost:5173`에서는 로그인·조치·실시간이 모두 거절된다. 실제 동작은 서버가 제공하는 빌드로 확인한다.
- **테스트 픽스처 위생(R-10):** 1B 웹 테스트는 혐오 표현을 쓰지 않고 중립 자리표시자(예: `금칙어예시`)를 쓴다. Task 0의 서버 탐지 테스트는 필터가 실제 단어를 다루므로 기존 서버 테스트 관례대로 실제 단어를 쓴다.
- **공개 저장소 위생(B6, 스펙 17장):** 파트너 채널명·시청자 규모·실제 닉네임·채팅 원문, 실제 로컬 경로를 문서·커밋·PR에 쓰지 않는다. 경로는 `/Users/<사용자>/`, `<설치 경로>` 같은 자리표시자만 쓴다.
- **설치 메모:** jsdom 30.1.2가 의존하는 패키지가 engines에 Node `^22.22.2`를 적어, Node 22.20에서는 npm이 `EBADENGINE` 경고를 낸다. 테스트 전용 의존성이고 22.20에서 테스트가 통과함을 확인했다. 버전은 바꾸지 않는다.

## Review Focus

- **몰려드는 채팅으로 화면이 멈춤**(초당 수십 건 + 휴대폰 성능): 채팅 줄은 최대 300개, 판정은 후보 창(10분)+1분만 메모리에 남긴다(R-11) → Task 2에 테스트.
- **오래 열어 둔 화면**(세션 만료·역할 해제·채널 연결 해제·서버 재시작): 4001(메시지 없이도)·티켓 401·409 `no_channel`이면 로그인으로, 4003이 이어지면 멈춤, 그 밖에는 백오프 재연결 → Task 3·8에 테스트.
- **화면이 꺼졌다 켜짐**(휴대폰은 화면이 꺼질 때마다 WebSocket이 끊긴다): 다시 열릴 때 후보를 다시 읽어 병합하고, 조회 중에 온 이벤트를 결과 위에 다시 적용한다(R-3·X1) → Task 2·8에 테스트.
- **권한 없는 버튼**(채팅 운영자가 켜기·규칙 수정을 누름): 보이되 비활성, 서버 403 문구도 그대로 보여 준다 → Task 4·7에 테스트.
- **실패한 조치가 조용히 사라짐**(치지직 429·쓰기 잠금·이미 처리됨·자동 숨김 취소): 서버 이유와 `note`를 화면에 남기고, 409 `already_handled`면 다시 읽고, 숨기지 못한 자동 숨김은 "숨김 대기·실패"에 숨기기 버튼과 함께 둔다(R-4·R-13) → Task 4에 테스트.
- **iPhone에서 알림 미지원·멈춤**(홈 화면에 추가하지 않음·iOS 16.4 미만·서비스 워커 등록 실패): 이유를 알려 주고 준비 대기에 시간 제한을 둔다. 로그아웃하면 그 기기의 구독을 해지한다(R-14) → Task 6·7에 테스트.
- **필터 우회와 가림**(서버): 좁은 공백류·한글 방점으로 금칙어 강을 피함, 예외 단어가 바깥 금칙어까지 가림("시발택시발"·"개새끼손가락") → Task 0에 테스트.
- **로그인 경로 남용**(서버): 한도 초과가 JSON 원문으로 보임, 가짜 콜백이 한도를 비움, HEAD 콜백이 state를 쓰고 토큰 교환까지 함, 인코딩한 경로 → Task 0에 테스트.

---

## 파일 구조

```
apps/server/                     (Task 0에서 수정)
  src/http/server.ts             /auth 한도 3단(전역·시작·콜백), 한도 초과는 loginError 리다이렉트, HEAD 없음
  src/http/routes.ts             GET /api/false-positives
  src/detection/normalize.ts     좁은 공백류·한글 방점·아래아 처리
  src/detection/wordMatch.ts     예외 단어를 지우지 않고 위치로 판정
  src/detection/pipeline.ts      위 판정 함수 사용
  src/records/verdictRepository.ts  오판 목록·이유별 건수
  src/records/minuteStats.ts     recent()가 MinuteStatDto[]를 돌려줌
packages/shared/src/index.ts     MinuteStatDto·FalsePositiveReasonCountDto·FalsePositiveReviewDto 추가
apps/web/
  package.json  tsconfig.json  vite.config.ts  index.html
  public/manifest.webmanifest  public/sw.js  public/icons/(logo.svg, icon-192.png, icon-512.png, apple-touch-icon.png)
  src/vite-env.d.ts                VITE_API_BASE 타입
  src/main.tsx                     진입점·서비스 워커 등록
  src/App.tsx                      로그인 여부 분기
  src/styles.css                   모바일 우선 스타일
  src/api/client.ts                REST 호출·ApiError·오류 문구·requiresSignIn
  src/api/realtime.ts              WebSocket 연결·재연결·거절 처리
  src/api/useApiResource.ts        조회용 훅(주기 조회 선택)
  src/domain/candidates.ts         후보 묶기·판정 목록 병합·정리(순수 함수)
  src/domain/verdictReason.ts      판정 이유 문구(규칙 번호)
  src/domain/timeFormat.ts         시각 표시
  src/domain/ruleKinds.ts          규칙 종류 이름
  src/state/serverReducer.ts       서버 상태 리듀서(순수 함수)
  src/state/useServerState.ts      조회 + 실시간 연결 훅
  src/state/useNow.ts              주기적 현재 시각
  src/push/pushSubscription.ts     푸시 구독·해지
  src/components/ApiNotice.tsx  StatusBanner.tsx  AutoHideToggle.tsx  CandidateGroupCard.tsx  AutoHideLists.tsx  TabBar.tsx
  src/screens/LoginScreen.tsx  MainScreen.tsx  CandidatesScreen.tsx  LiveChatScreen.tsx  SettingsScreen.tsx
  src/settings/StatusSection.tsx  StatsSection.tsx  FalsePositiveSection.tsx  RulesSection.tsx  LimitsSection.tsx  ChatSettingsSection.tsx  AuditSection.tsx  AccountSection.tsx
  test/**/*.test.ts(x)  test/helpers/stubFetch.ts
ops/launchd/com.zzirit-guard.server.plist.template
ops/scripts/install-launchd.sh  ops/scripts/render-icons.sh
docs/operations/operator-guide.md  channel-notice-template.md  streamer-agreement-template.md  chzzk-inquiry-email.md  device-checklist.md
README.md                          (상태·운영 안내 링크)
```

로그 회전 설정(newsyslog)은 두지 않는다. launchd가 로그 파일을 한 번만 열어 회전하면 로그가 사라지기 때문이다(R-17, 운영 안내서 8장).

테스트 개수 누계: 서버 375 → 412(Task 0). 웹 7 → 21 → 33 → 53 → 55 → 61 → 69 → 73(Task 1~8).

---
### Task 0: 서버 후속(로그인 한도·필터 품질·오판 목록)

1단계-A 최종 검토에서 보류한 항목과 1B가 기대는 서버 동작을 먼저 고친다(판정 B3 (a)~(g), B5, R-8·R-16·R-20). 서버 테스트만 바뀌고 웹은 아직 없다.

**Files:**
- Modify: `apps/server/src/http/server.ts`, `apps/server/test/http/server.test.ts` (Step 2~6: 로그인 경로 한도)
- Modify: `apps/server/src/detection/normalize.ts`, `apps/server/test/detection/normalize.test.ts`, `apps/server/test/detection/pipeline.test.ts` (Step 7~11: 좁은 공백류·한글 방점)
- Modify: `apps/server/src/detection/wordMatch.ts`, `apps/server/src/detection/pipeline.ts`, `apps/server/test/detection/wordMatch.test.ts`, `apps/server/test/detection/pipeline.test.ts` (Step 12~16: 예외 단어 가림)
- Modify: `packages/shared/src/index.ts`, `apps/server/src/records/verdictRepository.ts`, `apps/server/src/records/minuteStats.ts`, `apps/server/src/http/routes.ts`, `apps/server/test/records/records.test.ts`, `apps/server/test/http/server.test.ts` (Step 17~21: 오판 목록·통계 DTO)

**Interfaces:**
- Produces(shared): `MinuteStatDto`(snake_case 11개 필드: minute·received·skipped·deduplicated·stage1_forwarded·stage2_done·stage2_dropped·candidates·auto_hidden·shadow·invalid_events), `FalsePositiveReasonCountDto { reason: string; count: number }`, `FalsePositiveReviewDto { recent: VerdictDto[]; byReason: FalsePositiveReasonCountDto[] }`
- Produces(HTTP): `GET /api/false-positives?limit=1~200(기본 50)` → `FalsePositiveReviewDto`. 로그인한 매니저면 역할과 관계없이 본다(`guarded(null)`, 다른 조회 라우트와 같다). 범위를 벗어난 limit은 400 `invalid_input`.
- Produces(HTTP 동작): `/auth/connect`·`/auth/login`·`/auth/callback`은 한도를 넘으면 302 `/?loginError=요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.`(JSON 429 아님). 한도는 모든 /auth 120회/분 → 로그인 시작(connect·login 합산) 30회/분 → state 쿠키 확인을 통과한 콜백 60회/분 순서. 버킷은 원본 URL이 아니라 라우트(`request.routeOptions.url`)로 고른다. /auth 경로는 HEAD 라우트를 만들지 않는다(HEAD는 404).
- Produces(server): `VerdictRepository.listFalsePositives(channelId, limit): VerdictDto[]`, `VerdictRepository.countFalsePositivesByReason(channelId): FalsePositiveReasonCountDto[]`, `MinuteStats.recent(channelId, sinceMs): MinuteStatDto[]`; `wordMatch`의 `TextSpan`, `ExceptionAwareText`, `locateExceptions(normalizedText, exceptions)`, `locateExceptionsKeepingWhitespace(spacedText, exceptions)`, `findFirstMatch(target: ExceptionAwareText, entries)`, `findFirstIntactMatch(target: ExceptionAwareText, entries)`. `stripExceptions`·`stripExceptionsKeepingWhitespace`는 없앤다(쓰는 곳은 pipeline.ts와 wordMatch 테스트뿐이다).

- [ ] **Step 1: 브랜치와 기준 확인**

Run: `git branch --show-current && npm test -w @zzirit-guard/server 2>&1 | tail -4`
Expected: `feature/stage1b-web-ops`, `Tests  375 passed (375)`. 브랜치는 만들지 않는다(B1).

#### 로그인 경로 한도(B3 (a)(b)(g), R-8)

지금은 세 경로가 전역 버킷 하나(30회/분)를 함께 쓰고, 넘으면 429 JSON을 준다. 최상위 이동이라 사용자에게 JSON 원문이 보이고, 쿠키 없는 가짜 콜백만으로 버킷을 비워 정상 로그인을 막을 수 있다(S3). 또 Fastify가 GET마다 HEAD 라우트를 자동으로 만들어, `HEAD /auth/callback`이 state 쿠키를 지우고 토큰 교환(`authFlow.complete`)까지 한다(g, 재현함).

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/server/test/http/server.test.ts` 맨 위 import에 한 줄을 더한다(`toSocketSink` import 바로 아래):
```ts
import { AuthError } from "../../src/managers/authFlow.js";
```

같은 파일의 `describe("인증 경로 요청 한도(F6)", …)` 블록 전체(지금 173~197줄, `describe("WebSocket"` 바로 앞까지)를 다음으로 바꾼다:
```ts
describe("인증 경로 요청 한도(F6·S3·g)", () => {
  /** 한도를 넘었을 때 첫 화면으로 보내는 주소(디코딩한 값). */
  const RATE_LIMITED_LOCATION = "/?loginError=요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.";
  /** complete가 던지는 AuthError가 만드는 주소(디코딩한 값). 토큰 교환까지 갔다는 표시다. */
  const NOT_MANAGER_LOCATION = "/?loginError=이 채널의 매니저가 아닙니다.";

  /** 리다이렉트 주소를 사람이 읽는 형태로 바꾼다. */
  function locationOf(response: { headers: Record<string, unknown> }): string {
    return decodeURIComponent(String(response.headers.location));
  }

  /** 시계를 직접 움직이는 하네스로 바꾼다. complete는 매니저가 아니라는 AuthError를 던지고 호출 횟수를 센다. */
  async function useControlledClock() {
    await harness.close();
    const clock = { now: 1_000_000 };
    const complete = vi.fn(async () => {
      throw new AuthError("이 채널의 매니저가 아닙니다.");
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
    return send("/auth/callback?code=c&state=s", "GET", "zg_oauth_state=s");
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

  it("인코딩한 경로로 들어와도 같은 라우트의 한도를 쓴다(g)", async () => {
    await useControlledClock();
    for (let index = 0; index < 30; index += 1) await send(index % 2 === 0 ? "/auth/%6Cogin" : "/auth/./login");
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
    for (let index = 0; index < 100; index += 1) expect(locationOf(await send("/auth/callback?code=c&state=s"))).toMatch(/로그인 요청이 만료되었거나/);
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

  it("모든 /auth 요청은 합쳐 1분에 120번까지만 받는다(값싼 바깥 상한, g)", async () => {
    const { complete } = await useControlledClock();
    for (let index = 0; index < 120; index += 1) await send("/auth/callback?code=c&state=wrong", "GET", "zg_oauth_state=s");
    expect(locationOf(await validCallback())).toBe(RATE_LIMITED_LOCATION);
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
```

- [ ] **Step 3: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- test/http/server.test.ts`
Expected: FAIL 8개. 한도 초과가 429라 `location`이 없고(`expected 'undefined' to be '/?loginError=요청이 너무 많습니다…'`), HEAD가 302를 준다(`expected 302 to be 404`). "라우트와 맞지 않는 변형" 1개는 지금도 통과한다(회귀 방지용).

- [ ] **Step 4: 구현**

`apps/server/src/http/server.ts`:
1. import에 한 줄을 더한다(`import type { RealtimeHub, SocketSink } from "../realtime/hub.js";` 바로 아래):
```ts
import type { Clock } from "../time.js";
```
2. `/** * /auth/* 전체가 1분에 받을 요청 수(30). …` 주석부터 `completeLogin` 함수 끝까지(지금 88~155줄, `/** 로그인 성공 시 이전 세션을 지우고 그 소켓을 닫는다(세션 고정 방지). */` 바로 앞까지)를 다음으로 바꾼다. `rotateExistingSession` 이후는 그대로 둔다.
```ts
/**
 * 모든 /auth 요청이 합쳐서 1분에 받을 상한(120). state 확인 전에 세는 값싼 바깥 한도다.
 * 왜: state가 틀린 쓰레기 콜백은 콜백 한도를 쓰지 않으므로(S3), 이것이 없으면 그런 요청이 끝없이 서버를 돌릴 수 있다.
 * 주의: 이 상한을 쓰레기 요청으로 비우면 그 1분 동안 정상 로그인도 막힌다(가용성). 정상 사용(사람이 가끔 누름)보다 훨씬 크게 잡았다.
 */
const AUTH_GLOBAL_LIMIT_PER_MINUTE = 120;
/**
 * 로그인 시작(/auth/connect·/auth/login)이 합쳐서 1분에 받을 요청 수(30). 사람이 가끔 누르는 것이라 넉넉하다.
 * 왜: 시작마다 state를 메모리에 만들므로, 한도가 없으면 반복 호출로 정상 사용자의 state를 밀어낼 수 있다(F6, R20).
 */
const AUTH_START_LIMIT_PER_MINUTE = 30;
/**
 * 콜백이 1분에 치지직 토큰 교환까지 갈 수 있는 횟수(60). state 쿠키 확인을 통과한 요청만 센다.
 * 왜 따로 세나: 시작과 한 버킷을 쓰면 쿠키 없는 가짜 콜백만으로 버킷을 비워 정상 로그인을 막을 수 있다(S3).
 * 왜 시작보다 크게 두나: 인증 화면에서 뒤로 갔다가 다시 오는 경우 등 정상 재시도를 넉넉히 받으려는 것이다.
 */
const AUTH_CALLBACK_LIMIT_PER_MINUTE = 60;
/** 한도를 다시 채우는 기준 시간(1분). 이 시간 동안 한도만큼 연속으로 채워진다. */
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
/** 한도를 넘었을 때의 안내 문구. */
const RATE_LIMITED_MESSAGE = "요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.";
/**
 * 로그인 시작 한도를 쓰는 라우트 주소. 원본 URL이 아니라 Fastify가 맞춘 라우트 주소(request.routeOptions.url)로 비교한다.
 * 왜: "/auth/%6Cogin"·"/auth/./login"처럼 모양이 달라도 같은 라우트로 들어오는 요청이 같은 버킷을 쓰게 하려는 것이다.
 */
const AUTH_START_ROUTES: ReadonlySet<string> = new Set(["/auth/connect", "/auth/login"]);

/** 인증 경로의 요청 한도 묶음. */
interface AuthLimiters {
  /** 모든 /auth 요청의 바깥 상한. */
  global: TokenBucket;
  /** 로그인 시작(state 발급) 한도. */
  start: TokenBucket;
  /** state 확인을 통과한 콜백(토큰 교환) 한도. */
  callback: TokenBucket;
}

/**
 * 치지직 OAuth 시작·콜백. 바깥 상한 → 시작 한도(시작 두 경로) → state 확인 → 콜백 한도 순서로 거른다.
 * 왜 IP별이 아니라 전역인가: Tailscale Funnel 뒤에서는 모든 요청이 127.0.0.1에서 온 것처럼 보여 IP로 나눌 수 없다.
 * 왜 exposeHeadRoute: false인가: Fastify는 GET마다 HEAD 라우트를 자동으로 만들어 같은 핸들러를 돌린다. 그러면 HEAD 콜백이
 * state를 쓰고 토큰 교환까지 해 버린다. /auth는 브라우저 이동만 받으므로 HEAD를 열지 않는다(g).
 */
function registerAuthRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const limiters = createAuthLimiters(deps.services.clock);
  const options = { exposeHeadRoute: false, onRequest: async (request: FastifyRequest, reply: FastifyReply) => rejectOverAuthLimit(limiters, request, reply) };
  app.get("/auth/connect", options, async (_request, reply) => startAuthorization(deps, reply, "connect"));
  app.get("/auth/login", options, async (_request, reply) => startAuthorization(deps, reply, "login"));
  app.get(CALLBACK_PATH, options, async (request, reply) => completeLogin(deps, limiters.callback, request, reply));
}

/**
 * 인증 경로 한도 세 개를 만든다.
 * @param clock 현재 시각(테스트에서 시간을 흘려보내려고 주입한다)
 */
function createAuthLimiters(clock: Clock): AuthLimiters {
  const bucket = (perMinute: number) => createTokenBucket({ capacity: perMinute, refillPerMs: perMinute / AUTH_RATE_LIMIT_WINDOW_MS, clock });
  return { global: bucket(AUTH_GLOBAL_LIMIT_PER_MINUTE), start: bucket(AUTH_START_LIMIT_PER_MINUTE), callback: bucket(AUTH_CALLBACK_LIMIT_PER_MINUTE) };
}

/**
 * 바깥 상한과(시작 경로면) 시작 한도를 확인하고, 넘었으면 이유와 함께 첫 화면으로 보내 핸들러까지 가지 않게 한다.
 * @param limiters 인증 경로 한도
 * @param request 요청(라우트 주소로 시작 경로인지 본다)
 * @param reply 응답
 * @returns 거절했으면 보낸 응답, 통과면 undefined
 */
async function rejectOverAuthLimit(limiters: AuthLimiters, request: FastifyRequest, reply: FastifyReply) {
  if (!limiters.global.tryTake()) return redirectWithLoginError(reply, RATE_LIMITED_MESSAGE);
  if (AUTH_START_ROUTES.has(request.routeOptions.url ?? "") && !limiters.start.tryTake()) return redirectWithLoginError(reply, RATE_LIMITED_MESSAGE);
}

/**
 * 이유를 쿼리에 담아 첫 화면으로 보낸다. 화면(LoginScreen)이 loginError를 읽어 보여 준다.
 * 왜 JSON 오류가 아닌가: /auth/*는 브라우저가 최상위로 여는 주소라, JSON을 보내면 사용자에게 원문이 그대로 보인다(R-8).
 * @param reply 응답
 * @param message 사용자에게 보여 줄 이유
 */
function redirectWithLoginError(reply: FastifyReply, message: string) {
  return reply.redirect(`/?loginError=${encodeURIComponent(message)}`);
}

/** state 쿠키 수명(10분). 인증 페이지에서 머무는 시간보다 넉넉하다. */
const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 600;
/** state 쿠키 범위. 인증 경로에서만 보낸다. */
const OAUTH_STATE_COOKIE_PATH = "/auth";
/** state 쿠키가 없거나 다를 때의 안내 문구. */
const STATE_MISMATCH_MESSAGE = "로그인 요청이 만료되었거나 다른 브라우저에서 시작되었습니다. 처음부터 다시 시도하세요.";
/** 콜백에 code·state가 없을 때의 안내 문구. */
const MISSING_CALLBACK_VALUES_MESSAGE = "치지직에서 돌아온 값이 없습니다. 다시 시도하세요.";

/** 인증 URL의 state를 이 브라우저의 쿠키에 묶고 치지직으로 보낸다(로그인 CSRF 방지). */
function startAuthorization(deps: HttpDeps, reply: FastifyReply, purpose: "connect" | "login") {
  const url = deps.authFlow.authorizeUrl(purpose);
  const state = new URL(url).searchParams.get("state");
  if (state) reply.setCookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: "lax", path: OAUTH_STATE_COOKIE_PATH, maxAge: OAUTH_STATE_COOKIE_MAX_AGE_SECONDS });
  return reply.redirect(url);
}

/**
 * 콜백 처리: state 확인 → 콜백 한도 → 토큰 교환. 실패하면 이유를 쿼리에 담아 첫 화면으로 보낸다.
 * 왜 state 확인 뒤에 콜백 한도를 세나: 확인 전에 세면 쿠키 없는 가짜 콜백만으로 버킷을 비워 정상 로그인을 막을 수 있다(S3).
 */
async function completeLogin(deps: HttpDeps, callbackBucket: TokenBucket, request: FastifyRequest, reply: FastifyReply) {
  const verified = verifyCallbackState(request, reply);
  if (typeof verified === "string") return redirectWithLoginError(reply, verified);
  if (!callbackBucket.tryTake()) return redirectWithLoginError(reply, RATE_LIMITED_MESSAGE);
  return exchangeCodeForSession(deps, request, reply, verified);
}

/**
 * 콜백 쿼리와 state 쿠키를 확인한다. 쿼리가 있으면 쿠키는 결과와 관계없이 지운다(일회용).
 * @returns 통과하면 code·state, 아니면 사용자에게 보여 줄 이유
 */
function verifyCallbackState(request: FastifyRequest, reply: FastifyReply): { code: string; state: string } | string {
  const query = callbackQuerySchema.safeParse(request.query);
  if (!query.success) return MISSING_CALLBACK_VALUES_MESSAGE;
  const boundState = request.cookies[OAUTH_STATE_COOKIE];
  reply.clearCookie(OAUTH_STATE_COOKIE, { path: OAUTH_STATE_COOKIE_PATH });
  return boundState && boundState === query.data.state ? query.data : STATE_MISMATCH_MESSAGE;
}

/** code를 토큰으로 바꿔 세션을 만든다. 성공하면 세션 쿠키를 주고 첫 화면으로, 실패하면 이유를 담아 첫 화면으로 보낸다. */
async function exchangeCodeForSession(deps: HttpDeps, request: FastifyRequest, reply: FastifyReply, callback: { code: string; state: string }) {
  try {
    const { rawId } = await deps.authFlow.complete(callback.code, callback.state);
    rotateExistingSession(deps, request);
    reply.setCookie(SESSION_COOKIE, rawId, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_MS / 1000 });
    return reply.redirect("/");
  } catch (error) {
    if (!(error instanceof AuthError)) deps.logger.error("로그인 처리 실패", { error: describeError(error) });
    const message = error instanceof AuthError ? error.message : "로그인 중 오류가 발생했습니다. 잠시 뒤 다시 시도하세요.";
    return redirectWithLoginError(reply, message);
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -w @zzirit-guard/server`
Expected: PASS (382 tests)

- [ ] **Step 6: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/http/server.ts apps/server/test/http/server.test.ts
git commit -m "fix: 로그인 경로 한도를 나누고 초과·HEAD 요청을 정리" -m "한도를 넘으면 JSON 대신 첫 화면에 이유를 보내고, 모든 /auth 120회·로그인 시작 30회·state 확인을 통과한 콜백 60회로 나눠 가짜 콜백이 정상 로그인을 막지 못하게 한다. 버킷은 라우트로 고르고, HEAD 요청이 state를 쓰고 토큰 교환을 하지 않게 /auth의 자동 HEAD 라우트를 끈다."
```

#### 좁은 공백류·한글 방점(B3 (c)(e))

좁은 공백류(U+1680, U+2006~U+200A, U+2028, U+2029, U+202F, U+205F)는 `\s`라서 공백 유지 형태에서 공백 한 칸이 된다. 화면에서는 거의 붙어 보이는데 금칙어 강이 "단어를 걸친 일치"로 보여 자동 숨김이 후보로 낮아진다(S2). 한글 방점(U+302E·U+302F)과 아래아(ㆍ, U+318D)는 Script=Hangul이라 두 형태 모두에 남아 금칙어 비교를 통째로 피한다.

- [ ] **Step 7: 실패하는 테스트 작성**

`apps/server/test/detection/normalize.test.ts`의 `describe("normalizeForMatching")` 표에서 `["반각 채움 문자도 지운다", "시ﾠ발", "시발"],` 줄 바로 아래에 세 줄을 더한다:
```ts
    ["한글 방점(U+302E)을 지운다", "씨〮발", "씨발"],
    ["한글 겹방점(U+302F)을 지운다", "시〯발", "시발"],
    ["아래아(ㆍ, U+318D)를 지운다", "병ㆍ신", "병신"],
```

같은 파일의 `describe("normalizeKeepingWhitespace")` 표에서 `["나머지 단계는 normalizeForMatching과 같다", …],` 줄 바로 아래에 두 줄을 더한다:
```ts
    ["좁은 공백류는 공백으로 남기지 않고 붙인다(S2)", "김 치 녀 같 은 말 이 다 요 진짜", "김치녀같은말이다요 진짜"],
    ["한글 방점·아래아도 지운다", "김ㆍ치〮녀 같〯은", "김치녀 같은"],
```

`apps/server/test/detection/pipeline.test.ts`의 `it("개인 도배는 다섯 번째부터 후보", …)` 바로 앞에 넣는다(기본 규칙의 금칙어 강 "김치녀"를 쓴다):
```ts
  it.each([
    ["U+2006", " "], ["U+2009", " "], ["U+200A", " "], ["U+202F", " "], ["U+205F", " "], ["U+1680", " "], ["U+2028", " "], ["U+2029", " "],
  ])("좁은 공백(%s)을 끼운 금칙어 강도 후보로 낮추지 않고 자동 숨김이다(S2)", (_name, space) => {
    expect(pipeline.evaluate(chat(`김치${space}녀 진짜`))).toMatchObject({ decision: "auto_hide", reason: expect.stringMatching(/^rule:strong:\d+$/) });
  });

  it.each([["U+302E", "〮"], ["U+302F", "〯"], ["U+318D", "ㆍ"]])("한글 방점·아래아(%s)를 끼워도 금칙어 강을 피하지 못한다", (_name, mark) => {
    expect(pipeline.evaluate(chat(`김치${mark}녀`))).toMatchObject({ decision: "auto_hide", reason: expect.stringMatching(/^rule:strong:\d+$/) });
  });

```

- [ ] **Step 8: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- test/detection`
Expected: FAIL 16개(정규화 5개: 예 `Expected: "씨발" Received: "씨〮발"`, `Received: "김 치 녀 같 은 말 이 다 요 진짜"`, 파이프라인 11개: 좁은 공백은 `candidate rule:strong_spanning`, 방점은 `pass`).

- [ ] **Step 9: 구현**

`apps/server/src/detection/normalize.ts` 전체를 다음으로 바꾼다(바뀐 곳: `HANGUL_DOT_MARKS`·`NARROW_SPACES` 상수, `prepareForMatching`, 두 정규화 함수의 앞 단계):
```ts
/**
 * 글자 사이에 끼워 필터를 피하는 데 쓰는 보이지 않는 문자를 지운다.
 * 제로폭·서식 문자(U+00AD, U+200B~U+200F, U+2060~U+2064, U+FEFF)와 한글 채움 문자(U+115F, U+1160, U+3164)·반각 채움 문자(U+FFA0)를 포함한다.
 * 한글 채움 문자는 Script=Hangul이라 아래 DISALLOWED_CHARACTERS에서 남으므로 여기서 먼저 지워야 한다.
 */
const INVISIBLE_CHARACTERS = /[\u00AD\u115F\u1160\u200B-\u200F\u2060-\u2064\u3164\uFEFF\uFFA0]/g;
/** 전각 ASCII 영역(！~～). 반각으로 바꾼다. */
const FULLWIDTH_ASCII = /[！-～]/g;
/** 남길 문자: 한글(음절·자모), 영문 소문자, 숫자, 그리고 모음 대용으로 쓰는 '|'. */
const DISALLOWED_CHARACTERS = /[^\p{Script=Hangul}a-z0-9|]/gu;
/** normalizeKeepingWhitespace용: DISALLOWED_CHARACTERS와 같되 공백 문자(\s)도 남긴다. 단어 경계를 보존하려는 것이다. */
const DISALLOWED_CHARACTERS_EXCEPT_WHITESPACE = /[^\p{Script=Hangul}a-z0-9|\s]/gu;
/** 연이은 공백 문자(줄바꿈·전각 공백 포함). 한 칸으로 줄여 공백 개수에 따라 일치가 갈리지 않게 한다. */
const WHITESPACE_RUN = /\s+/g;
/**
 * 한글 방점(U+302E·U+302F)과 아래아(ㆍ, U+318D). Script=Hangul이라 DISALLOWED_CHARACTERS에서 남는데, 화면에서는 작은 점으로만 보여
 * 금칙어 글자 사이에 끼워 넣는 우회("김치〮녀")에 쓰인다. 두 비교용 정규화 모두에서 지운다.
 */
const HANGUL_DOT_MARKS = /[\u302E\u302F\u318D]/g;
/**
 * 좁은 공백류(U+1680, U+2006~U+200A, U+2028, U+2029, U+202F, U+205F). \s에 들어 있어 공백 유지 형태에서 공백 한 칸이 되는데,
 * 화면에서는 거의 붙어 보여 글자 사이에 끼우면 금칙어 강이 "단어를 걸친 일치"로 보여 자동 숨김이 후보로 낮아진다(S2).
 * 그래서 공백 유지 형태에서도 공백으로 보지 않고 지운다. 공백 없는 형태에서는 원래부터 DISALLOWED_CHARACTERS가 지운다.
 */
const NARROW_SPACES = /[\u1680\u2006-\u200A\u2028\u2029\u202F\u205F]/g;
/** 자음 자모 바로 뒤의 1·l·|은 모음 'ㅣ'로 쓰인 것이다(예: ㅅ1발). */
const VOWEL_LOOKALIKE_AFTER_CONSONANT = /(?<=[ㄱ-ㅎ])[1l|]/g;
/** 두 음절 사이에 끼운 1·l·|은 채워 넣은 잡음이다(예: 병1신). */
const FILLER_BETWEEN_SYLLABLES = /(?<=[가-힣])[1l|]+(?=[가-힣])/g;
/**
 * 같은 글자 3번 이상 반복을 2번으로 줄인다(예: ㅋㅋㅋ, 시이이발).
 * 숫자(0-9)는 제외한다. 숫자는 뜻을 담으므로 "1000명"의 000을 줄이면 의미가 바뀐다.
 */
const REPEATED_CHARACTERS = /([^0-9])\1{2,}/gu;

/** 초성 순서(유니코드 음절 조합 공식의 순서). */
const CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
/** 중성 순서. */
const JUNGSEONG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
/** 종성 순서. 0번(받침 없음) 자리는 비워 둔다. */
const JONGSEONG = "\u0000ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";

/**
 * 보이지 않는 문자를 지우고 전각 ASCII를 반각으로 바꾼다. 소문자화·글자 제거는 하지 않는다.
 * 채팅 UI는 이런 문자를 건너뛰고 링크·번호로 그려 주므로, 패턴 검사 전에 같은 모양으로 맞춰야 우회를 막는다.
 * 순서: NFC → 보이지 않는 문자 제거 → 전각→반각.
 */
export function stripInvisibleAndFullwidth(text: string): string {
  return text
    .normalize("NFC")
    .replace(INVISIBLE_CHARACTERS, "")
    .replace(FULLWIDTH_ASCII, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0));
}

/**
 * 금칙어 비교용 문자열을 만든다. 표시용이 아니다.
 * 순서: NFC → 제로폭 제거 → 전각→반각 → 소문자 → 한글 방점·아래아 제거 → 허용 문자만 → 모음 대용 1 → 잡음 1 제거 → 자모 조합 → 반복 축약.
 */
export function normalizeForMatching(text: string): string {
  return finishMatchingNormalization(prepareForMatching(text).replace(DISALLOWED_CHARACTERS, ""));
}

/**
 * normalizeForMatching과 같은 단계를 거치되 공백만 지우지 않는다. 연이은 공백은 한 칸으로 줄이고 앞뒤 공백은 자른다.
 * 왜: 공백을 모두 지운 문장에서는 "김치 녀석들"처럼 단어를 걸친 우연한 일치가 생긴다. 되돌릴 수 없는 자동 숨김은
 * 단어 안에 그대로 든 금칙어 강에만 쓰고, 공백을 지워야만 걸리는 것은 후보로 낮추려고 이 형태와 비교한다(F4).
 * '|'·잡음 1을 지운 뒤 생긴 연속 공백도 한 칸으로 다시 줄인다("나쁜 | 놈" → "나쁜 놈", R2).
 * 좁은 공백류(NARROW_SPACES)는 공백으로 보지 않고 지운다(S2).
 * 주의: 글자마다 띄운 우회("김 치 녀")는 이 형태에서 걸리지 않으므로, 공백 없는 형태와 함께 써야 후보로라도 잡힌다.
 * @param text 채팅 원문
 * @returns 공백이 한 칸씩 남은 비교용 문자열(표시용이 아니다)
 */
export function normalizeKeepingWhitespace(text: string): string {
  const cleaned = prepareForMatching(text).replace(NARROW_SPACES, "").replace(DISALLOWED_CHARACTERS_EXCEPT_WHITESPACE, "");
  return finishMatchingNormalization(cleaned.replace(WHITESPACE_RUN, " ").trim()).replace(WHITESPACE_RUN, " ").trim();
}

/**
 * 두 비교용 정규화의 공통 앞 단계: 보이지 않는 문자 제거·전각→반각 → 소문자 → 한글 방점·아래아 제거.
 * 왜 stripInvisibleAndFullwidth에 넣지 않나: 그 함수는 링크·전화번호 검사도 쓰는데, 방점은 링크·번호 모양과 관계가 없어 금칙어 비교에서만 지운다.
 * @param text 채팅 원문
 * @returns 허용 문자 거르기 전의 비교용 문자열
 */
function prepareForMatching(text: string): string {
  return stripInvisibleAndFullwidth(text).toLowerCase().replace(HANGUL_DOT_MARKS, "");
}

/**
 * 허용 문자만 남긴 뒤의 공통 단계: 모음 대용 1 → 잡음 1 제거 → '|' 제거 → 자모 조합 → 반복 축약.
 * 두 정규화가 같은 단계를 쓰게 해, 공백 처리 말고는 결과가 갈리지 않게 한다.
 * @param cleaned 허용 문자만 남긴 소문자 문자열
 */
function finishMatchingNormalization(cleaned: string): string {
  const withVowels = cleaned.replace(VOWEL_LOOKALIKE_AFTER_CONSONANT, "ㅣ").replace(FILLER_BETWEEN_SYLLABLES, "").replace(/\|/g, "");
  return composeJamo(withVowels).replace(REPEATED_CHARACTERS, "$1$1");
}

/** 낱자 자모(초성+중성[+종성])를 완성 음절로 합친다. 예: "ㅂㅏ" → "바". */
function composeJamo(text: string): string {
  const characters = [...text];
  let result = "";
  let index = 0;
  while (index < characters.length) {
    const [piece, consumed] = composeAt(characters, index);
    result += piece;
    index += consumed;
  }
  return result;
}

/** index 위치에서 음절 하나를 만들 수 있으면 만들고, 소비한 글자 수를 함께 돌려준다. */
function composeAt(characters: readonly string[], index: number): [string, number] {
  const initial = tableIndex(CHOSEONG, characters[index]);
  const medial = tableIndex(JUNGSEONG, characters[index + 1]);
  if (initial < 0 || medial < 0) return [characters[index] as string, 1];
  const final = finalIndex(characters, index + 2);
  const syllable = String.fromCharCode(0xac00 + (initial * 21 + medial) * 28 + final);
  return [syllable, final > 0 ? 3 : 2];
}

/** 받침으로 쓸 수 있는 자음이고 뒤에 모음이 오지 않을 때만 받침으로 본다(뒤에 모음이 오면 다음 음절의 초성). */
function finalIndex(characters: readonly string[], index: number): number {
  const candidate = tableIndex(JONGSEONG, characters[index]);
  if (candidate <= 0) return 0;
  return tableIndex(JUNGSEONG, characters[index + 1]) >= 0 ? 0 : candidate;
}

/** 표에서 글자의 위치. 글자가 없으면 -1(빈 문자열 indexOf가 0을 주는 함정을 피한다). */
function tableIndex(table: string, character: string | undefined): number {
  return character ? table.indexOf(character) : -1;
}
```

- [ ] **Step 10: 통과 확인**

Run: `npm test -w @zzirit-guard/server`
Expected: PASS (398 tests)

- [ ] **Step 11: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/detection/normalize.ts apps/server/test/detection/normalize.test.ts apps/server/test/detection/pipeline.test.ts
git commit -m "fix: 좁은 공백류와 한글 방점으로 금칙어를 피하지 못하게 정규화" -m "공백 유지 형태에서 좁은 공백류를 공백으로 보지 않고 지워 금칙어 강이 후보로 낮아지지 않게 하고, 두 비교용 정규화 모두에서 한글 방점·아래아를 지운다."
```

#### 예외 단어 가림 해소(B3 (d))

지금은 예외 단어를 구분 문자로 바꿔 지운 뒤 금칙어를 찾는다. 그러면 금칙어가 예외 단어와 일부만 겹치거나(예외 "새끼손가락"이 "개새끼손가락"의 "개새끼"를 지움) 예외 밖에 또 있어도("시발택시발"에서 예외 "시발택시"를 지우면 남은 "발"만 보임) 놓친다(S4). 바꾸는 방식: 예외를 지우지 않은 정규화 문장(공백 없는 형태와 공백 유지 형태 둘 다)에서 금칙어가 나오는 **모든** 자리를 찾고, 그 자리 전체가 **예외 단어 한 곳 안에 완전히** 들어갈 때만 버린다. 아무것도 지우지 않으므로 앞뒤 조각이 이어 붙는 일(F7)은 생기지 않는다.

- [ ] **Step 12: 실패하는 테스트 작성**

`apps/server/test/detection/wordMatch.test.ts` 전체를 다음으로 바꾼다:
```ts
import { describe, expect, it } from "vitest";
import type { RuleEntry } from "../../src/detection/ruleRepository.js";
import { findFirstIntactMatch, findFirstMatch, locateExceptions, locateExceptionsKeepingWhitespace } from "../../src/detection/wordMatch.js";

/** 테스트용 규칙 항목. spacedPattern을 생략하면 공백 없는 규칙으로 본다. */
function entry(id: number, normalizedPattern: string, spacedPattern = normalizedPattern): RuleEntry {
  return { id, kind: "weak", pattern: spacedPattern, normalizedPattern, spacedPattern, createdBy: "test", createdAt: 0 };
}

/** 공백 없는 비교: 예외 단어 위치를 찾은 뒤 첫 일치 규칙의 id(없으면 null). */
function compactMatchId(text: string, exceptions: RuleEntry[], entries: RuleEntry[]): number | null {
  return findFirstMatch(locateExceptions(text, exceptions), entries)?.id ?? null;
}

/** 공백 유지 비교: 예외 단어 위치를 찾은 뒤 단어 안에 그대로 든 첫 규칙의 id(없으면 null). */
function intactMatchId(text: string, exceptions: RuleEntry[], entries: RuleEntry[]): number | null {
  return findFirstIntactMatch(locateExceptionsKeepingWhitespace(text, exceptions), entries)?.id ?? null;
}

/** 금칙어 "시발". */
const SIBAL = entry(2, "시발");
/** 예외 단어 "시발점". */
const SIBAL_POINT = entry(1, "시발점");

describe("wordMatch", () => {
  it("예외 단어 안에 든 금칙어는 버리고, 예외 단어 밖에 있는 것은 찾는다", () => {
    expect(compactMatchId("여기가시발점이야", [SIBAL_POINT], [SIBAL])).toBeNull();
    expect(compactMatchId("시발점이야시발", [SIBAL_POINT], [SIBAL])).toBe(2);
  });

  it.each(["시발점", "출시시발점발표", "시시발점발"])("'%s'의 '시발'은 모두 예외 단어 안에 있어 일치하지 않는다(F7: 앞뒤를 이어 붙이지 않는다)", (text) => {
    expect(compactMatchId(text, [SIBAL_POINT], [SIBAL])).toBeNull();
    expect(intactMatchId(text, [SIBAL_POINT], [SIBAL])).toBeNull();
  });

  it("공백을 남긴 문장에서도 예외 단어 안의 일치만 버린다(F7)", () => {
    expect(intactMatchId("출시 시발점 발표", [SIBAL_POINT], [SIBAL])).toBeNull();
  });

  it("같은 금칙어가 예외 단어 밖에도 있으면 찾는다(S4)", () => {
    const taxi = entry(3, "시발택시");
    expect(compactMatchId("시발택시발", [taxi], [SIBAL])).toBe(2);
    expect(intactMatchId("시발택시발", [taxi], [SIBAL])).toBe(2);
  });

  it("예외 단어와 일부만 겹치는 금칙어는 가려지지 않는다(S4)", () => {
    const finger = entry(4, "새끼손가락");
    const insult = entry(5, "개새끼");
    expect(compactMatchId("개새끼손가락", [finger], [insult])).toBe(5);
    expect(intactMatchId("개새끼손가락", [finger], [insult])).toBe(5);
  });

  it("공백 든 예외 단어는 공백 형태와 붙여 쓴 형태 모두 가린다(R2)", () => {
    const exception = entry(6, "짱깨집", "짱깨 집");
    expect(intactMatchId("짱깨 집 가자", [exception], [entry(7, "짱깨")])).toBeNull();
    expect(intactMatchId("짱깨집 가자", [exception], [entry(7, "짱깨")])).toBeNull();
  });

  it("빈 패턴은 금칙어로도 예외 단어로도 아무것과 일치하지 않는다", () => {
    expect(compactMatchId("아무 말", [], [entry(8, "")])).toBeNull();
    expect(compactMatchId("시발", [entry(9, "")], [SIBAL])).toBe(2);
  });

  it("목록 순서대로 첫 일치를 돌려준다", () => {
    expect(compactMatchId("ㅂㅅ같이", [], [entry(3, "병신"), entry(4, "ㅂㅅ")])).toBe(4);
  });

  it("findFirstIntactMatch는 공백을 넘는 일치를 찾지 않는다(F4)", () => {
    expect(intactMatchId("김치 녀석들", [], [entry(5, "김치녀")])).toBeNull();
    expect(intactMatchId("김치녀 같은", [], [entry(5, "김치녀")])).toBe(5);
  });

  it("findFirstIntactMatch는 공백이 든 규칙을 공백 그대로도, 붙여 쓴 것도 찾는다(F4)", () => {
    const rule = entry(6, "나쁜놈", "나쁜 놈");
    expect(intactMatchId("이 나쁜 놈아", [], [rule])).toBe(6);
    expect(intactMatchId("이 나쁜놈아", [], [rule])).toBe(6);
    expect(intactMatchId("나 쁜 놈", [], [rule])).toBeNull();
  });
});
```

`apps/server/test/detection/pipeline.test.ts`의 `it("개인 도배는 다섯 번째부터 후보", …)` 바로 앞(Step 7에서 넣은 테스트 다음)에 넣는다. 기본 규칙에 예외 "시발택시"와 금칙어 약 "시발"·"개새끼"가 있다:
```ts
  it("기본 예외 단어 밖에 같은 금칙어가 또 있으면 후보로 올린다(S4)", () => {
    expect(pipeline.evaluate(chat("시발택시발"))).toMatchObject({ decision: "candidate", reason: expect.stringMatching(/^rule:weak:\d+$/) });
  });

  it("예외 단어와 일부만 겹치는 금칙어는 예외에 가려지지 않는다(S4)", () => {
    rules.add("c1", "exception", "새끼손가락", "m");
    expect(pipeline.evaluate(chat("개새끼손가락"))).toMatchObject({ decision: "candidate", reason: expect.stringMatching(/^rule:weak:\d+$/) });
    expect(pipeline.evaluate(chat("새끼손가락 걸고 약속", { senderChannelId: "viewer-2" }))).toMatchObject({ decision: "pass", reason: "none" });
  });

```

- [ ] **Step 13: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- test/detection`
Expected: FAIL 14개(wordMatch 12개는 `TypeError: locateExceptions is not a function` 류, 파이프라인 2개는 `expected { decision: 'pass', … } to match object { decision: 'candidate', … }`).

- [ ] **Step 14: 구현**

`apps/server/src/detection/wordMatch.ts` 전체를 다음으로 바꾼다:
```ts
import type { RuleEntry } from "./ruleRepository.js";

/** 문장 안의 구간. start는 포함하고 end는 포함하지 않는다(UTF-16 위치, String.prototype.indexOf와 같은 기준). */
export interface TextSpan {
  /** 구간이 시작하는 위치. */
  start: number;
  /** 구간이 끝난 바로 다음 위치. */
  end: number;
}

/**
 * 비교할 문장과, 그 안에서 예외 단어가 차지한 구간들.
 * 왜 예외 단어를 지우지 않고 위치만 기억하나: 지우면 두 가지가 틀어진다.
 * ① 지운 자리의 앞뒤가 이어져 원문에 없던 금칙어가 생긴다("출시시발점발표"에서 "시발점"을 지우면 "출시발표", F7).
 * ② 금칙어가 예외 단어와 일부만 겹쳐도 함께 지워져 놓친다("개새끼손가락"에서 "새끼손가락"을 지우면 "개새끼"가 사라진다, S4).
 * 그래서 금칙어는 예외를 지우지 않은 문장에서 찾고, 그 일치가 예외 단어 한 곳 안에 완전히 들어 있을 때만 버린다.
 */
export interface ExceptionAwareText {
  /** 정규화한 비교용 문장(예외 단어를 지우지 않은 그대로). */
  text: string;
  /** text 안에서 예외 단어가 나온 모든 구간. 겹쳐 나온 것도 모두 담는다. */
  exceptionSpans: readonly TextSpan[];
}

/**
 * 공백까지 지운 문장에서 예외 단어 위치를 찾는다. "시발점"처럼 금칙어를 품은 정상 단어가 걸리지 않게 하려는 것이다.
 * @param normalizedText normalizeForMatching을 거친 문장
 * @param exceptions 예외 단어 규칙 목록
 * @returns 문장과 예외 단어 구간
 */
export function locateExceptions(normalizedText: string, exceptions: readonly RuleEntry[]): ExceptionAwareText {
  return { text: normalizedText, exceptionSpans: exceptions.flatMap((exception) => findSpans(normalizedText, exception.normalizedPattern)) };
}

/**
 * 공백을 남긴 문장에서 예외 단어 위치를 찾는다. 공백 든 예외("짱깨 집")는 공백 형태(spacedPattern)와 붙여 쓴 형태(normalizedPattern)를 모두 찾는다.
 * 왜: 금칙어 강 쪽은 spacedPattern까지 보는데 예외 쪽이 normalizedPattern만 보면, 공백 든 예외 문장이 auto_hide가 된다(R2).
 * @param spacedText normalizeKeepingWhitespace를 거친 문장
 * @param exceptions 예외 단어 규칙 목록
 * @returns 문장과 예외 단어 구간
 */
export function locateExceptionsKeepingWhitespace(spacedText: string, exceptions: readonly RuleEntry[]): ExceptionAwareText {
  const patterns = exceptions.flatMap((exception) => [...new Set([exception.spacedPattern, exception.normalizedPattern])]);
  return { text: spacedText, exceptionSpans: patterns.flatMap((pattern) => findSpans(spacedText, pattern)) };
}

/**
 * 공백까지 지운 문장에서, 예외 단어에 가려지지 않은 일치가 있는 첫 번째 규칙(목록 순서)을 찾는다.
 * @param target locateExceptions로 만든 문장과 예외 구간
 * @param entries 비교할 규칙 목록
 * @returns 처음 일치한 규칙, 없으면 null
 */
export function findFirstMatch(target: ExceptionAwareText, entries: readonly RuleEntry[]): RuleEntry | null {
  return entries.find((entry) => hasUncoveredMatch(target, entry.normalizedPattern)) ?? null;
}

/**
 * 공백을 남긴 문장에서 단어 경계를 넘지 않고 그대로 들어 있고 예외 단어에 가려지지 않은 첫 번째 규칙(목록 순서)을 찾는다.
 * 규칙에 공백이 없으면 normalizedPattern으로 보고, 매니저가 공백을 넣어 만든 규칙("나쁜 놈")은 그 공백까지 맞는 spacedPattern으로도 본다.
 * 왜 둘 다 보나: 공백 든 규칙을 공백 없는 형태로만 비교하면 규칙대로 쓴 문장이 영영 자동 숨김이 되지 않고, 공백 형태로만 비교하면 붙여 쓴 것을 놓친다.
 * @param target locateExceptionsKeepingWhitespace로 만든 문장과 예외 구간
 * @param entries 비교할 규칙 목록
 * @returns 처음 일치한 규칙, 없으면 null
 */
export function findFirstIntactMatch(target: ExceptionAwareText, entries: readonly RuleEntry[]): RuleEntry | null {
  return entries.find((entry) => hasUncoveredMatch(target, entry.normalizedPattern) || hasUncoveredMatch(target, entry.spacedPattern)) ?? null;
}

/**
 * pattern이 나오는 자리 중 예외 단어 한 곳 안에 완전히 들지 않는 자리가 하나라도 있는지 본다.
 * 왜 "한 곳 안에 완전히"인가: 예외 단어 밖으로 한 글자라도 삐져나오면 그 정상 단어의 일부가 아니라 따로 쓴 금칙어이기 때문이다.
 */
function hasUncoveredMatch(target: ExceptionAwareText, pattern: string): boolean {
  return findSpans(target.text, pattern).some((span) => !target.exceptionSpans.some((exception) => covers(exception, span)));
}

/** outer가 inner를 완전히 품는지 본다. */
function covers(outer: TextSpan, inner: TextSpan): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * text에서 pattern이 나오는 모든 자리를 찾는다. 겹쳐 나오는 자리도 모두 센다(예: "시발시발"의 "시발"은 0과 2).
 * 빈 패턴은 아무 데도 없는 것으로 본다. 왜: 빈 문자열은 모든 위치에 일치해, 금칙어면 모든 메시지를 걸고 예외면 모든 일치를 가린다.
 * @param text 찾을 문장
 * @param pattern 찾을 문자열
 * @returns 나온 자리의 구간 목록(앞에서부터)
 */
function findSpans(text: string, pattern: string): TextSpan[] {
  const spans: TextSpan[] = [];
  if (!pattern) return spans;
  for (let start = text.indexOf(pattern); start >= 0; start = text.indexOf(pattern, start + 1)) spans.push({ start, end: start + pattern.length });
  return spans;
}
```

`apps/server/src/detection/pipeline.ts`에서 다음 네 곳을 바꾼다.

import 줄:
```ts
import { findFirstIntactMatch, findFirstMatch, stripExceptions, stripExceptionsKeepingWhitespace } from "./wordMatch.js";
```
→
```ts
import { findFirstIntactMatch, findFirstMatch, locateExceptions, locateExceptionsKeepingWhitespace, type ExceptionAwareText } from "./wordMatch.js";
```

`RuleContext`의 두 필드:
```ts
  withoutExceptions: string;
  /** 공백을 남겨 정규화하고 예외 단어를 지운 문장. 금칙어 강이 단어 안에 그대로 있는지 볼 때 쓴다(F4). */
  spacedWithoutExceptions: string;
```
→
```ts
  /** 공백까지 지운 문장과 그 안의 예외 단어 위치. 금칙어 약·협박·단어를 걸친 금칙어 강을 볼 때 쓴다. */
  compact: ExceptionAwareText;
  /** 공백을 남긴 문장과 그 안의 예외 단어 위치. 금칙어 강이 단어 안에 그대로 있는지 볼 때 쓴다(F4). */
  spaced: ExceptionAwareText;
```

`buildContext`의 두 줄:
```ts
    withoutExceptions: stripExceptions(normalized, snapshot.exception),
    spacedWithoutExceptions: stripExceptionsKeepingWhitespace(normalizeKeepingWhitespace(event.content), snapshot.exception),
```
→
```ts
    compact: locateExceptions(normalized, snapshot.exception),
    spaced: locateExceptionsKeepingWhitespace(normalizeKeepingWhitespace(event.content), snapshot.exception),
```

`decide`의 네 줄에서 인자를 바꾼다(`c.spacedWithoutExceptions` → `c.spaced`, `c.withoutExceptions` → `c.compact`):
```ts
    (c) => matchRule(findFirstIntactMatch(c.spaced, c.snapshot.strong), "auto_hide", "strong"),
```
```ts
    (c) => matchRule(findFirstMatch(c.compact, c.snapshot.strong), "candidate", "strong_spanning"),
```
```ts
    (c) => matchRule(findFirstMatch(c.compact, c.snapshot.weak), "candidate", "weak"),
```
```ts
    (c) => matchRule(findFirstMatch(c.compact, c.snapshot.threat), "candidate", "threat"),
```

- [ ] **Step 15: 통과 확인**

Run: `npm test -w @zzirit-guard/server`
Expected: PASS (407 tests). 기존 F7 테스트("시시발점발"·"출시 시발점 발표"는 pass)와 R2 테스트("짱깨 집 가자"는 pass)도 그대로 통과한다.

- [ ] **Step 16: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/detection/wordMatch.ts apps/server/src/detection/pipeline.ts apps/server/test/detection/wordMatch.test.ts apps/server/test/detection/pipeline.test.ts
git commit -m "fix: 예외 단어가 바깥 금칙어를 가리지 않게 위치로 판정" -m "예외 단어를 지우지 않고 위치만 찾은 뒤, 금칙어가 나온 자리가 예외 단어 한 곳 안에 완전히 들 때만 버린다. '시발택시발'·'개새끼손가락'을 놓치지 않고, 지운 자리 앞뒤가 이어져 새 금칙어가 생기는 일도 없다. 빈 패턴은 어디에도 일치하지 않는다."
```

#### 오판 검토 목록과 분당 통계 DTO(B3 (f), B5, R-16, R-20)

스펙 5.5 "오판을 누르면 그 규칙이 검토 목록에 올라간다"를 받칠 조회가 서버에 없다(`/api/candidates`는 10분치만 준다). 그리고 `/api/stats`가 이미 snake_case 행(`minute` + STAT_FIELDS)을 주지만 shared에 그 타입이 없어 웹이 인터페이스를 복사해야 한다.

- [ ] **Step 17: 실패하는 테스트 작성**

`apps/server/test/records/records.test.ts` 맨 위에 import를 더한다(첫 줄로):
```ts
import type { MinuteStatDto } from "@zzirit-guard/shared";
```
그리고 파일 끝에 덧붙인다:
```ts
describe("VerdictRepository 오판 검토(스펙 5.5)", () => {
  it("오판 신고된 판정만 최신순으로 limit개 읽고, 이유별 건수는 많은 순으로 센다(다른 채널·다른 상태는 뺀다)", () => {
    let now = 1_000;
    const repository = createVerdictRepository(openDatabase(":memory:"), () => now);
    const report = (reason: string, channelId = "c1") => {
      now += 1_000;
      const verdict = repository.insert({ ...sample, channelId, reason });
      repository.updateStatus(verdict.id, "false_positive");
      return verdict.id;
    };
    const first = report("rule:strong:3");
    const second = report("rule:weak:7");
    const third = report("rule:strong:3");
    report("rule:strong:3", "other-channel");
    repository.insert({ ...sample, reason: "rule:strong:3" });
    expect(repository.listFalsePositives("c1", 2).map((verdict) => verdict.id)).toEqual([third, second]);
    expect(repository.listFalsePositives("c1", 10).map((verdict) => verdict.id)).toEqual([third, second, first]);
    expect(repository.countFalsePositivesByReason("c1")).toEqual([
      { reason: "rule:strong:3", count: 2 },
      { reason: "rule:weak:7", count: 1 },
    ]);
  });
});

describe("MinuteStats 행 형태", () => {
  it("recent 행의 키가 shared의 MinuteStatDto와 정확히 같다(웹이 같은 타입을 쓴다, R-20)", () => {
    const stats = createMinuteStats(openDatabase(":memory:"), () => 61_000);
    stats.increment("c1", "received");
    stats.flush();
    const expected: MinuteStatDto = {
      minute: 60_000, received: 1, skipped: 0, deduplicated: 0, stage1_forwarded: 0, stage2_done: 0, stage2_dropped: 0,
      candidates: 0, auto_hidden: 0, shadow: 0, invalid_events: 0,
    };
    expect(stats.recent("c1", 0)).toEqual([expected]);
  });
});
```

`apps/server/test/http/server.test.ts` 맨 위에 import를 더한다(첫 줄로):
```ts
import type { FalsePositiveReviewDto } from "@zzirit-guard/shared";
```
그리고 파일 끝에 덧붙인다:
```ts
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
      expect((await harness.app.inject({ method: "GET", url: `/api/false-positives?limit=${limit}`, headers: { cookie } })).statusCode).toBe(400);
    }
  });

  it("로그인하지 않으면 401", async () => {
    expect((await harness.app.inject({ method: "GET", url: "/api/false-positives" })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 18: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- test/records test/http/server.test.ts; npm run typecheck`
Expected: 테스트 FAIL 4개(`repository.listFalsePositives is not a function`, 라우트가 없어 `expected 404 to be 200`·`expected 404 to be 401`). "MinuteStats 행 형태"는 실행 시에는 통과하지만 typecheck가 `TS2305: Module '"@zzirit-guard/shared"' has no exported member 'MinuteStatDto'`(`FalsePositiveReviewDto`도 같음)로 실패한다.

- [ ] **Step 19: 구현**

`packages/shared/src/index.ts`의 `/** WebSocket으로 서버가 보내는 메시지. */` 바로 앞에 넣는다:
```ts
/** 분당 통계 한 행(GET /api/stats). 서버 minute_stat 열 이름(snake_case)을 그대로 쓴다. */
export interface MinuteStatDto {
  /** 그 분이 시작한 시각(ms). */
  minute: number;
  /** 받은 채팅 수. */
  received: number;
  /** 가벼운 반응(ㅋㅋ 등)이라 AI 단계를 건너뛴 수. */
  skipped: number;
  /** 10분 안에 같은 정규화 문장이 이미 있었던 수. */
  deduplicated: number;
  /** 1차 분류기로 보낸 수(2단계). */
  stage1_forwarded: number;
  /** 2차 분류기가 판정한 수(2단계). */
  stage2_done: number;
  /** 2차 대기열에서 버린 수(2단계). */
  stage2_dropped: number;
  /** 후보로 올린 수. */
  candidates: number;
  /** 자동 숨김을 보낸 수. */
  auto_hidden: number;
  /** 스위치가 꺼져 섀도로 기록한 수. */
  shadow: number;
  /** 형식이 틀려 버린 채팅 이벤트 수. */
  invalid_events: number;
}

/** 오판 검토 목록의 이유별 건수 한 줄. */
export interface FalsePositiveReasonCountDto {
  /** 판정 이유(예: rule:strong:12). 규칙 번호가 들어 있어 어떤 규칙을 고칠지 알 수 있다. */
  reason: string;
  /** 보관 기간 안에서 이 이유로 오판 신고된 판정 수. */
  count: number;
}

/** 오판 검토 목록(GET /api/false-positives, 스펙 5.5 "오판을 누르면 그 규칙이 검토 목록에 올라간다"). */
export interface FalsePositiveReviewDto {
  /** 최근 오판 신고 판정(판정이 만들어진 순서로 최신부터, limit개까지). */
  recent: VerdictDto[];
  /** 이유별 오판 건수(많은 순, 같으면 이유 순). */
  byReason: FalsePositiveReasonCountDto[];
}
```

`apps/server/src/records/verdictRepository.ts`:
1. 첫 줄 import를 바꾼다:
```ts
import type { Decision, FalsePositiveReasonCountDto, VerdictDto, VerdictStatus } from "@zzirit-guard/shared";
```
2. `VerdictRepository` 인터페이스의 `listRecent(…)` 줄 바로 아래에 넣는다:
```ts
  /**
   * 오판으로 신고된 판정을 최신순(만들어진 시각, 같으면 id)으로 limit개 읽는다. 오판 검토 목록(스펙 5.5)에 쓴다.
   * 신고한 시각은 감사 기록(action false_positive)에 있다. 판정 표에는 없어 만들어진 순서로 정렬한다.
   */
  listFalsePositives(channelId: string, limit: number): VerdictDto[];
  /** 오판으로 신고된 판정을 이유(규칙 번호)별로 센다. 많은 순, 같으면 이유 순. 고칠 규칙을 고르는 데 쓴다. */
  countFalsePositivesByReason(channelId: string): FalsePositiveReasonCountDto[];
```
3. `createVerdictRepository`가 돌려주는 객체의 `listRecent: …` 항목 바로 아래에 넣는다. 상태 열에는 인덱스가 없지만 `verdict_channel_created`로 채널을 좁힌 뒤 30일치만 걸러서 1단계 규모에서는 충분하다(측정 없이 인덱스를 더하지 않는다):
```ts
    listFalsePositives: (channelId, limit) =>
      (database
        .prepare("SELECT * FROM verdict WHERE channel_id = ? AND status = 'false_positive' ORDER BY created_at DESC, id DESC LIMIT ?")
        .all(channelId, limit) as VerdictRow[]).map(toDto),
    countFalsePositivesByReason: (channelId) =>
      database
        .prepare("SELECT reason, COUNT(*) AS count FROM verdict WHERE channel_id = ? AND status = 'false_positive' GROUP BY reason ORDER BY count DESC, reason")
        .all(channelId) as FalsePositiveReasonCountDto[],
```

`apps/server/src/records/minuteStats.ts`:
1. 첫 줄로 import를 더한다:
```ts
import type { MinuteStatDto } from "@zzirit-guard/shared";
```
2. `MinuteStats` 인터페이스의 `recent` 줄을 바꾼다:
```ts
  /** sinceMs 이후의 분당 통계를 분 순서로 읽는다. 행 형태는 shared의 MinuteStatDto와 같다(웹이 같은 타입을 쓴다). */
  recent(channelId: string, sinceMs: number): MinuteStatDto[];
```
3. 구현의 `recent: …` 항목을 바꾼다(캐스트 타입만 바뀐다):
```ts
    recent: (channelId, sinceMs) =>
      database.prepare(`SELECT minute, ${STAT_FIELDS.join(", ")} FROM minute_stat WHERE channel_id = ? AND minute >= ? ORDER BY minute`).all(channelId, sinceMs) as MinuteStatDto[],
```

`apps/server/src/http/routes.ts`:
1. 첫 줄 import를 바꾼다:
```ts
import type { ChatSettingsDto, FalsePositiveReviewDto, ManagerRole, MeDto, Permission, ServerStatus, SettingsDto, VerdictStatus } from "@zzirit-guard/shared";
```
2. `auditQuerySchema` 정의 바로 아래에 넣는다:
```ts
/** 오판 검토 목록 쿼리. 최근 목록의 길이를 감사 기록과 같은 범위(1~200, 기본 50)로 제한한다. */
const falsePositiveQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
```
3. `registerVerdictRoutes`의 마지막 라우트(`/api/verdicts/:id/false-positive`) 바로 아래에 한 줄을 넣고, 함수 바로 뒤에 처리 함수를 더한다:
```ts
  app.get("/api/false-positives", guarded(services, null, (context) => listFalsePositiveReview(services, context)));
```
```ts
/**
 * 오판 검토 목록(스펙 5.5): 최근 오판 신고 판정과 이유별 건수. 이유에 규칙 번호가 있어 어떤 규칙을 고칠지 보인다.
 * 읽기 전용이라 다른 조회 라우트(/api/candidates·/api/rules)처럼 로그인한 매니저면 누구나 본다.
 */
function listFalsePositiveReview(services: RouteServices, { request, channelId }: GuardedContext): FalsePositiveReviewDto {
  const { limit } = falsePositiveQuerySchema.parse(request.query);
  return { recent: services.verdicts.listFalsePositives(channelId, limit), byReason: services.verdicts.countFalsePositivesByReason(channelId) };
}
```

- [ ] **Step 20: 통과 확인**

Run: `npm run typecheck && npm test -w @zzirit-guard/server`
Expected: typecheck 통과, PASS (412 tests)

- [ ] **Step 21: 커밋**

```bash
npm run lint && npm run typecheck
git add packages/shared/src/index.ts apps/server/src/records apps/server/src/http/routes.ts apps/server/test/records/records.test.ts apps/server/test/http/server.test.ts
git commit -m "feat: 오판 검토 목록 조회와 분당 통계 DTO 추가" -m "GET /api/false-positives가 최근 오판 판정(이유에 규칙 번호)과 이유별 건수를 준다(스펙 5.5). /api/stats 행 형태를 shared의 MinuteStatDto로 두어 웹이 서버 타입을 그대로 쓰게 하고, 행 키가 DTO와 같은지 테스트로 묶는다."
```

---
### Task 1: 웹 기반 구성과 API 클라이언트

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/src/vite-env.d.ts`, `apps/web/src/api/client.ts`
- Create: `apps/web/test/helpers/stubFetch.ts`
- Test: `apps/web/test/api/client.test.ts`

**Interfaces:**
- Produces: `API_BASE: string`, `class ApiError extends Error { status: number; code: string; constructor(status, code, message, options?: ErrorOptions) }`, `apiGet<T>(path: string): Promise<T>`, `apiSend<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T>`, `describeApiError(error: unknown): string`, `requiresSignIn(error: unknown): error is ApiError`(401 또는 `no_channel`); 테스트용 `stubFetch(routes: Record<string, (init?: RequestInit) => Response>)`, `json(status, body): Response`

브랜치는 이미 있다(B1). 초판의 "브랜치 만들기" 단계는 없앴다.

- [ ] **Step 1: 패키지 설정 작성**

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

`apps/web/vite.config.ts`(개발 서버 프록시 없음, R-21):
```ts
// 웹 빌드·테스트 설정.
// 개발 서버(npm run dev)에는 서버 프록시를 두지 않는다(R-21). 로그인 콜백 주소는 ZG_PUBLIC_ORIGIN으로 고정이고(authFlow.ts),
// 세션 쿠키는 Secure이며, 상태 변경 요청과 WebSocket은 Origin이 ZG_PUBLIC_ORIGIN과 같아야 해서(server.ts),
// localhost:5173을 거치면 로그인·조치·실시간이 모두 거절된다. 실제 동작은 서버가 제공하는 빌드(dist)를 Funnel 주소로 열어 확인한다.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
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

/** import.meta에 위 환경 값 타입을 붙인다. */
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 2: 의존성 설치**

```bash
npm install --save-exact -w @zzirit-guard/web react@19.3.0 react-dom@19.3.0
npm install --save-dev --save-exact -w @zzirit-guard/web vite@8.3.4 @vitejs/plugin-react@6.1.2 vitest@5.0.3 jsdom@30.1.2 @types/react@19.3.0 @types/react-dom@19.3.0 @testing-library/react@16.3.3 @testing-library/dom@10.4.2 @testing-library/user-event@14.6.7
grep -E '"react(-dom)?": "19.3.0"' apps/web/package.json
```
Expected: 마지막 명령이 두 줄(`"react": "19.3.0"`, `"react-dom": "19.3.0"`)을 보인다. 개정 때 새 워크스페이스에서 첫 명령이 `dependencies`에 저장되지 않은 일이 한 번 있었다. 두 줄이 없으면 첫 명령을 다시 실행한다. `EBADENGINE` 경고(jsdom 계열, Node ^22.22.2)는 Global Constraints의 설치 메모대로 두고 넘어간다.

- [ ] **Step 3: 테스트 도우미와 실패하는 테스트 작성**

`apps/web/test/helpers/stubFetch.ts`:
```ts
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
```

`apps/web/test/api/client.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, apiSend, describeApiError, requiresSignIn } from "../../src/api/client";
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

  it("네트워크 오류는 원인과 해결 방향을 담고, 원래 오류를 cause로 남긴다", async () => {
    const original = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn(async () => { throw original; }));
    const error = await apiGet("/api/me").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 0, code: "network", message: expect.stringMatching(/서버에 연결할 수 없습니다/) });
    expect((error as ApiError).cause).toBe(original);
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
```

- [ ] **Step 4: 실패 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: FAIL — `Cannot find module '../../src/api/client'` 류(모듈 없음)

- [ ] **Step 5: 구현**

`apps/web/src/api/client.ts`:
```ts
import type { ApiErrorBody } from "@zzirit-guard/shared";

/** API 주소 앞부분. 같은 출처면 빈 문자열. 화면만 Cloudflare Pages로 옮길 때 빌드 값으로 바꾼다(스펙 12장). */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";

/** 서버가 돌려준 오류. message는 사용자에게 그대로 보여 준다. status 0은 네트워크 오류다. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  /** HTTP 상태 코드. 서버에 닿지 못했으면 0. */
  readonly status: number;
  /** 서버 오류 코드(ApiErrorBody.error). 화면이 분기할 때 쓴다(예: no_channel·already_handled). */
  readonly code: string;

  /**
   * @param status HTTP 상태 코드(네트워크 오류는 0)
   * @param code 서버 오류 코드
   * @param message 사용자에게 보여 줄 문구
   * @param options cause에 원래 오류를 담아 개발자 도구에서 원인을 볼 수 있게 한다
   */
  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
    this.code = code;
  }
}

/** 상태 변경 요청 표식. 서버의 REQUEST_MARKER_HEADER(apps/server/src/http/constants.ts)와 같아야 한다(CSRF 방지). */
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

/**
 * 로그인 화면으로 돌아가야 하는 오류인지 본다: 세션이 끝났거나(401) 채널 연결이 사라졌다(409 no_channel).
 * 왜 no_channel도 넣나: 채널이 없으면 /api/status·/api/candidates·/api/ws-ticket이 모두 409라, 본 화면에 남으면
 * 배너가 "불러오는 중"에서 멈추고 티켓 요청만 끝없이 되풀이된다(R-12).
 */
export function requiresSignIn(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 401 || error.code === "no_channel");
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

/** fetch 자체가 실패하면(서버 꺼짐·네트워크) 원인과 해결 방향을 담아 바꾸고, 원래 오류는 cause로 남긴다. */
async function fetchOrExplain(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new ApiError(0, "network", "서버에 연결할 수 없습니다. 맥 미니가 켜져 있는지, 네트워크가 연결돼 있는지 확인하세요.", { cause: error });
  }
}

/** 본문을 JSON으로 읽는다. 비어 있으면 null, JSON이 아니면 형식 오류(해석 오류는 cause로 남긴다). */
function parseBody(status: number, text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ApiError(status, "bad_response", "서버 응답 형식이 올바르지 않습니다. 앱을 새로고침하세요.", { cause: error });
  }
}

/** 오류 본문을 ApiError로 바꾼다. */
function toApiError(status: number, payload: unknown): ApiError {
  const body = payload as Partial<ApiErrorBody> | null;
  if (body && typeof body.error === "string" && typeof body.message === "string") return new ApiError(status, body.error, body.message);
  return new ApiError(status, "unknown", `요청이 실패했습니다(${status}). 잠시 뒤 다시 시도하세요.`);
}
```

- [ ] **Step 6: 통과 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: PASS (7 tests)

- [ ] **Step 7: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web package-lock.json
git commit -m "feat: 웹 기반 구성과 API 클라이언트 추가" -m "React·Vite·Vitest를 설정하고, 쿠키를 함께 보내며 상태 변경 요청에 표식 헤더를 붙이는 API 클라이언트를 만든다. 오류는 서버 문구 그대로 보여 줄 수 있게 ApiError로 바꾸고 원래 오류는 cause로 남긴다. 로그인 화면으로 돌아갈 오류(401·no_channel)를 가리는 requiresSignIn을 둔다. 개발 서버에는 쓸 수 없는 프록시를 두지 않는다."
```

---

### Task 2: 후보 묶기와 서버 상태 리듀서

**Files:**
- Create: `apps/web/src/domain/candidates.ts`, `apps/web/src/state/serverReducer.ts`
- Test: `apps/web/test/domain/candidates.test.ts`, `apps/web/test/state/serverReducer.test.ts`

**Interfaces:**
- Produces(`domain/candidates.ts`): `CANDIDATE_WINDOW_MS`(10분), `VERDICT_KEEP_MS`(창+1분), `interface SenderGroup { senderChannelId; senderNickname; chatChannelId; verdicts: VerdictDto[]; latestAt }`, `interface CandidateSections { care: SenderGroup[]; shadow: SenderGroup[]; candidates: SenderGroup[]; autoHidePending: VerdictDto[]; autoHidden: VerdictDto[] }`, `buildSections(verdicts, now): CandidateSections`, `countActionable(sections): number`, `addVerdictIfAbsent(verdicts, verdict): VerdictDto[]`, `mergeVerdicts(current, loaded): VerdictDto[]`, `applyVerdictStatus(verdicts, verdictId, status): VerdictDto[]`, `pruneVerdicts(verdicts): VerdictDto[]`
- Produces(`state/serverReducer.ts`): `MAX_CHAT_LINES = 300`, `interface ServerState { status: ServerStatus | null; verdicts: VerdictDto[]; chatLines: ChatLine[]; realtimeConnected: boolean; realtimeRejected: boolean; sessionEndedReason: string | null; loadError: string | null; replayLog: RealtimeEvent[] | null }`, `type ServerAction = { type: "snapshot_started" } | { type: "snapshot_loaded"; status; verdicts } | { type: "snapshot_failed"; message } | { type: "event"; event: RealtimeEvent } | { type: "connection"; connected: boolean } | { type: "realtime_rejected" }`, `initialServerState`, `serverReducer(state, action): ServerState`

초판과 달라진 점: 자동 숨김을 `hidden`(자동 숨김됨)과 `pending`(숨김 대기·실패)으로 가른다(R-4). 판정 목록은 창+1분을 넘기면 지운다(R-11). 조회 결과는 통째로 바꾸지 않고 id로 병합하며, 조회 중에 온 판정·상태 이벤트는 결과 위에 다시 적용한다(X1·R-3).

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/test/domain/candidates.test.ts`:
```ts
import type { VerdictDto } from "@zzirit-guard/shared";
import { describe, expect, it } from "vitest";
import { addVerdictIfAbsent, applyVerdictStatus, buildSections, countActionable, mergeVerdicts, pruneVerdicts, VERDICT_KEEP_MS } from "../../src/domain/candidates";

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
  it("결정별로 나누고, 같은 사람은 한 묶음으로 최신순이며, 자동 숨김은 숨겨진 것과 아직 안 숨겨진 것을 가른다", () => {
    const sections = buildSections(
      [
        verdict(1), verdict(2), verdict(3, { senderChannelId: "viewer-2", senderNickname: "시청자2" }), verdict(4, { decision: "shadow" }),
        verdict(5, { decision: "needs_care" }), verdict(6, { decision: "auto_hide", status: "hidden" }), verdict(7, { decision: "auto_hide" }),
      ],
      NOW,
    );
    expect(sections.candidates.map((group) => [group.senderChannelId, group.verdicts.map((item) => item.id)])).toEqual([["viewer-2", [3]], ["viewer-1", [2, 1]]]);
    expect(sections.shadow.map((group) => group.verdicts.map((item) => item.id))).toEqual([[4]]);
    expect(sections.care).toHaveLength(1);
    expect(sections.autoHidden.map((item) => item.id)).toEqual([6]);
    expect(sections.autoHidePending.map((item) => item.id)).toEqual([7]);
    expect(countActionable(sections)).toBe(5);
  });

  it("처리된 것과 10분이 지난 것은 빼고, 자동 숨김도 10분 안의 것만 둔다(R-19)", () => {
    const old = NOW - 11 * 60 * 1000;
    const sections = buildSections(
      [
        verdict(1, { status: "hidden" }), verdict(2, { createdAt: old }), verdict(3, { decision: "auto_hide", status: "hidden", createdAt: old }),
        verdict(4, { decision: "auto_hide", status: "false_positive" }), verdict(5, { decision: "auto_hide", status: "hidden" }),
      ],
      NOW,
    );
    expect(sections.candidates).toEqual([]);
    expect(sections.autoHidden.map((item) => item.id)).toEqual([5]);
    expect(sections.autoHidePending).toEqual([]);
  });
});

describe("판정 목록 갱신", () => {
  it("새 판정 이벤트는 없던 id만 더한다(이미 있으면 같거나 더 새 상태다)", () => {
    const list = addVerdictIfAbsent([verdict(1, { status: "hidden" })], verdict(2));
    expect(addVerdictIfAbsent(list, verdict(1)).map((item) => [item.id, item.status])).toEqual([[1, "hidden"], [2, "pending"]]);
  });

  it("다시 읽은 목록은 id로 합친다: 같은 id는 읽은 값, 없던 것은 더하고, 기존 것은 남긴다(R-3)", () => {
    const merged = mergeVerdicts([verdict(1), verdict(2)], [verdict(1, { status: "hidden" }), verdict(3)]);
    expect(merged.map((item) => [item.id, item.status])).toEqual([[1, "hidden"], [2, "pending"], [3, "pending"]]);
  });

  it("상태만 바꾼다", () => {
    expect(applyVerdictStatus([verdict(1)], 1, "ignored")[0]?.status).toBe("ignored");
    expect(applyVerdictStatus([verdict(1)], 9, "ignored")[0]?.status).toBe("pending");
  });

  it("가장 새 판정 기준으로 창과 여유를 넘긴 판정을 지운다(R-11)", () => {
    const newest = verdict(2, { createdAt: VERDICT_KEEP_MS + 5_000 });
    expect(pruneVerdicts([verdict(1, { createdAt: 4_000 }), verdict(3, { createdAt: 5_000 }), newest]).map((item) => item.id)).toEqual([3, 2]);
    expect(pruneVerdicts([])).toEqual([]);
  });
});
```

`apps/web/test/state/serverReducer.test.ts`:
```ts
import type { ChatLine, ServerStatus, VerdictDto } from "@zzirit-guard/shared";
import { describe, expect, it } from "vitest";
import { VERDICT_KEEP_MS } from "../../src/domain/candidates";
import { initialServerState, MAX_CHAT_LINES, serverReducer, type ServerAction, type ServerState } from "../../src/state/serverReducer";

/** 상태 예시. */
const status: ServerStatus = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, lastChatAt: null, pendingActions: 0 };

/** 채팅 줄 예시. */
function line(index: number): ChatLine {
  return { senderNickname: "n", content: `c${index}`, messageTime: index, decision: "pass" };
}

/** 판정 예시. */
function verdict(id: number, overrides: Partial<VerdictDto> = {}): VerdictDto {
  return { id, chatChannelId: "c", senderChannelId: "s", senderNickname: "n", content: "x", messageTime: id, decision: "candidate", reason: "rule:weak:1", status: "pending", createdAt: id, ...overrides };
}

/** 동작을 차례로 적용한다. */
function reduce(actions: ServerAction[], from: ServerState = initialServerState): ServerState {
  return actions.reduce(serverReducer, from);
}

describe("serverReducer", () => {
  it("조회 결과를 넣는다", () => {
    const state = reduce([{ type: "snapshot_started" }, { type: "snapshot_loaded", status, verdicts: [verdict(1)] }]);
    expect(state).toMatchObject({ status, verdicts: [verdict(1)], loadError: null, replayLog: null });
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
    expect(reduce([{ type: "event", event: { type: "session_ended", reason: "권한 해제" } }]).sessionEndedReason).toBe("권한 해제");
    expect(reduce([{ type: "connection", connected: true }]).realtimeConnected).toBe(true);
    expect(reduce([{ type: "snapshot_started" }, { type: "snapshot_failed", message: "서버 오류" }])).toMatchObject({ loadError: "서버 오류", replayLog: null });
  });

  it("판정 이벤트와 상태 이벤트를 반영한다", () => {
    const state = reduce([
      { type: "event", event: { type: "verdict", verdict: verdict(1) } },
      { type: "event", event: { type: "verdict_status", verdictId: 1, status: "hidden" } },
      { type: "event", event: { type: "status", status } },
    ]);
    expect(state.verdicts[0]?.status).toBe("hidden");
    expect(state.status).toEqual(status);
  });

  it("조회 중에 온 판정·상태 이벤트는 조회 결과 위에 다시 적용한다(X1)", () => {
    const newerStatus = { ...status, autoHideEnabled: true };
    const state = reduce([
      { type: "snapshot_started" },
      { type: "event", event: { type: "status", status: newerStatus } },
      { type: "event", event: { type: "verdict_status", verdictId: 1, status: "hidden" } },
      { type: "event", event: { type: "verdict", verdict: verdict(2) } },
      { type: "snapshot_loaded", status, verdicts: [verdict(1)] },
    ]);
    expect(state.status).toEqual(newerStatus);
    expect(state.verdicts.map((item) => [item.id, item.status])).toEqual([[1, "hidden"], [2, "pending"]]);
    expect(state.replayLog).toBeNull();
  });

  it("다시 조회하면 기존 판정과 id로 합친다(재연결, R-3)", () => {
    const before = reduce([{ type: "snapshot_started" }, { type: "snapshot_loaded", status, verdicts: [verdict(1), verdict(2)] }]);
    const after = reduce([{ type: "snapshot_started" }, { type: "snapshot_loaded", status, verdicts: [verdict(1, { status: "ignored" }), verdict(3)] }], before);
    expect(after.verdicts.map((item) => [item.id, item.status])).toEqual([[1, "ignored"], [2, "pending"], [3, "pending"]]);
  });

  it("새 판정이 오면 창과 여유를 넘긴 판정을 지운다(R-11)", () => {
    const state = reduce([
      { type: "event", event: { type: "verdict", verdict: verdict(1, { createdAt: 0 }) } },
      { type: "event", event: { type: "verdict", verdict: verdict(2, { createdAt: VERDICT_KEEP_MS + 1 }) } },
    ]);
    expect(state.verdicts.map((item) => item.id)).toEqual([2]);
  });

  it("실시간 연결이 거듭 거절되면 표시하고, 다시 연결되면 지운다(R-6)", () => {
    const rejected = reduce([{ type: "connection", connected: true }, { type: "realtime_rejected" }]);
    expect(rejected).toMatchObject({ realtimeRejected: true, realtimeConnected: false });
    expect(serverReducer(rejected, { type: "connection", connected: true }).realtimeRejected).toBe(false);
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

/**
 * 후보 화면에 보여 줄 기간(최근 10분, 스펙 6장).
 * 서버 CANDIDATE_WINDOW_MS(apps/server/src/http/constants.ts)와 같아야 한다. shared는 타입만 내보내 런타임 값을 옮길 수 없어 복사했다(R-20).
 */
export const CANDIDATE_WINDOW_MS = 10 * 60 * 1000;
/**
 * 판정을 화면 메모리에 남기는 기간: 후보 창 + 1분 여유.
 * 왜: 창을 넘긴 판정은 어차피 보이지 않는데 남겨 두면 섀도 떼도배 몇 번에 수천 건이 쌓여 휴대폰이 느려진다(R-11). 여유는 시계 차이를 흡수한다.
 */
export const VERDICT_KEEP_MS = CANDIDATE_WINDOW_MS + 60_000;

/** 한 사람의 판정 묶음. 매니저는 사람 단위로 제재한다. */
export interface SenderGroup {
  /** 보낸 사람 채널 ID(묶음의 키, 임시 제한 대상). */
  senderChannelId: string;
  /** 보낸 사람 닉네임(가장 최근 판정의 값). */
  senderNickname: string;
  /** 임시 제한 API에 넘길 채팅 채널 ID. */
  chatChannelId: string;
  /** 이 사람의 판정(최신순). */
  verdicts: VerdictDto[];
  /** 가장 최근 판정 시각. 묶음 정렬에 쓴다. */
  latestAt: number;
}

/** 후보 화면의 구역. 도움 필요·섀도·후보는 처리 전(pending)만 사람 단위로 묶는다. */
export interface CandidateSections {
  /** 도움 필요(자해·자살 신호). 1단계에는 생기지 않는다(AI는 2단계). */
  care: SenderGroup[];
  /** 스위치가 켜져 있었으면 숨겼을 메시지(섀도). */
  shadow: SenderGroup[];
  /** 매니저 확인이 필요한 후보. */
  candidates: SenderGroup[];
  /**
   * 자동 숨김 판정인데 아직 숨겨지지 않은 것(최신순). 실행 대기 중이거나, 스위치가 꺼져 취소됐거나, 재시도를 다 써도 실패한 것이다.
   * 왜 따로 두나: "자동 숨김됨"에 섞으면 숨겨지지 않은 메시지가 숨겨진 것처럼 보이고 숨길 버튼도 없어 조용히 사라진다(R-4).
   */
  autoHidePending: VerdictDto[];
  /** 실제로 숨겨진 자동 숨김(status hidden, 최신순). 잘못 숨겼으면 오판으로 신고한다. */
  autoHidden: VerdictDto[];
}

/** 판정 목록을 화면 구역으로 나눈다. now보다 CANDIDATE_WINDOW_MS 넘게 지난 판정은 뺀다. */
export function buildSections(verdicts: readonly VerdictDto[], now: number): CandidateSections {
  const recent = verdicts.filter((verdict) => verdict.createdAt >= now - CANDIDATE_WINDOW_MS);
  const pick = (decision: VerdictDto["decision"], status: VerdictStatus) => recent.filter((verdict) => verdict.decision === decision && verdict.status === status);
  return {
    care: groupBySender(pick("needs_care", "pending")),
    shadow: groupBySender(pick("shadow", "pending")),
    candidates: groupBySender(pick("candidate", "pending")),
    autoHidePending: pick("auto_hide", "pending").sort(newestFirst),
    autoHidden: pick("auto_hide", "hidden").sort(newestFirst),
  };
}

/** 처리를 기다리는 항목 수: 사람 묶음(도움 필요·섀도·후보) 수 + 숨기지 못한 자동 숨김 건수. 탭 배지와 "후보 없음" 판단에 쓴다. */
export function countActionable(sections: CandidateSections): number {
  return sections.care.length + sections.shadow.length + sections.candidates.length + sections.autoHidePending.length;
}

/**
 * 실시간 verdict 이벤트(새 판정)를 더한다. 이미 있는 id면 그대로 둔다.
 * 왜: verdict 이벤트는 판정이 만들어질 때 한 번만 온다. 이미 있는 것은 같은 판정이거나 그 뒤 상태가 바뀐 것이라 더 새롭다.
 */
export function addVerdictIfAbsent(verdicts: readonly VerdictDto[], verdict: VerdictDto): VerdictDto[] {
  return verdicts.some((item) => item.id === verdict.id) ? [...verdicts] : [...verdicts, verdict];
}

/**
 * REST로 다시 읽은 판정을 id로 합친다. 같은 id는 읽은 값으로 바꾸고(끊긴 동안 바뀐 상태를 반영), 없던 것은 더하고, 목록에 없는 기존 판정은 남긴다.
 * 결과는 id 순서(저장 순서)로 정렬한다.
 * 왜 통째로 바꾸지 않나: 조회와 실시간 연결이 함께 시작돼, 먼저 온 실시간 판정을 덮어쓰면 사라지기 때문이다(X1, R-3).
 */
export function mergeVerdicts(current: readonly VerdictDto[], loaded: readonly VerdictDto[]): VerdictDto[] {
  const byId = new Map(current.map((verdict) => [verdict.id, verdict]));
  for (const verdict of loaded) byId.set(verdict.id, verdict);
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

/** 상태만 바꾼다. 없는 id면 그대로 둔다. */
export function applyVerdictStatus(verdicts: readonly VerdictDto[], verdictId: number, status: VerdictStatus): VerdictDto[] {
  return verdicts.map((item) => (item.id === verdictId ? { ...item, status } : item));
}

/**
 * 가장 새 판정의 시각에서 VERDICT_KEEP_MS보다 오래된 판정을 지운다(R-11).
 * 왜 휴대폰 시계가 아니라 판정 시각(서버 시계)을 기준으로 하나: 휴대폰 시계가 틀려도 보여야 할 판정을 지우지 않게 하려는 것이다.
 */
export function pruneVerdicts(verdicts: readonly VerdictDto[]): VerdictDto[] {
  if (verdicts.length === 0) return [];
  const cutoff = Math.max(...verdicts.map((verdict) => verdict.createdAt)) - VERDICT_KEEP_MS;
  return verdicts.filter((verdict) => verdict.createdAt >= cutoff);
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
import { addVerdictIfAbsent, applyVerdictStatus, mergeVerdicts, pruneVerdicts } from "../domain/candidates";

/** 실시간 채팅 화면에 남길 최대 줄 수. 초당 수십 건이어도 휴대폰이 버티게 한다. */
export const MAX_CHAT_LINES = 300;

/** 화면이 쓰는 서버 상태. */
export interface ServerState {
  /** 서버 상태(상태 배너·스위치). 아직 모르면 null. */
  status: ServerStatus | null;
  /** 최근 판정. 창과 여유(VERDICT_KEEP_MS)를 넘긴 것은 지운다. */
  verdicts: VerdictDto[];
  /** 실시간 채팅 줄(최근 MAX_CHAT_LINES개). */
  chatLines: ChatLine[];
  /** 실시간 연결이 열려 서버 메시지를 받고 있는지. */
  realtimeConnected: boolean;
  /** 실시간 연결이 거듭 거절돼(4003) 다시 연결을 멈췄는지(R-6). */
  realtimeRejected: boolean;
  /** 세션이 끝난 이유. 값이 생기면 로그인 화면으로 돌아간다. */
  sessionEndedReason: string | null;
  /** 마지막 조회 실패 문구. 성공하면 지운다. */
  loadError: string | null;
  /**
   * 조회(snapshot)가 진행 중일 때 받은 판정·상태 이벤트. 조회 결과를 넣은 뒤 그 위에 다시 적용한다. 조회 중이 아니면 null.
   * 왜: 조회 결과는 요청 시점의 사진이라, 응답을 기다리는 동안 온 이벤트보다 오래됐을 수 있다(X1).
   */
  replayLog: RealtimeEvent[] | null;
}

/** 상태를 바꾸는 동작. 조회는 snapshot_started → snapshot_loaded·snapshot_failed 순서로 하나씩만 진행한다(useServerState가 보장). */
export type ServerAction =
  | { type: "snapshot_started" }
  | { type: "snapshot_loaded"; status: ServerStatus; verdicts: VerdictDto[] }
  | { type: "snapshot_failed"; message: string }
  | { type: "event"; event: RealtimeEvent }
  | { type: "connection"; connected: boolean }
  | { type: "realtime_rejected" };

/** 처음 상태. */
export const initialServerState: ServerState = {
  status: null, verdicts: [], chatLines: [], realtimeConnected: false, realtimeRejected: false, sessionEndedReason: null, loadError: null, replayLog: null,
};

/** 조회 중에 기록해 두었다가 다시 적용할 이벤트 종류. 채팅 줄·세션 종료는 다시 적용할 필요가 없다. */
const REPLAYED_EVENT_TYPES: ReadonlySet<RealtimeEvent["type"]> = new Set(["verdict", "verdict_status", "status"]);

/** 순수 리듀서. 화면 로직을 테스트할 수 있게 부수 효과 없이 둔다. */
export function serverReducer(state: ServerState, action: ServerAction): ServerState {
  switch (action.type) {
    case "snapshot_started":
      return { ...state, replayLog: [] };
    case "snapshot_loaded":
      return applySnapshot(state, action.status, action.verdicts);
    case "snapshot_failed":
      return { ...state, loadError: action.message, replayLog: null };
    case "connection":
      return { ...state, realtimeConnected: action.connected, realtimeRejected: action.connected ? false : state.realtimeRejected };
    case "realtime_rejected":
      return { ...state, realtimeConnected: false, realtimeRejected: true };
    case "event":
      return recordForReplay(applyEvent(state, action.event), action.event);
  }
}

/** 조회 결과를 합치고, 조회 중에 받은 이벤트를 그 위에 다시 적용한다. */
function applySnapshot(state: ServerState, status: ServerStatus, verdicts: readonly VerdictDto[]): ServerState {
  const base: ServerState = { ...state, status, verdicts: pruneVerdicts(mergeVerdicts(state.verdicts, verdicts)), loadError: null, replayLog: null };
  return (state.replayLog ?? []).reduce(applyEvent, base);
}

/** 조회 중이면 판정·상태 이벤트를 기록해 둔다. */
function recordForReplay(state: ServerState, event: RealtimeEvent): ServerState {
  if (!state.replayLog || !REPLAYED_EVENT_TYPES.has(event.type)) return state;
  return { ...state, replayLog: [...state.replayLog, event] };
}

/** 실시간 이벤트 반영. */
function applyEvent(state: ServerState, event: RealtimeEvent): ServerState {
  switch (event.type) {
    case "verdict":
      return { ...state, verdicts: pruneVerdicts(addVerdictIfAbsent(state.verdicts, event.verdict)) };
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
Expected: PASS (21 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web/src/domain apps/web/src/state/serverReducer.ts apps/web/test/domain apps/web/test/state
git commit -m "feat: 후보 묶기와 서버 상태 리듀서 추가" -m "후보를 도움 필요·섀도·후보 구역으로 사람 단위로 묶고, 자동 숨김은 숨겨진 것과 아직 숨겨지지 않은 것을 가른다. 판정은 창과 여유를 넘기면 지우고, 다시 읽은 결과는 id로 병합하며 조회 중에 온 이벤트를 그 위에 다시 적용한다. 채팅 줄은 최근 300개만 남긴다."
```

---

### Task 3: 실시간 연결(WebSocket)

**Files:**
- Create: `apps/web/src/api/realtime.ts`
- Test: `apps/web/test/api/realtime.test.ts`

**Interfaces:**
- Consumes: `apiSend`·`requiresSignIn`·`API_BASE`(Task 1)
- Produces: `interface SocketLike { onmessage: ((event: { data: unknown }) => void) | null; onclose: ((event: { code: number }) => void) | null; close(): void }`, `interface RealtimeOptions { onEvent(event: RealtimeEvent): void; onConnectionChange(connected: boolean): void; onSessionEnded(reason: string): void; onRejected(): void; issueTicket?: () => Promise<string>; openSocket?: (url: string) => SocketLike; schedule?: (callback: () => void, ms: number) => void }`, `reconnectDelayMs(attempt): number`, `websocketUrl(ticket, base?, origin?): string`, `class RealtimeConnection { constructor(options); start(): void; stop(): void }`

초판과 달라진 점: "연결됨"은 열린 뒤 **첫 메시지**를 받았을 때다. 서버가 업그레이드 뒤에 티켓·출처를 확인해 4003으로 닫으므로, 초판처럼 onopen에서 백오프를 되돌리면 4003 때 1초 간격으로 끝없이 재연결한다(A23·R-6). 4003이 3번 이어지면 멈추고 `onRejected`를 부른다. 티켓 발급이 401뿐 아니라 409 `no_channel`이어도 세션 종료로 본다(R-12). 메시지 없이 4001만 와도 멈춘다(R-19).

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/test/api/realtime.test.ts`:
```ts
import type { RealtimeEvent } from "@zzirit-guard/shared";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/client";
import { RealtimeConnection, reconnectDelayMs, websocketUrl, type SocketLike } from "../../src/api/realtime";

/** 직접 조작하는 가짜 소켓. */
function fakeSocket(): SocketLike & { closed: boolean } {
  return { onmessage: null, onclose: null, closed: false, close() { this.closed = true; } };
}

/** 대기 중인 비동기 처리를 흘려보낸다. */
async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 서버가 연결 직후 보내는 status 메시지. */
const STATUS_MESSAGE = JSON.stringify({ type: "status", status: { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, lastChatAt: null, pendingActions: 0 } });

/** 테스트용 연결과 기록. */
function setup(issueTicket: () => Promise<string> = async () => "ticket-1") {
  const sockets: Array<SocketLike & { closed: boolean }> = [];
  const urls: string[] = [];
  const scheduled: number[] = [];
  const events: RealtimeEvent[] = [];
  const connection: { states: boolean[]; ended: string[]; rejected: number } = { states: [], ended: [], rejected: 0 };
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
    onRejected: () => {
      connection.rejected += 1;
    },
  });
  /** 예약된 재연결을 실행하고 티켓 발급을 기다린다. */
  const runPending = async () => {
    pending?.();
    await flushPromises();
  };
  /** 마지막 소켓을 메시지 없이 code로 닫는다(열렸다가 서버가 바로 닫은 경우). */
  const closeWithoutMessage = (code: number) => sockets.at(-1)?.onclose?.({ code });
  return { realtime, sockets, urls, scheduled, events, connection, runPending, closeWithoutMessage };
}

describe("RealtimeConnection", () => {
  it("티켓으로 연결하고, 첫 메시지를 받아야 연결됨으로 알리며 이벤트를 넘긴다", async () => {
    const { realtime, sockets, urls, events, connection } = setup();
    realtime.start();
    await flushPromises();
    expect(urls[0]).toMatch(/\/ws\?ticket=ticket-1$/);
    expect(connection.states).toEqual([]);
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
    await runPending();
    expect(issueTicket).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
  });

  it("세션 종료 메시지가 오면 다시 연결하지 않고 그 이유를 알린다", async () => {
    const { realtime, sockets, scheduled, connection } = setup();
    realtime.start();
    await flushPromises();
    sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "session_ended", reason: "권한 해제" }) });
    sockets[0]?.onclose?.({ code: 4001 });
    expect(connection.ended).toEqual(["권한 해제"]);
    expect(scheduled).toEqual([]);
  });

  it("메시지 없이 4001로만 닫혀도 다시 연결하지 않고 로그인이 필요하다고 알린다(R-19)", async () => {
    const { realtime, sockets, scheduled, connection } = setup();
    realtime.start();
    await flushPromises();
    sockets[0]?.onclose?.({ code: 4001 });
    expect(connection.ended).toEqual(["세션이 종료되었습니다. 다시 로그인하세요."]);
    expect(scheduled).toEqual([]);
  });

  it.each([
    [new ApiError(401, "unauthorized", "로그인이 필요합니다.")],
    [new ApiError(409, "no_channel", "연결된 채널이 없습니다. 스트리머가 먼저 채널을 연결하세요.")],
  ])("티켓 발급이 %s이면 다시 연결하지 않고 서버 문구로 알린다(R-12)", async (error) => {
    const { realtime, connection, scheduled } = setup(async () => {
      throw error;
    });
    realtime.start();
    await flushPromises();
    expect(connection.ended).toEqual([error.message]);
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

  it("열리기만 하고 메시지 없이 닫히면 백오프를 처음으로 되돌리지 않는다(R-6)", async () => {
    const { realtime, scheduled, runPending, closeWithoutMessage } = setup();
    realtime.start();
    await flushPromises();
    closeWithoutMessage(1006);
    await runPending();
    closeWithoutMessage(1006);
    expect(scheduled).toEqual([1000, 2000]);
  });

  it("4003으로 3번 이어서 거절되면 멈추고 알리며, start()로 다시 시작할 수 있다(R-6)", async () => {
    const issueTicket = vi.fn(async () => "ticket");
    const { realtime, scheduled, connection, runPending, closeWithoutMessage } = setup(issueTicket);
    realtime.start();
    await flushPromises();
    closeWithoutMessage(4003);
    await runPending();
    closeWithoutMessage(4003);
    await runPending();
    closeWithoutMessage(4003);
    expect(scheduled).toEqual([1000, 2000]);
    expect(connection.rejected).toBe(1);
    realtime.start();
    await flushPromises();
    expect(issueTicket).toHaveBeenCalledTimes(4);
  });

  it("메시지를 받으면 백오프와 거절 횟수를 처음부터 센다", async () => {
    const { realtime, sockets, scheduled, runPending } = setup();
    realtime.start();
    await flushPromises();
    sockets[0]?.onclose?.({ code: 1006 });
    await runPending();
    sockets[1]?.onmessage?.({ data: STATUS_MESSAGE });
    sockets[1]?.onclose?.({ code: 1006 });
    expect(scheduled).toEqual([1000, 1000]);
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
import { API_BASE, apiSend, requiresSignIn } from "./client";

/** 연결에 필요한 WebSocket 기능. 테스트에서 가짜로 바꾼다. onopen은 쓰지 않는다(연결됨은 첫 메시지로 판단, RealtimeOptions 참고). */
export interface SocketLike {
  /** 서버 메시지를 받았을 때. */
  onmessage: ((event: { data: unknown }) => void) | null;
  /** 연결이 닫혔을 때(닫기 코드 포함). */
  onclose: ((event: { code: number }) => void) | null;
  /** 연결을 닫는다. */
  close(): void;
}

/** RealtimeConnection 옵션. issueTicket·openSocket·schedule은 테스트에서 바꿔 끼운다. */
export interface RealtimeOptions {
  /** 판정·상태·채팅 이벤트를 받는다(session_ended는 onSessionEnded로 간다). */
  onEvent(event: RealtimeEvent): void;
  /**
   * 연결 상태가 바뀔 때. true는 열린 뒤 첫 메시지를 받았을 때다.
   * 왜 onopen이 아닌가: 서버는 업그레이드를 마친 뒤에 티켓·출처를 확인하고 실패하면 4003으로 닫으므로, 열렸다고 인증된 것이 아니다.
   * 인증된 연결에는 곧바로 status를 보낸다(server.ts registerWebSocket).
   */
  onConnectionChange(connected: boolean): void;
  /** 세션이 끝나 로그인 화면으로 가야 할 때(4001·session_ended·티켓 401·409 no_channel). */
  onSessionEnded(reason: string): void;
  /** 4003 거절이 MAX_CONSECUTIVE_REJECTIONS번 이어져 다시 연결을 멈췄을 때. */
  onRejected(): void;
  /** 티켓 발급(기본: POST /api/ws-ticket). */
  issueTicket?: () => Promise<string>;
  /** 소켓 열기(기본: 브라우저 WebSocket). */
  openSocket?: (url: string) => SocketLike;
  /** 재연결 예약(기본: setTimeout). */
  schedule?: (callback: () => void, ms: number) => void;
}

/** 서버가 세션을 끝낼 때 쓰는 닫기 코드(hub.ts). */
const SESSION_ENDED_CLOSE_CODE = 4001;
/** 티켓이 틀렸거나 출처가 다를 때 서버가 쓰는 닫기 코드(server.ts). */
const REJECTED_CLOSE_CODE = 4003;
/**
 * 4003을 이만큼 이어서 받으면 다시 연결을 멈춘다.
 * 왜: 출처 불일치(다른 주소로 접속)는 재시도해도 낫지 않는데, 멈추지 않으면 그때마다 티켓을 발급받으며 끝없이 되풀이한다(R-6).
 */
const MAX_CONSECUTIVE_REJECTIONS = 3;
/** 재연결 대기 시간의 시작값(1초). 시도마다 두 배로 늘린다. */
const BACKOFF_BASE_MS = 1000;
/** 재연결 대기 시간의 최댓값(30초, 스펙 10장). */
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

/** 서버와의 실시간 연결. 끊기면 새 티켓으로 다시 연결하고, 세션이 끝났거나 거듭 거절되면 멈춘다. */
export class RealtimeConnection {
  /** 지금 열려 있거나 여는 중인 소켓. */
  private socket: SocketLike | null = null;
  /** stop()을 불렀거나 아직 start()하지 않았으면 true. 비동기 처리 중에 멈췄는지 확인하는 데 쓴다. */
  private stopped = true;
  /** 연이은 재연결 시도 횟수. 백오프에 쓰고, 서버 메시지를 받으면 0으로 되돌린다. */
  private attempt = 0;
  /** 연이은 4003 거절 횟수. 서버 메시지를 받으면 0으로 되돌린다. */
  private rejections = 0;
  /** 티켓 발급 함수. */
  private readonly issueTicket: () => Promise<string>;
  /** 소켓 여는 함수. */
  private readonly openSocket: (url: string) => SocketLike;
  /** 재연결 예약 함수. */
  private readonly schedule: (callback: () => void, ms: number) => void;

  /** @param options 이벤트 수신자와(테스트용) 바꿔 끼울 함수 */
  constructor(private readonly options: RealtimeOptions) {
    this.issueTicket = options.issueTicket ?? requestTicket;
    this.openSocket = options.openSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.schedule = options.schedule ?? ((callback, ms) => void setTimeout(callback, ms));
  }

  /** 연결을 시작한다. 이미 돌고 있으면 무시한다. 거절로 멈춘 뒤 다시 부르면 처음부터 센다. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.rejections = 0;
    void this.connect();
  }

  /** 연결을 멈추고 소켓을 닫는다. 이후 닫힘·예약된 재연결은 무시된다. */
  stop(): void {
    this.stopped = true;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  /** 티켓을 받아 소켓을 연다. 로그인이 필요한 오류(401·no_channel)면 세션 종료, 그 밖의 실패는 재연결. */
  private async connect(): Promise<void> {
    try {
      const ticket = await this.issueTicket();
      if (this.stopped) return;
      this.attach(this.openSocket(websocketUrl(ticket)));
    } catch (error) {
      if (requiresSignIn(error)) return this.endSession(error.message);
      console.warn("실시간 연결 티켓 발급 실패, 다시 시도합니다", error);
      this.scheduleReconnect();
    }
  }

  /** 소켓 이벤트를 연결한다. 연결됨 표시는 첫 메시지에서 한다(RealtimeOptions.onConnectionChange 참고). */
  private attach(socket: SocketLike): void {
    this.socket = socket;
    let received = false;
    socket.onmessage = (event) => {
      if (!received) this.markConnected();
      received = true;
      this.handleMessage(event.data);
    };
    socket.onclose = (event) => this.handleClose(socket, event.code);
  }

  /** 인증된 연결을 확인했다: 백오프·거절 횟수를 처음으로 되돌리고 알린다. */
  private markConnected(): void {
    this.attempt = 0;
    this.rejections = 0;
    this.options.onConnectionChange(true);
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

  /** 닫힘 처리: 4001이면 세션 종료, 4003이 이어지면 멈춤, 그 밖에는 백오프 재연결. */
  private handleClose(socket: SocketLike, code: number): void {
    if (this.socket === socket) this.socket = null;
    this.options.onConnectionChange(false);
    if (this.stopped) return;
    if (code === SESSION_ENDED_CLOSE_CODE) return this.endSession("세션이 종료되었습니다. 다시 로그인하세요.");
    if (code === REJECTED_CLOSE_CODE && ++this.rejections >= MAX_CONSECUTIVE_REJECTIONS) return this.giveUp();
    this.scheduleReconnect();
  }

  /** 세션 종료: 멈추고 한 번만 알린다. */
  private endSession(reason: string): void {
    if (this.stopped) return;
    this.stop();
    this.options.onSessionEnded(reason);
  }

  /** 거절이 이어져 멈춘다. 화면이 /api/me를 다시 확인하고 이유를 보여 준다. */
  private giveUp(): void {
    this.stop();
    this.options.onRejected();
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
Expected: PASS (33 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web/src/api/realtime.ts apps/web/test/api/realtime.test.ts
git commit -m "feat: 실시간 WebSocket 연결 추가" -m "일회용 티켓으로 연결하고 끊기면 1~30초 백오프로 새 티켓을 받아 다시 연결한다. 연결됨과 백오프 초기화는 첫 메시지를 받았을 때만 하고, 4003 거절이 3번 이어지면 멈춘다. 세션 종료(4001·session_ended·티켓 401·no_channel)면 멈추고 로그인으로 보낸다."
```

---
### Task 4: 후보 화면

**Files:**
- Create: `apps/web/src/domain/verdictReason.ts`, `apps/web/src/domain/timeFormat.ts`
- Create: `apps/web/src/components/StatusBanner.tsx`, `apps/web/src/components/AutoHideToggle.tsx`, `apps/web/src/components/CandidateGroupCard.tsx`, `apps/web/src/components/AutoHideLists.tsx`, `apps/web/src/screens/CandidatesScreen.tsx`
- Test: `apps/web/test/domain/verdictReason.test.ts`, `apps/web/test/screens/CandidatesScreen.test.tsx`

**Interfaces:**
- Consumes: `buildSections`·`countActionable`·`CandidateSections`·`SenderGroup`(Task 2), `ApiError`·`describeApiError`(Task 1), shared 타입
- Produces(`domain`): `describeReason(reason: string): string`, `ruleIdOf(reason: string): number | null`, `formatClockTime(timestampMs: number): string`, `formatDateTime(timestampMs: number | null): string`
- Produces(`screens/CandidatesScreen.tsx`): `interface CandidateActions { hide(verdict): Promise<string | null>; temporaryRestrict(group: SenderGroup): Promise<string | null>; ignore(verdict): Promise<string | null>; reportFalsePositive(verdict): Promise<string | null>; setAutoHide(enabled: boolean): Promise<string | null> }`(성공 시 화면에 보여 줄 안내), `type ActionRunner = (task: () => Promise<string | null>) => void`, `CandidatesScreen(props: { me: MeDto; status: ServerStatus | null; sections: CandidateSections; realtimeConnected: boolean; actions: CandidateActions; onReload(): void })`
- Produces(`components`): `StatusBanner(props: { status: ServerStatus | null; realtimeConnected: boolean })`, `AutoHideToggle(props: { enabled: boolean | null; canEnable: boolean; canDisable: boolean; onChange(enabled: boolean): void })`, `type GroupKind = "care" | "shadow" | "candidate"`, `CandidateGroupCard(props: { group: SenderGroup; kind: GroupKind; permissions: readonly Permission[]; run: ActionRunner; actions: CandidateActions })`, `AutoHidePendingList(props: AutoHideListProps)`, `AutoHiddenList(props: AutoHideListProps)`(`{ verdicts; canHide; run; actions }`)

초판과 달라진 점: 모든 판정 줄에 이유(규칙 번호, `:privileged` 포함)를 보여 준다(스펙 5.5, R-5). 자동 숨김 판정 중 아직 숨겨지지 않은 것은 "숨김 대기·실패"에 숨기기·오판 버튼과 함께 펼쳐 둔다(R-4). 성공 안내(`note`)를 보여 주고, 409 `already_handled`면 목록을 다시 읽으며, 늘 보이는 "다시 불러오기" 버튼을 둔다(R-13, iOS 홈 화면 앱에는 새로고침이 없다). 구역은 MainScreen이 한 번 계산해 내려 준다(B8). 서버 상태를 모르면 스위치를 누를 수 없다(B4 표).

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/test/domain/verdictReason.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { describeReason, ruleIdOf } from "../../src/domain/verdictReason";

describe("describeReason", () => {
  it.each([
    ["rule:strong:12", "금칙어 강 #12"],
    ["rule:strong_spanning:3", "금칙어 강(띄어 쓰거나 단어를 걸침) #3"],
    ["rule:weak:7:privileged", "금칙어 약 #7 · 스트리머·매니저 메시지라 후보로 낮춤"],
    ["rule:group_flood", "떼도배"],
    ["rule:group_flood:privileged", "떼도배 · 스트리머·매니저 메시지라 후보로 낮춤"],
    ["rule:watch_user", "요주의 사용자(최근 180일 조치 이력)"],
    ["model:kanana", "model:kanana"],
    ["rule:toString", "rule:toString"],
  ])("%s → %s", (reason, expected) => {
    expect(describeReason(reason)).toBe(expected);
  });

  it("규칙 번호를 꺼낸다", () => {
    expect([ruleIdOf("rule:strong:12"), ruleIdOf("rule:weak:7:privileged"), ruleIdOf("rule:link"), ruleIdOf("model:x")]).toEqual([12, 7, null, null]);
  });
});
```

`apps/web/test/screens/CandidatesScreen.test.tsx`:
```tsx
import type { MeDto, ServerStatus, VerdictDto } from "@zzirit-guard/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/client";
import { buildSections } from "../../src/domain/candidates";
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

/** 모든 동작이 안내 없이 성공하는 가짜. */
function fakeActions(overrides: Partial<CandidateActions> = {}): CandidateActions {
  const succeed = async () => null;
  return { hide: vi.fn(succeed), temporaryRestrict: vi.fn(succeed), ignore: vi.fn(succeed), reportFalsePositive: vi.fn(succeed), setAutoHide: vi.fn(succeed), ...overrides };
}

/** 화면을 그린다. status를 null로 넘기면 서버 상태를 아직 모르는 경우다. */
function renderScreen(verdicts: VerdictDto[], actions = fakeActions(), currentStatus: ServerStatus | null = status) {
  const onReload = vi.fn();
  render(<CandidatesScreen me={chatManager} status={currentStatus} sections={buildSections(verdicts, NOW)} realtimeConnected actions={actions} onReload={onReload} />);
  return { actions, onReload };
}

describe("CandidatesScreen", () => {
  it("사람 단위로 묶어 건수와 메시지를 보여 주고, 섀도는 따로 보여 준다", () => {
    renderScreen([verdict(1), verdict(2), verdict(3, { decision: "shadow", senderNickname: "도배러", senderChannelId: "spam" })]);
    expect(screen.getByText("악플러")).toBeTruthy();
    expect(screen.getByText("2건")).toBeTruthy();
    expect(screen.getByText("나쁜 말 1")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /켜져 있었으면 숨겼을 메시지/ })).toBeTruthy();
  });

  it("판정마다 이유(규칙 번호)를 보여 준다(R-5)", () => {
    renderScreen([verdict(1, { reason: "rule:strong_spanning:4" })]);
    expect(screen.getByText("금칙어 강(띄어 쓰거나 단어를 걸침) #4")).toBeTruthy();
  });

  it("숨기기를 누르면 그 판정으로 동작을 부른다", async () => {
    const { actions } = renderScreen([verdict(1)]);
    await userEvent.click(screen.getByRole("button", { name: "숨기기" }));
    expect(actions.hide).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("채팅 운영자는 자동 숨김을 켤 수 없다(버튼 비활성)", () => {
    renderScreen([]);
    expect((screen.getByRole("button", { name: /자동 숨김: 꺼짐/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("서버 상태를 아직 모르면 스위치를 누를 수 없다", () => {
    renderScreen([], fakeActions(), null);
    expect((screen.getByRole("button", { name: "자동 숨김: 확인 중" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("실패하면 서버가 준 이유를 보여 준다", async () => {
    renderScreen([verdict(1)], fakeActions({ hide: async () => { throw new ApiError(502, "chzzk_failed", "치지직 호출 한도를 넘었습니다. 잠시 뒤 다시 시도하세요."); } }));
    await userEvent.click(screen.getByRole("button", { name: "숨기기" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/호출 한도/));
  });

  it("성공하면 서버 안내(note)를 보여 준다(R-13)", async () => {
    renderScreen([verdict(1)], fakeActions({ hide: async () => "이미 사라진 메시지입니다" }));
    await userEvent.click(screen.getByRole("button", { name: "숨기기" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("이미 사라진 메시지입니다"));
  });

  it("이미 처리된 판정(409 already_handled)이면 이유를 보여 주고 목록을 다시 읽는다(R-13)", async () => {
    const conflict = new ApiError(409, "already_handled", "이미 다른 조치가 끝난 판정입니다. 화면을 새로고침해 현재 상태를 확인하세요.");
    const { onReload } = renderScreen([verdict(1)], fakeActions({ ignore: async () => { throw conflict; } }));
    await userEvent.click(screen.getByRole("button", { name: "무시" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/이미 다른 조치가 끝난 판정/));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("'다시 불러오기'를 누르면 목록을 다시 읽는다(iOS 홈 화면 앱에는 새로고침이 없다)", async () => {
    const { onReload } = renderScreen([]);
    await userEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("아직 숨겨지지 않은 자동 숨김은 '숨김 대기·실패'에 숨기기 버튼과 함께, 숨겨진 것만 '자동 숨김됨'에 보여 준다(R-4)", async () => {
    const { actions } = renderScreen([
      verdict(1, { decision: "auto_hide", content: "못 숨긴 광고" }),
      verdict(2, { decision: "auto_hide", status: "hidden", content: "숨긴 광고" }),
    ]);
    const pendingSection = screen.getByRole("heading", { name: /숨김 대기·실패\(1건\)/ }).closest("section") as HTMLElement;
    expect(pendingSection.textContent).toContain("못 숨긴 광고");
    expect(pendingSection.textContent).not.toContain("숨긴 광고 ");
    expect(screen.getByText(/자동 숨김됨\(최근 10분, 1건\)/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "숨기기" }));
    expect(actions.hide).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
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

`apps/web/src/domain/verdictReason.ts`:
```ts
/**
 * 판정 이유의 규칙 종류별 이름. 키는 서버 판정 이유 "rule:<종류>[:<규칙 번호>]"의 <종류>다(apps/server/src/detection/pipeline.ts decide).
 * 왜 Map인가: 객체 표로 두면 "rule:toString" 같은 값이 프로토타입 함수를 꺼내 이름으로 보여 준다.
 */
const RULE_LABELS: ReadonlyMap<string, string> = new Map([
  ["strong", "금칙어 강"], ["strong_spanning", "금칙어 강(띄어 쓰거나 단어를 걸침)"], ["weak", "금칙어 약"], ["threat", "협박 표현"],
  ["group_flood", "떼도배"], ["personal_flood", "개인 도배"], ["link", "광고 링크"], ["phone", "전화번호"], ["address", "주소"],
  ["watch_user", "요주의 사용자(최근 180일 조치 이력)"], ["allow", "허용어"],
]);
/** 스트리머·매니저 본인 메시지라 자동 숨김 대신 후보로 낮췄다는 꼬리표(pipeline.ts applyPrivilege). */
const PRIVILEGED_SUFFIX = ":privileged";
/** 규칙 번호가 든 이유의 모양: rule:<종류>:<번호>[:privileged]. */
const RULE_ID_PATTERN = /^rule:[a-z_]+:(\d+)(?::privileged)?$/;

/**
 * 판정 이유를 매니저가 읽을 수 있는 문구로 바꾼다(스펙 5.5 "자동 숨김마다 이유(규칙 번호)를 표시").
 * 모르는 이유(2단계 AI 판정 등)는 원문 그대로 보여 준다.
 * @param reason 서버 판정 이유(예: rule:strong:12, rule:group_flood:privileged)
 * @returns 예: "금칙어 강 #12", "떼도배 · 스트리머·매니저 메시지라 후보로 낮춤"
 */
export function describeReason(reason: string): string {
  const privileged = reason.endsWith(PRIVILEGED_SUFFIX);
  const [prefix, kind, ruleId] = (privileged ? reason.slice(0, -PRIVILEGED_SUFFIX.length) : reason).split(":");
  const label = prefix === "rule" && kind ? RULE_LABELS.get(kind) : undefined;
  if (!label) return reason;
  return `${label}${ruleId ? ` #${ruleId}` : ""}${privileged ? " · 스트리머·매니저 메시지라 후보로 낮춤" : ""}`;
}

/** 이유에서 규칙 번호를 꺼낸다. 규칙 번호가 없는 이유(떼도배·링크 등)면 null. 오판 검토 목록이 규칙 내용을 찾을 때 쓴다. */
export function ruleIdOf(reason: string): number | null {
  const match = RULE_ID_PATTERN.exec(reason);
  return match ? Number(match[1]) : null;
}
```

`apps/web/src/domain/timeFormat.ts`:
```ts
/** 시각을 "14:03:21"처럼 시·분·초로 보여 준다. 후보 카드처럼 최근 10분 안의 시각에 쓴다. */
export function formatClockTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** 날짜와 시각을 함께 보여 준다. 값이 없으면 "—". 상태 점검·감사 기록처럼 날짜가 다를 수 있는 시각에 쓴다. */
export function formatDateTime(timestampMs: number | null): string {
  return timestampMs ? new Date(timestampMs).toLocaleString("ko-KR") : "—";
}
```

`apps/web/src/components/StatusBanner.tsx`:
```tsx
import type { ServerStatus } from "@zzirit-guard/shared";

/** StatusBanner 속성. */
export interface StatusBannerProps {
  /** 서버 상태. 아직 모르면 null. */
  status: ServerStatus | null;
  /** 실시간 연결이 살아 있는지. */
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
  /** 지금 켜져 있는지. 서버 상태를 아직 모르면 null이고, 그동안은 누를 수 없다(모르는 상태에서 켜지 않도록). */
  enabled: boolean | null;
  /** 켜기 권한(enable_auto_hide)이 있는지. */
  canEnable: boolean;
  /** 끄기 권한(disable_auto_hide)이 있는지. */
  canDisable: boolean;
  /** 바꾸려는 값으로 부른다. */
  onChange(enabled: boolean): void;
}

/** 켜기 확인 문구. 숨긴 메시지는 되돌릴 수 없어서 한 번 더 묻는다. */
const ENABLE_CONFIRMATION = "자동 숨김을 켜면 규칙에 걸린 채팅이 바로 숨겨지고, 숨긴 채팅은 되돌릴 수 없습니다. 켤까요?";

/** 자동 숨김 스위치. 끄기는 바로, 켜기는 확인 후. 권한이 없거나 상태를 모르면 비활성. */
export function AutoHideToggle({ enabled, canEnable, canDisable, onChange }: AutoHideToggleProps) {
  if (enabled === null) return <button type="button" className="toggle" disabled>자동 숨김: 확인 중</button>;
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
import { formatClockTime } from "../domain/timeFormat";
import { describeReason } from "../domain/verdictReason";
import type { ActionRunner, CandidateActions } from "../screens/CandidatesScreen";

/** 묶음 카드의 종류. 버튼 구성을 정한다. */
export type GroupKind = "care" | "shadow" | "candidate";

/** 묶음 카드 속성. */
export interface CandidateGroupCardProps {
  /** 한 사람의 판정 묶음. */
  group: SenderGroup;
  /** 카드 종류. 섀도는 '무시' 대신 '오판'을 둔다(켜져 있었으면 숨겼을 판정에 동의하지 않는다는 뜻이라). */
  kind: GroupKind;
  /** 로그인한 매니저의 권한. 없는 권한의 버튼은 보이되 비활성으로 둔다. */
  permissions: readonly Permission[];
  /** 동작 실행기. 결과 안내와 오류 표시를 맡는다. */
  run: ActionRunner;
  /** 후보 화면 동작. */
  actions: CandidateActions;
}

/** 메시지 한 줄 속성. */
interface MessageRowProps {
  /** 보여 줄 판정. */
  verdict: VerdictDto;
  /** 카드 종류(버튼 구성). */
  kind: GroupKind;
  /** 숨기기·무시·오판 권한(hide_message)이 있는지. */
  canHide: boolean;
  /** 동작 실행기. */
  run: ActionRunner;
  /** 후보 화면 동작. */
  actions: CandidateActions;
}

/** 카드에 보여 줄 최근 메시지 수(스펙 6장). */
const VISIBLE_MESSAGES = 3;

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

/** 메시지 한 줄과 이유·버튼. 채팅 원문은 텍스트로만 넣는다(React가 이스케이프한다). */
function MessageRow({ verdict, kind, canHide, run, actions }: MessageRowProps) {
  return (
    <li className="message">
      <span className="time">{formatClockTime(verdict.createdAt)}</span>
      <span className="content">{verdict.content}</span>
      <span className="reason">{describeReason(verdict.reason)}</span>
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

`apps/web/src/components/AutoHideLists.tsx`:
```tsx
import type { VerdictDto } from "@zzirit-guard/shared";
import { describeReason } from "../domain/verdictReason";
import type { ActionRunner, CandidateActions } from "../screens/CandidatesScreen";

/** 자동 숨김 목록 속성. */
export interface AutoHideListProps {
  /** 보여 줄 자동 숨김 판정(최신순). */
  verdicts: readonly VerdictDto[];
  /** 숨기기·오판 권한(hide_message)이 있는지. */
  canHide: boolean;
  /** 동작 실행기. */
  run: ActionRunner;
  /** 후보 화면 동작. */
  actions: CandidateActions;
}

/** 판정 한 건의 보낸 사람·원문·이유. 원문은 텍스트로만 넣는다. */
function VerdictSummary({ verdict }: { verdict: VerdictDto }) {
  return (
    <>
      <span className="content">{verdict.senderNickname}: {verdict.content}</span>
      <span className="reason">{describeReason(verdict.reason)}</span>
    </>
  );
}

/**
 * 자동 숨김 판정인데 아직 숨겨지지 않은 것(실행 대기·스위치가 꺼져 취소·재시도 실패, R-4).
 * 펼쳐 두고 숨기기 버튼을 준다: 접어 두면 숨겨지지 않은 메시지를 매니저가 놓친다.
 */
export function AutoHidePendingList({ verdicts, canHide, run, actions }: AutoHideListProps) {
  if (verdicts.length === 0) return null;
  return (
    <section className="section section-auto-pending">
      <h2>숨김 대기·실패({verdicts.length}건)</h2>
      <p className="hint">자동 숨김이 아직 처리 중이거나, 스위치가 꺼져 취소됐거나, 실패한 메시지입니다. 필요하면 직접 숨기세요.</p>
      <ul className="messages">
        {verdicts.map((verdict) => (
          <li key={verdict.id} className="message">
            <VerdictSummary verdict={verdict} />
            <span className="buttons">
              <button type="button" disabled={!canHide} onClick={() => run(() => actions.hide(verdict))}>숨기기</button>
              <button type="button" disabled={!canHide} onClick={() => run(() => actions.reportFalsePositive(verdict))}>오판</button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 최근 10분 동안 실제로 숨겨진 자동 숨김. 잘못 숨겼으면 오판으로 신고해 규칙을 검토하게 한다(스펙 5.5). */
export function AutoHiddenList({ verdicts, canHide, run, actions }: AutoHideListProps) {
  if (verdicts.length === 0) return null;
  return (
    <details className="section section-auto">
      <summary>자동 숨김됨(최근 10분, {verdicts.length}건)</summary>
      <ul className="messages">
        {verdicts.map((verdict) => (
          <li key={verdict.id} className="message">
            <VerdictSummary verdict={verdict} />
            <button type="button" disabled={!canHide} onClick={() => run(() => actions.reportFalsePositive(verdict))}>오판</button>
          </li>
        ))}
      </ul>
    </details>
  );
}
```

`apps/web/src/screens/CandidatesScreen.tsx`:
```tsx
import type { MeDto, ServerStatus, VerdictDto } from "@zzirit-guard/shared";
import { useState } from "react";
import { ApiError, describeApiError } from "../api/client";
import { AutoHiddenList, AutoHidePendingList } from "../components/AutoHideLists";
import { AutoHideToggle } from "../components/AutoHideToggle";
import { CandidateGroupCard, type GroupKind } from "../components/CandidateGroupCard";
import { StatusBanner } from "../components/StatusBanner";
import { countActionable, type CandidateSections, type SenderGroup } from "../domain/candidates";

/** 후보 화면이 부르는 동작. 성공하면 화면에 보여 줄 안내(없으면 null)를 돌려준다. MainScreen이 API로 채우고, 테스트는 가짜를 넘긴다. */
export interface CandidateActions {
  /** 메시지 하나를 숨긴다. */
  hide(verdict: VerdictDto): Promise<string | null>;
  /** 사람 단위 임시 제한. */
  temporaryRestrict(group: SenderGroup): Promise<string | null>;
  /** 후보를 무시로 표시한다(대기 중인 것만). */
  ignore(verdict: VerdictDto): Promise<string | null>;
  /** 오판으로 신고한다(오판 검토 목록에 오른다). */
  reportFalsePositive(verdict: VerdictDto): Promise<string | null>;
  /** 자동 숨김 스위치를 켜거나 끈다. */
  setAutoHide(enabled: boolean): Promise<string | null>;
}

/** 동작 하나를 실행하고 결과(안내 또는 오류)를 화면에 남기는 함수. */
export type ActionRunner = (task: () => Promise<string | null>) => void;

/** 후보 화면 속성. */
export interface CandidatesScreenProps {
  /** 로그인한 매니저(권한으로 버튼을 켠다). */
  me: MeDto;
  /** 서버 상태. 아직 모르면 null. */
  status: ServerStatus | null;
  /** MainScreen이 한 번 계산한 구역(탭 배지와 같은 값을 쓰려고 위에서 받는다). */
  sections: CandidateSections;
  /** 실시간 연결이 살아 있는지. */
  realtimeConnected: boolean;
  /** 후보 화면 동작. */
  actions: CandidateActions;
  /** 서버에서 상태·후보를 다시 읽는다(iOS 홈 화면 앱에는 새로고침이 없다). */
  onReload(): void;
}

/** 화면에 남기는 동작 결과. */
type Feedback = { kind: "ok" | "error"; message: string } | null;

/** 사람 단위 구역의 제목과 종류. 순서가 화면 순서다(스펙 5.1: 섀도는 후보 목록 위). */
const GROUP_SECTIONS: ReadonlyArray<{ key: "care" | "shadow" | "candidates"; kind: GroupKind; title: string }> = [
  { key: "care", kind: "care", title: "도움 필요(자해·자살 신호)" },
  { key: "shadow", kind: "shadow", title: "켜져 있었으면 숨겼을 메시지" },
  { key: "candidates", kind: "candidate", title: "후보" },
];

/**
 * 동작 실행기를 만든다. 성공하면 안내를, 실패하면 서버 문구를 남긴다.
 * 이미 처리된 판정(409 already_handled)이면 화면이 낡은 것이므로 목록을 다시 읽는다(R-13).
 */
function createRunner(setFeedback: (feedback: Feedback) => void, onReload: () => void): ActionRunner {
  return (task) => {
    setFeedback(null);
    task().then(
      (message) => setFeedback(message ? { kind: "ok", message } : null),
      (error: unknown) => {
        setFeedback({ kind: "error", message: describeApiError(error) });
        if (error instanceof ApiError && error.code === "already_handled") onReload();
      },
    );
  };
}

/** 후보 화면(스펙 6장 ①): 상태 배너·스위치·구역별 사람 단위 묶음·자동 숨김 목록. */
export function CandidatesScreen({ me, status, sections, realtimeConnected, actions, onReload }: CandidatesScreenProps) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const run = createRunner(setFeedback, onReload);
  const canHide = me.permissions.includes("hide_message");
  return (
    <section className="screen">
      <StatusBanner status={status} realtimeConnected={realtimeConnected} />
      <div className="toolbar">
        <AutoHideToggle enabled={status?.autoHideEnabled ?? null} canEnable={me.permissions.includes("enable_auto_hide")}
          canDisable={me.permissions.includes("disable_auto_hide")} onChange={(enabled) => run(() => actions.setAutoHide(enabled))} />
        <button type="button" onClick={onReload}>다시 불러오기</button>
      </div>
      <FeedbackLine feedback={feedback} />
      {GROUP_SECTIONS.map(({ key, kind, title }) => (
        <GroupSection key={key} title={title} groups={sections[key]} kind={kind} me={me} run={run} actions={actions} />
      ))}
      {countActionable(sections) === 0 && <p className="empty">지금 확인할 후보가 없습니다.</p>}
      <AutoHidePendingList verdicts={sections.autoHidePending} canHide={canHide} run={run} actions={actions} />
      <AutoHiddenList verdicts={sections.autoHidden} canHide={canHide} run={run} actions={actions} />
    </section>
  );
}

/** 동작 결과 한 줄. 오류는 alert, 안내는 status로 읽어 준다. */
function FeedbackLine({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return feedback.kind === "error" ? <p className="error" role="alert">{feedback.message}</p> : <p className="feedback" role="status">{feedback.message}</p>;
}

/** 사람 단위 구역 하나의 속성. */
interface GroupSectionProps {
  /** 구역 제목. */
  title: string;
  /** 이 구역의 사람 묶음. */
  groups: readonly SenderGroup[];
  /** 카드 종류. */
  kind: GroupKind;
  /** 로그인한 매니저. */
  me: MeDto;
  /** 동작 실행기. */
  run: ActionRunner;
  /** 후보 화면 동작. */
  actions: CandidateActions;
}

/** 구역 하나. 비어 있으면 그리지 않는다. */
function GroupSection({ title, groups, kind, me, run, actions }: GroupSectionProps) {
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
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: PASS (53 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web/src/domain/verdictReason.ts apps/web/src/domain/timeFormat.ts apps/web/src/components apps/web/src/screens/CandidatesScreen.tsx apps/web/test/domain/verdictReason.test.ts apps/web/test/screens/CandidatesScreen.test.tsx
git commit -m "feat: 후보 화면 추가" -m "상태 배너·자동 숨김 스위치·도움 필요/섀도/후보 구역을 사람 단위 묶음으로 보여 주고, 판정마다 이유(규칙 번호)를 붙인다. 숨기지 못한 자동 숨김은 숨기기 버튼과 함께 따로 보여 준다. 권한 없는 버튼은 비활성으로 두고, 실패하면 서버 이유를, 성공하면 안내를 보여 주며 이미 처리된 판정이면 목록을 다시 읽는다."
```

---

### Task 5: 실시간 채팅 화면

**Files:**
- Create: `apps/web/src/screens/LiveChatScreen.tsx`
- Test: `apps/web/test/screens/LiveChatScreen.test.tsx`

**Interfaces:**
- Consumes: `ChatLine`(shared)
- Produces: `LiveChatScreen(props: LiveChatScreenProps)`(`{ lines: readonly ChatLine[] }`)

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

/** 실시간 채팅 화면 속성. */
export interface LiveChatScreenProps {
  /** 최근 채팅 줄(오래된 것부터, 최대 MAX_CHAT_LINES개). */
  lines: readonly ChatLine[];
}

/** 실시간 채팅 화면(스펙 6장 ②): 위험 메시지 강조, 위험한 것만 보기. 최신 줄이 위로 온다. */
export function LiveChatScreen({ lines }: LiveChatScreenProps) {
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
Expected: PASS (55 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web/src/screens/LiveChatScreen.tsx apps/web/test/screens/LiveChatScreen.test.tsx
git commit -m "feat: 실시간 채팅 화면 추가" -m "채팅을 텍스트로만 보여 주고 판정이 붙은 줄을 강조하며, 위험한 것만 걸러 볼 수 있다."
```

---

### Task 6: 푸시 구독·해지와 PWA 파일

**Files:**
- Create: `apps/web/src/push/pushSubscription.ts`
- Create: `apps/web/public/manifest.webmanifest`, `apps/web/public/sw.js`, `ops/scripts/render-icons.sh`
- Create(스크립트 결과): `apps/web/public/icons/logo.svg`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`
- Test: `apps/web/test/push/pushSubscription.test.ts`

**Interfaces:**
- Consumes: `apiGet`·`apiSend`(Task 1)
- Produces: `base64UrlToUint8Array(value: string): Uint8Array<ArrayBuffer>`, `SERVICE_WORKER_READY_TIMEOUT_MS = 10_000`, `enablePush(readyTimeoutMs?: number): Promise<void>`(지원 안 함·권한 거부·준비 시간 초과는 이유를 담은 `Error`, 서버 거절은 `ApiError`), `disablePush(): Promise<void>`

초판과 달라진 점: 반환 타입을 `Uint8Array<ArrayBuffer>`로 바꾼다. 초판의 `Uint8Array`는 TS 6.0.3 lib.dom의 `applicationServerKey`(BufferSource)와 맞지 않아 typecheck가 `TS2322: Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'string | BufferSource | null | undefined'`로 실패한다(R-2, 재현함). `serviceWorker.ready`에 10초 제한을 둔다(등록이 실패하면 영영 끝나지 않는다, X3). 서버가 구독을 거절하면 브라우저 구독도 해지하고, 로그아웃용 `disablePush`를 더한다(스펙 11장 "해지 시 삭제", R-14).

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/test/push/pushSubscription.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/client";
import { base64UrlToUint8Array, disablePush, enablePush } from "../../src/push/pushSubscription";
import { json, stubFetch } from "../helpers/stubFetch";

/** jsdom에는 서비스 워커가 없어 테스트마다 navigator.serviceWorker를 직접 심는다. */
function stubServiceWorker(container: unknown): void {
  Object.defineProperty(window.navigator, "serviceWorker", { value: container, configurable: true });
}

/** 알림 권한을 허락하는 브라우저로 만든다. */
function stubPushSupport(): void {
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { requestPermission: async () => "granted" });
}

/** 가짜 푸시 구독. */
function fakeSubscription() {
  const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
  return { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }), unsubscribe: vi.fn(async () => true) };
}

afterEach(() => {
  delete (window.navigator as { serviceWorker?: unknown }).serviceWorker;
  vi.unstubAllGlobals();
});

describe("pushSubscription", () => {
  it("VAPID 공개키(base64url)를 바이트로 바꾼다", () => {
    expect([...base64UrlToUint8Array("AQID-_8")]).toEqual([1, 2, 3, 251, 255]);
  });

  it("서비스 워커가 없는 브라우저면 이유와 해결 방법을 알려 준다", async () => {
    await expect(enablePush()).rejects.toThrow(/홈 화면에 추가/);
  });

  it("서비스 워커가 준비되지 않으면 기다리다 멈추지 않고 이유를 알려 준다(X3)", async () => {
    stubPushSupport();
    stubServiceWorker({ ready: new Promise(() => undefined) });
    await expect(enablePush(10)).rejects.toThrow(/서비스 워커/);
  });

  it("서버가 구독을 거절하면 서버 문구를 전하고 브라우저 구독도 해지한다(R-14)", async () => {
    stubPushSupport();
    const subscription = fakeSubscription();
    stubServiceWorker({ ready: Promise.resolve({ pushManager: { subscribe: async () => subscription } }) });
    stubFetch({
      "GET /api/push/public-key": () => json(200, { publicKey: "AQID" }),
      "POST /api/push/subscriptions": () => json(400, { error: "bad_request", message: "지원하지 않는 푸시 주소입니다." }),
    });
    const error = await enablePush().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("지원하지 않는 푸시 주소입니다.");
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("알림 해지는 서버에서 구독을 지우고 브라우저 구독도 끊는다(스펙 11장, R-14)", async () => {
    const subscription = fakeSubscription();
    stubServiceWorker({ getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }) });
    const fetchMock = stubFetch({ "DELETE /api/push/subscriptions": () => json(200, { ok: true }) });
    await disablePush();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ endpoint: subscription.endpoint });
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("구독이 없으면 알림 해지는 아무것도 보내지 않는다", async () => {
    stubServiceWorker({ getRegistration: async () => undefined });
    const fetchMock = stubFetch({});
    await disablePush();
    expect(fetchMock).not.toHaveBeenCalled();
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
/** 알림 권한을 거부했을 때의 안내. */
const PERMISSION_DENIED_MESSAGE = "알림 권한이 거부되었습니다. 브라우저(또는 iPhone 설정 → 알림)에서 이 앱의 알림을 허용하세요.";
/**
 * 서비스 워커 준비를 기다리는 최대 시간(10초).
 * 왜: 등록이 실패하면 navigator.serviceWorker.ready는 영영 끝나지 않아 "장애 알림 받기"가 아무 문구 없이 멈춘다(X3).
 */
export const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;
/** 서비스 워커가 준비되지 않았을 때의 안내. */
const READY_TIMEOUT_MESSAGE = "알림 준비(서비스 워커)가 끝나지 않았습니다. 앱을 완전히 닫았다가 다시 열고 시도하세요.";

/**
 * base64url 문자열을 바이트 배열로 바꾼다(PushManager가 VAPID 공개키를 바이트로 받는다).
 * 반환 타입을 Uint8Array<ArrayBuffer>로 두는 이유: TS 6 lib.dom의 applicationServerKey는 BufferSource라 ArrayBufferLike 버전을 받지 않는다(R-2).
 */
export function base64UrlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

/**
 * 알림 권한을 받고 푸시를 구독해 서버에 등록한다.
 * @param readyTimeoutMs 서비스 워커 준비를 기다릴 시간(테스트에서 줄인다)
 * @throws Error 지원하지 않거나 권한이 거부되거나 서비스 워커가 준비되지 않으면 이유와 해결 방법을 담아 던진다
 * @throws ApiError 서버가 구독을 거절하면(그때는 브라우저 구독도 해지한다)
 */
export async function enablePush(readyTimeoutMs: number = SERVICE_WORKER_READY_TIMEOUT_MS): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error(UNSUPPORTED_MESSAGE);
  if ((await Notification.requestPermission()) !== "granted") throw new Error(PERMISSION_DENIED_MESSAGE);
  const registration = await waitForServiceWorker(readyTimeoutMs);
  const { publicKey } = await apiGet<{ publicKey: string }>("/api/push/public-key");
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(publicKey) });
  await registerSubscription(subscription);
}

/**
 * 이 기기의 푸시 구독을 해지한다: 서버에서 지우고 브라우저 구독도 끊는다(스펙 11장 "해지 시 삭제", R-14).
 * 로그아웃·연결 해제 전에 부른다. 서비스 워커나 구독이 없으면 아무것도 하지 않는다.
 * 왜 ready가 아니라 getRegistration인가: 등록이 없으면 ready는 끝나지 않아 로그아웃이 멈춘다.
 * 서버 삭제가 실패해도 브라우저 구독은 끊는다: 끊긴 주소로 보낸 푸시는 푸시 서비스가 410으로 돌려주고, 서버가 그때 지운다.
 */
export async function disablePush(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  try {
    await apiSend("DELETE", "/api/push/subscriptions", { endpoint: subscription.endpoint });
  } finally {
    await subscription.unsubscribe();
  }
}

/** 서비스 워커 준비를 기다리되, timeoutMs가 지나면 이유를 담아 실패한다. */
function waitForServiceWorker(timeoutMs: number): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(READY_TIMEOUT_MESSAGE)), timeoutMs);
  });
  return Promise.race([navigator.serviceWorker.ready, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 서버에 구독을 등록한다. 실패하면(허용하지 않는 푸시 주소 400 등) 브라우저 구독도 해지해, 서버가 모르는 구독이 남지 않게 하고 원래 오류를 다시 던진다.
 */
async function registerSubscription(subscription: PushSubscription): Promise<void> {
  try {
    await apiSend("POST", "/api/push/subscriptions", subscription.toJSON());
  } catch (error) {
    await subscription.unsubscribe().catch((unsubscribeError: unknown) => console.warn("서버가 거절한 푸시 구독을 브라우저에서 해지하지 못했습니다", unsubscribeError));
    throw error;
  }
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

Run: `npm test -w @zzirit-guard/web && npm run typecheck`
Expected: PASS (61 tests), typecheck 통과(`applicationServerKey` 타입 오류 없음)

- [ ] **Step 6: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web/src/push apps/web/test/push apps/web/public ops/scripts/render-icons.sh
git commit -m "feat: 푸시 구독·해지와 PWA 매니페스트·서비스 워커 추가" -m "알림 권한을 받아 푸시를 구독하고, 지원하지 않는 환경(홈 화면에 추가하지 않은 iPhone 등)과 서비스 워커가 준비되지 않은 경우는 이유를 알려 준다. 서버가 구독을 거절하면 브라우저 구독도 해지하고, 로그아웃 때 쓸 해지 함수를 둔다. 서비스 워커는 알림 표시만 하고 캐시는 하지 않는다."
```

---
### Task 7: 기록·설정 화면

**Files:**
- Create: `apps/web/src/api/useApiResource.ts`, `apps/web/src/components/ApiNotice.tsx`, `apps/web/src/domain/ruleKinds.ts`
- Create: `apps/web/src/settings/StatusSection.tsx`, `StatsSection.tsx`, `FalsePositiveSection.tsx`, `RulesSection.tsx`, `LimitsSection.tsx`, `ChatSettingsSection.tsx`, `AuditSection.tsx`, `AccountSection.tsx`
- Create: `apps/web/src/screens/SettingsScreen.tsx`
- Test: `apps/web/test/settings/settings.test.tsx`, `apps/web/test/settings/AccountSection.test.tsx`

**Interfaces:**
- Consumes: `apiGet`·`apiSend`·`ApiError`·`describeApiError`(Task 1), `describeReason`·`ruleIdOf`·`formatDateTime`(Task 4), `enablePush`·`disablePush`(Task 6), shared `MinuteStatDto`·`FalsePositiveReviewDto`(Task 0)
- Produces: `useApiResource<T>(path: string | null, refreshIntervalMs?: number | null): { data: T | null; error: string | null; loading: boolean; reload(): void }`, `ApiNotice()`, `KIND_LABELS`, `EDITABLE_KINDS`, `describeRuleKind(kind: string): string`, `SettingsScreen(props: { me: MeDto; onSignedOut(message: string | null): void })`, 각 Section(`StatusSection()`, `StatsSection()`, `FalsePositiveSection()`, `RulesSection({ me })`, `LimitsSection({ me })`, `ChatSettingsSection({ me })`, `AuditSection({ me })`, `AccountSection({ me, onSignedOut })`)

초판과 달라진 점: 상태 점검은 열릴 때와 15초마다 `/api/status`를 읽는다(마지막 채팅 수신·처리 대기는 방송되지 않는다, R-7). 감사 기록 이름을 실제 action(`ignored`, `auto_hide_off:breaker` 등)에 맞춘다(R-9). 오판 검토 구역을 더한다(B5, R-16). 통계는 shared `MinuteStatDto`를 쓰고, 복사한 서버 상수에는 출처를 단다(R-20). 로그아웃·연결 해제 전에 이 기기의 알림 구독을 푼다(R-14). 규칙 테스트의 금칙어 강 예시는 중립 자리표시자다(R-10).

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/test/settings/settings.test.tsx`:
```tsx
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
    const status: ServerStatus = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, lastChatAt: null, pendingActions: 2 };
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
      recent: [{ id: 9, chatChannelId: "c", senderChannelId: "s", senderNickname: "시청자", content: "정상 문장", messageTime: 1, decision: "candidate", reason: "rule:strong_spanning:3", status: "false_positive", createdAt: 0 }],
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
```

`apps/web/test/settings/AccountSection.test.tsx`(푸시 모듈을 가짜로 바꾸므로 파일을 나눈다):
```tsx
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
  /** 마지막으로 성공한 응답. 다시 읽다 실패해도 지우지 않는다(주기 조회 중 잠깐의 오류로 표가 사라지지 않게). */
  data: T | null;
  /** 마지막 조회의 오류 문구. 성공하면 null. */
  error: string | null;
  /** 첫 응답을 기다리는 중인지. */
  loading: boolean;
  /** 지금 다시 읽는다. */
  reload(): void;
}

/** 내부 조회 상태(reload 제외). */
type ResourceState<T> = Omit<ApiResource<T>, "reload">;

/**
 * 경로를 조회하고 결과를 상태로 돌려준다. path가 null이면 조회하지 않는다(권한이 없을 때).
 * refreshIntervalMs를 주면 그 간격으로 다시 읽는다(상태 점검처럼 서버가 방송하지 않는 값, R-7).
 * 화면이 사라진 뒤 도착한 응답은 버린다.
 */
export function useApiResource<T>(path: string | null, refreshIntervalMs: number | null = null): ApiResource<T> {
  const [state, setState] = useState<ResourceState<T>>({ data: null, error: null, loading: path !== null });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    apiGet<T>(path).then(
      (data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (!cancelled) setState((previous) => ({ data: previous.data, error: describeApiError(error), loading: false }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, version]);
  useEffect(() => {
    if (path === null || refreshIntervalMs === null) return;
    const timer = setInterval(() => setVersion((value) => value + 1), refreshIntervalMs);
    return () => clearInterval(timer);
  }, [path, refreshIntervalMs]);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { ...state, reload };
}
```

`apps/web/src/components/ApiNotice.tsx`:
```tsx
/** 치지직 API 사용·비공식 표시(약관 제7조④·14호). 정확한 표시 방식은 0단계에서 치지직에 확인한다(스펙 16장, 문의 메일 2번). */
export function ApiNotice() {
  return <p className="notice">이 앱은 치지직 Open API를 사용합니다. 네이버·치지직과 관계없는 비공식 프로젝트입니다.</p>;
}
```

`apps/web/src/domain/ruleKinds.ts`:
```ts
import type { RuleKind } from "@zzirit-guard/shared";

/** 규칙 종류 이름. 규칙 목록·감사 기록(rule_add:<종류>)에서 함께 쓴다. */
export const KIND_LABELS: Readonly<Record<RuleKind, string>> = {
  strong: "금칙어 강(자동 숨김)", weak: "금칙어 약(후보)", exception: "예외 단어", allow: "허용어(메시지 전체 일치)",
  allow_domain: "허용 도메인", threat: "협박 표현(후보)", keyword_route: "AI 키워드 경로",
};

/** 1단계에서 화면으로 추가할 수 있는 종류(AI 키워드 경로는 2단계). */
export const EDITABLE_KINDS: readonly RuleKind[] = ["strong", "weak", "exception", "allow", "allow_domain", "threat"];

/** 서버가 보낸 종류 문자열을 이름으로 바꾼다. 모르는 값이면 그대로 둔다(Object.hasOwn: 프로토타입 키를 이름으로 꺼내지 않게). */
export function describeRuleKind(kind: string): string {
  return Object.hasOwn(KIND_LABELS, kind) ? KIND_LABELS[kind as RuleKind] : kind;
}
```

`apps/web/src/settings/StatusSection.tsx`:
```tsx
import type { ServerStatus } from "@zzirit-guard/shared";
import { useApiResource } from "../api/useApiResource";
import { formatDateTime } from "../domain/timeFormat";

/**
 * 상태 점검을 다시 읽는 간격(15초).
 * 왜 실시간 status를 쓰지 않나: 서버는 연결·잠금·스위치가 바뀔 때만 status를 방송하고, 마지막 채팅 수신·처리 대기 건수가 바뀔 때는 보내지 않는다(R-7).
 */
const STATUS_REFRESH_MS = 15_000;

/** 표에 보여 줄 행(이름, 값). */
function rowsOf(status: ServerStatus): Array<[string, string]> {
  return [
    ["채널", status.channelName ?? "연결 안 됨"],
    ["치지직 채팅 연결", status.chatConnected ? "연결됨" : "끊김"],
    ["숨김·제재 가능", status.writeLocked ? "불가(스트리머 재연결 필요)" : "가능"],
    ["자동 숨김", status.autoHideEnabled ? "켜짐" : "꺼짐"],
    ["토큰 만료 예정", formatDateTime(status.accessExpiresAt)],
    ["마지막 채팅 수신", formatDateTime(status.lastChatAt)],
    ["처리 대기 중인 조치", `${status.pendingActions}건`],
  ];
}

/** 방송 전 상태 점검(스펙 6장 ③, 10장). 열릴 때와 15초마다 서버에서 다시 읽는다. */
export function StatusSection() {
  const status = useApiResource<ServerStatus>("/api/status", STATUS_REFRESH_MS);
  return (
    <section>
      <h2>상태 점검</h2>
      {status.error && <p className="error" role="alert">{status.error}</p>}
      {status.data ? (
        <dl className="rows">
          {rowsOf(status.data).map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
        </dl>
      ) : (
        !status.error && <p>불러오는 중…</p>
      )}
    </section>
  );
}
```

`apps/web/src/settings/StatsSection.tsx`:
```tsx
import type { MinuteStatDto } from "@zzirit-guard/shared";
import { useApiResource } from "../api/useApiResource";

/** 합계로 보여 줄 항목과 이름. 2단계(AI) 항목은 1단계에서 늘 0이라 뺀다. */
const TOTAL_FIELDS: ReadonlyArray<[keyof Omit<MinuteStatDto, "minute">, string]> = [
  ["received", "받은 채팅"], ["skipped", "가벼운 반응(ㅋㅋ 등)"], ["deduplicated", "중복 문장"], ["candidates", "후보"],
  ["shadow", "섀도"], ["auto_hidden", "자동 숨김"], ["invalid_events", "형식 오류 이벤트"],
];

/** 가장 바빴던 1분의 초당 채팅 수. */
function peakPerSecond(rows: readonly MinuteStatDto[]): number {
  return Math.max(0, ...rows.map((row) => row.received)) / 60;
}

/** 최근 1시간 통계. 1단계의 핵심 측정값(초당 채팅량·건너뛰기·중복 비율)을 보여 준다(스펙 15장). */
export function StatsSection() {
  const stats = useApiResource<MinuteStatDto[]>("/api/stats?sinceMinutes=60");
  if (stats.error) return <section><h2>최근 1시간</h2><p className="error" role="alert">{stats.error}</p></section>;
  const rows = stats.data ?? [];
  return (
    <section>
      <h2>최근 1시간</h2>
      <dl className="rows">
        {TOTAL_FIELDS.map(([field, label]) => (
          <div key={field}><dt>{label}</dt><dd>{rows.reduce((sum, row) => sum + row[field], 0)}</dd></div>
        ))}
        <div><dt>가장 바빴던 1분의 초당 채팅</dt><dd>{peakPerSecond(rows).toFixed(1)}</dd></div>
      </dl>
    </section>
  );
}
```

`apps/web/src/settings/FalsePositiveSection.tsx`:
```tsx
import type { FalsePositiveReviewDto, RuleEntryDto } from "@zzirit-guard/shared";
import { useApiResource } from "../api/useApiResource";
import { describeReason, ruleIdOf } from "../domain/verdictReason";

/** 최근 오판을 몇 건까지 읽을지. 서버 상한(200) 안에서 휴대폰 화면에 맞게 줄였다. */
const RECENT_LIMIT = 20;

/** 이유를 규칙 내용까지 붙여 보여 준다. 예: "금칙어 강 #3 '내용'". 규칙이 지워졌거나 아직 못 읽었으면 이유만. */
function describeWithPattern(reason: string, patterns: ReadonlyMap<number, string>): string {
  const ruleId = ruleIdOf(reason);
  const pattern = ruleId === null ? undefined : patterns.get(ruleId);
  return pattern ? `${describeReason(reason)} '${pattern}'` : describeReason(reason);
}

/**
 * 오판 검토 목록(스펙 5.5 "오판을 누르면 그 규칙이 검토 목록에 올라간다", R-16).
 * 오판이 많이 나온 규칙부터 보여 줘 예외 단어·허용어를 먼저 손보게 한다. 읽기 전용이라 로그인한 매니저면 누구나 본다.
 */
export function FalsePositiveSection() {
  const review = useApiResource<FalsePositiveReviewDto>(`/api/false-positives?limit=${RECENT_LIMIT}`);
  const rules = useApiResource<RuleEntryDto[]>("/api/rules");
  const patterns = new Map((rules.data ?? []).map((rule) => [rule.id, rule.pattern]));
  const data = review.data ?? { recent: [], byReason: [] };
  return (
    <section>
      <h2>오판 검토</h2>
      {review.error && <p className="error" role="alert">{review.error}</p>}
      {data.byReason.length === 0 ? <p className="hint">오판 신고가 없습니다.</p> : (
        <ul className="false-positive-counts">
          {data.byReason.map(({ reason, count }) => <li key={reason}>{`${describeWithPattern(reason, patterns)} — ${count}건`}</li>)}
        </ul>
      )}
      {data.recent.length > 0 && (
        <details>
          <summary>최근 오판 {data.recent.length}건</summary>
          <ul className="messages">
            {data.recent.map((verdict) => (
              <li key={verdict.id} className="message">
                <span className="content">{`${verdict.senderNickname}: ${verdict.content}`}</span>
                <span className="reason">{describeReason(verdict.reason)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
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
import { EDITABLE_KINDS, KIND_LABELS } from "../domain/ruleKinds";

/**
 * 규칙 입력 최대 길이. 서버 MAX_PATTERN_LENGTH(apps/server/src/detection/ruleRepository.ts)와 같아야 한다.
 * shared는 타입만 내보내 런타임 값을 옮길 수 없어 복사했다(R-20). 서버가 다시 검사하므로 어긋나도 400 문구가 보인다.
 */
const MAX_PATTERN_LENGTH = 50;

/** 규칙 목록과 추가·삭제(스펙 6장 ③). 수정 권한(edit_rules)이 없으면 목록만 보인다. */
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

/** 규칙 추가 양식. 빈 입력은 보내지 않는다. */
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
      <label>내용<input value={pattern} maxLength={MAX_PATTERN_LENGTH} onChange={(event) => setPattern(event.target.value)} /></label>
      <button type="submit">추가</button>
    </form>
  );
}

/** 규칙 묶음 속성. */
interface RuleGroupProps {
  /** 이 묶음의 종류. */
  kind: RuleKind;
  /** 이 종류의 규칙. */
  rules: readonly RuleEntryDto[];
  /** 삭제 버튼을 보일지. */
  canEdit: boolean;
  /** 삭제를 누르면 부른다. */
  onRemove(rule: RuleEntryDto): void;
}

/** 종류 하나의 규칙 목록. 비어 있으면 그리지 않는다. */
function RuleGroup({ kind, rules, canEdit, onRemove }: RuleGroupProps) {
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

/**
 * 설정 항목 이름과 허용 범위. 범위는 서버 SETTING_RULES(apps/server/src/records/settingsRepository.ts)와 같아야 한다.
 * shared는 타입만 내보내 런타임 값을 옮길 수 없어 복사했다(R-20). 서버가 다시 검사하므로 어긋나도 400 문구가 보인다.
 */
const FIELDS: ReadonlyArray<{ key: keyof SettingsDto; label: string; min: number; max: number }> = [
  { key: "breakerPerMinute", label: "자동 숨김 1분 한도(넘으면 스위치가 꺼짐)", min: 1, max: 1000 },
  { key: "retentionDaysContent", label: "원문 보관 기간(일)", min: 1, max: 365 },
  { key: "retentionDaysAudit", label: "감사 기록 보관 기간(일)", min: 1, max: 365 },
];

/** 한도·보관 기간 설정(스펙 5.5·9장). 수정 권한(edit_rules)이 없으면 값만 보인다. */
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

/**
 * 치지직이 허용하는 저속 모드 값(초). 서버 ALLOWED_SLOW_MODE_SECONDS(apps/server/src/http/routes.ts)와 같아야 한다.
 * shared는 타입만 내보내 런타임 값을 옮길 수 없어 복사했다(R-20). 서버가 다시 검사하므로 어긋나도 400 문구가 보인다.
 */
const SLOW_MODE_OPTIONS: readonly number[] = [0, 3, 5, 10, 30, 60, 120, 300];

/** 치지직 채팅 설정 중 저속 모드(도배가 몰릴 때 바로 쓰는 수단). 수정 권한(edit_chat_settings)이 없으면 값만 보인다. */
export function ChatSettingsSection({ me }: { me: MeDto }) {
  const settings = useApiResource<ChatSettingsDto>("/api/chat-settings");
  const [message, setMessage] = useState<string | null>(null);
  const canEdit = me.permissions.includes("edit_chat_settings");
  const change = (seconds: number) => {
    if (!settings.data) return;
    apiSend("PUT", "/api/chat-settings", { ...settings.data, chatSlowModeSec: seconds }).then(
      () => {
        setMessage(seconds === 0 ? "저속 모드를 껐습니다." : `저속 모드를 ${seconds}초로 바꿨습니다.`);
        settings.reload();
      },
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
import { describeRuleKind } from "../domain/ruleKinds";
import { formatDateTime } from "../domain/timeFormat";

/**
 * 감사 기록 동작 이름. 키는 서버가 남기는 action에서 ':' 앞부분이다:
 * 실행기 kind(executor.ts), auto_hide_on/off(autoHideSwitch.ts), ignored·false_positive·rule_add·rule_remove·settings_update(routes.ts).
 */
const ACTION_LABELS: ReadonlyMap<string, string> = new Map([
  ["hide", "숨김"], ["temporary_restrict", "임시 제한"], ["restrict", "활동 제한"], ["unrestrict", "활동 제한 해제"],
  ["update_chat_settings", "채팅 설정 변경"], ["auto_hide_on", "자동 숨김 켬"], ["auto_hide_off", "자동 숨김 끔"],
  ["ignored", "무시"], ["false_positive", "오판 신고"], ["rule_add", "규칙 추가"], ["rule_remove", "규칙 삭제"], ["settings_update", "설정 변경"],
]);
/** 스위치를 켜고 끈 이유(autoHideSwitch.ts·app.ts가 넘기는 reason). */
const SWITCH_REASON_LABELS: ReadonlyMap<string, string> = new Map([["manual", "수동"], ["breaker", "1분 한도 초과"], ["failure_rate", "치지직 호출 실패 증가"]]);
/** 행위자 이름. */
const ACTOR_LABELS: Record<AuditEntryDto["actorType"], string> = { manager: "매니저", rule: "자동 규칙", system: "시스템" };

/** 동작 문자열을 읽기 쉬운 이름으로. 예: "auto_hide_off:breaker" → "자동 숨김 끔(1분 한도 초과)". 모르는 동작은 그대로 둔다. */
function describeAction(action: string): string {
  const separator = action.indexOf(":");
  const name = separator < 0 ? action : action.slice(0, separator);
  const label = ACTION_LABELS.get(name);
  if (!label) return action;
  return separator < 0 ? label : `${label}(${describeDetail(name, action.slice(separator + 1))})`;
}

/** 동작 뒤에 붙은 세부 값(규칙 종류 또는 스위치 이유)을 이름으로. */
function describeDetail(name: string, detail: string): string {
  return name === "rule_add" ? describeRuleKind(detail) : (SWITCH_REASON_LABELS.get(detail) ?? detail);
}

/** 감사 기록(스펙 6장 ③). 채널 관리자 이상(view_audit)만 본다. */
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
            <time>{formatDateTime(entry.createdAt)}</time> {ACTOR_LABELS[entry.actorType]} · {describeAction(entry.action)}
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
import { disablePush, enablePush } from "../push/pushSubscription";

/** 역할 이름. */
const ROLE_LABELS: Record<MeDto["role"], string> = {
  STREAMING_CHANNEL_OWNER: "스트리머", STREAMING_CHANNEL_MANAGER: "채널 관리자", STREAMING_CHAT_MANAGER: "채팅 운영자",
};
/** 채널 연결 해제 확인 문구. 서버가 모든 세션을 지우고 수신을 멈춘다(app.ts disconnectChannel). 규칙·설정은 남는다. */
const DISCONNECT_CONFIRMATION = "채널 연결을 해제하면 모든 매니저가 로그아웃되고 자동 기능이 멈춥니다(규칙·설정은 남습니다). 해제할까요?";

/** 오류 문구: 서버 오류(ApiError)는 서버 문구, 일반 Error(알림 미지원·권한 거부·준비 시간 초과)는 자기 문구. */
function messageOf(error: unknown): string {
  return error instanceof Error && !(error instanceof ApiError) ? error.message : describeApiError(error);
}

/**
 * 이 기기의 알림 구독을 푼다(스펙 11장 "해지 시 삭제", R-14). 실패해도 로그아웃·연결 해제는 계속하고, 원인은 콘솔에 남긴다.
 * 왜 계속하나: 구독 해지 실패로 로그아웃이 막히면 안 되고, 남은 구독은 푸시 서비스가 끊긴 주소를 알려 줄 때 서버가 지운다.
 */
function releasePush(): Promise<void> {
  return disablePush().catch((error: unknown) => console.warn("알림 구독 해지에 실패했습니다(로그아웃은 계속합니다)", error));
}

/** 계정·장애 알림·로그아웃·(스트리머) 채널 연결 해제. */
export function AccountSection({ me, onSignedOut }: { me: MeDto; onSignedOut(message: string | null): void }) {
  const [message, setMessage] = useState<string | null>(null);
  const report = (error: unknown) => setMessage(messageOf(error));
  const enableAlerts = () => enablePush().then(() => setMessage("장애 알림을 켰습니다."), report);
  const logout = () => releasePush().then(() => apiSend("POST", "/api/logout")).then(() => onSignedOut(null), report);
  const disconnect = () => {
    if (!window.confirm(DISCONNECT_CONFIRMATION)) return;
    releasePush().then(() => apiSend("POST", "/api/channel/disconnect")).then(() => onSignedOut("채널 연결을 해제했습니다."), report);
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
import type { MeDto } from "@zzirit-guard/shared";
import { AccountSection } from "../settings/AccountSection";
import { AuditSection } from "../settings/AuditSection";
import { ChatSettingsSection } from "../settings/ChatSettingsSection";
import { FalsePositiveSection } from "../settings/FalsePositiveSection";
import { LimitsSection } from "../settings/LimitsSection";
import { RulesSection } from "../settings/RulesSection";
import { StatsSection } from "../settings/StatsSection";
import { StatusSection } from "../settings/StatusSection";

/** 기록·설정 화면 속성. */
export interface SettingsScreenProps {
  /** 로그인한 매니저. */
  me: MeDto;
  /** 로그아웃·연결 해제 뒤 로그인 화면으로 돌아갈 때 부른다(message는 로그인 화면 안내). */
  onSignedOut(message: string | null): void;
}

/** 기록·설정 화면(스펙 6장 ③). 영구 제한·해제는 이 앱에 없다: 치지직 기본 도구로 한다(B4, 운영 안내서). */
export function SettingsScreen({ me, onSignedOut }: SettingsScreenProps) {
  return (
    <section className="screen settings">
      <StatusSection />
      <StatsSection />
      <FalsePositiveSection />
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
Expected: PASS (69 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web/src/api/useApiResource.ts apps/web/src/components/ApiNotice.tsx apps/web/src/domain/ruleKinds.ts apps/web/src/settings apps/web/src/screens/SettingsScreen.tsx apps/web/test/settings
git commit -m "feat: 기록·설정 화면 추가" -m "상태 점검(15초마다 다시 읽음)·최근 1시간 통계(초당 피크)·오판 검토·규칙·한도·저속 모드·감사 기록·계정을 한 화면에 둔다. 감사 기록은 실제 동작 이름과 이유를 읽기 쉽게 바꾸고, 로그아웃·연결 해제 전에 이 기기의 알림 구독을 푼다. 권한이 없으면 조회하지 않거나 수정 버튼을 숨긴다."
```

---

### Task 8: 앱 골격과 빌드

**Files:**
- Create: `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles.css`
- Create: `apps/web/src/screens/LoginScreen.tsx`, `apps/web/src/screens/MainScreen.tsx`, `apps/web/src/components/TabBar.tsx`
- Create: `apps/web/src/state/useServerState.ts`, `apps/web/src/state/useNow.ts`
- Test: `apps/web/test/App.test.tsx`

**Interfaces:**
- Consumes: Task 1~7의 모듈(`requiresSignIn`, `RealtimeConnection`, `serverReducer`, `buildSections`·`countActionable`, `CandidatesScreen`·`CandidateActions`, `LiveChatScreen`, `SettingsScreen`, `ApiNotice`)
- Produces: `App()`, `LoginScreen(props: { loginError: string | null; message: string | null })`, `MainScreen(props: { me: MeDto; onSignedOut(message: string | null): void })`, `TabBar(props: { active: Tab; onChange(tab: Tab): void; pendingCount: number })`, `type Tab = "candidates" | "chat" | "settings"`, `useServerState(): { state: ServerState; reload(): void; reconnect(): void }`, `useNow(intervalMs: number): number`

초판과 달라진 점: 실시간 연결이 열릴 때마다 상태·후보를 다시 읽는다(R-3). 조회는 하나씩만 돌린다(리듀서의 `replayLog`가 조회 하나를 전제로 한다). 조회·티켓·조치가 401·409 `no_channel`이면 로그인 화면으로 보낸다(R-12). 4003이 이어져 멈추면 `/api/me`로 세션을 확인한 뒤 주소 확인 안내와 "다시 연결"을 보여 준다(R-6). 조치 응답의 `note`를 후보 화면으로 넘긴다(R-13). 구역은 한 번만 계산해 후보 화면과 탭 배지가 같이 쓴다(B8). `App`의 로그아웃 함수는 `useCallback`으로 고정한다(MainScreen effect가 의존한다).

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/test/App.test.tsx`:
```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { json, stubFetch } from "./helpers/stubFetch";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

/** 정상 서버 상태. */
const status = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, lastChatAt: null, pendingActions: 0 };
/** 채팅 운영자 내 정보. */
const me = { channelId: "m1", channelName: "매니저1", role: "STREAMING_CHAT_MANAGER", permissions: ["disable_auto_hide", "hide_message", "temporary_restrict"] };

/** 열리자마자 서버처럼 status 메시지를 보내는 가짜 WebSocket(인증된 연결은 곧바로 status를 받는다). */
class FakeWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "status", status }) }), 0);
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
      "GET /api/me": () => json(200, me),
      "GET /api/status": () => json(200, status),
      "GET /api/candidates": () => json(200, []),
      "POST /api/ws-ticket": () => json(200, { ticket: "t1" }),
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: /실시간 채팅/ })).toBeTruthy();
    expect(await screen.findByText("정상 동작 중")).toBeTruthy();
  });

  it("실시간 연결이 열리면 상태·후보를 다시 읽어 끊긴 동안의 변화를 메운다(R-3)", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const fetchMock = stubFetch({
      "GET /api/me": () => json(200, me),
      "GET /api/status": () => json(200, status),
      "GET /api/candidates": () => json(200, []),
      "POST /api/ws-ticket": () => json(200, { ticket: "t1" }),
    });
    render(<App />);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === "/api/candidates").length).toBeGreaterThanOrEqual(2));
  });

  it("채널 연결이 사라지면(409 no_channel) 실시간을 멈추고 로그인 화면에 서버 문구를 보여 준다(R-12)", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const noChannel = () => json(409, { error: "no_channel", message: "연결된 채널이 없습니다. 스트리머가 먼저 채널을 연결하세요." });
    const fetchMock = stubFetch({ "GET /api/me": () => json(200, me), "GET /api/status": noChannel, "GET /api/candidates": noChannel, "POST /api/ws-ticket": noChannel });
    render(<App />);
    expect(await screen.findByRole("link", { name: "매니저 로그인" })).toBeTruthy();
    expect(screen.getByText(/연결된 채널이 없습니다/)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/ws-ticket").length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: FAIL — `Cannot find module '../src/App'` 류(모듈 없음)

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

/**
 * 서비스 워커를 등록한다(푸시 알림용). 실패해도 앱은 동작하므로 경고만 남긴다.
 * 등록이 실패하면 "장애 알림 받기"는 enablePush의 준비 시간 제한(10초) 뒤 이유를 보여 준다(X3).
 */
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
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiGet, describeApiError } from "./api/client";
import { LoginScreen } from "./screens/LoginScreen";
import { MainScreen } from "./screens/MainScreen";

/** 로그인 상태. signedOut의 message는 로그인 화면에 보여 줄 안내(세션 종료 이유, 409 no_channel 문구 등)다. */
type MeState = { kind: "loading" } | { kind: "signedOut"; message: string | null } | { kind: "signedIn"; me: MeDto };

/** 주소의 loginError(서버 콜백·한도 초과가 넣은 로그인 실패 이유)를 읽는다. */
function readLoginError(search: string): string | null {
  return new URLSearchParams(search).get("loginError");
}

/** 최상위: 내 정보를 읽어 로그인 화면과 본 화면을 고른다. 401은 안내 없이, 그 밖의 오류는 서버 문구와 함께 로그인 화면으로. */
export function App() {
  const [meState, setMeState] = useState<MeState>({ kind: "loading" });
  // 왜 useCallback인가: MainScreen의 effect가 이 함수를 의존하므로, 렌더마다 새 함수면 effect가 매번 다시 돈다.
  const signOut = useCallback((message: string | null) => setMeState({ kind: "signedOut", message }), []);
  useEffect(() => {
    apiGet<MeDto>("/api/me").then(
      (me) => setMeState({ kind: "signedIn", me }),
      (error: unknown) => signOut(error instanceof ApiError && error.status === 401 ? null : describeApiError(error)),
    );
  }, [signOut]);
  if (meState.kind === "loading") return <p className="splash">불러오는 중…</p>;
  if (meState.kind === "signedOut") return <LoginScreen loginError={readLoginError(window.location.search)} message={meState.message} />;
  return <MainScreen me={meState.me} onSignedOut={signOut} />;
}
```

`apps/web/src/screens/LoginScreen.tsx`:
```tsx
import { API_BASE } from "../api/client";
import { ApiNotice } from "../components/ApiNotice";

/** 로그인 화면 속성. */
export interface LoginScreenProps {
  /** 서버 콜백이 주소에 넣은 로그인 실패 이유(?loginError=). 한도 초과도 여기로 온다(R-8). */
  loginError: string | null;
  /** 세션 종료 이유 같은 안내. */
  message: string | null;
}

/** 로그인 화면. 매니저 로그인과 스트리머 채널 연결 두 길만 둔다. 링크는 최상위 이동이라 서버는 실패를 JSON이 아닌 loginError로 돌려준다. */
export function LoginScreen({ loginError, message }: LoginScreenProps) {
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

/** TabBar 속성. */
export interface TabBarProps {
  /** 지금 보이는 탭. */
  active: Tab;
  /** 탭을 누르면 부른다. */
  onChange(tab: Tab): void;
  /** 후보 탭 배지: 처리를 기다리는 항목 수(사람 묶음 + 숨기지 못한 자동 숨김 건, countActionable). 메시지 건수가 아니다. */
  pendingCount: number;
}

/** 아래쪽 탭 막대. 후보 탭에는 처리를 기다리는 항목 수를 붙인다. */
export function TabBar({ active, onChange, pendingCount }: TabBarProps) {
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
import { useCallback, useEffect, useReducer, useRef, type Dispatch } from "react";
import { apiGet, describeApiError, requiresSignIn } from "../api/client";
import { RealtimeConnection } from "../api/realtime";
import { initialServerState, serverReducer, type ServerAction, type ServerState } from "./serverReducer";

/** useServerState 결과. */
export interface ServerConnection {
  /** 화면이 쓰는 서버 상태. */
  state: ServerState;
  /** 상태·후보를 서버에서 다시 읽는다('다시 불러오기', 409 already_handled). */
  reload(): void;
  /** 거절로 멈춘 실시간 연결을 다시 시작한다(R-6). */
  reconnect(): void;
}

/** 상태·후보 조회기. 한 번에 하나만 돌고, 도는 중에 다시 요청되면 끝난 뒤 한 번 더 읽는다. */
interface SnapshotLoader {
  /** 조회를 요청한다. */
  request(): void;
  /** 화면이 사라졌다: 이후 결과를 버린다. */
  cancel(): void;
}

/**
 * 처음 상태를 REST로 읽고 이후 변화는 WebSocket으로 받는다.
 * 실시간 연결이 (다시) 열릴 때마다 상태·후보를 다시 읽는다. 휴대폰은 화면이 꺼질 때마다 연결이 끊겨, 그동안 생긴 후보를 놓치기 때문이다(R-3).
 * 조회·티켓이 로그인이 필요한 오류(401·409 no_channel)면 실시간을 멈추고 세션 종료로 처리해 로그인 화면으로 보낸다(R-12).
 */
export function useServerState(): ServerConnection {
  const [state, dispatch] = useReducer(serverReducer, initialServerState);
  const controls = useRef<{ loader: SnapshotLoader; connection: RealtimeConnection } | null>(null);
  useEffect(() => {
    // endSession·loader·connection은 서로를 부르지만 모두 비동기 콜백 안에서만 부르므로, 아래 선언 순서로도 초기화 전에 쓰이지 않는다.
    const endSession = (reason: string) => {
      connection.stop();
      dispatch({ type: "event", event: { type: "session_ended", reason } });
    };
    const loader = createSnapshotLoader(dispatch, endSession);
    const connection = new RealtimeConnection({
      onEvent: (event) => dispatch({ type: "event", event }),
      onConnectionChange: (connected) => {
        dispatch({ type: "connection", connected });
        if (connected) loader.request();
      },
      onSessionEnded: (reason) => dispatch({ type: "event", event: { type: "session_ended", reason } }),
      onRejected: () => dispatch({ type: "realtime_rejected" }),
    });
    controls.current = { loader, connection };
    loader.request();
    connection.start();
    return () => {
      loader.cancel();
      connection.stop();
    };
  }, []);
  const reload = useCallback(() => controls.current?.loader.request(), []);
  const reconnect = useCallback(() => controls.current?.connection.start(), []);
  return { state, reload, reconnect };
}

/**
 * 조회기를 만든다. 조회를 하나씩만 돌리는 이유: 리듀서는 조회 하나가 진행 중인 동안의 이벤트만 기록했다가 다시 적용한다(replayLog).
 * @param dispatch 리듀서 디스패치
 * @param onSignInRequired 로그인이 필요한 오류일 때 서버 문구로 부른다
 */
function createSnapshotLoader(dispatch: Dispatch<ServerAction>, onSignInRequired: (message: string) => void): SnapshotLoader {
  let running = false;
  let requestedAgain = false;
  let cancelled = false;
  const run = async (): Promise<void> => {
    running = true;
    await loadSnapshot(dispatch, () => cancelled, onSignInRequired);
    running = false;
    if (!requestedAgain || cancelled) return;
    requestedAgain = false;
    void run();
  };
  return {
    request: () => {
      if (running) requestedAgain = true;
      else void run();
    },
    cancel: () => {
      cancelled = true;
    },
  };
}

/** 상태와 최근 후보를 함께 읽어 리듀서에 넣는다. 화면이 사라졌으면 결과를 버린다. */
async function loadSnapshot(dispatch: Dispatch<ServerAction>, isCancelled: () => boolean, onSignInRequired: (message: string) => void): Promise<void> {
  dispatch({ type: "snapshot_started" });
  try {
    const [status, verdicts] = await Promise.all([apiGet<ServerStatus>("/api/status"), apiGet<VerdictDto[]>("/api/candidates")]);
    if (!isCancelled()) dispatch({ type: "snapshot_loaded", status, verdicts });
  } catch (error) {
    if (isCancelled()) return;
    dispatch({ type: "snapshot_failed", message: describeApiError(error) });
    if (requiresSignIn(error)) onSignInRequired(error.message);
  }
}
```

`apps/web/src/screens/MainScreen.tsx`:
```tsx
import type { MeDto } from "@zzirit-guard/shared";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiSend, requiresSignIn } from "../api/client";
import { TabBar, type Tab } from "../components/TabBar";
import { buildSections, countActionable } from "../domain/candidates";
import { useNow } from "../state/useNow";
import { useServerState } from "../state/useServerState";
import { CandidatesScreen, type CandidateActions } from "./CandidatesScreen";
import { LiveChatScreen } from "./LiveChatScreen";
import { SettingsScreen } from "./SettingsScreen";

/** 후보 시각 창을 다시 계산하는 간격(15초). */
const NOW_REFRESH_MS = 15_000;
/** 임시 제한 성공 안내. 서버는 묶음의 첫 판정 1건만 restricted로 바꾸므로, 남은 메시지를 정리하라고 알린다. */
const TEMPORARY_RESTRICT_DONE = "임시 제한했습니다. 같은 사람의 남은 메시지는 숨기기나 무시로 정리하세요.";
/** 오판 신고 성공 안내. 신고한 판정은 후보 화면에서 빠지고 오판 검토 목록에 오른다. */
const FALSE_POSITIVE_DONE = "오판으로 신고했습니다. 기록·설정 → 오판 검토에서 볼 수 있습니다.";
/** 실시간 연결이 거듭 거절됐을 때의 안내(R-6). 출처 불일치(다른 주소로 연 경우)가 가장 흔한 원인이다. */
const REALTIME_REJECTED_MESSAGE = "실시간 연결이 계속 거절됩니다. 운영자가 알려 준 주소(https://…ts.net)로 열었는지 확인한 뒤 '다시 연결'을 누르세요.";

/** 조치 응답(서버 sendOutcome). 무시·오판·스위치는 note가 없다. */
interface ActionResponse {
  /** 성공 여부(실패는 오류 응답으로 온다). */
  ok: true;
  /** 매니저에게 보여 줄 안내(예: "이미 사라진 메시지입니다"). */
  note?: string | null;
}

/** MainScreen 속성. */
export interface MainScreenProps {
  /** 로그인한 매니저. */
  me: MeDto;
  /** 세션이 끝났을 때 로그인 화면으로 돌아간다(message는 안내 문구). 렌더마다 바뀌지 않는 함수여야 한다. */
  onSignedOut(message: string | null): void;
}

/**
 * 후보 화면 동작을 API로 채운다. 결과 상태는 서버가 WebSocket으로 다시 알려 화면이 바뀐다.
 * 로그인이 필요한 오류(401·409 no_channel)면 로그인 화면으로 보내고, 오류는 다시 던져 화면에 남긴다.
 */
function createCandidateActions(onSignedOut: (message: string | null) => void): CandidateActions {
  const send = (path: string, body?: unknown) =>
    apiSend<ActionResponse>("POST", path, body).catch((error: unknown) => {
      if (requiresSignIn(error)) onSignedOut(error.message);
      throw error;
    });
  return {
    hide: async (verdict) => (await send(`/api/verdicts/${verdict.id}/hide`)).note ?? null,
    temporaryRestrict: async (group) =>
      (await send(`/api/senders/${encodeURIComponent(group.senderChannelId)}/temporary-restrict`, { chatChannelId: group.chatChannelId, verdictId: group.verdicts[0]?.id ?? null })).note ?? TEMPORARY_RESTRICT_DONE,
    ignore: async (verdict) => (await send(`/api/verdicts/${verdict.id}/ignore`)).note ?? null,
    reportFalsePositive: async (verdict) => (await send(`/api/verdicts/${verdict.id}/false-positive`)).note ?? FALSE_POSITIVE_DONE,
    setAutoHide: async (enabled) => (await send("/api/auto-hide", { enabled })).note ?? null,
  };
}

/** 로그인 뒤 본 화면: 탭 3개(스펙 6장). 세션이 끝나면 로그인 화면으로 돌아간다. */
export function MainScreen({ me, onSignedOut }: MainScreenProps) {
  const [tab, setTab] = useState<Tab>("candidates");
  const { state, reload, reconnect } = useServerState();
  const now = useNow(NOW_REFRESH_MS);
  const actions = useMemo(() => createCandidateActions(onSignedOut), [onSignedOut]);
  useEffect(() => {
    if (state.sessionEndedReason) onSignedOut(state.sessionEndedReason);
  }, [state.sessionEndedReason, onSignedOut]);
  // 구역은 여기서 한 번만 계산해 후보 화면과 탭 배지가 같은 값을 쓴다.
  const sections = useMemo(() => buildSections(state.verdicts, now), [state.verdicts, now]);
  return (
    <div className="app">
      {state.loadError && <p className="error" role="alert">{state.loadError}</p>}
      {state.realtimeRejected && <RealtimeRejectedNotice onRetry={reconnect} onSignedOut={onSignedOut} />}
      {tab === "candidates" && <CandidatesScreen me={me} status={state.status} sections={sections} realtimeConnected={state.realtimeConnected} actions={actions} onReload={reload} />}
      {tab === "chat" && <LiveChatScreen lines={state.chatLines} />}
      {tab === "settings" && <SettingsScreen me={me} onSignedOut={onSignedOut} />}
      <TabBar active={tab} onChange={setTab} pendingCount={countActionable(sections)} />
    </div>
  );
}

/** 실시간 거절 안내 속성. */
interface RealtimeRejectedNoticeProps {
  /** '다시 연결'을 누르면 부른다. */
  onRetry(): void;
  /** 세션이 끝났으면 로그인 화면으로 보낸다. */
  onSignedOut(message: string | null): void;
}

/**
 * 실시간 연결이 거듭 거절됐을 때의 안내(R-6). 먼저 /api/me로 세션을 확인해, 세션이 끝났으면 로그인 화면으로 보낸다.
 * 세션이 살아 있으면 출처 문제일 가능성이 크므로 주소를 확인하라고 알리고 '다시 연결'을 둔다.
 */
function RealtimeRejectedNotice({ onRetry, onSignedOut }: RealtimeRejectedNoticeProps) {
  useEffect(() => {
    apiGet<MeDto>("/api/me").catch((error: unknown) => {
      if (requiresSignIn(error)) onSignedOut(error.message);
      else console.warn("실시간 연결이 거절된 뒤 세션 확인에 실패했습니다", error);
    });
  }, [onSignedOut]);
  return (
    <div className="error" role="alert">
      <p>{REALTIME_REJECTED_MESSAGE}</p>
      <button type="button" onClick={onRetry}>다시 연결</button>
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
  --ok: #7ad99a;
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
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
.banner { margin: 0; padding: 10px 12px; border-radius: 10px; list-style: none; }
.banner-ok { background: #1f3a2a; }
.banner-warning { background: #4a2a1a; }
.toggle-on { background: var(--accent); color: #17171f; font-weight: 700; }
.error { color: var(--danger); }
.feedback { color: var(--ok); }
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
.message .reason { grid-column: 1 / -1; color: var(--muted); font-size: 12px; }
.section-auto-pending { border: 1px solid var(--danger); border-radius: 12px; padding: 10px; }
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
.false-positive-counts { padding-left: 18px; }
.field, .rule-form label { display: flex; flex-direction: column; gap: 4px; margin: 6px 0; }
input, select { min-height: 40px; border-radius: 8px; border: 1px solid #3a3a48; background: #101018; color: var(--text); padding: 0 8px; font-size: 15px; }
.splash { padding: 48px; text-align: center; color: var(--muted); }
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/web`
Expected: PASS (73 tests)

- [ ] **Step 5: 빌드 확인**

Run: `npm run build -w @zzirit-guard/web && ls apps/web/dist/index.html apps/web/dist/sw.js apps/web/dist/manifest.webmanifest && grep -c "<script>" apps/web/dist/index.html`
Expected: 오류 없음, 세 파일 존재, 마지막 숫자가 0(인라인 스크립트 없음 — 서버 CSP와 맞음). `grep -c`는 0을 찾으면 종료 코드 1을 돌려주니 숫자만 본다.

- [ ] **Step 6: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/web
git commit -m "feat: PWA 앱 골격과 로그인·탭 화면 추가" -m "내 정보로 로그인 화면과 본 화면을 고르고, 본 화면은 후보·실시간 채팅·기록·설정 탭을 둔다. 상태는 REST로 읽고 변화는 WebSocket으로 받으며, 연결이 다시 열릴 때마다 다시 읽어 병합한다. 세션이 끝나거나 채널 연결이 사라지면 로그인 화면으로 돌아가고, 실시간 연결이 거듭 거절되면 이유와 다시 연결 버튼을 보여 준다."
```

---
### Task 9: 운영 스크립트와 문서

**Files:**
- Create: `ops/launchd/com.zzirit-guard.server.plist.template`, `ops/scripts/install-launchd.sh`
- Create: `docs/operations/operator-guide.md`, `docs/operations/channel-notice-template.md`, `docs/operations/streamer-agreement-template.md`, `docs/operations/chzzk-inquiry-email.md`, `docs/operations/device-checklist.md`
- Modify: `README.md`(상태·운영 안내 링크)

**Interfaces:** 없음(문서·스크립트). 문서의 화면 이름은 Task 4·7의 실제 문구("기록·설정 → 계정 → 장애 알림 받기", "상태 점검", "오판 검토", "숨김 대기·실패", "다시 연결")와 맞춘다.

초판과 달라진 점(R-17·R-18·B4·B6):
- FileVault를 켜면 자동 로그인을 쓸 수 없어 정전·재부팅 뒤 잠금 화면에서 멈춘다는 현실과 `fdesetup authrestart`를 적는다(`pmset autorestart`는 켜기만 한다).
- newsyslog 설정을 없앤다. launchd가 로그 파일을 한 번만 열고 서버도 다시 열지 않아, 회전하면 옛 파일에 계속 쓰고 압축 회전이 옛 파일을 지우면 로그가 사라진다. 손으로 옮기는 절차로 바꾼다.
- 복원 때 `-wal`·`-shm`을 지우고, 백업 파일 이름(`zzirit-guard-YYYYMMDD-HHMMSS.sqlite`)을 적는다. 웹을 다시 빌드하면 서버를 재시작해야 한다.
- 새 매니저는 최대 5분 로그인 거부(관리자 목록 캐시), 해임은 최대 약 10분(재확인 5분 + 캐시 5분).
- 자동 숨김을 켜는 기준(스펙 14장)은 지금 화면으로 바로 볼 수 없고 스위치가 채널에 하나뿐이라는 사실에 맞춰 고친다.
- 공지·합의서에 백업 +7일, 요주의 사용자 기준(최근 180일 조치 이력), 조치 기록 180일 보관(대상 채널 ID 포함)을 넣는다(README·제37조의2④).
- 운영 안내서·공지·합의서에 "영구 제한(활동 제한)과 해제는 치지직 기본 도구로 한다"를 적는다(B4).
- API Scope 이름은 확인하지 않은 값이라고 밝히고, 문의 메일 주소를 저장소에 고정하지 않는다. 설치 경로는 `<설치 경로>` 자리표시자로 쓴다.
- `install-launchd.sh`: node가 없으면 이유를 말하고 끝내고, 실행 중인 서버가 있는지 먼저 확인해 내리기 실패를 "처음 설치"로 잘못 안내하지 않는다.
- 실기기 점검표에 위생 문구와 행(홈 화면 앱 안 로그인, XSS 문자열, 판정 이유, 오판 검토, 화면 끔 뒤 후보, 로그아웃 뒤 알림 없음, 해임 약 10분)을 더한다.

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
# Node를 업그레이드하면(경로가 바뀌므로) 다시 실행한다.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LABEL=com.zzirit-guard.server
DOMAIN="gui/$(id -u)"
DATA_DIR="$HOME/Library/Application Support/zzirit-guard"
ENV_FILE="$DATA_DIR/.env"
LOG_DIR="$HOME/Library/Logs/zzirit-guard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# command -v는 못 찾으면 1을 돌려 set -e가 이유 없이 끝내므로, 빈 값으로 받고 직접 안내한다.
NODE=$(command -v node || true)
if [[ -z "$NODE" ]]; then
  echo "node를 찾을 수 없습니다. Node.js 22.12 이상을 설치하고 이 터미널의 PATH에서 node가 보이게 한 뒤 다시 실행하세요." >&2
  exit 1
fi
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
# 이미 떠 있으면 내린다. 떠 있는지 먼저 확인해, 내리기 실패(권한 등)를 '처음 설치'로 잘못 안내하지 않는다.
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  echo "실행 중이던 서버를 내렸습니다."
else
  echo "실행 중인 서버가 없습니다(처음 설치)."
fi
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "설치했습니다: $PLIST (node: $NODE)"
echo "상태 확인: launchctl print $DOMAIN/$LABEL | grep state"
echo "로그: tail -f \"$LOG_DIR/server.log\""
```

- [ ] **Step 2: 운영 안내서 작성**

`docs/operations/operator-guide.md`:
````markdown
# 찌리릿 가드 운영 안내서

맥 미니 한 대에 서버를 설치해 채널 1곳을 운영하는 절차다. 스펙: `docs/superpowers/specs/2026-10-11-zzirit-guard-design.md`.

## 1. 준비물
- macOS 맥 미니(전원 연결, **FileVault 켬**, 스펙 8장), Node.js 22.12 이상, git
- Tailscale 계정과 맥 미니 설치(Funnel 사용 가능해야 함)
- 치지직 개발자 센터 계정(운영자 본인 네이버 계정)

## 2. 치지직 개발자 앱 등록
1. https://developers.chzzk.naver.com 에서 애플리케이션을 만든다. **이름에 chzzk·치지직·naver·네이버를 넣을 수 없다**(예: "찌리릿 가드").
2. 로그인 리디렉션 URL: `https://<기기이름>.<tailnet>.ts.net/auth/callback` (Funnel 주소, 4장 참고)
3. API Scope: 서버가 쓰는 기능은 유저 정보 조회, 채널 관리자 목록 조회, 채팅 메시지 조회(세션 구독), 채팅 메시지 숨기기, 채팅 설정 조회·변경, 임시 제한·활동 제한이다. 조사 당시 문서의 이름은 "유저 정보 조회, 채널 관리자 조회, 채팅 메시지 조회, 채팅 메시지 쓰기, 채팅 설정 조회, 채팅 설정 변경, 활동제한 조회, 활동제한 쓰기"였지만 **개발자 센터 화면에서 확인하지 않았다.** 화면의 실제 이름으로 고르고, 고른 이름을 이 문서에 고쳐 적는다.
4. 발급된 Client ID·Secret은 6장의 `.env`에만 적는다. **누구와도 공유하지 않는다**(약관 제7조②11호·③).
5. 90일 동안 API 사용이 없으면 앱이 삭제된다. 비시즌에도 한 달에 한 번은 서버를 켜 둔다.

## 3. 설치와 빌드
```bash
git clone https://github.com/<계정>/zzirit-guard.git <설치 경로>
cd <설치 경로>
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
- 이 주소를 2장의 리디렉션 URL과 6장의 `ZG_PUBLIC_ORIGIN`에 똑같이 쓴다. 매니저에게도 이 주소만 알려 준다(다른 주소로 열면 실시간 연결이 거절된다, 12장).

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
`.env`를 채운다: `ZG_PUBLIC_ORIGIN`(Funnel 주소), `ZG_CHANNEL_ID`(스트리머 채널 ID: 채널 주소 `chzzk.naver.com/<채널ID>`의 끝부분), Client ID·Secret, `ZG_DATA_DIR`, `ZG_WEB_DIST`(`<설치 경로>/apps/web/dist`), VAPID 키 3개.

## 7. 서버 시작·잠자기·재부팅
```bash
ops/scripts/install-launchd.sh
sudo pmset -a sleep 0 disksleep 0     # 방송 중 잠들지 않게
sudo pmset -a autorestart 1           # 정전 뒤 전기가 들어오면 켜지게(켜지기만 한다, 아래 참고)
```
- 서버는 로그인한 사용자 세션에서 돈다(키체인을 읽어야 해서 LaunchAgent로 둔다). Node를 업그레이드하면 `install-launchd.sh`를 다시 실행한다(node 경로가 plist에 들어간다).
- **FileVault를 켜면 macOS는 자동 로그인을 쓸 수 없다.** 그래서 정전·재부팅 뒤에는 맥 미니가 FileVault 잠금 화면에서 멈추고, 누군가 맥 미니 앞에서 암호를 넣어 로그인해야 Tailscale과 서버가 뜬다. 원격으로는 풀 수 없다.
  - 계획한 재시작(macOS 업데이트 등)은 `sudo fdesetup authrestart`로 하면 다음 한 번의 재시작에서 잠금을 건너뛴다. 이 맥이 지원하는지 먼저 `man fdesetup`으로 확인한다.
  - 방송 전 점검(11장)에서 화면이 열리는지 꼭 확인한다. 정전이 잦은 곳이면 무정전 전원 장치(UPS)를 고려한다.
- 재시작: `launchctl kickstart -k gui/$(id -u)/com.zzirit-guard.server`

## 8. 로그
- 위치: `~/Library/Logs/zzirit-guard/server.log`·`server.err.log`. 채팅 원문은 남지 않는다(식별자만).
- **newsyslog 같은 자동 회전은 쓰지 않는다.** launchd는 로그 파일을 서버를 띄울 때 한 번만 열고 서버도 파일을 다시 열지 않는다. 그래서 회전 도구가 파일을 옮기면 서버는 옮겨진 옛 파일에 계속 쓰고, 압축 회전이 옛 파일을 지우면 그 뒤 로그가 사라진다.
- 가끔 `ls -lh ~/Library/Logs/zzirit-guard`로 크기를 보고, 커졌으면 서버를 멈추고 옮긴 뒤 다시 띄운다.
```bash
launchctl bootout gui/$(id -u)/com.zzirit-guard.server
cd ~/Library/Logs/zzirit-guard && for name in server server.err; do [[ -f $name.log ]] && mv $name.log $name-$(date +%Y%m%d).log; done
<설치 경로>/ops/scripts/install-launchd.sh
```

## 9. 첫 연결(스트리머)
1. 스트리머와 **운영 합의서**(`streamer-agreement-template.md`)를 먼저 주고받는다.
2. 스트리머가 `https://<Funnel 주소>`에서 "스트리머: 채널 연결"을 누르고 치지직 동의 화면에서 허용한다.
3. 채널 공지에 `channel-notice-template.md`를 채워 올린다(개인정보보호법 제37조의2).
- 연결 해제(기록·설정 → 계정 → 채널 연결 해제, 스트리머만): 모든 매니저가 로그아웃되고 자동 기능이 멈춘다. **규칙·설정은 남는다**(다시 연결하면 그대로 쓴다).

## 10. 매니저 안내
1. 치지직에서 채널 관리자 또는 채팅 운영자로 등록돼 있어야 한다. **방금 등록한 매니저는 최대 5분 동안 로그인이 거부될 수 있다**(서버가 관리자 목록을 5분 동안 캐시한다). 5분 뒤 다시 시도한다.
2. 치지직에서 매니저를 해제하면, 서버가 5분마다 다시 확인하고 목록 캐시도 최대 5분이라 **최대 약 10분 안에** 그 사람의 화면이 로그인 화면으로 돌아간다.
3. 휴대폰으로 Funnel 주소 → "매니저 로그인".
4. iPhone: Safari 공유 → "홈 화면에 추가" 후 그 앱에서 "기록·설정 → 계정 → 장애 알림 받기"(iOS 16.4 이상). 홈 화면 앱 안에서 치지직 로그인이 끝나는지는 아직 실기기로 확인하지 않았다(실기기 점검표). 확인한 결과와, 안 될 때의 방법을 이 장에 적는다.
5. 로그아웃하면 그 기기의 장애 알림 구독도 해지된다.

## 11. 방송 전 점검(기록·설정 → 상태 점검)
- 이 표는 15초마다 서버에서 다시 읽는다.
- 채널: (채널 이름) / 치지직 채팅 연결: 연결됨 / 숨김·제재 가능: 가능 / 마지막 채팅 수신: 채팅이 오고 있으면 방금 / 처리 대기 중인 조치: 0건 근처
- 하나라도 아니면 12장.

## 12. 장애 대응
| 증상 | 조치 |
|---|---|
| "숨김·제재 불가(스트리머 재연결 필요)" | 스트리머가 "스트리머: 채널 연결"을 다시 한다 |
| 채팅 연결 끊김이 계속 | 로그 확인 → 서버 재시작(7장) |
| 화면이 안 열림 | 맥 미니가 FileVault 잠금 화면에 멈췄는지(7장), `tailscale funnel status`, `launchctl print gui/$(id -u)/com.zzirit-guard.server` 확인 |
| "실시간 연결이 계속 거절됩니다" | Funnel 주소(`ZG_PUBLIC_ORIGIN`과 같은 주소)로 열었는지 확인한 뒤 '다시 연결' |
| 로그인 화면에 "요청이 너무 많습니다" | 1분 기다렸다 다시 한다. 계속되면 누군가 로그인 주소를 반복해서 부르는 것이므로 로그를 본다 |
| 자동 숨김이 저절로 꺼짐 | 기록·설정 → 감사 기록에서 이유("1분 한도 초과"·"치지직 호출 실패 증가")를 확인하고 규칙을 고친다 |
| 후보 화면 "숨김 대기·실패"에 항목이 남음 | 스위치가 꺼져 취소됐거나 치지직 호출이 실패한 자동 숨김이다. 필요하면 '숨기기'로 직접 숨긴다 |
| 웹을 다시 빌드한 뒤 화면이 비어 있음 | 서버를 재시작한다(14장) |

## 13. 백업과 복원
- 서버는 시작 5분 뒤와 그 뒤 매일 `$ZG_DATA_DIR/backups/`에 `zzirit-guard-YYYYMMDD-HHMMSS.sqlite`(소유자만 읽기)를 만들고 최근 7개를 남긴다. 그래서 보관 기간이 지나 DB에서 지운 원문도 **백업에는 최대 7일 더 남는다**(공지·합의서에 적는다).
- 복원: 서버를 멈추고, 지금 DB의 `-wal`·`-shm` 파일을 지운 뒤 백업으로 바꾸고 다시 띄운다. **`-wal`을 남기면 옛 기록이 복원본에 섞인다**(DB는 WAL 모드다).
```bash
launchctl bootout gui/$(id -u)/com.zzirit-guard.server
cd "$HOME/Library/Application Support/zzirit-guard"      # ZG_DATA_DIR
rm -f zzirit-guard.sqlite-wal zzirit-guard.sqlite-shm
cp backups/zzirit-guard-YYYYMMDD-HHMMSS.sqlite zzirit-guard.sqlite
chmod 600 zzirit-guard.sqlite
<설치 경로>/ops/scripts/install-launchd.sh
```
- 같은 맥(같은 키체인 키)에서만 토큰을 읽을 수 있다.

## 14. 업데이트
```bash
cd <설치 경로>
git pull --ff-only
npm ci
npm run build -w @zzirit-guard/server
npm run build -w @zzirit-guard/web
launchctl kickstart -k gui/$(id -u)/com.zzirit-guard.server
```
- **웹만 다시 빌드해도 서버를 재시작해야 한다.** 서버는 시작할 때 `dist`의 파일 목록으로 경로를 만든다(@fastify/static `wildcard: false`, 문서 기준이며 실행해 보지는 않았다). 새 빌드의 파일 이름(해시)이 재시작 전까지 없는 경로가 되어 화면이 비어 보일 수 있다.

## 15. 자동 숨김을 켜기 전에(로드맵 3단계)
- 스펙 14장의 기준은 "섀도 판정에 매니저가 동의한 비율 95% 이상"이다. **지금 화면에는 이 비율을 바로 보여 주는 곳이 없고, 스위치는 규칙별이 아니라 채널에 하나뿐이다.**
- 그 전까지는 방송마다 섀도 구역("켜져 있었으면 숨겼을 메시지")에서 '숨기기'(동의)와 '오판'(동의 안 함)을 누른 건수를 적어 동의 비율 = 숨기기 ÷ (숨기기 + 오판)으로 계산한다.
- 기록·설정 → 오판 검토에서 오판이 나온 규칙을 먼저 고친다(예외 단어·허용어 추가, 금칙어 강을 약으로 옮기기).
- 동의 비율이 방송 2회 이상 95%를 넘고 오판 검토에 새 오판이 없을 때 스위치를 켠다. 켜면 채널 전체에 적용된다.

## 16. 치지직 기본 도구로 하는 일
- **영구 제한(활동 제한)과 그 해제는 이 앱에 화면이 없다. 치지직 기본 도구(방송 관리 화면)로 한다.** 이 앱의 버튼은 숨기기·임시 제한·무시·오판뿐이다(스펙 6장).
- 이의 제기로 제재를 풀어야 하면 치지직 기본 도구에서 해제하고, 앱의 감사 기록(기록·설정)과 맞춰 본다.
- 숨긴 채팅은 되돌릴 수 없다(치지직에 숨김 해제 API가 없다).
- 이 앱이 멈춰도 매니저는 치지직 기본 도구로 관리할 수 있다(스펙 10장).

## 17. 개발 메모
- `npm run dev -w @zzirit-guard/web`(Vite 개발 서버)에는 서버 프록시를 두지 않았다. 로그인 콜백 주소는 `ZG_PUBLIC_ORIGIN`으로 고정이고, 세션 쿠키는 Secure이며, 상태 변경 요청과 WebSocket은 Origin이 `ZG_PUBLIC_ORIGIN`과 같아야 해서 `localhost:5173`을 거치면 로그인·조치·실시간이 모두 거절되기 때문이다.
- 화면 동작은 테스트(`npm test -w @zzirit-guard/web`)로, 실제 연결은 빌드해 서버가 제공하는 화면(Funnel 주소)으로 확인한다(빌드 뒤 서버 재시작, 14장).
````

- [ ] **Step 3: 공지·합의서·문의 메일·기기 점검표 작성**

`docs/operations/channel-notice-template.md`:
```markdown
# 채널 공지 문안(초안)

> 개인정보보호법 제37조의2 ④(자동화된 결정의 기준·절차 공개)를 위한 초안이다. 시행령이 정한 적용 범위는 아직 확인하지 않았다. 올리기 전에 [ ] 부분을 채운다. 기간은 기록·설정 → 한도·보관 기간의 값과 같게 적는다.

**[채팅 관리 안내]**

이 채널은 채팅 관리를 돕는 도구 '찌리릿 가드'를 씁니다(치지직 Open API를 쓰는 비공식 도구).

- **자동으로 숨기는 채팅**(자동 숨김을 켠 동안만): 채널이 정한 금칙어(혐오 표현·패드립 등), 여러 사람이 같은 문장을 반복하는 도배, 광고·외부 링크, 전화번호
- **매니저가 확인하는 채팅**: 일반 욕설, 짧은 시간의 반복 채팅, 협박·주소로 보이는 표현, 그리고 **최근 [180]일 안에 숨김·임시 제한·활동 제한을 받은 분의 채팅**(자동으로 숨기지 않고 매니저가 한 번 더 봅니다)
- **제재(임시 제한·활동 제한)는 매니저가 직접 판단**합니다. 자동으로 제재하지 않습니다. 활동 제한(영구)과 그 해제는 매니저가 치지직 기본 도구로 합니다.
- 채팅은 외부 AI나 다른 회사로 보내지 않습니다.
- **보관**: 문제로 판정된 채팅만 원문을 [30]일 보관한 뒤 지웁니다. 매일 만드는 백업에는 최대 7일 더 남습니다. 원문 없는 조치 기록(언제 어떤 조치를 했는지와 대상의 채널 ID)은 [180]일 보관합니다.
- 잘못 숨겨졌다고 생각하면 [이의 제기 경로: 예) 디스코드 #문의, 이메일 ___]로 알려 주세요. 숨겨진 채팅은 되돌릴 수 없지만, 기록을 바로잡고 제재가 있었다면 해제합니다(해제는 치지직 기본 도구로 합니다).
```

`docs/operations/streamer-agreement-template.md`:
```markdown
# 운영 합의서(초안)

> 법률 검토 전 초안이다. 누가 개인정보처리자이고 누가 수탁자인지는 법률 검토를 받아 확정한다(스펙 9장).

- **당사자**: 스트리머 [채널명] / 운영자 [이름]
- **목적**: [채널명] 방송 채팅의 악플·도배 대응 보조(찌리릿 가드 운영)
- **처리하는 정보**: 방송 채팅(닉네임·채널 ID·내용·시각). 문제로 판정되지 않은 채팅은 저장하지 않는다. 조치 기록에는 원문 없이 대상의 채널 ID와 조치 내용·시각을 남긴다.
- **처리 장소**: 운영자의 맥 미니(FileVault 암호화). 외부 AI·다른 회사로 보내지 않는다. 외부 접속은 Tailscale Funnel(중계 서버는 암호화된 트래픽만 전달)로 한다.
- **보관 기간**: 판정된 채팅 원문 [30]일, 원문 없는 조치 기록 [180]일. 기간이 지나면 매일 자동 삭제한다. 매일 백업을 7개까지 두므로 지운 원문도 **백업에 최대 7일 더 남는다**.
- **요주의 사용자**: 최근 [180]일 조치 기록에 숨김·임시 제한·활동 제한이 있는 사용자의 채팅은 매니저 확인 후보로 올린다(자동 숨김 아님). 별도 명단은 저장하지 않고 조치 기록에서 계산한다.
- **토큰**: 스트리머 치지직 토큰은 암호화해 보관하고, 숨김·제재·채팅 설정 외의 용도로 쓰지 않는다.
- **제재 원칙**: 자동 숨김은 스트리머·채널 관리자가 켠 동안만, 제재는 사람만. 활동 제한(영구)과 그 해제는 이 앱에 화면이 없어 치지직 기본 도구로 한다.
- **유료화 없음**: 치지직 약관 제7조②13호에 따라 대가를 받지 않는다.
- **종료**: 어느 쪽이든 알리면 종료한다. 종료 시 운영자는 채널 연결을 해제하고 DB·백업을 [7]일 안에 지운다.
- **연락처**: 스트리머 [ ] / 운영자 [ ]
```

`docs/operations/chzzk-inquiry-email.md`:
```markdown
# 치지직 문의 메일(초안)

- 받는 곳: 치지직 개발자 센터의 문의 안내에 적힌 창구. 공개 저장소에 주소를 고정하지 않는다. 보내기 전에 개발자 센터에서 지금 주소를 확인한다.
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

iPhone(Safari, 홈 화면 앱)과 Android(Chrome) 각각에서 확인한다. 날짜·기기(모델·OS 버전)·결과를 적는다.

> 공개 저장소에 커밋하는 문서다. 채널명·시청자 규모·실제 닉네임·채팅 원문은 적지 않는다(스펙 17장). 실패 내용은 현상과 재현 방법만 적는다.

| 항목 | iPhone | Android |
|---|---|---|
| Funnel 주소 접속, 로그인 화면·로고·"비공식" 표시 | | |
| 매니저 로그인 → 후보 탭 표시 | | |
| 홈 화면 앱 안에서 매니저 로그인이 끝까지 된다(치지직 로그인 뒤 앱으로 돌아와 후보 탭이 보임) | | |
| 매니저가 아닌 계정 로그인 → 이유 문구 표시 | | |
| 방금 매니저로 등록한 계정 → 5분 안에는 거부될 수 있고, 5분 뒤 로그인됨 | | |
| 상태 배너 "정상 동작 중" | | |
| 테스트 채팅(금칙어 약) → 후보에 사람 단위로 표시, 줄마다 이유(예: "금칙어 약 #번호") | | |
| 채팅에 `<b>굵게</b><img src=x onerror=alert(1)>` 입력 → 실시간 채팅·후보에 글자 그대로 보이고 아무것도 실행되지 않음 | | |
| 숨기기 → 치지직 방송 화면에서 실제로 숨겨짐 | | |
| 임시 제한 → 치지직에서 실제로 제한됨, 남은 메시지 정리 안내가 보임 | | |
| 무시·오판 → 후보에서 사라짐, 감사 기록에 "무시"·"오판 신고"로 남음 | | |
| 오판 → 기록·설정 → 오판 검토에 규칙과 건수가 보임 | | |
| 자동 숨김 켜기 확인 창, 채팅 운영자는 켜기 비활성 | | |
| 실시간 채팅 탭: 위험한 것만 보기 | | |
| 규칙 추가·삭제(채널 관리자), 채팅 운영자는 목록만 | | |
| 저속 모드 변경이 치지직에 반영 | | |
| 상태 점검: 마지막 채팅 수신이 15초 안에 갱신됨 | | |
| 홈 화면 추가 후 "장애 알림 받기" → 알림 수신 | | |
| 로그아웃 → 그 기기로 장애 알림이 더 오지 않음 | | |
| 화면을 끄고 1분 뒤 켬 → 그사이 올라온 후보가 보임 | | |
| 서버 재시작 중 화면 → 재연결 후 정상 | | |
| 치지직에서 매니저 해제 → 약 10분 안에 로그인 화면으로 | | |

## 실연결 메모

- sessionKey 전달 방식:
- CHAT 페이로드 형식:
- 홈 화면 앱 안 로그인:
```

- [ ] **Step 4: README 고치기**

`README.md`의 "## 상태" 아래 세 줄:
```markdown
- **1단계 서버(1A)를 구현했습니다.** 규칙 판정(금칙어·도배·광고·전화번호), 섀도 모드, 매니저 조치(숨김·제한·무시·오판 신고), REST·WebSocket API가 들어 있습니다.
- **매니저 화면(PWA)과 운영 문서(1B)는 작업 중입니다.**
- **실제 치지직과 연결해 검증하지는 않았습니다.** 지금까지는 가짜 치지직 서버로만 시험했습니다.
```
를 다음으로 바꾼다:
```markdown
- **1단계 서버(1A)와 매니저 화면(PWA)·운영 문서(1B)를 구현했습니다.** 규칙 판정(금칙어·도배·광고·전화번호), 섀도 모드, 매니저 조치(숨김·임시 제한·무시·오판 신고), 휴대폰 화면(후보·실시간 채팅·기록/설정·오판 검토·장애 알림)이 들어 있습니다.
- **실제 치지직과 연결해 검증하지는 않았습니다.** 지금까지는 가짜 치지직 서버와 단위 테스트로만 시험했습니다. 실기기 확인 결과는 [실기기 점검표](docs/operations/device-checklist.md)에 적습니다.
- 영구 제한(활동 제한)과 그 해제는 이 앱에 화면이 없습니다. 치지직 기본 도구로 합니다.
```

같은 파일의 제목 `## 운영하려는 분께(구현 후)`를 `## 운영하려는 분께`로 바꾸고, 그 바로 아래에 빈 줄과 다음 줄을 넣는다(기존 "이 프로젝트를 설치해서 운영하는 사람은…" 문단 앞):
```markdown
설치·운영 절차는 [운영 안내서](docs/operations/operator-guide.md)를 따릅니다.
```

- [ ] **Step 5: 스크립트 문법과 위생 확인**

Run:
```bash
chmod +x ops/scripts/install-launchd.sh && zsh -n ops/scripts/install-launchd.sh && echo SCRIPT_OK
CHECK=$(mktemp -t zg-plist) && sed 's/__[A-Z_]*__/x/g' ops/launchd/com.zzirit-guard.server.plist.template > "$CHECK" && plutil -lint "$CHECK"; rm -f "$CHECK"
[[ ! -e /usr/bin/node && ! -e /bin/node ]] && (PATH=/usr/bin:/bin /bin/zsh ops/scripts/install-launchd.sh; echo "exit=$?") 2>&1 | tail -2
grep -rnE "/Users/[A-Za-z0-9_]+/|dl_chzzk" docs/operations README.md ops || echo HYGIENE_OK
```
Expected: `SCRIPT_OK`, `…: OK`(plutil), node 없는 PATH에서는 "node를 찾을 수 없습니다…"와 `exit=1`(launchctl을 건드리기 전에 끝난다. `/usr/bin`·`/bin`에 node가 있는 맥이면 이 줄은 건너뛴다), `HYGIENE_OK`. plutil은 프로세스 치환(`<(…)`)을 열지 못하는 환경이 있어 임시 파일로 확인한다.

- [ ] **Step 6: 커밋**

```bash
npm run lint
git add ops docs/operations README.md
git commit -m "docs: 운영 안내서·launchd 설치·공지·합의서·문의 메일 초안 추가" -m "맥 미니 한 대로 채널 1곳을 운영하는 절차(앱 등록·Funnel·키체인·launchd·잠자기·FileVault 재부팅·로그·백업 복원·업데이트)와 채널 공지(제37조의2: 요주의 기준·보관 기간·백업 7일)·운영 합의서·치지직 문의 메일 초안, 실기기 점검표를 둔다. 영구 제한·해제는 치지직 기본 도구로 한다고 적는다."
```

---

### Task 10: 전체 검사·실기기 확인

push와 PR은 이 작업에서 하지 않는다. 컨트롤러가 마지막에 `--base main`으로 연다(B6).

- [ ] **Step 1: 전체 검사**

Run: `npm run check && npm run build -w @zzirit-guard/server && npm run build -w @zzirit-guard/web`
Expected: lint 0건, typecheck 통과, 서버 412·웹 73 테스트 통과, 빌드 성공

- [ ] **Step 2: 실제 환경 확인(사람이 함께)**

운영 안내서 2~10장대로 맥 미니에 설치하고, 스트리머 계정으로 채널을 연결한 뒤 `docs/operations/device-checklist.md`를 채운다. 점검표 맨 위의 위생 문구대로 채널명·시청자 규모·실제 닉네임·채팅 원문은 적지 않는다. 실패 항목은 이슈로 남기고 원인을 고친 뒤 다시 확인한다. 특히 다음을 실연결로 확인하고 결과를 점검표 아래 "실연결 메모"에 적는다.
- sessionKey 쿼리 전달로 채팅 구독이 되는지(가짜 서버는 쿼리로 가정)
- CHAT 페이로드가 객체로 오는지 문자열로 오는지(둘 다 처리하지만 실제 형식을 기록)
- 홈 화면 앱 안에서 로그인이 끝나는지(안 되면 운영 안내서 10장에 결과와 방법을 적는다)

- [ ] **Step 3: 점검표·README 커밋**

점검표의 모든 행이 통과했으면 `README.md`의 `- **실제 치지직과 연결해 검증하지는 않았습니다.** …` 줄을 `- **실제 치지직 연결은 <YYYY-MM-DD>에 실기기 점검표대로 확인했습니다.** 결과는 [실기기 점검표](docs/operations/device-checklist.md)에 있습니다.`로 바꾼다(날짜는 확인한 날). 실패 행이 남았으면 README는 그대로 둔다.
```bash
git add docs/operations/device-checklist.md docs/operations/operator-guide.md README.md
git commit -m "docs: 1단계 실기기 점검 결과 기록" -m "iPhone·Android에서 로그인·후보 처리·숨김·제재·스위치·알림·재연결을 확인한 결과를 남긴다."
```

- [ ] **Step 4: 컨트롤러에게 넘김**

push·PR은 하지 않는다. 컨트롤러가 finishing 단계에서 `git push -u origin feature/stage1b-web-ops`와 `gh pr create --base main`을 한다. 아래는 컨트롤러가 쓸 PR 본문 초안이다(채널명·시청자 규모를 넣지 않는다).
```markdown
## 요약
- 서버 후속: /auth 한도 분리(전역 120·시작 30·콜백 60, 초과는 첫 화면 안내, HEAD 없음), 좁은 공백류·한글 방점 정규화, 예외 단어 가림 해소, 오판 검토 목록 API, MinuteStatDto
- 매니저 PWA: 후보(사람 단위·섀도·숨김 대기·판정 이유)·실시간 채팅·기록/설정(상태 점검·오판 검토 포함), 자동 숨김 스위치(켜기 확인), 푸시 알림(로그아웃 시 해지), 재연결 시 다시 읽기
- 운영: launchd 설치 스크립트, Funnel·키체인·잠자기·FileVault·백업 복원 안내, 채널 공지·운영 합의서·치지직 문의 메일 초안
- 영구 제한·해제는 화면 없이 치지직 기본 도구로 한다(운영 안내서 16장)

## 실기기 점검
docs/operations/device-checklist.md 참고

## 실연결로 확인한 치지직 동작
- sessionKey 전달 방식:
- CHAT 페이로드 형식:
- 홈 화면 앱 안 로그인:
```
