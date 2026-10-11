# 찌리릿 가드 1단계-A(서버) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 치지직 채팅을 받아 규칙으로 판정하고, 자동 숨김 스위치(기본 꺼짐)·섀도 모드·매니저 조치·감사 기록을 REST/WebSocket으로 제공하는 Node 서버를 만든다(로드맵 1단계의 서버 부분).

**Architecture:** Node 22 + TypeScript 단일 프로세스. 치지직 Session API(socket.io-client 2.0.3)로 채팅을 받고, 규칙 파이프라인이 판정을 붙이고, 모든 쓰기 API는 실행기 한 곳을 지난다. 상태는 SQLite(better-sqlite3)에 두고 토큰은 키체인 키로 AES-256-GCM 암호화한다. 매니저는 치지직 OAuth로 로그인하고 Fastify의 REST·WebSocket으로 접속한다. 테스트는 Vitest와 가짜 치지직 서버(HTTP + socket.io 2.x)로 한다.

**Tech Stack:** Node.js 22.20, TypeScript 6.0.3, Vitest 5.0.3, ESLint 10.12.0 + typescript-eslint 8.71.1, better-sqlite3 13.0.3, Fastify 5.12.5(@fastify/cookie 11.1.3, @fastify/static 10.1.6, @fastify/websocket 11.3.4), zod 4.6.5, socket.io-client 2.0.3, web-push 3.6.7, 테스트 전용 socket.io 2.5.1.

**Spec:** `docs/superpowers/specs/2026-10-11-zzirit-guard-design.md` (이 계획은 스펙의 1단계 중 서버 부분을 구현한다. PWA와 운영 문서는 `2026-10-11-stage1b-web-ops.md`)

## Global Constraints

- 런타임: Node.js 22(22.12 이상), TypeScript, ESM(`"type": "module"`, `module: NodeNext`). import 경로에는 `.js` 확장자를 붙인다.
- 치지직 Session API는 socket.io-client **1.0.0~2.0.3만** 지원한다 → `socket.io-client@2.0.3` 고정. 채팅 수신 모듈 안에서만 쓴다.
- 치지직 Open API 도메인 `https://openapi.chzzk.naver.com`, 인증 코드 요청 `https://chzzk.naver.com/account-interlock`. 공통 응답 `{code, message, content}`.
- Refresh Token은 **일회용**이다. 갱신은 한 곳에서만, **새 토큰을 저장한 뒤 사용**한다.
- **토큰 폐기(revoke) API를 호출하지 않는다.** 같은 clientId·사용자의 토큰이 모두 지워져 보관 중인 스트리머 토큰까지 사라진다.
- 서버는 `127.0.0.1:8710`에만 바인딩한다(외부는 Tailscale Funnel → 8710).
- 스트리머·매니저(`userRoleCode`가 `streamer`·`streaming_channel_manager`·`streaming_chat_manager`)의 메시지는 절대 `auto_hide`가 되지 않는다(최대 `candidate`).
- 자동 숨김 스위치 기본값은 꺼짐. 꺼져 있으면 `auto_hide` 대상은 `shadow`로 기록한다.
- 기본값: 폭주 차단 60건/분, 원문 보관 30일, 감사 기록 180일, 세션 12시간, WebSocket 티켓 30초 일회용, 역할 재확인 5분, 관리자 목록 캐시 5분, 토큰 선제 갱신(만료 2시간 전), 재연결 백오프 최대 30초, 쓰기 재시도 최대 3회, 1분 실패율 50% 초과 시 자동 숨김 끔.
- 떼도배: 정규화 길이 **10자 이상**, 10초 안 서로 다른 사용자 5명 이상 → 창 안의 같은 문장을 앞선 것까지 숨김. 개인 도배: 한 사람 10초 안 5건 이상 → 후보.
- 채널 허용어는 정규화한 메시지 **전체**가 같을 때만 `pass`(금칙어 강·떼도배·광고·전화번호보다 후순위).
- MVP는 채널 1곳. 연결은 `ZG_CHANNEL_ID`와 같은 채널만 허용하고, 다른 채널 연결 요청은 거부한다.
- 앱 로그에 채팅 원문을 남기지 않는다(식별자만).
- 저장소에 Client ID·Secret, 토큰, `.env`, DB, 백업을 넣지 않는다.
- 코드 주석·문서화 주석은 한국어, 식별자는 영어. 모든 함수·타입·모듈 수준 상수 위에 문서화 주석(역할·이유). 빈 catch 금지.
- 커밋: Conventional Commits, 본문 한국어, 작업 브랜치 `feature/stage1-server`. 커밋 전 `npm run lint && npm run typecheck` 통과.

## Review Focus

- **토큰 갱신 직후 저장 실패**(디스크 오류·프로세스 종료): 치지직은 이미 새 refresh token을 발급해 옛 것은 무효다. 사람이 기대하는 동작은 "쓰기 잠금 + 재연결 필요 알림"이지 조용한 실패가 아니다 → Task 6에 테스트.
- **채팅 이벤트 형식 변형**(payload가 JSON 문자열로 오거나 `profile`·`emojis`가 빠짐): 수신이 죽지 않고 해당 메시지만 버리고 센다 → Task 7에 테스트.
- **우회 표기**(제로폭 문자·전각 문자·자모 분리·특수문자 끼우기, 예: `씨​발`, `ｓｉｂａｌ`, `시 ㅂ ㅏ`)와 **오탐 단어**(`시발점`): 정규화와 예외 단어로 처리 → Task 8·9에 테스트.
- **시계 어긋남**(치지직 `messageTime`이 서버 시각과 다르거나 순서가 뒤바뀜): 도배 창은 서버 수신 시각 기준, `messageTime`은 식별자로만 쓴다 → Task 11에 테스트.
- **조치 도중 권한 변화**(매니저가 치지직에서 해임됨, 스트리머가 연결 해제, 이미 지워진 메시지 404): 세션 종료·명확한 오류·404는 "이미 사라짐"으로 정리 → Task 15·17에 테스트.

---

## 파일 구조

```
package.json                     루트 워크스페이스, lint/typecheck/test 스크립트
tsconfig.base.json               공통 컴파일 옵션
eslint.config.js                 ESLint flat config
.gitignore  .nvmrc
packages/shared/src/index.ts     서버·웹 공용 타입(REST·WebSocket 메시지) — 타입만
apps/server/
  src/time.ts                    Clock 타입, 분 단위 내림
  src/config.ts                  환경 변수 검증 → AppConfig
  src/db/database.ts             SQLite 열기(WAL·FK)·마이그레이션 실행
  src/db/migrations.ts           스키마 버전별 SQL
  src/security/tokenCipher.ts    AES-256-GCM 암복호화
  src/security/keychain.ts       macOS 키체인에서 암호화 키 읽기
  src/chzzk/apiClient.ts         치지직 Open API 호출(봉투 해석·오류 변환)
  src/connection/credentialStore.ts  채널·토큰 저장(암호화)
  src/connection/tokenManager.ts     선제 갱신·단일 갱신·쓰기 잠금
  src/chat/chatEvent.ts          CHAT 페이로드 검증·변환
  src/chat/chatReceiver.ts       세션 연결·구독·재연결
  src/detection/normalize.ts     비교용 정규화(제로폭·전각·자모 조합·반복 축약)
  src/detection/ruleRepository.ts    rule_entry 저장소·스냅샷·기본 규칙
  src/detection/defaultRules.ts      최소 기본 규칙 목록
  src/detection/wordMatch.ts     예외 제거·첫 일치 찾기
  src/detection/patterns.ts      링크·전화번호·주소 패턴
  src/detection/floodDetectors.ts    떼도배·개인 도배
  src/detection/messageTraits.ts     건너뛰기·중복 추적
  src/detection/pipeline.ts      판정 파이프라인
  src/records/verdictRepository.ts   verdict 테이블
  src/records/auditLog.ts        audit_log 테이블·요주의 사용자
  src/records/minuteStats.ts     분당 통계 누적·저장
  src/records/maintenance.ts     보관 기한 삭제·백업
  src/actions/executor.ts        쓰기 API 대기열·재시도·실패율 감시
  src/actions/autoHideSwitch.ts  스위치·폭주 차단
  src/actions/decisionHandler.ts 판정 → 숨김/섀도/후보 저장·방송
  src/managers/permissions.ts    역할별 권한 표
  src/managers/roleVerifier.ts   관리자 목록 캐시·역할 확인
  src/managers/sessionStore.ts   매니저 세션·WebSocket 티켓
  src/managers/authFlow.ts       OAuth 시작·콜백(연결·로그인)
  src/realtime/hub.ts            WebSocket 방송·채팅 묶음 전송
  src/push/pushNotifier.ts       Web Push 알림
  src/http/server.ts             Fastify 구성·인증 훅·CSRF 검사
  src/http/routes.ts             REST 라우트
  src/app.ts                     구성 요소 조립(테스트에서도 사용)
  src/main.ts                    실행 진입점·타이머·종료 처리
  src/tools/replayLoad.ts        부하 재생 도구
  test/fakes/fakeChzzk.ts        가짜 치지직(REST + socket.io 2.x)
  test/**/*.test.ts
ops/scripts/setup-keychain.sh    키체인 암호화 키 생성
ops/env.example                  환경 변수 예시(비밀값 없음)
```

---

### Task 1: 저장소 기반(워크스페이스·린트·타입체크·테스트)

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `eslint.config.js`, `.gitignore`, `.nvmrc`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/tsconfig.build.json`, `apps/server/vitest.config.ts`, `apps/server/src/time.ts`
- Test: `apps/server/test/time.test.ts`

**Interfaces:**
- Produces: `Clock = () => number`, `systemClock`, `floorToMinute(timestampMs: number): number` (`apps/server/src/time.ts`); 공용 타입 전부(`packages/shared/src/index.ts`, 아래 코드 그대로).

- [ ] **Step 1: 브랜치 만들기**

```bash
git switch main && git pull --ff-only && git switch -c feature/stage1-server
```

- [ ] **Step 2: 루트 설정 파일 작성**

`package.json`:
```json
{
  "name": "zzirit-guard",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "engines": { "node": ">=22.12" },
  "scripts": {
    "lint": "eslint .",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "check": "npm run lint && npm run typecheck && npm run test"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "sourceMap": true
  }
}
```

`eslint.config.js`:
```js
// ESLint 설정: JS 권장 규칙 + typescript-eslint 권장 규칙. 빈 catch는 CLAUDE.md 규칙에 따라 금지한다.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
  { ignores: ["**/dist/**", "**/node_modules/**", "docs/**", "**/*.d.ts"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
]);
```

`.gitignore`:
```
node_modules/
dist/
coverage/
*.sqlite
*.sqlite-*
.env
.env.*
!ops/env.example
data/
backups/
.DS_Store
```

`.nvmrc`:
```
22
```

- [ ] **Step 3: 공용 타입 패키지 작성**

`packages/shared/package.json`:
```json
{
  "name": "@zzirit-guard/shared",
  "private": true,
  "type": "module",
  "types": "./src/index.ts",
  "exports": { ".": { "types": "./src/index.ts" } },
  "scripts": { "typecheck": "tsc -p tsconfig.json --noEmit" }
}
```

`packages/shared/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/shared/src/index.ts`:
```ts
// 서버와 PWA가 함께 쓰는 REST·WebSocket 메시지 타입. 타입만 두어 런타임 의존이 생기지 않게 한다.

/** 이 앱에 접근할 수 있는 치지직 역할. 정산 관리자(STREAMING_SETTLEMENT_MANAGER)는 제외한다. */
export type ManagerRole = "STREAMING_CHANNEL_OWNER" | "STREAMING_CHANNEL_MANAGER" | "STREAMING_CHAT_MANAGER";

/** 판정 종류. shadow는 스위치가 꺼져 있어 숨기지 않은 auto_hide 대상이다. */
export type Decision = "auto_hide" | "shadow" | "candidate" | "needs_care" | "pass";

/** 저장된 판정의 처리 상태. */
export type VerdictStatus = "pending" | "hidden" | "ignored" | "restricted" | "false_positive";

/** 채널 규칙 종류. exception은 금칙어 비교 전에 지우는 예외 단어(예: 시발점)다. */
export type RuleKind = "strong" | "weak" | "exception" | "allow" | "allow_domain" | "threat" | "keyword_route";

/** 역할별로 허용되는 기능. 스펙 7장 권한 표와 일치해야 한다. */
export type Permission =
  | "connect_channel"
  | "disable_auto_hide"
  | "enable_auto_hide"
  | "edit_rules"
  | "hide_message"
  | "temporary_restrict"
  | "restrict"
  | "edit_chat_settings"
  | "view_audit";

/** 저장된 판정 1건(후보·섀도·자동 숨김 등). */
export interface VerdictDto {
  id: number;
  chatChannelId: string;
  senderChannelId: string;
  senderNickname: string;
  content: string;
  messageTime: number;
  decision: Decision;
  reason: string;
  status: VerdictStatus;
  createdAt: number;
}

/** 실시간 채팅 화면에 보내는 한 줄. */
export interface ChatLine {
  senderNickname: string;
  content: string;
  messageTime: number;
  decision: Decision;
}

/** 상태 배너·상태 점검 화면에 쓰는 서버 상태. */
export interface ServerStatus {
  channelConnected: boolean;
  channelName: string | null;
  chatConnected: boolean;
  writeLocked: boolean;
  accessExpiresAt: number | null;
  autoHideEnabled: boolean;
  lastChatAt: number | null;
  pendingActions: number;
}

/** 로그인한 매니저 정보와 권한. */
export interface MeDto {
  channelId: string;
  channelName: string;
  role: ManagerRole;
  permissions: Permission[];
}

/** 채널 규칙 1건. */
export interface RuleEntryDto {
  id: number;
  kind: RuleKind;
  pattern: string;
  createdBy: string;
  createdAt: number;
}

/** 1단계에서 설정 화면이 바꿀 수 있는 값. */
export interface SettingsDto {
  breakerPerMinute: number;
  retentionDaysContent: number;
  retentionDaysAudit: number;
}

/** 감사 기록 1건(원문 없음). */
export interface AuditEntryDto {
  id: number;
  actorType: "manager" | "rule" | "system";
  actorChannelId: string | null;
  action: string;
  targetSenderChannelId: string | null;
  verdictId: number | null;
  result: "ok" | "error";
  error: string | null;
  createdAt: number;
}

/** 치지직 채팅 설정(GET/PUT /open/v1/chats/settings와 같은 필드). */
export interface ChatSettingsDto {
  chatAvailableCondition: "NONE" | "REAL_NAME";
  chatAvailableGroup: "ALL" | "FOLLOWER" | "MANAGER" | "SUBSCRIBER";
  minFollowerMinute: number;
  allowSubscriberInFollowerMode: boolean;
  chatSlowModeSec: number;
  chatEmojiMode: boolean;
}

/** WebSocket으로 서버가 보내는 메시지. */
export type RealtimeEvent =
  | { type: "verdict"; verdict: VerdictDto }
  | { type: "verdict_status"; verdictId: number; status: VerdictStatus }
  | { type: "chat_batch"; lines: ChatLine[] }
  | { type: "status"; status: ServerStatus }
  | { type: "session_ended"; reason: string };

/** REST 오류 응답 본문. message는 사용자에게 보여 줄 문구다. */
export interface ApiErrorBody {
  error: string;
  message: string;
}
```

- [ ] **Step 4: 서버 패키지 골격 작성**

`apps/server/package.json`:
```json
{
  "name": "@zzirit-guard/server",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "@zzirit-guard/shared": "*" }
}
```

`apps/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test"]
}
```

`apps/server/tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`apps/server/vitest.config.ts`:
```ts
// 서버 테스트 설정. 가짜 치지직 서버를 띄우는 통합 테스트가 있어 기본 제한 시간을 늘린다.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 15_000, environment: "node" },
});
```

- [ ] **Step 5: 의존성 설치**

```bash
npm install --save-dev --save-exact typescript@6.0.3 eslint@10.12.0 @eslint/js@10.0.1 typescript-eslint@8.71.1 globals@17.13.0 @types/node@22.20.5
npm install --save-dev --save-exact -w @zzirit-guard/server vitest@5.0.3
```
Expected: `package-lock.json` 생성, 오류 없음.

- [ ] **Step 6: 실패하는 테스트 작성**

`apps/server/test/time.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { floorToMinute } from "../src/time.js";

describe("floorToMinute", () => {
  it("분 단위로 내림한다", () => {
    expect(floorToMinute(125_999)).toBe(120_000);
    expect(floorToMinute(120_000)).toBe(120_000);
  });
});
```

- [ ] **Step 7: 실패 확인**

Run: `npm test -w @zzirit-guard/server`
Expected: FAIL — `Cannot find module '../src/time.js'`

- [ ] **Step 8: 구현**

`apps/server/src/time.ts`:
```ts
/** 현재 시각(ms)을 돌려주는 함수. 테스트에서 시간을 고정하려고 주입한다. */
export type Clock = () => number;

/** 실제 시스템 시계. */
export const systemClock: Clock = () => Date.now();

/** 1분(ms). */
const MINUTE_MS = 60_000;

/**
 * 시각을 분 단위로 내림한다. minute_stat 테이블의 키로 쓴다.
 * @param timestampMs 기준 시각(ms)
 * @returns 그 분의 시작 시각(ms)
 */
export function floorToMinute(timestampMs: number): number {
  return Math.floor(timestampMs / MINUTE_MS) * MINUTE_MS;
}
```

- [ ] **Step 9: 전체 검사 통과 확인**

Run: `npm run check`
Expected: lint 오류 0, typecheck 통과, `1 passed`

- [ ] **Step 10: 커밋**

```bash
git add package.json package-lock.json tsconfig.base.json eslint.config.js .gitignore .nvmrc packages apps/server
git commit -m "chore: 워크스페이스·린트·타입체크·테스트 기반 구성" -m "npm workspaces(apps/server, packages/shared)와 TypeScript 6, ESLint 10, Vitest 5를 설정하고 서버·웹 공용 타입을 정의한다."
```

---

### Task 2: 환경 변수 설정

**Files:**
- Create: `apps/server/src/config.ts`, `ops/env.example`
- Test: `apps/server/test/config.test.ts`

**Interfaces:**
- Produces: `interface AppConfig { port; publicOrigin; channelId; chzzkClientId; chzzkClientSecret; chzzkApiBase; chzzkAuthorizeUrl; dataDirectory; databasePath; backupDirectory; keychainService; webDistDirectory; vapidPublicKey; vapidPrivateKey; vapidSubject }`, `class ConfigError extends Error`, `loadConfig(environment: Record<string, string | undefined>): AppConfig`

- [ ] **Step 1: 의존성 설치**

```bash
npm install --save-exact -w @zzirit-guard/server zod@4.6.5
```

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/server/test/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

/** 필수 값을 모두 채운 환경 변수 예시. */
const validEnvironment = {
  ZG_PUBLIC_ORIGIN: "https://guard.example.ts.net/",
  ZG_CHANNEL_ID: "owner-channel",
  ZG_CHZZK_CLIENT_ID: "client-id",
  ZG_CHZZK_CLIENT_SECRET: "client-secret",
  ZG_DATA_DIR: "/tmp/zg",
  ZG_WEB_DIST: "/tmp/zg-web",
  ZG_VAPID_PUBLIC_KEY: "public",
  ZG_VAPID_PRIVATE_KEY: "private",
  ZG_VAPID_SUBJECT: "mailto:owner@example.com",
};

describe("loadConfig", () => {
  it("기본값을 채우고 경로를 만든다", () => {
    const config = loadConfig(validEnvironment);
    expect(config.port).toBe(8710);
    expect(config.publicOrigin).toBe("https://guard.example.ts.net");
    expect(config.channelId).toBe("owner-channel");
    expect(config.chzzkApiBase).toBe("https://openapi.chzzk.naver.com");
    expect(config.databasePath).toBe("/tmp/zg/zzirit-guard.sqlite");
    expect(config.backupDirectory).toBe("/tmp/zg/backups");
  });

  it("빠진 필수 값을 모두 알려 준다", () => {
    const { ZG_CHZZK_CLIENT_SECRET: _secret, ZG_DATA_DIR: _dir, ...partial } = validEnvironment;
    expect(() => loadConfig(partial)).toThrow(ConfigError);
    expect(() => loadConfig(partial)).toThrow(/ZG_CHZZK_CLIENT_SECRET.*ZG_DATA_DIR|ZG_DATA_DIR.*ZG_CHZZK_CLIENT_SECRET/s);
  });

  it("mailto가 아닌 VAPID subject를 거부한다", () => {
    expect(() => loadConfig({ ...validEnvironment, ZG_VAPID_SUBJECT: "owner@example.com" })).toThrow(/ZG_VAPID_SUBJECT/);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- config`
Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 4: 구현**

`apps/server/src/config.ts`:
```ts
import { join } from "node:path";
import { z } from "zod";

/** 서버 전체 설정. 환경 변수에서 한 번 읽어 구성 요소에 넘긴다. */
export interface AppConfig {
  port: number;
  publicOrigin: string;
  /** 연결을 허용할 스트리머 채널 ID. 공개 주소로 남이 먼저 자기 채널을 연결해 서버를 가로채는 것을 막는다. */
  channelId: string;
  chzzkClientId: string;
  chzzkClientSecret: string;
  chzzkApiBase: string;
  chzzkAuthorizeUrl: string;
  dataDirectory: string;
  databasePath: string;
  backupDirectory: string;
  keychainService: string;
  webDistDirectory: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
}

/** 설정 오류. 메시지에 빠진 항목과 해결 방법을 담는다. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** 환경 변수 검증 규칙. 비밀값은 ops/env.example을 복사한 .env에서 읽는다. */
const environmentSchema = z.object({
  ZG_PORT: z.coerce.number().int().min(1).max(65535).default(8710),
  ZG_PUBLIC_ORIGIN: z.url(),
  ZG_CHANNEL_ID: z.string().min(1),
  ZG_CHZZK_CLIENT_ID: z.string().min(1),
  ZG_CHZZK_CLIENT_SECRET: z.string().min(1),
  ZG_CHZZK_API_BASE: z.url().default("https://openapi.chzzk.naver.com"),
  ZG_CHZZK_AUTHORIZE_URL: z.url().default("https://chzzk.naver.com/account-interlock"),
  ZG_DATA_DIR: z.string().min(1),
  ZG_KEYCHAIN_SERVICE: z.string().min(1).default("zzirit-guard"),
  ZG_WEB_DIST: z.string().min(1),
  ZG_VAPID_PUBLIC_KEY: z.string().min(1),
  ZG_VAPID_PRIVATE_KEY: z.string().min(1),
  ZG_VAPID_SUBJECT: z.string().startsWith("mailto:"),
});

/**
 * 환경 변수를 검증해 AppConfig로 바꾼다.
 * @param environment process.env 같은 키-값 묶음
 * @throws ConfigError 빠지거나 잘못된 항목이 있을 때(모든 항목을 한 번에 알려 준다)
 */
export function loadConfig(environment: Record<string, string | undefined>): AppConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new ConfigError(`환경 변수가 잘못되었습니다: ${fields}. ops/env.example을 참고해 .env를 채우세요.`);
  }
  return toAppConfig(parsed.data);
}

/** 검증된 환경 변수를 AppConfig로 옮긴다. 출처(origin)는 끝의 '/'를 없애 비교가 쉽게 한다. */
function toAppConfig(values: z.infer<typeof environmentSchema>): AppConfig {
  return {
    port: values.ZG_PORT,
    publicOrigin: new URL(values.ZG_PUBLIC_ORIGIN).origin,
    channelId: values.ZG_CHANNEL_ID,
    chzzkClientId: values.ZG_CHZZK_CLIENT_ID,
    chzzkClientSecret: values.ZG_CHZZK_CLIENT_SECRET,
    chzzkApiBase: values.ZG_CHZZK_API_BASE.replace(/\/$/, ""),
    chzzkAuthorizeUrl: values.ZG_CHZZK_AUTHORIZE_URL,
    dataDirectory: values.ZG_DATA_DIR,
    databasePath: join(values.ZG_DATA_DIR, "zzirit-guard.sqlite"),
    backupDirectory: join(values.ZG_DATA_DIR, "backups"),
    keychainService: values.ZG_KEYCHAIN_SERVICE,
    webDistDirectory: values.ZG_WEB_DIST,
    vapidPublicKey: values.ZG_VAPID_PUBLIC_KEY,
    vapidPrivateKey: values.ZG_VAPID_PRIVATE_KEY,
    vapidSubject: values.ZG_VAPID_SUBJECT,
  };
}
```

`ops/env.example`:
```
# 찌리릿 가드 환경 변수 예시. 복사해서 ~/Library/Application Support/zzirit-guard/.env 로 저장하고 chmod 600 한다.
# 실제 값은 절대 저장소에 커밋하지 않는다.
ZG_PORT=8710
ZG_PUBLIC_ORIGIN=https://<기기이름>.<tailnet>.ts.net
# 연결을 허용할 스트리머 채널 ID(치지직 채널 주소 chzzk.naver.com/<채널ID>의 끝부분). 이 채널만 연결할 수 있다.
ZG_CHANNEL_ID=
ZG_CHZZK_CLIENT_ID=
ZG_CHZZK_CLIENT_SECRET=
ZG_DATA_DIR=/Users/<사용자>/Library/Application Support/zzirit-guard
ZG_KEYCHAIN_SERVICE=zzirit-guard
ZG_WEB_DIST=/Users/<사용자>/Developer/zzirit-guard/apps/web/dist
# npx web-push generate-vapid-keys 로 만든다.
ZG_VAPID_PUBLIC_KEY=
ZG_VAPID_PRIVATE_KEY=
ZG_VAPID_SUBJECT=mailto:<연락받을 이메일>
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- config`
Expected: PASS (3 tests)

- [ ] **Step 6: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/config.ts apps/server/test/config.test.ts ops/env.example apps/server/package.json package-lock.json
git commit -m "feat: 환경 변수 설정 검증 추가" -m "필수 값이 빠지면 항목 이름과 해결 방법을 한 번에 알려 주고, 경로·출처 형식을 정규화한다. 연결을 허용할 스트리머 채널 ID(ZG_CHANNEL_ID)를 필수로 둔다."
```

---

### Task 3: SQLite와 스키마

**Files:**
- Create: `apps/server/src/db/database.ts`, `apps/server/src/db/migrations.ts`
- Test: `apps/server/test/db/database.test.ts`

**Interfaces:**
- Produces: `type Database = BetterSqlite3.Database`, `openDatabase(filePath: string): Database`, `runMigrations(database: Database): void`

- [ ] **Step 1: 의존성 설치**

```bash
npm install --save-exact -w @zzirit-guard/server better-sqlite3@13.0.3
npm install --save-dev --save-exact -w @zzirit-guard/server @types/better-sqlite3@9.6.0
```

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/server/test/db/database.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrations.js";

describe("openDatabase", () => {
  it("스펙 11장의 테이블을 모두 만든다", () => {
    const database = openDatabase(":memory:");
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual([
      "audit_log", "channel", "credential", "manager_session", "minute_stat", "push_subscription", "rule_entry", "setting", "verdict",
    ]);
  });

  it("마이그레이션을 두 번 실행해도 안전하다", () => {
    const database = openDatabase(":memory:");
    expect(() => runMigrations(database)).not.toThrow();
    expect(database.pragma("user_version", { simple: true })).toBe(1);
  });

  it("알 수 없는 규칙 종류를 거부한다", () => {
    const database = openDatabase(":memory:");
    database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    const insertRule = database.prepare(
      "INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', ?, 'x', 'test', 0)",
    );
    expect(() => insertRule.run("unknown")).toThrow(/CHECK/);
    expect(() => insertRule.run("exception")).not.toThrow();
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- database`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: 구현**

`apps/server/src/db/migrations.ts`:
```ts
import type { Database } from "./database.js";

/**
 * 스키마 버전별 SQL. 배열 순서가 곧 버전이다(PRAGMA user_version).
 * 한 번 배포한 항목은 고치지 말고 새 항목을 뒤에 추가한다.
 */
const migrations: readonly string[] = [
  `
  CREATE TABLE channel (
    channel_id TEXT PRIMARY KEY,
    channel_name TEXT NOT NULL,
    connected_at INTEGER NOT NULL
  );
  CREATE TABLE credential (
    channel_id TEXT PRIMARY KEY REFERENCES channel(channel_id) ON DELETE CASCADE,
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT NOT NULL,
    access_expires_at INTEGER NOT NULL,
    refreshed_at INTEGER NOT NULL
  );
  CREATE TABLE setting (
    channel_id TEXT PRIMARY KEY REFERENCES channel(channel_id) ON DELETE CASCADE,
    auto_hide_enabled INTEGER NOT NULL DEFAULT 0,
    stage1_threshold REAL NOT NULL DEFAULT 0.05,
    candidate_threshold REAL NOT NULL DEFAULT 0.5,
    sure_threshold REAL NOT NULL DEFAULT 0.99,
    breaker_per_minute INTEGER NOT NULL DEFAULT 60,
    retention_days_content INTEGER NOT NULL DEFAULT 30,
    retention_days_audit INTEGER NOT NULL DEFAULT 180
  );
  CREATE TABLE rule_entry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL REFERENCES channel(channel_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('strong','weak','exception','allow','allow_domain','threat','keyword_route')),
    pattern TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (channel_id, kind, pattern)
  );
  CREATE TABLE verdict (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    chat_channel_id TEXT NOT NULL,
    message_time INTEGER NOT NULL,
    sender_channel_id TEXT NOT NULL,
    sender_nickname TEXT NOT NULL,
    content TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('auto_hide','shadow','candidate','needs_care')),
    reason TEXT NOT NULL,
    unsafe_probability REAL,
    category TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','hidden','ignored','restricted','false_positive')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX verdict_channel_created ON verdict (channel_id, created_at);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('manager','rule','system')),
    actor_channel_id TEXT,
    action TEXT NOT NULL,
    target_sender_channel_id TEXT,
    verdict_id INTEGER,
    result TEXT NOT NULL CHECK (result IN ('ok','error')),
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX audit_target ON audit_log (channel_id, target_sender_channel_id, created_at);
  CREATE INDEX audit_created ON audit_log (created_at);
  CREATE TABLE minute_stat (
    channel_id TEXT NOT NULL,
    minute INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    deduplicated INTEGER NOT NULL DEFAULT 0,
    stage1_forwarded INTEGER NOT NULL DEFAULT 0,
    stage2_done INTEGER NOT NULL DEFAULT 0,
    stage2_dropped INTEGER NOT NULL DEFAULT 0,
    candidates INTEGER NOT NULL DEFAULT 0,
    auto_hidden INTEGER NOT NULL DEFAULT 0,
    shadow INTEGER NOT NULL DEFAULT 0,
    invalid_events INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, minute)
  );
  CREATE TABLE manager_session (
    id TEXT PRIMARY KEY,
    manager_channel_id TEXT NOT NULL,
    manager_channel_name TEXT NOT NULL,
    role TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    last_role_check_at INTEGER NOT NULL
  );
  CREATE TABLE push_subscription (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manager_channel_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
];

/**
 * 아직 적용하지 않은 마이그레이션을 순서대로 적용한다.
 * 버전마다 트랜잭션으로 묶어, 중간에 실패해도 반쯤 바뀐 스키마가 남지 않게 한다.
 */
export function runMigrations(database: Database): void {
  const currentVersion = database.pragma("user_version", { simple: true }) as number;
  for (let index = currentVersion; index < migrations.length; index += 1) {
    const statement = migrations[index] as string;
    database.transaction(() => {
      database.exec(statement);
      database.pragma(`user_version = ${index + 1}`);
    })();
  }
}
```

`apps/server/src/db/database.ts`:
```ts
import BetterSqlite3 from "better-sqlite3";
import { runMigrations } from "./migrations.js";

/** 서버가 쓰는 SQLite 연결 타입. */
export type Database = BetterSqlite3.Database;

/**
 * SQLite 파일을 열고 운영 설정과 마이그레이션을 적용한다.
 * WAL은 읽기와 쓰기가 서로 막지 않게 하려고, foreign_keys는 채널 해제 시 하위 행을 지우려고 켠다.
 * @param filePath DB 파일 경로. 테스트에서는 ":memory:"
 */
export function openDatabase(filePath: string): Database {
  const database = new BetterSqlite3(filePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  return database;
}
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- database`
Expected: PASS (3 tests)

- [ ] **Step 6: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/db apps/server/test/db apps/server/package.json package-lock.json
git commit -m "feat: SQLite 연결과 1차 스키마 추가" -m "스펙 11장 테이블에 예외 단어(exception) 규칙 종류와 잘못된 이벤트 통계 열을 더해 만든다."
```

---

### Task 4: 토큰 암호화와 키체인 키

**Files:**
- Create: `apps/server/src/security/tokenCipher.ts`, `apps/server/src/security/keychain.ts`, `ops/scripts/setup-keychain.sh`
- Test: `apps/server/test/security/tokenCipher.test.ts`, `apps/server/test/security/keychain.test.ts`

**Interfaces:**
- Produces: `interface TokenCipher { encrypt(plainText: string): string; decrypt(cipherText: string): string }`, `createTokenCipher(key: Buffer): TokenCipher`; `interface CommandResult { stdout: string; stderr: string; exitCode: number }`, `type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>`, `runCommandWithExecFile: CommandRunner`, `loadEncryptionKey(service: string, runCommand: CommandRunner): Promise<Buffer>`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/security/tokenCipher.test.ts`:
```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTokenCipher } from "../../src/security/tokenCipher.js";

describe("createTokenCipher", () => {
  it("암호화한 값을 되돌린다", () => {
    const cipher = createTokenCipher(randomBytes(32));
    const encrypted = cipher.encrypt("access-token-값");
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(encrypted).not.toContain("access-token");
    expect(cipher.decrypt(encrypted)).toBe("access-token-값");
  });

  it("같은 값도 매번 다르게 암호화한다", () => {
    const cipher = createTokenCipher(randomBytes(32));
    expect(cipher.encrypt("same")).not.toBe(cipher.encrypt("same"));
  });

  it("다른 키로는 풀 수 없다", () => {
    const encrypted = createTokenCipher(randomBytes(32)).encrypt("secret");
    expect(() => createTokenCipher(randomBytes(32)).decrypt(encrypted)).toThrow();
  });

  it("32바이트가 아닌 키를 거부한다", () => {
    expect(() => createTokenCipher(randomBytes(16))).toThrow(/32바이트/);
  });
});
```

`apps/server/test/security/keychain.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { loadEncryptionKey, type CommandRunner } from "../../src/security/keychain.js";

/** 정해진 결과를 돌려주는 가짜 security 명령. 받은 인자를 기록한다. */
function fakeRunner(result: { stdout?: string; stderr?: string; exitCode: number }, calls: string[][] = []): CommandRunner {
  return async (command, args) => {
    calls.push([command, ...args]);
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode };
  };
}

describe("loadEncryptionKey", () => {
  it("키체인의 16진수 키를 32바이트로 읽는다", async () => {
    const calls: string[][] = [];
    const key = await loadEncryptionKey("zzirit-guard", fakeRunner({ stdout: `${"ab".repeat(32)}\n`, exitCode: 0 }, calls));
    expect(key.length).toBe(32);
    expect(calls[0]).toEqual(["/usr/bin/security", "find-generic-password", "-s", "zzirit-guard", "-a", "token-encryption-key", "-w"]);
  });

  it("항목이 없으면 설정 스크립트를 안내한다", async () => {
    await expect(loadEncryptionKey("zzirit-guard", fakeRunner({ exitCode: 44 }))).rejects.toThrow(/setup-keychain\.sh/);
  });

  it("다른 실패는 원인과 함께 알린다", async () => {
    await expect(loadEncryptionKey("zzirit-guard", fakeRunner({ exitCode: 51, stderr: "locked" }))).rejects.toThrow(/locked.*잠겨/);
  });

  it("형식이 잘못된 키를 거부한다", async () => {
    await expect(loadEncryptionKey("zzirit-guard", fakeRunner({ stdout: "not-hex", exitCode: 0 }))).rejects.toThrow(/64자리/);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- security`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/server/src/security/tokenCipher.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** 토큰 문자열을 저장용으로 암호화·복호화한다. */
export interface TokenCipher {
  encrypt(plainText: string): string;
  decrypt(cipherText: string): string;
}

/** 암호문 형식 버전 표시. 나중에 형식을 바꿔도 옛 값을 구분할 수 있게 한다. */
const CIPHER_PREFIX = "v1:";
/** GCM 권장 IV 길이(바이트). */
const IV_LENGTH = 12;
/** GCM 인증 태그 길이(바이트). */
const TAG_LENGTH = 16;

/**
 * AES-256-GCM 암호기를 만든다. GCM은 변조를 감지하므로 DB 파일이 바뀌면 복호화가 실패한다.
 * @param key 32바이트 키(키체인에서 읽은 값)
 */
export function createTokenCipher(key: Buffer): TokenCipher {
  if (key.length !== 32) {
    throw new Error("암호화 키는 32바이트여야 합니다. ops/scripts/setup-keychain.sh로 키를 다시 만드세요.");
  }
  return {
    encrypt: (plainText) => encryptText(key, plainText),
    decrypt: (cipherText) => decryptText(key, cipherText),
  };
}

/** 평문을 "v1:" + base64(IV | 태그 | 암호문)으로 만든다. IV는 매번 새로 뽑는다. */
function encryptText(key: Buffer, plainText: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return CIPHER_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** encryptText의 역. 형식이 다르거나 태그 검증에 실패하면 예외를 던진다. */
function decryptText(key: Buffer, cipherText: string): string {
  if (!cipherText.startsWith(CIPHER_PREFIX)) {
    throw new Error("알 수 없는 암호문 형식입니다. DB가 다른 버전에서 만들어졌는지 확인하세요.");
  }
  const raw = Buffer.from(cipherText.slice(CIPHER_PREFIX.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_LENGTH));
  decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
  return Buffer.concat([decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString("utf8");
}
```

`apps/server/src/security/keychain.ts`:
```ts
import { execFile } from "node:child_process";

/** 외부 명령 실행 결과. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** 외부 명령 실행기. 테스트에서 가짜로 바꾸려고 주입한다. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

/** `security` 명령이 항목을 못 찾았을 때의 종료 코드. */
const ITEM_NOT_FOUND_EXIT_CODE = 44;
/** 암호화 키를 저장하는 키체인 계정 이름. setup-keychain.sh와 같아야 한다. */
const ENCRYPTION_KEY_ACCOUNT = "token-encryption-key";
/** 키 형식: 32바이트 = 16진수 64자리. */
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * 키체인에서 토큰 암호화 키를 읽는다. 서버는 읽기만 하고, 키 생성은 setup-keychain.sh가 한다.
 * 키를 명령 인자로 넘기는 생성 작업을 서버에서 하지 않으려는 것이다(프로세스 목록 노출 방지).
 * @param service 키체인 서비스 이름(ZG_KEYCHAIN_SERVICE)
 */
export async function loadEncryptionKey(service: string, runCommand: CommandRunner): Promise<Buffer> {
  const result = await runCommand("/usr/bin/security", ["find-generic-password", "-s", service, "-a", ENCRYPTION_KEY_ACCOUNT, "-w"]);
  if (result.exitCode === ITEM_NOT_FOUND_EXIT_CODE) {
    throw new Error(`키체인에 '${service}' 암호화 키가 없습니다. ops/scripts/setup-keychain.sh를 먼저 실행하세요.`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`키체인 읽기 실패(exit ${result.exitCode}): ${result.stderr.trim()} — 로그인 키체인이 잠겨 있는지 확인하세요.`);
  }
  return parseHexKey(result.stdout.trim());
}

/** 16진수 64자리 문자열을 32바이트 버퍼로 바꾼다. */
function parseHexKey(hexText: string): Buffer {
  if (!HEX_KEY_PATTERN.test(hexText)) {
    throw new Error("키체인의 암호화 키 형식이 잘못되었습니다(16진수 64자리여야 함). 항목을 지우고 setup-keychain.sh를 다시 실행하세요.");
  }
  return Buffer.from(hexText, "hex");
}

/** child_process.execFile을 CommandRunner 형태로 감싼다. 0이 아닌 종료도 예외 대신 결과로 돌려준다. */
export const runCommandWithExecFile: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ stdout, stderr: error && !stderr ? error.message : stderr, exitCode });
    });
  });
```

`ops/scripts/setup-keychain.sh`:
```sh
#!/bin/zsh
# 토큰 암호화 키를 로그인 키체인에 한 번 만든다. 이미 있으면 아무것도 하지 않는다.
# 사용법: ops/scripts/setup-keychain.sh [서비스이름(기본 zzirit-guard)]
set -euo pipefail
SERVICE=${1:-zzirit-guard}
ACCOUNT=token-encryption-key
if /usr/bin/security find-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1; then
  echo "이미 키가 있습니다: $SERVICE/$ACCOUNT (지우면 저장된 토큰을 읽을 수 없게 됩니다)"
  exit 0
fi
KEY=$(/usr/bin/openssl rand -hex 32)
/usr/bin/security add-generic-password -s "$SERVICE" -a "$ACCOUNT" -w "$KEY"
echo "키체인에 암호화 키를 만들었습니다: $SERVICE/$ACCOUNT"
```

- [ ] **Step 4: 통과 확인**

Run: `chmod +x ops/scripts/setup-keychain.sh && npm test -w @zzirit-guard/server -- security`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/security apps/server/test/security ops/scripts/setup-keychain.sh
git commit -m "feat: 토큰 암호화와 키체인 키 읽기 추가" -m "AES-256-GCM으로 토큰을 암호화하고, 키는 setup-keychain.sh가 만든 키체인 항목에서 읽는다."
```

---

### Task 5: 치지직 API 클라이언트와 가짜 치지직 서버

**Files:**
- Create: `apps/server/src/chzzk/apiClient.ts`
- Create: `apps/server/test/fakes/fakeChzzk.ts`, `apps/server/test/helpers/waitFor.ts`
- Test: `apps/server/test/chzzk/apiClient.test.ts`

**Interfaces:**
- Produces: `class ChzzkApiError extends Error { status: number; apiMessage: string; path: string }`, `interface TokenSet { accessToken; refreshToken; expiresInSeconds }`, `interface ChzzkUser { channelId; channelName }`, `interface StreamingRole { managerChannelId; managerChannelName; userRole }`, `interface MessageTarget { chatChannelId; messageTime; senderChannelId }`, `interface ChzzkApi { exchangeCode(code, state); refreshToken(refreshToken); getMe(token); getStreamingRoles(token); createSessionUrl(token); subscribeChat(token, sessionKey); blindMessage(token, target); addTemporaryRestriction(token, targetChannelId, chatChannelId); addRestriction(token, targetChannelId); removeRestriction(token, targetChannelId); getChatSettings(token); updateChatSettings(token, settings) }`, `createChzzkApi(options: { apiBase; clientId; clientSecret; fetchFunction?; timeoutMs? }): ChzzkApi`
- Produces(테스트용): `startFakeChzzk(): Promise<FakeChzzk>`(아래 코드), `waitFor(condition: () => boolean, timeoutMs?: number): Promise<void>`

- [ ] **Step 1: 테스트 전용 의존성 설치**

```bash
npm install --save-dev --save-exact -w @zzirit-guard/server socket.io@2.5.1 @types/socket.io@2.1.13
```

- [ ] **Step 2: 가짜 치지직 서버와 대기 도우미 작성**

`apps/server/test/helpers/waitFor.ts`:
```ts
/**
 * 조건이 참이 될 때까지 20ms 간격으로 기다린다. 비동기 소켓 이벤트를 테스트하려는 것이다.
 * @throws 제한 시간 안에 참이 되지 않으면 예외
 */
export async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waitFor: ${timeoutMs}ms 안에 조건이 충족되지 않았습니다`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
```

`apps/server/test/fakes/fakeChzzk.ts`:
```ts
// 테스트용 가짜 치지직. 공식 문서의 경로·봉투({code, message, content})·권한 규칙(쓰기는 스트리머만)을 흉내 낸다.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import SocketIO from "socket.io";
import type { ChatSettingsDto } from "@zzirit-guard/shared";

/** 가짜 치지직 계정. */
export interface FakeUser {
  channelId: string;
  channelName: string;
}

/** 가짜 서버가 받은 API 호출 기록. */
export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  token: string | null;
  body: unknown;
}

/** 테스트에서 조작하는 가짜 치지직. */
export interface FakeChzzk {
  baseUrl: string;
  owner: FakeUser;
  streamingRoles: Array<{ managerChannelId: string; managerChannelName: string; userRole: string }>;
  chatSettings: ChatSettingsDto;
  calls: RecordedCall[];
  failNext(path: string, status: number, times?: number): void;
  grantCode(user: FakeUser): string;
  issueTokens(user: FakeUser): { accessToken: string; refreshToken: string };
  emitChat(payload: unknown): void;
  emitSystem(payload: unknown): void;
  subscribedSessionCount(): number;
  dropAllSockets(): void;
  close(): Promise<void>;
}

/** 무작위 토큰 문자열. */
function randomToken(): string {
  return randomBytes(12).toString("hex");
}

/** 가짜 치지직 서버를 임의 포트에 띄운다. */
export async function startFakeChzzk(): Promise<FakeChzzk> {
  const state = createState();
  const server = createServer((request, response) => void handleRequest(state, request, response));
  const io = SocketIO(server);
  io.on("connection", (socket) => handleSocket(state, socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return buildHandle(state, () => closeAll(io, server));
}

/** 가짜 서버 내부 상태. */
interface FakeState {
  baseUrl: string;
  owner: FakeUser;
  accessTokens: Map<string, FakeUser>;
  refreshTokens: Map<string, FakeUser>;
  codes: Map<string, FakeUser>;
  streamingRoles: FakeChzzk["streamingRoles"];
  chatSettings: ChatSettingsDto;
  calls: RecordedCall[];
  failures: Map<string, { status: number; remaining: number }>;
  sockets: Map<string, SocketIO.Socket>;
  subscribed: Set<string>;
}

/** 기본 상태: 스트리머 1명, 관리자 목록은 비어 있음. */
function createState(): FakeState {
  return {
    baseUrl: "",
    owner: { channelId: "owner-channel", channelName: "스트리머" },
    accessTokens: new Map(),
    refreshTokens: new Map(),
    codes: new Map(),
    streamingRoles: [],
    chatSettings: {
      chatAvailableCondition: "NONE", chatAvailableGroup: "ALL", minFollowerMinute: 0,
      allowSubscriberInFollowerMode: false, chatSlowModeSec: 0, chatEmojiMode: false,
    },
    calls: [],
    failures: new Map(),
    sockets: new Map(),
    subscribed: new Set(),
  };
}

/** 테스트에 넘길 조작 핸들. state를 직접 공유해 테스트가 값을 바꿀 수 있다. */
function buildHandle(state: FakeState, close: () => Promise<void>): FakeChzzk {
  return {
    get baseUrl() { return state.baseUrl; },
    owner: state.owner,
    streamingRoles: state.streamingRoles,
    get chatSettings() { return state.chatSettings; },
    calls: state.calls,
    failNext: (path, status, times = 1) => void state.failures.set(path, { status, remaining: times }),
    grantCode: (user) => grantCode(state, user),
    issueTokens: (user) => issueTokens(state, user),
    emitChat: (payload) => state.subscribed.forEach((key) => state.sockets.get(key)?.emit("CHAT", payload)),
    emitSystem: (payload) => state.sockets.forEach((socket) => socket.emit("SYSTEM", payload)),
    subscribedSessionCount: () => state.subscribed.size,
    dropAllSockets: () => state.sockets.forEach((socket) => socket.disconnect(true)),
    close,
  };
}

/** 인증 코드를 발급한다(account-interlock 리다이렉트를 흉내 냄). */
function grantCode(state: FakeState, user: FakeUser): string {
  const code = randomToken();
  state.codes.set(code, user);
  return code;
}

/** 토큰 쌍을 발급한다. refresh token은 한 번 쓰면 사라진다(일회용). */
function issueTokens(state: FakeState, user: FakeUser): { accessToken: string; refreshToken: string } {
  const tokens = { accessToken: randomToken(), refreshToken: randomToken() };
  state.accessTokens.set(tokens.accessToken, user);
  state.refreshTokens.set(tokens.refreshToken, user);
  return tokens;
}

/** HTTP 요청 하나를 처리한다. */
async function handleRequest(state: FakeState, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://fake");
  const call = await recordCall(state, request, url);
  const failure = state.failures.get(url.pathname);
  if (failure && failure.remaining > 0) {
    failure.remaining -= 1;
    return sendError(response, failure.status, "INJECTED_FAILURE");
  }
  routeRequest(state, call, response);
}

/** 요청 본문과 토큰을 읽어 기록한다. */
async function recordCall(state: FakeState, request: IncomingMessage, url: URL): Promise<RecordedCall> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const authorization = request.headers.authorization ?? "";
  const call: RecordedCall = {
    method: request.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    token: authorization.startsWith("Bearer ") ? authorization.slice(7) : null,
    body: raw ? JSON.parse(raw) : null,
  };
  state.calls.push(call);
  return call;
}

/** 경로별 응답. 스트리머 전용 쓰기 API는 소유자 토큰이 아니면 400을 준다(실제 동작과 같음). */
function routeRequest(state: FakeState, call: RecordedCall, response: ServerResponse): void {
  const key = `${call.method} ${call.path}`;
  if (key === "POST /auth/v1/token") return handleToken(state, call, response);
  const user = call.token ? state.accessTokens.get(call.token) : undefined;
  if (!user) return sendError(response, 401, "INVALID_TOKEN");
  const isOwner = user.channelId === state.owner.channelId;
  if (key === "GET /open/v1/users/me") return sendContent(response, user);
  if (key === "GET /open/v1/sessions/auth") return sendContent(response, { url: `${state.baseUrl}?auth=${call.token}` });
  if (key === "POST /open/v1/sessions/events/subscribe/chat") return handleSubscribe(state, call, response);
  if (key === "GET /open/v1/channels/streaming-roles") return sendContent(response, { data: state.streamingRoles });
  if (key === "GET /open/v1/chats/settings") return sendContent(response, state.chatSettings);
  if (!isOwner) return sendError(response, 400, "스트리머가 아닙니다");
  return handleOwnerWrite(state, key, call, response);
}

/** 스트리머 전용 쓰기 API. 성공 시 내용 없이 200을 준다. */
function handleOwnerWrite(state: FakeState, key: string, call: RecordedCall, response: ServerResponse): void {
  const writeKeys = [
    "POST /open/v1/chats/blind-message", "POST /open/v1/temporary-restrict-channels",
    "POST /open/v1/restrict-channels", "DELETE /open/v1/restrict-channels",
  ];
  if (key === "PUT /open/v1/chats/settings") {
    state.chatSettings = call.body as ChatSettingsDto;
    return sendContent(response, null);
  }
  if (writeKeys.includes(key)) return sendContent(response, null);
  sendError(response, 404, "NOT_FOUND");
}

/** 토큰 발급·갱신. 갱신에 쓴 refresh token은 즉시 지운다. */
function handleToken(state: FakeState, call: RecordedCall, response: ServerResponse): void {
  const body = call.body as Record<string, string>;
  const source = body.grantType === "authorization_code" ? state.codes : state.refreshTokens;
  const lookupKey = body.grantType === "authorization_code" ? body.code : body.refreshToken;
  const user = lookupKey ? source.get(lookupKey) : undefined;
  if (!user || body.clientSecret !== "test-secret") return sendError(response, 401, "INVALID_TOKEN");
  source.delete(lookupKey as string);
  sendContent(response, { ...issueTokens(state, user), tokenType: "Bearer", expiresIn: "86400" });
}

/** 채팅 구독. 해당 세션 소켓으로 subscribed 시스템 메시지를 보낸다. */
function handleSubscribe(state: FakeState, call: RecordedCall, response: ServerResponse): void {
  const sessionKey = call.query.sessionKey ?? "";
  const socket = state.sockets.get(sessionKey);
  if (!socket) return sendError(response, 400, "잘못된 값을 입력했습니다.");
  state.subscribed.add(sessionKey);
  sendContent(response, null);
  socket.emit("SYSTEM", { type: "subscribed", data: { eventType: "CHAT", channelId: state.owner.channelId } });
}

/** 소켓 연결: auth 쿼리의 토큰을 확인하고 connected 시스템 메시지를 보낸다. */
function handleSocket(state: FakeState, socket: SocketIO.Socket): void {
  const token = String(socket.handshake.query.auth ?? "");
  if (!state.accessTokens.has(token)) {
    socket.disconnect(true);
    return;
  }
  const sessionKey = randomToken();
  state.sockets.set(sessionKey, socket);
  socket.on("disconnect", () => {
    state.sockets.delete(sessionKey);
    state.subscribed.delete(sessionKey);
  });
  socket.emit("SYSTEM", { type: "connected", data: { sessionKey } });
}

/** 성공 봉투로 응답한다. */
function sendContent(response: ServerResponse, content: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ code: 200, message: null, content }));
}

/** 실패 봉투로 응답한다. */
function sendError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ code: status, message }));
}

/** 소켓 서버와 HTTP 서버를 닫는다. */
async function closeAll(io: SocketIO.Server, server: ReturnType<typeof createServer>): Promise<void> {
  io.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
```

- [ ] **Step 3: 실패하는 테스트 작성**

`apps/server/test/chzzk/apiClient.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChzzkApiError, createChzzkApi, type ChzzkApi } from "../../src/chzzk/apiClient.js";
import { startFakeChzzk, type FakeChzzk } from "../fakes/fakeChzzk.js";

let fake: FakeChzzk;
let api: ChzzkApi;

beforeEach(async () => {
  fake = await startFakeChzzk();
  api = createChzzkApi({ apiBase: fake.baseUrl, clientId: "test-client", clientSecret: "test-secret" });
});
afterEach(async () => fake.close());

describe("ChzzkApi", () => {
  it("인증 코드로 토큰을 받고 사용자 정보를 읽는다", async () => {
    const tokens = await api.exchangeCode(fake.grantCode(fake.owner), "state-1");
    expect(tokens.expiresInSeconds).toBe(86400);
    expect(await api.getMe(tokens.accessToken)).toEqual(fake.owner);
    const tokenCall = fake.calls.find((call) => call.path === "/auth/v1/token");
    expect(tokenCall?.body).toMatchObject({ grantType: "authorization_code", state: "state-1", clientId: "test-client" });
  });

  it("refresh token은 한 번만 쓸 수 있다", async () => {
    const tokens = fake.issueTokens(fake.owner);
    await api.refreshToken(tokens.refreshToken);
    await expect(api.refreshToken(tokens.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it("스트리머가 아닌 토큰의 쓰기는 400 오류가 된다", async () => {
    const viewer = fake.issueTokens({ channelId: "viewer", channelName: "시청자" });
    const target = { chatChannelId: "chat-1", messageTime: 1, senderChannelId: "bad" };
    const error = await api.blindMessage(viewer.accessToken, target).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChzzkApiError);
    expect(error).toMatchObject({ status: 400, apiMessage: "스트리머가 아닙니다" });
  });

  it("429를 상태 코드와 함께 알린다", async () => {
    const owner = fake.issueTokens(fake.owner);
    fake.failNext("/open/v1/chats/blind-message", 429);
    const target = { chatChannelId: "chat-1", messageTime: 1, senderChannelId: "bad" };
    await expect(api.blindMessage(owner.accessToken, target)).rejects.toMatchObject({ status: 429 });
    await expect(api.blindMessage(owner.accessToken, target)).resolves.toBeUndefined();
  });

  it("sessionKey를 쿼리로 보내고 채팅 설정을 읽고 쓴다", async () => {
    const owner = fake.issueTokens(fake.owner);
    await expect(api.subscribeChat(owner.accessToken, "no-such-session")).rejects.toMatchObject({ status: 400 });
    expect(fake.calls.at(-1)?.query).toEqual({ sessionKey: "no-such-session" });
    const settings = await api.getChatSettings(owner.accessToken);
    await api.updateChatSettings(owner.accessToken, { ...settings, chatSlowModeSec: 5 });
    expect(fake.chatSettings.chatSlowModeSec).toBe(5);
  });
});
```

- [ ] **Step 4: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- apiClient`
Expected: FAIL — `Cannot find module '../../src/chzzk/apiClient.js'`

- [ ] **Step 5: 구현**

`apps/server/src/chzzk/apiClient.ts`:
```ts
import type { ChatSettingsDto } from "@zzirit-guard/shared";
import { z } from "zod";

/** 치지직 API 오류. status는 HTTP 상태, apiMessage는 치지직이 준 메시지다. */
export class ChzzkApiError extends Error {
  override readonly name = "ChzzkApiError";
  readonly status: number;
  readonly apiMessage: string;
  readonly path: string;

  constructor(status: number, apiMessage: string, path: string) {
    super(`치지직 API 오류 ${status} (${path}): ${apiMessage}`);
    this.status = status;
    this.apiMessage = apiMessage;
    this.path = path;
  }
}

/** 발급·갱신된 토큰 쌍. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

/** GET /open/v1/users/me 결과. */
export interface ChzzkUser {
  channelId: string;
  channelName: string;
}

/** GET /open/v1/channels/streaming-roles의 항목. */
export interface StreamingRole {
  managerChannelId: string;
  managerChannelName: string;
  userRole: string;
}

/** 숨길 메시지를 가리키는 값. 채팅 이벤트에 모두 들어 있다. */
export interface MessageTarget {
  chatChannelId: string;
  messageTime: number;
  senderChannelId: string;
}

/** 서버가 쓰는 치지직 Open API 묶음. 토큰을 인자로 받아 호출자가 어떤 토큰을 쓸지 정한다. */
export interface ChzzkApi {
  exchangeCode(code: string, state: string): Promise<TokenSet>;
  refreshToken(refreshToken: string): Promise<TokenSet>;
  getMe(accessToken: string): Promise<ChzzkUser>;
  getStreamingRoles(accessToken: string): Promise<StreamingRole[]>;
  createSessionUrl(accessToken: string): Promise<string>;
  subscribeChat(accessToken: string, sessionKey: string): Promise<void>;
  blindMessage(accessToken: string, target: MessageTarget): Promise<void>;
  addTemporaryRestriction(accessToken: string, targetChannelId: string, chatChannelId: string): Promise<void>;
  addRestriction(accessToken: string, targetChannelId: string): Promise<void>;
  removeRestriction(accessToken: string, targetChannelId: string): Promise<void>;
  getChatSettings(accessToken: string): Promise<ChatSettingsDto>;
  updateChatSettings(accessToken: string, settings: ChatSettingsDto): Promise<void>;
}

/** createChzzkApi 옵션. fetchFunction은 테스트에서 바꿔 끼우려고 둔다. */
export interface ChzzkApiOptions {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  fetchFunction?: typeof fetch;
  timeoutMs?: number;
}

/** 토큰 응답. 문서에 expiresIn이 String으로 적혀 있어 숫자·문자 모두 받는다. */
const tokenSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.union([z.string(), z.number()]).transform(Number),
});
/** 사용자 정보 응답. */
const userSchema = z.object({ channelId: z.string(), channelName: z.string() });
/** 관리자 목록 응답. */
const rolesSchema = z.object({
  data: z.array(z.object({ managerChannelId: z.string(), managerChannelName: z.string(), userRole: z.string() })),
});
/** 세션 생성 응답. */
const sessionSchema = z.object({ url: z.string() });
/** 채팅 설정 응답. */
const chatSettingsSchema = z.object({
  chatAvailableCondition: z.enum(["NONE", "REAL_NAME"]),
  chatAvailableGroup: z.enum(["ALL", "FOLLOWER", "MANAGER", "SUBSCRIBER"]),
  minFollowerMinute: z.number(),
  allowSubscriberInFollowerMode: z.boolean(),
  chatSlowModeSec: z.number(),
  chatEmojiMode: z.boolean(),
});

/** HTTP 메서드. */
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
/** 호출 1건의 토큰·본문. */
interface CallOptions {
  token?: string;
  body?: unknown;
}
/** 봉투를 벗긴 content를 돌려주는 호출 함수. */
type Caller = (method: HttpMethod, path: string, callOptions: CallOptions) => Promise<unknown>;

/** 치지직 API 클라이언트를 만든다. */
export function createChzzkApi(options: ChzzkApiOptions): ChzzkApi {
  const call = createCaller(options);
  return {
    exchangeCode: (code, state) => requestTokens(call, options, { grantType: "authorization_code", code, state }),
    refreshToken: (refreshToken) => requestTokens(call, options, { grantType: "refresh_token", refreshToken }),
    getMe: async (token) => userSchema.parse(await call("GET", "/open/v1/users/me", { token })),
    getStreamingRoles: async (token) => rolesSchema.parse(await call("GET", "/open/v1/channels/streaming-roles", { token })).data,
    createSessionUrl: async (token) => sessionSchema.parse(await call("GET", "/open/v1/sessions/auth", { token })).url,
    subscribeChat: (token, sessionKey) => discard(call("POST", `/open/v1/sessions/events/subscribe/chat?sessionKey=${encodeURIComponent(sessionKey)}`, { token })),
    blindMessage: (token, target) => discard(call("POST", "/open/v1/chats/blind-message", { token, body: target })),
    addTemporaryRestriction: (token, targetChannelId, chatChannelId) =>
      discard(call("POST", "/open/v1/temporary-restrict-channels", { token, body: { targetChannelId, chatChannelId } })),
    addRestriction: (token, targetChannelId) => discard(call("POST", "/open/v1/restrict-channels", { token, body: { targetChannelId } })),
    removeRestriction: (token, targetChannelId) => discard(call("DELETE", "/open/v1/restrict-channels", { token, body: { targetChannelId } })),
    getChatSettings: async (token) => chatSettingsSchema.parse(await call("GET", "/open/v1/chats/settings", { token })),
    updateChatSettings: (token, settings) => discard(call("PUT", "/open/v1/chats/settings", { token, body: settings })),
  };
}

/** 결과 값이 필요 없는 호출을 Promise<void>로 바꾼다. */
async function discard(promise: Promise<unknown>): Promise<void> {
  await promise;
}

/** 토큰 발급·갱신 공통 처리. clientId·clientSecret은 본문으로 보낸다(문서 규격). */
async function requestTokens(call: Caller, options: ChzzkApiOptions, grant: Record<string, string>): Promise<TokenSet> {
  const content = await call("POST", "/auth/v1/token", { body: { ...grant, clientId: options.clientId, clientSecret: options.clientSecret } });
  const parsed = tokenSchema.parse(content);
  return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresInSeconds: parsed.expiresIn };
}

/** fetch로 요청하고 봉투를 벗기는 호출 함수를 만든다. */
function createCaller(options: ChzzkApiOptions): Caller {
  const fetchFunction = options.fetchFunction ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (method, path, callOptions) => {
    const response = await fetchFunction(options.apiBase + path, buildRequestInit(method, callOptions, timeoutMs));
    return unwrapEnvelope(response, path);
  };
}

/** 헤더·본문·제한 시간을 붙인다. 토큰은 "Bearer " 뒤에 공백 하나를 두어야 한다(문서 주의사항). */
function buildRequestInit(method: HttpMethod, callOptions: CallOptions, timeoutMs: number): RequestInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (callOptions.token) headers.Authorization = `Bearer ${callOptions.token}`;
  const body = callOptions.body === undefined ? undefined : JSON.stringify(callOptions.body);
  return { method, headers, body, signal: AbortSignal.timeout(timeoutMs) };
}

/** 응답 봉투를 해석한다. 실패면 ChzzkApiError를 던지고, 성공이면 content를 돌려준다(없으면 undefined). */
async function unwrapEnvelope(response: Response, path: string): Promise<unknown> {
  const envelope = parseJsonOrNull(await response.text());
  const bodyCode = isRecord(envelope) && typeof envelope.code === "number" ? envelope.code : response.status;
  if (!response.ok || bodyCode >= 400) {
    const message = isRecord(envelope) && typeof envelope.message === "string" ? envelope.message : response.statusText;
    throw new ChzzkApiError(response.ok ? bodyCode : response.status, message, path);
  }
  return isRecord(envelope) ? envelope.content : undefined;
}

/** 빈 본문이나 JSON이 아닌 본문은 null로 본다(blind-message는 본문 없이 200을 줄 수 있다). */
function parseJsonOrNull(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 객체인지 확인한다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
```

- [ ] **Step 6: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- apiClient`
Expected: PASS (5 tests)

- [ ] **Step 7: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/chzzk apps/server/test/chzzk apps/server/test/fakes apps/server/test/helpers apps/server/package.json package-lock.json
git commit -m "feat: 치지직 Open API 클라이언트와 가짜 치지직 서버 추가" -m "공통 응답 봉투를 해석해 실패를 ChzzkApiError로 바꾸고, 테스트용 가짜 서버는 일회용 refresh token과 스트리머 전용 쓰기 규칙을 흉내 낸다."
```

---

### Task 6: 채널 연결 저장과 토큰 관리

**Files:**
- Create: `apps/server/src/connection/credentialStore.ts`, `apps/server/src/connection/tokenManager.ts`
- Create: `apps/server/test/fakes/fakeApi.ts`
- Test: `apps/server/test/connection/credentialStore.test.ts`, `apps/server/test/connection/tokenManager.test.ts`

**Interfaces:**
- Consumes: `Database`(Task 3), `TokenCipher`(Task 4), `ChzzkApi`·`ChzzkApiError`(Task 5), `Clock`(Task 1)
- Produces: `interface ConnectedChannel { channelId; channelName }`, `interface StoredCredential { channelId; accessToken; refreshToken; accessExpiresAt }`, `interface CredentialStore { loadChannel(): ConnectedChannel | null; loadCredential(): StoredCredential | null; saveConnection(channel, credential): void; saveCredential(credential): void; clearConnection(): void }`, `createCredentialStore(database, cipher, clock)`; `class WriteLockedError extends Error`, `interface TokenManager { getAccessToken(): Promise<string>; forceRefresh(): Promise<string>; isWriteLocked(): boolean; accessExpiresAt(): number | null; adoptCredential(channel, credential): void; disconnect(): void; onLockChange(listener: (locked: boolean) => void): void }`, `createTokenManager(options: { store; api; clock; refreshMarginMs? })`, 테스트용 `createFakeApi(overrides: Partial<ChzzkApi>): ChzzkApi`

- [ ] **Step 1: 테스트용 가짜 API 작성**

`apps/server/test/fakes/fakeApi.ts`:
```ts
import type { ChzzkApi } from "../../src/chzzk/apiClient.js";

/**
 * 필요한 메서드만 채운 가짜 ChzzkApi. 채우지 않은 메서드를 부르면 바로 실패해,
 * 테스트가 예상하지 못한 호출을 놓치지 않게 한다.
 */
export function createFakeApi(overrides: Partial<ChzzkApi>): ChzzkApi {
  return new Proxy(overrides as ChzzkApi, {
    get(target, property) {
      const value = target[property as keyof ChzzkApi];
      if (value) return value;
      return () => Promise.reject(new Error(`fakeApi.${String(property)}가 준비되지 않았습니다`));
    },
  });
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/server/test/connection/credentialStore.test.ts`:
```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/connection/credentialStore.js";
import { openDatabase } from "../../src/db/database.js";
import { createTokenCipher } from "../../src/security/tokenCipher.js";

/** 테스트용 저장소. */
function createStore() {
  const database = openDatabase(":memory:");
  return { database, store: createCredentialStore(database, createTokenCipher(randomBytes(32)), () => 1_000) };
}

/** 예시 채널과 토큰. */
const channel = { channelId: "owner-channel", channelName: "스트리머" };
const credential = { channelId: "owner-channel", accessToken: "access-1", refreshToken: "refresh-1", accessExpiresAt: 90_000 };

describe("CredentialStore", () => {
  it("연결을 저장하면 토큰을 암호화해 두고 그대로 읽는다", () => {
    const { database, store } = createStore();
    store.saveConnection(channel, credential);
    expect(store.loadChannel()).toEqual(channel);
    expect(store.loadCredential()).toEqual(credential);
    const row = database.prepare("SELECT access_token_enc FROM credential").get() as { access_token_enc: string };
    expect(row.access_token_enc).not.toContain("access-1");
    expect(database.prepare("SELECT auto_hide_enabled FROM setting").get()).toEqual({ auto_hide_enabled: 0 });
  });

  it("다른 채널 연결을 거부한다(MVP는 채널 1곳)", () => {
    const { store } = createStore();
    store.saveConnection(channel, credential);
    const other = { channelId: "other", channelName: "다른 채널" };
    expect(() => store.saveConnection(other, { ...credential, channelId: "other" })).toThrow(/이미 다른 채널/);
  });

  it("연결 해제 시 토큰과 설정까지 지운다", () => {
    const { database, store } = createStore();
    store.saveConnection(channel, credential);
    store.clearConnection();
    expect(store.loadChannel()).toBeNull();
    expect(store.loadCredential()).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM setting").get()).toEqual({ count: 0 });
  });
});
```

`apps/server/test/connection/tokenManager.test.ts`:
```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ChzzkApiError, type TokenSet } from "../../src/chzzk/apiClient.js";
import { createCredentialStore, type CredentialStore } from "../../src/connection/credentialStore.js";
import { createTokenManager, WriteLockedError } from "../../src/connection/tokenManager.js";
import { openDatabase } from "../../src/db/database.js";
import { createTokenCipher } from "../../src/security/tokenCipher.js";
import { createFakeApi } from "../fakes/fakeApi.js";

/** 2시간(ms). 선제 갱신 기준. */
const TWO_HOURS = 2 * 60 * 60 * 1000;
/** 테스트 기준 시각. */
const NOW = 10_000_000;

/** 만료까지 남은 시간을 정해 연결된 저장소를 만든다. */
function connectedStore(expiresInMs: number): CredentialStore {
  const store = createCredentialStore(openDatabase(":memory:"), createTokenCipher(randomBytes(32)), () => NOW);
  store.saveConnection(
    { channelId: "owner-channel", channelName: "스트리머" },
    { channelId: "owner-channel", accessToken: "old-access", refreshToken: "old-refresh", accessExpiresAt: NOW + expiresInMs },
  );
  return store;
}

/** 새 토큰 쌍. */
const freshTokens: TokenSet = { accessToken: "new-access", refreshToken: "new-refresh", expiresInSeconds: 86_400 };

describe("TokenManager", () => {
  it("만료가 멀면 갱신하지 않는다", async () => {
    const refreshToken = vi.fn();
    const manager = createTokenManager({ store: connectedStore(TWO_HOURS * 3), api: createFakeApi({ refreshToken }), clock: () => NOW });
    expect(await manager.getAccessToken()).toBe("old-access");
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("만료 2시간 전이면 갱신하고, 저장한 새 토큰을 쓴다", async () => {
    const store = connectedStore(TWO_HOURS - 1);
    const manager = createTokenManager({ store, api: createFakeApi({ refreshToken: async () => freshTokens }), clock: () => NOW });
    expect(await manager.getAccessToken()).toBe("new-access");
    expect(store.loadCredential()).toMatchObject({ refreshToken: "new-refresh", accessExpiresAt: NOW + 86_400_000 });
  });

  it("동시에 불러도 갱신은 한 번만 한다(refresh token은 일회용)", async () => {
    const refreshToken = vi.fn(async () => freshTokens);
    const manager = createTokenManager({ store: connectedStore(0), api: createFakeApi({ refreshToken }), clock: () => NOW });
    const tokens = await Promise.all([manager.getAccessToken(), manager.getAccessToken(), manager.getAccessToken()]);
    expect(tokens).toEqual(["new-access", "new-access", "new-access"]);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it("갱신이 401이면 쓰기를 잠그고 알린다", async () => {
    const listener = vi.fn();
    const api = createFakeApi({ refreshToken: async () => { throw new ChzzkApiError(401, "INVALID_TOKEN", "/auth/v1/token"); } });
    const manager = createTokenManager({ store: connectedStore(0), api, clock: () => NOW });
    manager.onLockChange(listener);
    await expect(manager.getAccessToken()).rejects.toBeInstanceOf(WriteLockedError);
    expect(manager.isWriteLocked()).toBe(true);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it("새 토큰 저장에 실패하면 쓰기를 잠근다(옛 refresh token은 이미 무효)", async () => {
    const store = connectedStore(0);
    store.saveCredential = () => { throw new Error("disk full"); };
    const manager = createTokenManager({ store, api: createFakeApi({ refreshToken: async () => freshTokens }), clock: () => NOW });
    await expect(manager.getAccessToken()).rejects.toThrow(/저장하지 못해.*disk full/);
    expect(manager.isWriteLocked()).toBe(true);
  });

  it("네트워크 오류여도 아직 유효한 토큰은 계속 쓴다", async () => {
    const api = createFakeApi({ refreshToken: async () => { throw new TypeError("fetch failed"); } });
    const manager = createTokenManager({ store: connectedStore(TWO_HOURS - 1), api, clock: () => NOW });
    expect(await manager.getAccessToken()).toBe("old-access");
    expect(manager.isWriteLocked()).toBe(false);
  });

  it("새 연결을 받으면 잠금을 푼다", async () => {
    const api = createFakeApi({ refreshToken: async () => { throw new ChzzkApiError(401, "INVALID_TOKEN", "/auth/v1/token"); } });
    const store = connectedStore(0);
    const manager = createTokenManager({ store, api, clock: () => NOW });
    await manager.getAccessToken().catch(() => undefined);
    manager.adoptCredential(
      { channelId: "owner-channel", channelName: "스트리머" },
      { channelId: "owner-channel", accessToken: "relinked", refreshToken: "r2", accessExpiresAt: NOW + TWO_HOURS * 10 },
    );
    expect(manager.isWriteLocked()).toBe(false);
    expect(await manager.getAccessToken()).toBe("relinked");
  });

  it("연결이 없으면 원인을 알려 준다", async () => {
    const store = createCredentialStore(openDatabase(":memory:"), createTokenCipher(randomBytes(32)), () => NOW);
    const manager = createTokenManager({ store, api: createFakeApi({}), clock: () => NOW });
    await expect(manager.getAccessToken()).rejects.toThrow(/스트리머가 먼저 연결/);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- connection`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: 구현**

`apps/server/src/connection/credentialStore.ts`:
```ts
import type { Database } from "../db/database.js";
import type { TokenCipher } from "../security/tokenCipher.js";
import type { Clock } from "../time.js";

/** 연결된 스트리머 채널. */
export interface ConnectedChannel {
  channelId: string;
  channelName: string;
}

/** 복호화된 토큰. accessExpiresAt은 ms 시각이다. */
export interface StoredCredential {
  channelId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
}

/** 채널 연결과 토큰을 저장한다. MVP는 채널 1곳만 허용한다. */
export interface CredentialStore {
  loadChannel(): ConnectedChannel | null;
  loadCredential(): StoredCredential | null;
  saveConnection(channel: ConnectedChannel, credential: StoredCredential): void;
  saveCredential(credential: StoredCredential): void;
  clearConnection(): void;
}

/** credential 테이블 행. */
interface CredentialRow {
  channel_id: string;
  access_token_enc: string;
  refresh_token_enc: string;
  access_expires_at: number;
}

/** SQLite 기반 CredentialStore를 만든다. 토큰은 저장 전에 암호화한다. */
export function createCredentialStore(database: Database, cipher: TokenCipher, clock: Clock): CredentialStore {
  return {
    loadChannel: () => loadChannel(database),
    loadCredential: () => loadCredential(database, cipher),
    saveConnection: (channel, credential) => database.transaction(() => saveConnection(database, cipher, clock, channel, credential))(),
    saveCredential: (credential) => writeCredential(database, cipher, clock, credential),
    clearConnection: () => void database.prepare("DELETE FROM channel").run(),
  };
}

/** 연결된 채널을 읽는다(없으면 null). */
function loadChannel(database: Database): ConnectedChannel | null {
  const row = database.prepare("SELECT channel_id, channel_name FROM channel LIMIT 1").get() as
    | { channel_id: string; channel_name: string }
    | undefined;
  return row ? { channelId: row.channel_id, channelName: row.channel_name } : null;
}

/** 토큰을 복호화해 읽는다(없으면 null). */
function loadCredential(database: Database, cipher: TokenCipher): StoredCredential | null {
  const row = database.prepare("SELECT * FROM credential LIMIT 1").get() as CredentialRow | undefined;
  if (!row) return null;
  return {
    channelId: row.channel_id,
    accessToken: cipher.decrypt(row.access_token_enc),
    refreshToken: cipher.decrypt(row.refresh_token_enc),
    accessExpiresAt: row.access_expires_at,
  };
}

/** 채널·기본 설정·토큰을 한 번에 저장한다. 다른 채널이 이미 있으면 거부한다. */
function saveConnection(database: Database, cipher: TokenCipher, clock: Clock, channel: ConnectedChannel, credential: StoredCredential): void {
  const existing = loadChannel(database);
  if (existing && existing.channelId !== channel.channelId) {
    throw new Error(`이미 다른 채널(${existing.channelName})이 연결되어 있습니다. 먼저 연결을 해제하세요.`);
  }
  database
    .prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES (?, ?, ?) ON CONFLICT (channel_id) DO UPDATE SET channel_name = excluded.channel_name")
    .run(channel.channelId, channel.channelName, clock());
  database.prepare("INSERT OR IGNORE INTO setting (channel_id) VALUES (?)").run(channel.channelId);
  writeCredential(database, cipher, clock, credential);
}

/** 토큰 행을 쓴다(있으면 교체). */
function writeCredential(database: Database, cipher: TokenCipher, clock: Clock, credential: StoredCredential): void {
  database
    .prepare(
      `INSERT INTO credential (channel_id, access_token_enc, refresh_token_enc, access_expires_at, refreshed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (channel_id) DO UPDATE SET access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
       access_expires_at = excluded.access_expires_at, refreshed_at = excluded.refreshed_at`,
    )
    .run(credential.channelId, cipher.encrypt(credential.accessToken), cipher.encrypt(credential.refreshToken), credential.accessExpiresAt, clock());
}
```

`apps/server/src/connection/tokenManager.ts`:
```ts
import { ChzzkApiError, type ChzzkApi } from "../chzzk/apiClient.js";
import type { Clock } from "../time.js";
import type { ConnectedChannel, CredentialStore, StoredCredential } from "./credentialStore.js";

/** 쓰기를 할 수 없는 상태. 메시지는 매니저 화면에 그대로 보여 줄 수 있게 쓴다. */
export class WriteLockedError extends Error {
  override readonly name = "WriteLockedError";
}

/** 스트리머 토큰을 꺼내 주고, 만료 전에 갱신하며, 갱신이 불가능하면 쓰기를 잠근다. */
export interface TokenManager {
  getAccessToken(): Promise<string>;
  forceRefresh(): Promise<string>;
  isWriteLocked(): boolean;
  accessExpiresAt(): number | null;
  adoptCredential(channel: ConnectedChannel, credential: StoredCredential): void;
  disconnect(): void;
  onLockChange(listener: (locked: boolean) => void): void;
}

/** createTokenManager 옵션. */
export interface TokenManagerOptions {
  store: CredentialStore;
  api: ChzzkApi;
  clock: Clock;
  refreshMarginMs?: number;
}

/** 기본 선제 갱신 여유: 만료 2시간 전(스펙 4장). */
const DEFAULT_REFRESH_MARGIN_MS = 2 * 60 * 60 * 1000;

/** TokenManager를 만든다. */
export function createTokenManager(options: TokenManagerOptions): TokenManager {
  return new RefreshingTokenManager(options);
}

/** 단일 갱신(single-flight)과 쓰기 잠금을 구현한다. */
class RefreshingTokenManager implements TokenManager {
  private locked = false;
  private inFlight: Promise<string> | null = null;
  private readonly listeners: Array<(locked: boolean) => void> = [];
  private readonly marginMs: number;

  constructor(private readonly options: TokenManagerOptions) {
    this.marginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
  }

  /** 유효한 access token을 돌려준다. 만료가 가까우면 먼저 갱신한다. */
  async getAccessToken(): Promise<string> {
    const credential = this.requireCredential();
    if (credential.accessExpiresAt - this.options.clock() > this.marginMs) return credential.accessToken;
    return this.refreshKeepingValidToken(credential);
  }

  /** 401을 받은 직후처럼 만료 시각과 관계없이 갱신해야 할 때 쓴다. */
  forceRefresh(): Promise<string> {
    return this.refreshOnce(this.requireCredential());
  }

  isWriteLocked(): boolean {
    return this.locked;
  }

  accessExpiresAt(): number | null {
    return this.options.store.loadCredential()?.accessExpiresAt ?? null;
  }

  /** 스트리머가 다시 연결(또는 로그인)해 받은 새 토큰을 저장하고 잠금을 푼다. */
  adoptCredential(channel: ConnectedChannel, credential: StoredCredential): void {
    this.options.store.saveConnection(channel, credential);
    this.setLocked(false);
  }

  /** 연결을 해제한다. 저장된 토큰을 지우고 잠근다. 치지직 revoke는 부르지 않는다(Global Constraints). */
  disconnect(): void {
    this.options.store.clearConnection();
    this.setLocked(true);
  }

  onLockChange(listener: (locked: boolean) => void): void {
    this.listeners.push(listener);
  }

  /** 잠겨 있거나 연결이 없으면 이유를 담아 예외를 던진다. */
  private requireCredential(): StoredCredential {
    const credential = this.options.store.loadCredential();
    if (!credential) throw new WriteLockedError("치지직 채널이 연결되어 있지 않습니다. 스트리머가 먼저 연결하세요.");
    if (this.locked) throw new WriteLockedError("치지직 토큰을 갱신할 수 없어 쓰기를 멈췄습니다. 스트리머가 다시 연결해야 합니다.");
    return credential;
  }

  /** 갱신을 시도하되, 일시 오류이고 토큰이 아직 유효하면 기존 토큰을 쓴다. */
  private async refreshKeepingValidToken(credential: StoredCredential): Promise<string> {
    try {
      return await this.refreshOnce(credential);
    } catch (error) {
      const stillValid = credential.accessExpiresAt > this.options.clock();
      if (error instanceof WriteLockedError || !stillValid) throw error;
      return credential.accessToken;
    }
  }

  /** 진행 중인 갱신이 있으면 그 결과를 함께 기다린다. refresh token이 일회용이라 두 번 쓰면 안 된다. */
  private refreshOnce(credential: StoredCredential): Promise<string> {
    this.inFlight ??= this.refresh(credential).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** 갱신 → 저장 → 반환. 저장 실패는 복구할 수 없으므로 잠근다. */
  private async refresh(credential: StoredCredential): Promise<string> {
    const tokens = await this.requestRefresh(credential.refreshToken);
    const renewed: StoredCredential = {
      channelId: credential.channelId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: this.options.clock() + tokens.expiresInSeconds * 1000,
    };
    this.saveOrLock(renewed);
    return renewed.accessToken;
  }

  /** 치지직에 갱신을 요청한다. 401이면 refresh token이 무효이므로 잠근다. */
  private async requestRefresh(refreshToken: string) {
    try {
      return await this.options.api.refreshToken(refreshToken);
    } catch (error) {
      if (error instanceof ChzzkApiError && error.status === 401) {
        this.setLocked(true);
        throw new WriteLockedError("치지직이 토큰 갱신을 거부했습니다(만료·철회). 스트리머가 다시 연결해야 합니다.");
      }
      throw error;
    }
  }

  /** 새 토큰을 저장한다. 실패하면 옛 refresh token도 이미 무효라 잠그고 원인을 알린다. */
  private saveOrLock(renewed: StoredCredential): void {
    try {
      this.options.store.saveCredential(renewed);
    } catch (error) {
      this.setLocked(true);
      const reason = error instanceof Error ? error.message : String(error);
      throw new WriteLockedError(`새 토큰을 저장하지 못해 쓰기를 멈췄습니다(${reason}). 디스크를 확인한 뒤 스트리머가 다시 연결하세요.`);
    }
  }

  /** 잠금 상태를 바꾸고, 바뀌었을 때만 알린다. */
  private setLocked(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    this.listeners.forEach((listener) => listener(locked));
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- connection`
Expected: PASS (11 tests)

- [ ] **Step 6: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/connection apps/server/test/connection apps/server/test/fakes/fakeApi.ts
git commit -m "feat: 채널 연결 저장과 토큰 선제 갱신 추가" -m "refresh token이 일회용이라 갱신은 한 번만 실행하고 새 토큰을 저장한 뒤 사용한다. 갱신 거부나 저장 실패는 쓰기 잠금으로 이어진다."
```

---

### Task 7: 채팅 수신(Session API)

**Files:**
- Create: `apps/server/src/logger.ts`, `apps/server/src/chat/chatEvent.ts`, `apps/server/src/chat/chatReceiver.ts`
- Test: `apps/server/test/chat/chatEvent.test.ts`, `apps/server/test/chat/chatReceiver.test.ts`

**Interfaces:**
- Consumes: `ChzzkApi`(Task 5), `TokenManager`(Task 6), `Clock`, `startFakeChzzk`·`waitFor`(Task 5)
- Produces: `interface Logger { info; warn; error }`(각각 `(message: string, details?: Record<string, unknown>) => void`), `createConsoleLogger(): Logger`, `silentLogger: Logger`, `describeError(error: unknown): string`; `interface ChatEvent { channelId; senderChannelId; chatChannelId; nickname; userRoleCode; content; messageTime; receivedAt }`, `parseChatPayload(payload: unknown, receivedAt: number): ChatEvent | null`, `type SystemMessage`, `parseSystemPayload(payload: unknown): SystemMessage | null`, `isPrivilegedRole(userRoleCode: string): boolean`; `interface SocketLike { on(event: string, handler: (payload: unknown) => void): unknown; close(): unknown }`, `type SocketConnector = (url: string) => SocketLike`, `connectWithSocketIo: SocketConnector`, `reconnectDelayMs(attempt: number): number`, `interface ChatReceiver { start(): void; stop(): void; isConnected(): boolean }`, `createChatReceiver(options: ChatReceiverOptions): ChatReceiver`

- [ ] **Step 1: 의존성 설치**

```bash
npm install --save-exact -w @zzirit-guard/server socket.io-client@2.0.3
npm install --save-dev --save-exact -w @zzirit-guard/server @types/socket.io-client@1.4.36
```

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/server/test/chat/chatEvent.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isPrivilegedRole, parseChatPayload, parseSystemPayload } from "../../src/chat/chatEvent.js";

/** 문서 필드표대로 만든 정상 CHAT 페이로드. */
const payload = {
  channelId: "owner-channel", senderChannelId: "viewer-1", chatChannelId: "chat-1",
  profile: { nickname: "시청자1", badges: [], verifiedMark: false },
  userRoleCode: "common_user", content: "안녕하세요", emojis: {}, messageTime: 1_700_000_000_000,
};

describe("parseChatPayload", () => {
  it("문서 형식을 ChatEvent로 바꾼다", () => {
    expect(parseChatPayload(payload, 5)).toEqual({
      channelId: "owner-channel", senderChannelId: "viewer-1", chatChannelId: "chat-1", nickname: "시청자1",
      userRoleCode: "common_user", content: "안녕하세요", messageTime: 1_700_000_000_000, receivedAt: 5,
    });
  });

  it("JSON 문자열로 와도 읽는다", () => {
    expect(parseChatPayload(JSON.stringify(payload), 5)?.content).toBe("안녕하세요");
  });

  it("profile·emojis·userRoleCode가 빠져도 기본값으로 읽는다", () => {
    const { profile: _profile, emojis: _emojis, userRoleCode: _role, ...minimal } = payload;
    expect(parseChatPayload(minimal, 5)).toMatchObject({ nickname: "(알 수 없음)", userRoleCode: "common_user" });
  });

  it("필수 필드가 없거나 JSON이 깨지면 null", () => {
    expect(parseChatPayload({ ...payload, content: undefined }, 5)).toBeNull();
    expect(parseChatPayload("{broken", 5)).toBeNull();
  });
});

describe("parseSystemPayload", () => {
  it("connected와 revoked를 구분한다", () => {
    expect(parseSystemPayload({ type: "connected", data: { sessionKey: "k1" } })).toEqual({ type: "connected", sessionKey: "k1" });
    expect(parseSystemPayload(JSON.stringify({ type: "revoked", data: { eventType: "CHAT", channelId: "c" } }))).toEqual({
      type: "revoked", eventType: "CHAT", channelId: "c",
    });
    expect(parseSystemPayload({ type: "unknown" })).toBeNull();
  });
});

describe("isPrivilegedRole", () => {
  it("스트리머와 매니저만 참", () => {
    expect(["streamer", "streaming_channel_manager", "streaming_chat_manager"].map(isPrivilegedRole)).toEqual([true, true, true]);
    expect(isPrivilegedRole("common_user")).toBe(false);
  });
});
```

`apps/server/test/chat/chatReceiver.test.ts`:
```ts
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../../src/chat/chatEvent.js";
import { connectWithSocketIo, createChatReceiver, reconnectDelayMs, type ChatReceiver } from "../../src/chat/chatReceiver.js";
import { createChzzkApi } from "../../src/chzzk/apiClient.js";
import { createCredentialStore } from "../../src/connection/credentialStore.js";
import { createTokenManager } from "../../src/connection/tokenManager.js";
import { openDatabase } from "../../src/db/database.js";
import { silentLogger } from "../../src/logger.js";
import { createTokenCipher } from "../../src/security/tokenCipher.js";
import { startFakeChzzk, type FakeChzzk } from "../fakes/fakeChzzk.js";
import { waitFor } from "../helpers/waitFor.js";

let fake: FakeChzzk;
let receiver: ChatReceiver;
let received: ChatEvent[];
let invalidCount: number;
let revokedCount: number;

beforeEach(async () => {
  fake = await startFakeChzzk();
  received = [];
  invalidCount = 0;
  revokedCount = 0;
  const api = createChzzkApi({ apiBase: fake.baseUrl, clientId: "test-client", clientSecret: "test-secret" });
  const store = createCredentialStore(openDatabase(":memory:"), createTokenCipher(randomBytes(32)), Date.now);
  const tokens = fake.issueTokens(fake.owner);
  store.saveConnection(fake.owner, { channelId: fake.owner.channelId, ...tokens, accessExpiresAt: Date.now() + 86_400_000 });
  receiver = createChatReceiver({
    api, tokenManager: createTokenManager({ store, api, clock: Date.now }), connect: connectWithSocketIo, clock: Date.now,
    logger: silentLogger, onChat: (event) => received.push(event), onConnectionChange: () => undefined,
    onInvalidEvent: () => { invalidCount += 1; }, onRevoked: () => { revokedCount += 1; },
  });
});
afterEach(async () => {
  receiver.stop();
  await fake.close();
});

/** 정상 CHAT 페이로드. */
function chatPayload(content: string) {
  return { channelId: "owner-channel", senderChannelId: "viewer-1", chatChannelId: "chat-1", profile: { nickname: "시청자1" }, userRoleCode: "common_user", content, emojis: {}, messageTime: Date.now() };
}

describe("ChatReceiver", () => {
  it("세션을 만들고 sessionKey로 구독한 뒤 채팅을 넘긴다", async () => {
    receiver.start();
    await waitFor(() => receiver.isConnected());
    expect(fake.calls.some((call) => call.path === "/open/v1/sessions/events/subscribe/chat" && call.query.sessionKey)).toBe(true);
    fake.emitChat(chatPayload("첫 채팅"));
    fake.emitChat(JSON.stringify(chatPayload("문자열 채팅")));
    fake.emitChat({ broken: true });
    await waitFor(() => received.length === 2 && invalidCount === 1);
    expect(received.map((event) => event.content)).toEqual(["첫 채팅", "문자열 채팅"]);
  });

  it("끊기면 새 세션으로 다시 연결한다", async () => {
    receiver.start();
    await waitFor(() => receiver.isConnected());
    fake.dropAllSockets();
    await waitFor(() => !receiver.isConnected());
    await waitFor(() => receiver.isConnected() && fake.subscribedSessionCount() === 1, 8_000);
    expect(fake.calls.filter((call) => call.path === "/open/v1/sessions/auth")).toHaveLength(2);
  });

  it("권한 회수(revoked)를 받으면 멈추고 알린다", async () => {
    receiver.start();
    await waitFor(() => receiver.isConnected());
    fake.emitSystem({ type: "revoked", data: { eventType: "CHAT", channelId: "owner-channel" } });
    await waitFor(() => revokedCount === 1);
    expect(receiver.isConnected()).toBe(false);
  });
});

describe("reconnectDelayMs", () => {
  it("1초부터 두 배씩 늘리고 30초에서 멈춘다", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- chat`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: 구현**

`apps/server/src/logger.ts`:
```ts
/** 구조화 로그 기록기. 채팅 원문은 절대 넘기지 않는다(식별자만, Global Constraints). */
export interface Logger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

/** 표준 출력에 JSON 한 줄씩 쓴다. launchd가 로그 파일로 모은다. */
export function createConsoleLogger(): Logger {
  const write = (level: string) => (message: string, details?: Record<string, unknown>) =>
    console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...details }));
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

/** 아무것도 쓰지 않는 기록기(테스트용). */
export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** 예외를 로그용 한 줄 문자열로 바꾼다. */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
```

`apps/server/src/chat/chatEvent.ts`:
```ts
import { z } from "zod";

/** 서버가 다루는 채팅 1건. receivedAt은 서버 수신 시각(도배 창 계산에 쓴다). */
export interface ChatEvent {
  channelId: string;
  senderChannelId: string;
  chatChannelId: string;
  nickname: string;
  userRoleCode: string;
  content: string;
  messageTime: number;
  receivedAt: number;
}

/** 시스템 메시지. connected만 sessionKey를 갖는다. */
export type SystemMessage =
  | { type: "connected"; sessionKey: string }
  | { type: "subscribed" | "unsubscribed" | "revoked"; eventType: string; channelId: string };

/** CHAT 이벤트 검증 규칙(문서 필드표). profile·userRoleCode가 빠져도 받아 준다. */
const chatPayloadSchema = z.object({
  channelId: z.string(),
  senderChannelId: z.string(),
  chatChannelId: z.string(),
  profile: z.object({ nickname: z.string() }).nullish(),
  userRoleCode: z.string().default("common_user"),
  content: z.string(),
  messageTime: z.coerce.number(),
});

/** SYSTEM 이벤트 검증 규칙. */
const systemPayloadSchema = z.union([
  z.object({ type: z.literal("connected"), data: z.object({ sessionKey: z.string() }) }),
  z.object({ type: z.enum(["subscribed", "unsubscribed", "revoked"]), data: z.object({ eventType: z.string(), channelId: z.string() }) }),
]);

/** 자동 숨김에서 빼는 역할(스펙 5.2 ①). */
const PRIVILEGED_ROLES: ReadonlySet<string> = new Set(["streamer", "streaming_channel_manager", "streaming_chat_manager"]);

/**
 * CHAT 페이로드를 ChatEvent로 바꾼다. 문자열로 오면 JSON으로 읽는다.
 * @returns 형식이 맞지 않으면 null(호출자가 개수를 센다)
 */
export function parseChatPayload(payload: unknown, receivedAt: number): ChatEvent | null {
  const parsed = chatPayloadSchema.safeParse(decodePayload(payload));
  if (!parsed.success) return null;
  const { profile, ...rest } = parsed.data;
  return { ...rest, nickname: profile?.nickname ?? "(알 수 없음)", receivedAt };
}

/** SYSTEM 페이로드를 SystemMessage로 바꾼다(모르는 형식이면 null). */
export function parseSystemPayload(payload: unknown): SystemMessage | null {
  const parsed = systemPayloadSchema.safeParse(decodePayload(payload));
  if (!parsed.success) return null;
  const message = parsed.data;
  return message.type === "connected" ? { type: "connected", sessionKey: message.data.sessionKey } : { type: message.type, ...message.data };
}

/** 스트리머·매니저 역할인지 확인한다. */
export function isPrivilegedRole(userRoleCode: string): boolean {
  return PRIVILEGED_ROLES.has(userRoleCode);
}

/** 문자열이면 JSON으로 풀고, 깨진 JSON은 검증에서 걸리도록 undefined로 바꾼다. */
function decodePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}
```

`apps/server/src/chat/chatReceiver.ts`:
```ts
import io from "socket.io-client";
import type { ChzzkApi } from "../chzzk/apiClient.js";
import type { TokenManager } from "../connection/tokenManager.js";
import { describeError, type Logger } from "../logger.js";
import type { Clock } from "../time.js";
import { parseChatPayload, parseSystemPayload, type ChatEvent } from "./chatEvent.js";

/** 소켓에서 필요한 기능만 뽑은 형태. 테스트와 실제 socket.io-client를 같은 방식으로 다룬다. */
export interface SocketLike {
  on(event: string, handler: (payload: unknown) => void): unknown;
  close(): unknown;
}

/** 세션 URL로 소켓을 여는 함수. */
export type SocketConnector = (url: string) => SocketLike;

/** 채팅 수신기. */
export interface ChatReceiver {
  start(): void;
  stop(): void;
  isConnected(): boolean;
}

/** createChatReceiver 옵션. */
export interface ChatReceiverOptions {
  api: ChzzkApi;
  tokenManager: TokenManager;
  connect: SocketConnector;
  clock: Clock;
  logger: Logger;
  onChat(event: ChatEvent): void;
  onConnectionChange(connected: boolean): void;
  onInvalidEvent(): void;
  onRevoked(): void;
}

/**
 * 치지직 문서의 연결 옵션 그대로(옛 이름과 2.x 이름을 함께 둔다).
 * 재연결은 끈다. 세션 URL이 일정 시간만 유효해서 재연결할 때마다 새로 받아야 하기 때문이다.
 */
const SOCKET_OPTIONS = {
  reconnection: false,
  "force new connection": true,
  forceNew: true,
  "connect timeout": 3000,
  timeout: 3000,
  transports: ["websocket"],
};

/** socket.io-client 2.0.3으로 세션에 연결한다. */
export const connectWithSocketIo: SocketConnector = (url) =>
  io.connect(url, SOCKET_OPTIONS as SocketIOClient.ConnectOpts) as unknown as SocketLike;

/** 재연결 대기 시간 기본값(1초). */
const BACKOFF_BASE_MS = 1000;
/** 재연결 대기 시간 상한(30초, 스펙 10장). */
const BACKOFF_MAX_MS = 30_000;

/** 지수 백오프: 1, 2, 4, 8, 16, 30, 30… 초. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

/** 채팅 수신기를 만든다. */
export function createChatReceiver(options: ChatReceiverOptions): ChatReceiver {
  return new SessionChatReceiver(options);
}

/** 세션 생성 → 소켓 연결 → connected → 구독 → subscribed 순서로 연결하고, 끊기면 백오프로 다시 시작한다. */
class SessionChatReceiver implements ChatReceiver {
  private socket: SocketLike | null = null;
  private stopped = true;
  private connected = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ChatReceiverOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connectOnce();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.closeSocket();
    this.setConnected(false);
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** 새 세션 URL을 받아 소켓을 연다. 실패하면 재연결을 예약한다. */
  private async connectOnce(): Promise<void> {
    try {
      const url = await this.options.api.createSessionUrl(await this.options.tokenManager.getAccessToken());
      if (this.stopped) return;
      this.attachSocket(this.options.connect(url));
    } catch (error) {
      this.options.logger.warn("채팅 세션 생성 실패, 다시 시도합니다", { error: describeError(error) });
      this.scheduleReconnect();
    }
  }

  /** 소켓 이벤트를 연결한다. */
  private attachSocket(socket: SocketLike): void {
    this.socket = socket;
    socket.on("SYSTEM", (payload) => void this.handleSystem(payload));
    socket.on("CHAT", (payload) => this.handleChat(payload));
    for (const event of ["disconnect", "connect_error", "connect_timeout", "error"]) {
      socket.on(event, () => this.handleDrop(event));
    }
  }

  /** 시스템 메시지 처리. */
  private async handleSystem(payload: unknown): Promise<void> {
    const message = parseSystemPayload(payload);
    if (message?.type === "connected") await this.subscribe(message.sessionKey);
    else if (message?.type === "subscribed") this.markConnected();
    else if (message?.type === "revoked") this.handleRevoked();
  }

  /** sessionKey로 채팅 이벤트를 구독한다. 실패하면 연결을 버리고 다시 시작한다. */
  private async subscribe(sessionKey: string): Promise<void> {
    try {
      await this.options.api.subscribeChat(await this.options.tokenManager.getAccessToken(), sessionKey);
    } catch (error) {
      this.options.logger.warn("채팅 구독 실패, 다시 연결합니다", { error: describeError(error) });
      this.handleDrop("subscribe_failed");
    }
  }

  /** 구독 완료. 백오프 단계를 처음으로 돌린다. */
  private markConnected(): void {
    this.attempt = 0;
    this.setConnected(true);
  }

  /** 채팅 이벤트를 검증해 넘기고, 형식이 틀리면 개수만 센다(원문은 로그에 남기지 않는다). */
  private handleChat(payload: unknown): void {
    const event = parseChatPayload(payload, this.options.clock());
    if (event) this.options.onChat(event);
    else this.options.onInvalidEvent();
  }

  /** 권한 회수: 다시 연결해도 소용없으므로 멈추고 알린다. */
  private handleRevoked(): void {
    this.options.logger.warn("치지직이 채팅 이벤트 권한을 회수했습니다. 스트리머가 다시 연결해야 합니다");
    this.stop();
    this.options.onRevoked();
  }

  /** 연결이 끊긴 경우: 소켓을 버리고 재연결을 예약한다. */
  private handleDrop(reason: string): void {
    if (this.stopped) return;
    this.options.logger.info("채팅 연결이 끊겼습니다", { reason });
    this.closeSocket();
    this.setConnected(false);
    this.scheduleReconnect();
  }

  /** 백오프 시간 뒤 다시 연결한다. 이미 예약돼 있으면 아무것도 하지 않는다. */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = reconnectDelayMs(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOnce();
    }, delay);
  }

  /** 예약된 재연결을 취소한다. */
  private clearTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** 소켓을 닫는다. 먼저 참조를 비워 close가 일으키는 disconnect 이벤트가 되돌아오지 않게 한다. */
  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  /** 연결 상태를 바꾸고, 바뀌었을 때만 알린다. */
  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.options.onConnectionChange(connected);
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- chat`
Expected: PASS (10 tests)

- [ ] **Step 6: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/logger.ts apps/server/src/chat apps/server/test/chat apps/server/package.json package-lock.json
git commit -m "feat: 치지직 Session API 채팅 수신 추가" -m "socket.io-client 2.0.3으로 세션에 연결해 채팅을 구독하고, 끊기면 새 세션 URL로 1~30초 백오프 재연결한다. 형식이 다른 이벤트는 버리고 개수만 센다."
```

---

### Task 8: 비교용 정규화

**Files:**
- Create: `apps/server/src/detection/normalize.ts`
- Test: `apps/server/test/detection/normalize.test.ts`

**Interfaces:**
- Produces: `normalizeForMatching(text: string): string`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/detection/normalize.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizeForMatching } from "../../src/detection/normalize.js";

describe("normalizeForMatching", () => {
  it.each([
    ["공백·특수문자를 지운다", "씨@발 방송 꺼라", "씨발방송꺼라"],
    ["제로폭 문자를 지운다", "씨​발", "씨발"],
    ["전각 영문을 반각 소문자로", "ＳＩＢＡＬ", "sibal"],
    ["흩어진 자모를 조합한다", "시 ㅂ ㅏ", "시바"],
    ["자음 뒤 숫자 1은 모음 ㅣ로 본다", "ㅅ1발 진짜", "시발진짜"],
    ["음절 사이에 끼운 1은 지운다", "병1신", "병신"],
    ["3번 이상 반복은 2번으로 줄인다", "ㅋㅋㅋㅋㅋㅋ", "ㅋㅋ"],
    ["자음만 있는 표기는 그대로", "ㅂㅅ같이 하네", "ㅂㅅ같이하네"],
    ["오탐 단어도 모양은 그대로 둔다(예외 단어로 처리)", "시발점", "시발점"],
    ["음절과 숫자 사이의 숫자는 그대로", "구독자 1000명", "구독자1000명"],
    ["이모티콘만 있으면 빈 문자열", "😀😀", ""],
  ])("%s", (_name, input, expected) => {
    expect(normalizeForMatching(input)).toBe(expected);
  });
});
```


- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- normalize`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/server/src/detection/normalize.ts`:
```ts
/** 글자 사이에 끼워 필터를 피하는 데 쓰는 제로폭·서식 문자. */
const INVISIBLE_CHARACTERS = /[­​-‏⁠-⁤﻿]/g;
/** 전각 ASCII 영역(！~～). 반각으로 바꾼다. */
const FULLWIDTH_ASCII = /[！-～]/g;
/** 남길 문자: 한글(음절·자모), 영문 소문자, 숫자, 그리고 모음 대용으로 쓰는 '|'. */
const DISALLOWED_CHARACTERS = /[^\p{Script=Hangul}a-z0-9|]/gu;
/** 자음 자모 바로 뒤의 1·l·|은 모음 'ㅣ'로 쓰인 것이다(예: ㅅ1발). */
const VOWEL_LOOKALIKE_AFTER_CONSONANT = /(?<=[ㄱ-ㅎ])[1l|]/g;
/** 두 음절 사이에 끼운 1·l·|은 채워 넣은 잡음이다(예: 병1신). */
const FILLER_BETWEEN_SYLLABLES = /(?<=[가-힣])[1l|]+(?=[가-힣])/g;
/** 같은 글자 3번 이상 반복. */
const REPEATED_CHARACTERS = /(.)\1{2,}/gu;

/** 초성 순서(유니코드 음절 조합 공식의 순서). */
const CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
/** 중성 순서. */
const JUNGSEONG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
/** 종성 순서. 0번(받침 없음) 자리는 비워 둔다. */
const JONGSEONG = "\u0000ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";

/**
 * 금칙어 비교용 문자열을 만든다. 표시용이 아니다.
 * 순서: NFC → 제로폭 제거 → 전각→반각 → 소문자 → 허용 문자만 → 모음 대용 1 → 잡음 1 제거 → 자모 조합 → 반복 축약.
 */
export function normalizeForMatching(text: string): string {
  const cleaned = text
    .normalize("NFC")
    .replace(INVISIBLE_CHARACTERS, "")
    .replace(FULLWIDTH_ASCII, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(DISALLOWED_CHARACTERS, "");
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

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- normalize`
Expected: PASS (11 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/detection/normalize.ts apps/server/test/detection/normalize.test.ts
git commit -m "feat: 금칙어 비교용 정규화 추가" -m "제로폭·전각·특수문자·자모 분리·모음 대용 숫자·반복 글자로 우회하는 표기를 같은 형태로 맞춘다."
```

---

### Task 9: 규칙 저장소·기본 규칙·단어 일치

**Files:**
- Create: `apps/server/src/detection/defaultRules.ts`, `apps/server/src/detection/ruleRepository.ts`, `apps/server/src/detection/wordMatch.ts`
- Test: `apps/server/test/detection/ruleRepository.test.ts`, `apps/server/test/detection/wordMatch.test.ts`

**Interfaces:**
- Consumes: `Database`, `Clock`, `normalizeForMatching`(Task 8), `RuleKind`·`RuleEntryDto`(shared)
- Produces: `DEFAULT_RULES`, `class RuleValidationError extends Error`, `interface RuleEntry extends RuleEntryDto { normalizedPattern: string }`, `interface RuleSnapshot { strong; weak; exception; threat; keywordRoute: readonly RuleEntry[]; allow: ReadonlySet<string>; allowDomains: readonly string[] }`, `interface RuleRepository { list(channelId): RuleEntryDto[]; add(channelId, kind, pattern, createdBy): RuleEntryDto; remove(channelId, id): boolean; seedDefaults(channelId): void; snapshot(channelId): RuleSnapshot }`, `createRuleRepository(database, clock)`, `stripExceptions(normalizedText, exceptions): string`, `findFirstMatch(normalizedText, entries): RuleEntry | null`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/detection/wordMatch.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { RuleEntry } from "../../src/detection/ruleRepository.js";
import { findFirstMatch, stripExceptions } from "../../src/detection/wordMatch.js";

/** 테스트용 규칙 항목. */
function entry(id: number, normalizedPattern: string): RuleEntry {
  return { id, kind: "weak", pattern: normalizedPattern, normalizedPattern, createdBy: "test", createdAt: 0 };
}

describe("wordMatch", () => {
  it("예외 단어를 지운 뒤 금칙어를 찾는다", () => {
    const exceptions = [entry(1, "시발점")];
    expect(findFirstMatch(stripExceptions("여기가시발점이야", exceptions), [entry(2, "시발")])).toBeNull();
    expect(findFirstMatch(stripExceptions("시발점이야시발", exceptions), [entry(2, "시발")])?.id).toBe(2);
  });

  it("목록 순서대로 첫 일치를 돌려준다", () => {
    expect(findFirstMatch("ㅂㅅ같이", [entry(3, "병신"), entry(4, "ㅂㅅ")])?.id).toBe(4);
  });
});
```

`apps/server/test/detection/ruleRepository.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { DEFAULT_RULES } from "../../src/detection/defaultRules.js";
import { createRuleRepository, RuleValidationError } from "../../src/detection/ruleRepository.js";

/** 채널 1개가 있는 저장소. */
function createRepository() {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
  return createRuleRepository(database, () => 42);
}

describe("RuleRepository", () => {
  it("추가·조회·삭제한다", () => {
    const repository = createRepository();
    const added = repository.add("c1", "weak", " 씨 발 ", "manager-1");
    expect(added).toMatchObject({ kind: "weak", pattern: "씨 발", createdBy: "manager-1", createdAt: 42 });
    expect(repository.list("c1")).toHaveLength(1);
    expect(repository.remove("c1", added.id)).toBe(true);
    expect(repository.remove("c1", added.id)).toBe(false);
  });

  it("비교용으로 정규화한 패턴을 스냅숏에 담고, 바뀌면 다시 만든다", () => {
    const repository = createRepository();
    repository.add("c1", "weak", "씨 발", "m");
    expect(repository.snapshot("c1").weak.map((rule) => rule.normalizedPattern)).toEqual(["씨발"]);
    repository.add("c1", "allow", "적팀 죽여버려!!", "m");
    repository.add("c1", "allow_domain", "https://www.YouTube.com/", "m");
    const snapshot = repository.snapshot("c1");
    expect(snapshot.allow.has("적팀죽여버려")).toBe(true);
    expect(snapshot.allowDomains).toEqual(["youtube.com"]);
  });

  it("빈 패턴·너무 긴 패턴·중복을 거부한다", () => {
    const repository = createRepository();
    expect(() => repository.add("c1", "weak", "!!!", "m")).toThrow(RuleValidationError);
    expect(() => repository.add("c1", "weak", "가".repeat(51), "m")).toThrow(/50자/);
    repository.add("c1", "weak", "바보", "m");
    expect(() => repository.add("c1", "weak", "바보", "m")).toThrow(/이미 있는/);
  });

  it("기본 규칙을 한 번만 넣는다", () => {
    const repository = createRepository();
    repository.seedDefaults("c1");
    repository.seedDefaults("c1");
    expect(repository.list("c1")).toHaveLength(DEFAULT_RULES.length);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- wordMatch ruleRepository`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/server/src/detection/defaultRules.ts`:
```ts
import type { RuleKind } from "@zzirit-guard/shared";

/**
 * 저장소에 두는 최소 기본 규칙. 공개 저장소라 목록이 길면 우회 연구에 쓰이므로 최소한만 둔다.
 * 실제 운영 목록은 채널 DB에서 매니저가 늘리고 줄인다(스펙 17장).
 * - strong: 정상 대화에서 거의 쓰지 않는 혐오 표현·패드립 → 스위치가 켜져 있으면 자동 숨김
 * - weak: 감탄사로도 쓰이는 일반 욕설 → 사람이 판단하는 후보
 * - exception: 금칙어를 포함하지만 정상인 단어
 * - threat: 협박 표현 → 후보
 */
export const DEFAULT_RULES: ReadonlyArray<{ kind: RuleKind; pattern: string }> = [
  { kind: "strong", pattern: "니애미" },
  { kind: "strong", pattern: "느금마" },
  { kind: "strong", pattern: "한남충" },
  { kind: "strong", pattern: "김치녀" },
  { kind: "strong", pattern: "홍어" },
  { kind: "strong", pattern: "틀딱" },
  { kind: "strong", pattern: "짱깨" },
  { kind: "weak", pattern: "씨발" },
  { kind: "weak", pattern: "시발" },
  { kind: "weak", pattern: "ㅅㅂ" },
  { kind: "weak", pattern: "병신" },
  { kind: "weak", pattern: "ㅂㅅ" },
  { kind: "weak", pattern: "개새끼" },
  { kind: "exception", pattern: "시발점" },
  { kind: "exception", pattern: "시발택시" },
  { kind: "threat", pattern: "찾아간다" },
  { kind: "threat", pattern: "찾아갈게" },
  { kind: "threat", pattern: "칼들고" },
  { kind: "threat", pattern: "집주소" },
  { kind: "threat", pattern: "신상털" },
];
```

`apps/server/src/detection/wordMatch.ts`:
```ts
import type { RuleEntry } from "./ruleRepository.js";

/**
 * 예외 단어를 지운다. "시발점"처럼 금칙어를 품은 정상 단어가 걸리지 않게 하려는 것이다.
 * @param normalizedText normalizeForMatching을 거친 문장
 */
export function stripExceptions(normalizedText: string, exceptions: readonly RuleEntry[]): string {
  return exceptions.reduce((text, exception) => text.split(exception.normalizedPattern).join(""), normalizedText);
}

/** 정규화한 문장에 포함된 첫 번째 규칙(목록 순서)을 찾는다. */
export function findFirstMatch(normalizedText: string, entries: readonly RuleEntry[]): RuleEntry | null {
  return entries.find((entry) => normalizedText.includes(entry.normalizedPattern)) ?? null;
}
```

`apps/server/src/detection/ruleRepository.ts`:
```ts
import type { RuleEntryDto, RuleKind } from "@zzirit-guard/shared";
import type { Database } from "../db/database.js";
import type { Clock } from "../time.js";
import { DEFAULT_RULES } from "./defaultRules.js";
import { normalizeForMatching } from "./normalize.js";

/** 사용자 입력 규칙이 잘못된 경우. 메시지를 그대로 매니저에게 보여 준다. */
export class RuleValidationError extends Error {
  override readonly name = "RuleValidationError";
}

/** 비교용 패턴을 함께 가진 규칙. */
export interface RuleEntry extends RuleEntryDto {
  normalizedPattern: string;
}

/** 판정 파이프라인이 메시지마다 읽는 규칙 묶음. 바뀔 때만 다시 만든다. */
export interface RuleSnapshot {
  strong: readonly RuleEntry[];
  weak: readonly RuleEntry[];
  exception: readonly RuleEntry[];
  threat: readonly RuleEntry[];
  keywordRoute: readonly RuleEntry[];
  allow: ReadonlySet<string>;
  allowDomains: readonly string[];
}

/** 채널 규칙 저장소. */
export interface RuleRepository {
  list(channelId: string): RuleEntryDto[];
  add(channelId: string, kind: RuleKind, pattern: string, createdBy: string): RuleEntryDto;
  remove(channelId: string, id: number): boolean;
  seedDefaults(channelId: string): void;
  snapshot(channelId: string): RuleSnapshot;
}

/** 패턴 최대 길이. 지나치게 긴 패턴은 실수일 가능성이 높다. */
const MAX_PATTERN_LENGTH = 50;

/** rule_entry 행. */
interface RuleRow {
  id: number;
  kind: RuleKind;
  pattern: string;
  created_by: string;
  created_at: number;
}

/** SQLite 기반 규칙 저장소를 만든다. 스냅숏은 채널별로 캐시하고 변경 시 버린다. */
export function createRuleRepository(database: Database, clock: Clock): RuleRepository {
  const cache = new Map<string, RuleSnapshot>();
  return {
    list: (channelId) => selectRows(database, channelId).map(toDto),
    add: (channelId, kind, pattern, createdBy) => {
      const added = insertRule(database, channelId, kind, pattern.trim(), createdBy, clock());
      cache.delete(channelId);
      return added;
    },
    remove: (channelId, id) => {
      cache.delete(channelId);
      return database.prepare("DELETE FROM rule_entry WHERE channel_id = ? AND id = ?").run(channelId, id).changes > 0;
    },
    seedDefaults: (channelId) => {
      seedDefaults(database, channelId, clock());
      cache.delete(channelId);
    },
    snapshot: (channelId) => cachedSnapshot(cache, channelId, () => buildSnapshot(selectRows(database, channelId))),
  };
}

/** 캐시에 있으면 그대로, 없으면 만들어 넣는다. */
function cachedSnapshot(cache: Map<string, RuleSnapshot>, channelId: string, build: () => RuleSnapshot): RuleSnapshot {
  const cached = cache.get(channelId) ?? build();
  cache.set(channelId, cached);
  return cached;
}

/** 채널의 규칙 행을 id 순서로 읽는다. */
function selectRows(database: Database, channelId: string): RuleRow[] {
  return database.prepare("SELECT id, kind, pattern, created_by, created_at FROM rule_entry WHERE channel_id = ? ORDER BY id").all(channelId) as RuleRow[];
}

/** 검증 후 규칙을 넣는다. 중복은 UNIQUE 제약에서 걸러 알기 쉬운 메시지로 바꾼다. */
function insertRule(database: Database, channelId: string, kind: RuleKind, pattern: string, createdBy: string, now: number): RuleEntryDto {
  validatePattern(kind, pattern);
  try {
    const result = database
      .prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(channelId, kind, pattern, createdBy, now);
    return { id: Number(result.lastInsertRowid), kind, pattern, createdBy, createdAt: now };
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new RuleValidationError(`이미 있는 규칙입니다: ${pattern}`);
    throw error;
  }
}

/** 길이와 비교용 결과가 비지 않는지 확인한다. */
function validatePattern(kind: RuleKind, pattern: string): void {
  if (pattern.length > MAX_PATTERN_LENGTH) throw new RuleValidationError(`규칙은 ${MAX_PATTERN_LENGTH}자 이하로 입력하세요.`);
  if (!normalizePattern(kind, pattern)) {
    throw new RuleValidationError("규칙이 비었습니다. 특수문자·공백만으로는 규칙을 만들 수 없습니다.");
  }
}

/** 기본 규칙 중 아직 없는 것만 넣는다. */
function seedDefaults(database: Database, channelId: string, now: number): void {
  const insert = database.prepare(
    "INSERT OR IGNORE INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES (?, ?, ?, 'default', ?)",
  );
  database.transaction(() => DEFAULT_RULES.forEach((rule) => insert.run(channelId, rule.kind, rule.pattern, now)))();
}

/** 종류별 비교용 패턴. 도메인은 소문자·scheme·www 제거, 나머지는 금칙어 정규화. */
function normalizePattern(kind: RuleKind, pattern: string): string {
  if (kind !== "allow_domain") return normalizeForMatching(pattern);
  return pattern.toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
}

/** 행을 DTO로 바꾼다. */
function toDto(row: RuleRow): RuleEntryDto {
  return { id: row.id, kind: row.kind, pattern: row.pattern, createdBy: row.created_by, createdAt: row.created_at };
}

/** 행 목록을 종류별 스냅숏으로 묶는다. */
function buildSnapshot(rows: readonly RuleRow[]): RuleSnapshot {
  const entries = rows.map((row) => ({ ...toDto(row), normalizedPattern: normalizePattern(row.kind, row.pattern) }));
  const ofKind = (kind: RuleKind) => entries.filter((entry) => entry.kind === kind);
  return {
    strong: ofKind("strong"),
    weak: ofKind("weak"),
    exception: ofKind("exception"),
    threat: ofKind("threat"),
    keywordRoute: ofKind("keyword_route"),
    allow: new Set(ofKind("allow").map((entry) => entry.normalizedPattern)),
    allowDomains: ofKind("allow_domain").map((entry) => entry.normalizedPattern),
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- wordMatch ruleRepository`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/detection/defaultRules.ts apps/server/src/detection/ruleRepository.ts apps/server/src/detection/wordMatch.ts apps/server/test/detection/ruleRepository.test.ts apps/server/test/detection/wordMatch.test.ts
git commit -m "feat: 채널 규칙 저장소와 기본 규칙 추가" -m "규칙을 비교용으로 정규화해 스냅숏으로 캐시하고, 시발점 같은 정상 단어는 예외 단어로 빼고 비교한다."
```

---

### Task 10: 링크·전화번호·주소 패턴

**Files:**
- Create: `apps/server/src/detection/patterns.ts`
- Test: `apps/server/test/detection/patterns.test.ts`

**Interfaces:**
- Produces: `containsBlockedLink(text: string, allowDomains: readonly string[]): boolean`, `containsPhoneNumber(text: string): boolean`, `looksLikeAddress(text: string): boolean`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/detection/patterns.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { containsBlockedLink, containsPhoneNumber, looksLikeAddress } from "../../src/detection/patterns.js";

describe("containsBlockedLink", () => {
  it.each([
    "무료 치킨 쿠폰 받기 👉 bit.ly/free-chk",
    "카지노 사이트 추천 www.xx-casino.com",
    "https://open.kakao.com/o/abcd 들어와",
    "t.me/spamroom",
    "토토 신규가입 3만 포인트 지급 텔레 @abc123",
    "텔레그램 abcd1234 연락",
  ])("광고·링크를 잡는다: %s", (text) => {
    expect(containsBlockedLink(text, [])).toBe(true);
  });

  it.each(["오늘 3.5시간 방송함", "ver.2 패치 좋네", "다음 판은 원딜 해주세요", "토토로 귀엽다"])("일반 대화는 통과: %s", (text) => {
    expect(containsBlockedLink(text, [])).toBe(false);
  });

  it("허용 도메인과 그 하위 도메인은 통과", () => {
    expect(containsBlockedLink("https://www.youtube.com/watch?v=1", ["youtube.com"])).toBe(false);
    expect(containsBlockedLink("m.youtube.com/abc", ["youtube.com"])).toBe(false);
    expect(containsBlockedLink("fakeyoutube.com/abc", ["youtube.com"])).toBe(true);
  });
});

describe("containsPhoneNumber", () => {
  it.each(["010-1234-5678 이 번호로", "01012345678", "010 1234 5678", "011.123.4567"])("잡는다: %s", (text) => {
    expect(containsPhoneNumber(text)).toBe(true);
  });
  it.each(["구독자 1000명", "2026-10-11 방송", "0101234567890123"])("통과: %s", (text) => {
    expect(containsPhoneNumber(text)).toBe(false);
  });
});

describe("looksLikeAddress", () => {
  it.each(["얘 실명 김민수고 분당 정자동 OO아파트 산다", "101동 1203호 맞지?", "역삼동 래미안 아파트"])("잡는다: %s", (text) => {
    expect(looksLikeAddress(text)).toBe(true);
  });
  it.each(["오후 3시로 10분 미뤄요", "동네 친구랑 봄", "아파트 게임 재밌다"])("통과: %s", (text) => {
    expect(looksLikeAddress(text)).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- patterns`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/server/src/detection/patterns.ts`:
```ts
/**
 * 도메인 모양의 문자열. 흔한 최상위 도메인만 보고, 숫자 버전 표기(ver.2)나 소수(3.5)는 걸리지 않게 한다.
 * 1번 그룹이 호스트 이름이다.
 */
const DOMAIN_PATTERN =
  /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+(?:com|net|org|kr|io|me|ly|gg|xyz|co|tv|app|link|site|shop|top|info|biz|cc|to|kim|vip))(?![a-z0-9-])/gi;
/** "텔레 @아이디", "텔레그램 아이디" 같은 연락처 유도. */
const TELEGRAM_HANDLE_PATTERN = /텔레(?:그램)?\s*[:@]?\s*@?[a-z0-9_]{4,}/i;
/** 도박 관련 단어. 단독으로는 대화일 수 있어(예: 토토로) 연락 유도와 함께일 때만 본다. */
const GAMBLING_PATTERN = /토토(?!로)|카지노|바카라|슬롯|홀덤|먹튀/;
/** 연락·가입 유도 표현. */
const CONTACT_PATTERN = /텔레|카톡|디엠|dm|문의|가입|@/i;
/** 휴대전화 번호(010·011·016·017·018·019 + 7~8자리, 구분자 공백·점·하이픈). 앞뒤에 숫자가 더 붙으면 제외. */
const PHONE_PATTERN = /(?<!\d)01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}(?!\d)/;
/** "○○동 … 아파트/빌라/오피스텔/맨션" 형태. */
const NEIGHBORHOOD_BUILDING_PATTERN = /[가-힣]+(?:동|읍|면|리)\s+\S*\s*(?:아파트|빌라|오피스텔|맨션)/;
/** "101동 1203호" 형태. */
const UNIT_NUMBER_PATTERN = /\d+\s*동\s*\d+\s*호/;

/**
 * 광고·외부 링크·연락처 유도가 있는지 본다(스펙 5.2 광고 링크 규칙).
 * @param allowDomains 채널이 허용한 도메인(소문자, www 제거). 하위 도메인까지 허용한다.
 */
export function containsBlockedLink(text: string, allowDomains: readonly string[]): boolean {
  const hosts = [...text.matchAll(DOMAIN_PATTERN)].map((match) => (match[1] ?? "").toLowerCase().replace(/^www\./, ""));
  if (hosts.some((host) => !isAllowedHost(host, allowDomains))) return true;
  if (TELEGRAM_HANDLE_PATTERN.test(text)) return true;
  return GAMBLING_PATTERN.test(text) && CONTACT_PATTERN.test(text);
}

/** 호스트가 허용 도메인이거나 그 하위 도메인인지 본다("fakeyoutube.com"은 허용하지 않는다). */
function isAllowedHost(host: string, allowDomains: readonly string[]): boolean {
  return allowDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** 휴대전화 번호가 있는지 본다(신상 노출 방지). */
export function containsPhoneNumber(text: string): boolean {
  return PHONE_PATTERN.test(text);
}

/** 주소처럼 보이는 표현이 있는지 본다. 오탐이 있을 수 있어 후보로만 쓴다. */
export function looksLikeAddress(text: string): boolean {
  return NEIGHBORHOOD_BUILDING_PATTERN.test(text) || UNIT_NUMBER_PATTERN.test(text);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- patterns`
Expected: PASS (24 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/detection/patterns.ts apps/server/test/detection/patterns.test.ts
git commit -m "feat: 광고 링크·전화번호·주소 패턴 추가" -m "허용 도메인과 하위 도메인은 통과시키고, 도박 단어는 연락 유도와 함께일 때만 광고로 본다."
```

---

### Task 11: 떼도배·개인 도배 감지

**Files:**
- Create: `apps/server/src/detection/floodDetectors.ts`
- Test: `apps/server/test/detection/floodDetectors.test.ts`

**Interfaces:**
- Produces: `interface MessageRef { chatChannelId; messageTime; senderChannelId; nickname; content; privileged: boolean }`, `interface GroupFloodObservation { triggered: boolean; earlierRefs: MessageRef[] }`, `interface GroupFloodDetector { observe(normalized: string, ref: MessageRef, receivedAt: number): GroupFloodObservation }`, `createGroupFloodDetector(options?: { windowMs?; minDistinctUsers?; minLength? })`, `interface PersonalFloodDetector { observe(senderChannelId: string, receivedAt: number): boolean }`, `createPersonalFloodDetector(options?: { windowMs?; maxMessages? })`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/detection/floodDetectors.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createGroupFloodDetector, createPersonalFloodDetector, type MessageRef } from "../../src/detection/floodDetectors.js";

/** 사용자 번호로 만든 메시지 참조. messageTime은 일부러 뒤죽박죽으로 둔다. */
function ref(user: number, messageTime = 1_000 - user): MessageRef {
  return { chatChannelId: "chat-1", messageTime, senderChannelId: `user-${user}`, nickname: `u${user}`, content: "복붙 도배 문장입니다아아", privileged: false };
}

/** 길이 10자 이상인 정규화 문장. */
const LONG_TEXT = "복붙도배문장입니다아아";

describe("GroupFloodDetector", () => {
  it("10초 안에 서로 다른 5명이 같은 문장을 보내면 앞선 4건까지 돌려준다", () => {
    const detector = createGroupFloodDetector();
    for (let user = 1; user <= 4; user += 1) expect(detector.observe(LONG_TEXT, ref(user), user * 1_000).triggered).toBe(false);
    const fifth = detector.observe(LONG_TEXT, ref(5), 5_000);
    expect(fifth.triggered).toBe(true);
    expect(fifth.earlierRefs.map((item) => item.senderChannelId)).toEqual(["user-1", "user-2", "user-3", "user-4"]);
    const sixth = detector.observe(LONG_TEXT, ref(6), 6_000);
    expect(sixth).toEqual({ triggered: true, earlierRefs: [] });
  });

  it("같은 사람이 반복한 것은 1명으로 센다", () => {
    const detector = createGroupFloodDetector();
    for (let index = 0; index < 6; index += 1) expect(detector.observe(LONG_TEXT, ref(1), index * 100).triggered).toBe(false);
  });

  it("10자 미만(ㅋㅋㅋ, GG 같은 집단 반응)은 보지 않는다", () => {
    const detector = createGroupFloodDetector();
    for (let user = 1; user <= 10; user += 1) expect(detector.observe("ㅋㅋ", ref(user), user).triggered).toBe(false);
  });

  it("창은 서버 수신 시각 기준이라, messageTime이 어긋나도 10초가 지나면 센 것을 잊는다", () => {
    const detector = createGroupFloodDetector();
    for (let user = 1; user <= 4; user += 1) detector.observe(LONG_TEXT, ref(user, 9_999_999), user * 1_000);
    expect(detector.observe(LONG_TEXT, ref(5, 0), 15_000).triggered).toBe(false);
  });
});

describe("PersonalFloodDetector", () => {
  it("한 사람이 10초 안에 5건째 보내면 참", () => {
    const detector = createPersonalFloodDetector();
    const results = [0, 1_000, 2_000, 3_000, 4_000].map((time) => detector.observe("user-1", time));
    expect(results).toEqual([false, false, false, false, true]);
    expect(detector.observe("user-2", 4_000)).toBe(false);
    expect(detector.observe("user-1", 20_000)).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- floodDetectors`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/server/src/detection/floodDetectors.ts`:
```ts
/** 숨기기에 필요한 메시지 식별값과 화면 표시용 정보. privileged는 스트리머·매니저 여부다. */
export interface MessageRef {
  chatChannelId: string;
  messageTime: number;
  senderChannelId: string;
  nickname: string;
  content: string;
  privileged: boolean;
}

/** 떼도배 관측 결과. earlierRefs는 이번에 처음 조건을 넘었을 때 함께 숨길 앞선 메시지들이다. */
export interface GroupFloodObservation {
  triggered: boolean;
  earlierRefs: MessageRef[];
}

/** 떼도배(여러 사람이 같은 문장 반복) 감지기. */
export interface GroupFloodDetector {
  observe(normalized: string, ref: MessageRef, receivedAt: number): GroupFloodObservation;
}

/** 개인 도배(한 사람이 짧은 시간에 여러 번) 감지기. */
export interface PersonalFloodDetector {
  observe(senderChannelId: string, receivedAt: number): boolean;
}

/** 떼도배 기본값: 10초, 5명, 10자(스펙 5.2). */
const GROUP_DEFAULTS = { windowMs: 10_000, minDistinctUsers: 5, minLength: 10 };
/** 개인 도배 기본값: 10초 안 5건. */
const PERSONAL_DEFAULTS = { windowMs: 10_000, maxMessages: 5 };
/** 이만큼 관측할 때마다 오래된 키를 정리해 메모리가 늘지 않게 한다. */
const SWEEP_EVERY_OBSERVATIONS = 1_000;

/** 창 안의 관측 1건. reported는 이미 숨김 대상으로 넘긴 것인지다. */
interface GroupEntry {
  ref: MessageRef;
  receivedAt: number;
  reported: boolean;
}

/** 떼도배 감지기를 만든다. 창은 서버 수신 시각으로 계산한다(치지직 시각은 어긋날 수 있다). */
export function createGroupFloodDetector(options: Partial<typeof GROUP_DEFAULTS> = {}): GroupFloodDetector {
  const settings = { ...GROUP_DEFAULTS, ...options };
  const entriesByText = new Map<string, GroupEntry[]>();
  let observations = 0;
  return {
    observe(normalized, ref, receivedAt) {
      if (normalized.length < settings.minLength) return { triggered: false, earlierRefs: [] };
      observations += 1;
      if (observations % SWEEP_EVERY_OBSERVATIONS === 0) sweep(entriesByText, receivedAt - settings.windowMs);
      const entries = withinWindow(entriesByText.get(normalized), receivedAt - settings.windowMs);
      entries.push({ ref, receivedAt, reported: false });
      entriesByText.set(normalized, entries);
      return evaluateGroup(entries, settings.minDistinctUsers);
    },
  };
}

/** 창 밖(cutoff 이전) 항목을 버린다. */
function withinWindow(entries: GroupEntry[] | undefined, cutoff: number): GroupEntry[] {
  return (entries ?? []).filter((entry) => entry.receivedAt > cutoff);
}

/** 서로 다른 사용자 수가 기준 이상이면, 아직 넘기지 않은 앞선 메시지를 모아 돌려준다. */
function evaluateGroup(entries: GroupEntry[], minDistinctUsers: number): GroupFloodObservation {
  const distinctUsers = new Set(entries.map((entry) => entry.ref.senderChannelId)).size;
  if (distinctUsers < minDistinctUsers) return { triggered: false, earlierRefs: [] };
  const current = entries[entries.length - 1] as GroupEntry;
  const earlierRefs = entries.filter((entry) => entry !== current && !entry.reported).map((entry) => entry.ref);
  entries.forEach((entry) => (entry.reported = true));
  return { triggered: true, earlierRefs };
}

/** 오래된 키를 지운다. */
function sweep(entriesByText: Map<string, GroupEntry[]>, cutoff: number): void {
  for (const [text, entries] of entriesByText) {
    const remaining = withinWindow(entries, cutoff);
    if (remaining.length === 0) entriesByText.delete(text);
    else entriesByText.set(text, remaining);
  }
}

/** 개인 도배 감지기를 만든다. */
export function createPersonalFloodDetector(options: Partial<typeof PERSONAL_DEFAULTS> = {}): PersonalFloodDetector {
  const settings = { ...PERSONAL_DEFAULTS, ...options };
  const timesBySender = new Map<string, number[]>();
  let observations = 0;
  return {
    observe(senderChannelId, receivedAt) {
      observations += 1;
      if (observations % SWEEP_EVERY_OBSERVATIONS === 0) sweepTimes(timesBySender, receivedAt - settings.windowMs);
      const times = (timesBySender.get(senderChannelId) ?? []).filter((time) => time > receivedAt - settings.windowMs);
      times.push(receivedAt);
      timesBySender.set(senderChannelId, times);
      return times.length >= settings.maxMessages;
    },
  };
}

/** 창 밖 시각만 남은 사용자를 지운다. */
function sweepTimes(timesBySender: Map<string, number[]>, cutoff: number): void {
  for (const [sender, times] of timesBySender) {
    if (times.every((time) => time <= cutoff)) timesBySender.delete(sender);
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- floodDetectors`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/detection/floodDetectors.ts apps/server/test/detection/floodDetectors.test.ts
git commit -m "feat: 떼도배·개인 도배 감지 추가" -m "떼도배는 10자 이상 같은 문장을 10초 안에 5명이 보낼 때 앞선 메시지까지 넘기고, 창은 서버 수신 시각으로 계산한다."
```

---

### Task 12: 판정·감사 기록·분당 통계 저장소

**Files:**
- Create: `apps/server/src/records/verdictRepository.ts`, `apps/server/src/records/auditLog.ts`, `apps/server/src/records/minuteStats.ts`
- Test: `apps/server/test/records/records.test.ts`

**Interfaces:**
- Consumes: `Database`, `Clock`, `floorToMinute`, shared 타입
- Produces: `interface NewVerdict { channelId; chatChannelId; messageTime; senderChannelId; senderNickname; content; decision: Exclude<Decision, "pass">; reason; unsafeProbability?: number | null; category?: string | null }`, `interface VerdictRepository { insert(verdict: NewVerdict): VerdictDto; updateStatus(id: number, status: VerdictStatus): void; get(id: number): (VerdictDto & { channelId: string }) | null; listRecent(channelId: string, sinceMs: number): VerdictDto[]; deleteOlderThan(cutoffMs: number): number }`, `createVerdictRepository(database, clock)`; `interface AuditRecord { channelId; actorType: "manager" | "rule" | "system"; actorChannelId: string | null; action: string; targetSenderChannelId: string | null; verdictId: number | null; result: "ok" | "error"; error: string | null }`, `interface AuditLog { record(entry: AuditRecord): void; list(channelId, limit, beforeId: number | null): AuditEntryDto[]; hasEnforcedAction(channelId, senderChannelId, sinceMs): boolean; deleteOlderThan(cutoffMs): number }`, `createAuditLog(database, clock)`; `type StatField`, `STAT_FIELDS`, `interface MinuteStats { increment(channelId, field, amount?): void; flush(): void; recent(channelId, sinceMs): Array<{ minute: number } & Record<StatField, number>> }`, `createMinuteStats(database, clock)`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/records/records.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createAuditLog } from "../../src/records/auditLog.js";
import { createMinuteStats } from "../../src/records/minuteStats.js";
import { createVerdictRepository, type NewVerdict } from "../../src/records/verdictRepository.js";

/** 예시 판정. */
const sample: NewVerdict = {
  channelId: "c1", chatChannelId: "chat-1", messageTime: 111, senderChannelId: "viewer-1",
  senderNickname: "시청자1", content: "나쁜 말", decision: "candidate", reason: "rule:weak:1",
};

describe("VerdictRepository", () => {
  it("저장하고 상태를 바꾸고 최근 것만 읽는다", () => {
    let now = 1_000;
    const repository = createVerdictRepository(openDatabase(":memory:"), () => now);
    const first = repository.insert(sample);
    now = 5_000;
    const second = repository.insert({ ...sample, messageTime: 222, decision: "shadow", reason: "rule:strong:3" });
    repository.updateStatus(first.id, "ignored");
    expect(repository.get(first.id)).toMatchObject({ channelId: "c1", status: "ignored" });
    expect(repository.listRecent("c1", 2_000).map((verdict) => verdict.id)).toEqual([second.id]);
    expect(repository.deleteOlderThan(2_000)).toBe(1);
  });
});

describe("AuditLog", () => {
  it("기록하고 최신순으로 읽으며, 실제로 조치된 사용자만 요주의로 본다", () => {
    let now = 1_000;
    const log = createAuditLog(openDatabase(":memory:"), () => now);
    const base = { channelId: "c1", actorType: "manager" as const, actorChannelId: "m1", verdictId: null, error: null };
    log.record({ ...base, action: "hide", targetSenderChannelId: "bad", result: "ok" });
    now = 2_000;
    log.record({ ...base, action: "hide", targetSenderChannelId: "failed", result: "error", error: "429" });
    log.record({ ...base, action: "auto_hide_on", targetSenderChannelId: null, result: "ok" });
    expect(log.list("c1", 10, null).map((entry) => entry.action)).toEqual(["auto_hide_on", "hide", "hide"]);
    expect(log.hasEnforcedAction("c1", "bad", 0)).toBe(true);
    expect(log.hasEnforcedAction("c1", "failed", 0)).toBe(false);
    expect(log.hasEnforcedAction("c1", "bad", 1_500)).toBe(false);
  });
});

describe("MinuteStats", () => {
  it("메모리에 모았다가 분 단위로 더해 저장한다", () => {
    let now = 61_000;
    const stats = createMinuteStats(openDatabase(":memory:"), () => now);
    stats.increment("c1", "received");
    stats.increment("c1", "received", 2);
    stats.flush();
    stats.increment("c1", "received");
    stats.increment("c1", "shadow");
    now = 125_000;
    stats.increment("c1", "received");
    stats.flush();
    expect(stats.recent("c1", 0)).toEqual([
      expect.objectContaining({ minute: 60_000, received: 4, shadow: 1 }),
      expect.objectContaining({ minute: 120_000, received: 1, shadow: 0 }),
    ]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- records`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/server/src/records/verdictRepository.ts`:
```ts
import type { Decision, VerdictDto, VerdictStatus } from "@zzirit-guard/shared";
import type { Database } from "../db/database.js";
import type { Clock } from "../time.js";

/** 새로 저장할 판정. pass는 저장하지 않는다(최소 저장, 스펙 9장). */
export interface NewVerdict {
  channelId: string;
  chatChannelId: string;
  messageTime: number;
  senderChannelId: string;
  senderNickname: string;
  content: string;
  decision: Exclude<Decision, "pass">;
  reason: string;
  unsafeProbability?: number | null;
  category?: string | null;
}

/** 판정 저장소. */
export interface VerdictRepository {
  insert(verdict: NewVerdict): VerdictDto;
  updateStatus(id: number, status: VerdictStatus): void;
  get(id: number): (VerdictDto & { channelId: string }) | null;
  listRecent(channelId: string, sinceMs: number): VerdictDto[];
  deleteOlderThan(cutoffMs: number): number;
}

/** verdict 행. */
interface VerdictRow {
  id: number;
  channel_id: string;
  chat_channel_id: string;
  message_time: number;
  sender_channel_id: string;
  sender_nickname: string;
  content: string;
  decision: Exclude<Decision, "pass">;
  reason: string;
  status: VerdictStatus;
  created_at: number;
}

/** SQLite 기반 판정 저장소를 만든다. */
export function createVerdictRepository(database: Database, clock: Clock): VerdictRepository {
  return {
    insert: (verdict) => insertVerdict(database, verdict, clock()),
    updateStatus: (id, status) => void database.prepare("UPDATE verdict SET status = ? WHERE id = ?").run(status, id),
    get: (id) => {
      const row = database.prepare("SELECT * FROM verdict WHERE id = ?").get(id) as VerdictRow | undefined;
      return row ? { ...toDto(row), channelId: row.channel_id } : null;
    },
    listRecent: (channelId, sinceMs) =>
      (database.prepare("SELECT * FROM verdict WHERE channel_id = ? AND created_at >= ? ORDER BY id").all(channelId, sinceMs) as VerdictRow[]).map(toDto),
    deleteOlderThan: (cutoffMs) => database.prepare("DELETE FROM verdict WHERE created_at < ?").run(cutoffMs).changes,
  };
}

/** 판정을 넣고 DTO로 돌려준다. */
function insertVerdict(database: Database, verdict: NewVerdict, now: number): VerdictDto {
  const result = database
    .prepare(
      `INSERT INTO verdict (channel_id, chat_channel_id, message_time, sender_channel_id, sender_nickname, content, decision, reason, unsafe_probability, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      verdict.channelId, verdict.chatChannelId, verdict.messageTime, verdict.senderChannelId, verdict.senderNickname,
      verdict.content, verdict.decision, verdict.reason, verdict.unsafeProbability ?? null, verdict.category ?? null, now,
    );
  const { channelId: _channelId, unsafeProbability: _probability, category: _category, ...rest } = verdict;
  return { ...rest, id: Number(result.lastInsertRowid), status: "pending", createdAt: now };
}

/** 행을 DTO로 바꾼다. */
function toDto(row: VerdictRow): VerdictDto {
  return {
    id: row.id, chatChannelId: row.chat_channel_id, messageTime: row.message_time, senderChannelId: row.sender_channel_id,
    senderNickname: row.sender_nickname, content: row.content, decision: row.decision, reason: row.reason, status: row.status, createdAt: row.created_at,
  };
}
```

`apps/server/src/records/auditLog.ts`:
```ts
import type { AuditEntryDto } from "@zzirit-guard/shared";
import type { Database } from "../db/database.js";
import type { Clock } from "../time.js";

/** 감사 기록 1건(원문 없음). */
export interface AuditRecord {
  channelId: string;
  actorType: "manager" | "rule" | "system";
  actorChannelId: string | null;
  action: string;
  targetSenderChannelId: string | null;
  verdictId: number | null;
  result: "ok" | "error";
  error: string | null;
}

/** 감사 기록 저장소. */
export interface AuditLog {
  record(entry: AuditRecord): void;
  list(channelId: string, limit: number, beforeId: number | null): AuditEntryDto[];
  hasEnforcedAction(channelId: string, senderChannelId: string, sinceMs: number): boolean;
  deleteOlderThan(cutoffMs: number): number;
}

/** 요주의 사용자로 볼 '실제 조치' 종류. 실패한 조치는 세지 않는다. */
const ENFORCED_ACTIONS = ["hide", "temporary_restrict", "restrict"] as const;

/** audit_log 행. */
interface AuditRow {
  id: number;
  actor_type: AuditEntryDto["actorType"];
  actor_channel_id: string | null;
  action: string;
  target_sender_channel_id: string | null;
  verdict_id: number | null;
  result: "ok" | "error";
  error: string | null;
  created_at: number;
}

/** SQLite 기반 감사 기록을 만든다. */
export function createAuditLog(database: Database, clock: Clock): AuditLog {
  const enforcedQuery = database.prepare(
    `SELECT 1 FROM audit_log WHERE channel_id = ? AND target_sender_channel_id = ? AND created_at >= ? AND result = 'ok'
     AND action IN (${ENFORCED_ACTIONS.map(() => "?").join(",")}) LIMIT 1`,
  );
  return {
    record: (entry) => insertAudit(database, entry, clock()),
    list: (channelId, limit, beforeId) => listAudit(database, channelId, limit, beforeId),
    hasEnforcedAction: (channelId, senderChannelId, sinceMs) => enforcedQuery.get(channelId, senderChannelId, sinceMs, ...ENFORCED_ACTIONS) !== undefined,
    deleteOlderThan: (cutoffMs) => database.prepare("DELETE FROM audit_log WHERE created_at < ?").run(cutoffMs).changes,
  };
}

/** 기록을 넣는다. */
function insertAudit(database: Database, entry: AuditRecord, now: number): void {
  database
    .prepare(
      `INSERT INTO audit_log (channel_id, actor_type, actor_channel_id, action, target_sender_channel_id, verdict_id, result, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(entry.channelId, entry.actorType, entry.actorChannelId, entry.action, entry.targetSenderChannelId, entry.verdictId, entry.result, entry.error, now);
}

/** 최신순 목록. beforeId로 이어 읽는다(무한 스크롤). */
function listAudit(database: Database, channelId: string, limit: number, beforeId: number | null): AuditEntryDto[] {
  const rows = database
    .prepare("SELECT * FROM audit_log WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
    .all(channelId, beforeId ?? Number.MAX_SAFE_INTEGER, limit) as AuditRow[];
  return rows.map((row) => ({
    id: row.id, actorType: row.actor_type, actorChannelId: row.actor_channel_id, action: row.action,
    targetSenderChannelId: row.target_sender_channel_id, verdictId: row.verdict_id, result: row.result, error: row.error, createdAt: row.created_at,
  }));
}
```

`apps/server/src/records/minuteStats.ts`:
```ts
import type { Database } from "../db/database.js";
import { floorToMinute, type Clock } from "../time.js";

/** 분당 통계 항목(minute_stat 열 이름과 같다). */
export const STAT_FIELDS = [
  "received", "skipped", "deduplicated", "stage1_forwarded", "stage2_done", "stage2_dropped", "candidates", "auto_hidden", "shadow", "invalid_events",
] as const;

/** 통계 항목 이름. */
export type StatField = (typeof STAT_FIELDS)[number];

/** 분당 통계. 메시지마다 DB에 쓰지 않으려고 메모리에 모았다가 flush로 더한다. */
export interface MinuteStats {
  increment(channelId: string, field: StatField, amount?: number): void;
  flush(): void;
  recent(channelId: string, sinceMs: number): Array<{ minute: number } & Record<StatField, number>>;
}

/** 분당 통계를 만든다. */
export function createMinuteStats(database: Database, clock: Clock): MinuteStats {
  let pending = new Map<string, { channelId: string; minute: number; counts: Partial<Record<StatField, number>> }>();
  const upsert = database.prepare(
    `INSERT INTO minute_stat (channel_id, minute, ${STAT_FIELDS.join(", ")}) VALUES (?, ?, ${STAT_FIELDS.map(() => "?").join(", ")})
     ON CONFLICT (channel_id, minute) DO UPDATE SET ${STAT_FIELDS.map((field) => `${field} = ${field} + excluded.${field}`).join(", ")}`,
  );
  return {
    increment(channelId, field, amount = 1) {
      const minute = floorToMinute(clock());
      const key = `${channelId}|${minute}`;
      const bucket = pending.get(key) ?? { channelId, minute, counts: {} };
      bucket.counts[field] = (bucket.counts[field] ?? 0) + amount;
      pending.set(key, bucket);
    },
    flush() {
      const buckets = [...pending.values()];
      pending = new Map();
      database.transaction(() => buckets.forEach((bucket) => upsert.run(bucket.channelId, bucket.minute, ...STAT_FIELDS.map((field) => bucket.counts[field] ?? 0))))();
    },
    recent: (channelId, sinceMs) =>
      database.prepare(`SELECT minute, ${STAT_FIELDS.join(", ")} FROM minute_stat WHERE channel_id = ? AND minute >= ? ORDER BY minute`).all(channelId, sinceMs) as Array<
        { minute: number } & Record<StatField, number>
      >,
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- records`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/records apps/server/test/records
git commit -m "feat: 판정·감사 기록·분당 통계 저장소 추가" -m "요주의 사용자는 실제로 성공한 조치(숨김·제한)만으로 판단하고, 통계는 메모리에 모았다가 분 단위로 더해 저장한다."
```

---

### Task 13: 건너뛰기·중복 추적

**Files:**
- Create: `apps/server/src/detection/messageTraits.ts`
- Test: `apps/server/test/detection/messageTraits.test.ts`

**Interfaces:**
- Produces: `isTrivialMessage(normalized: string): boolean`, `interface DuplicateTracker { seen(normalized: string, now: number): boolean }`, `createDuplicateTracker(options?: { ttlMs?; maxEntries? })`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/detection/messageTraits.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createDuplicateTracker, isTrivialMessage } from "../../src/detection/messageTraits.js";

describe("isTrivialMessage", () => {
  it.each([["ㅋㅋ", true], ["ㅎㅎ", true], ["ㄷㄷ", true], ["ㅠㅠ", true], ["", true], ["ㄴㄱㅁ", false], ["ㅋㅋ개웃기네", false]])(
    "%s → %s",
    (normalized, expected) => expect(isTrivialMessage(normalized)).toBe(expected),
  );
});

describe("DuplicateTracker", () => {
  it("10분 안에 다시 나온 문장을 중복으로 본다", () => {
    const tracker = createDuplicateTracker();
    expect(tracker.seen("안녕하세요", 0)).toBe(false);
    expect(tracker.seen("안녕하세요", 1_000)).toBe(true);
    expect(tracker.seen("안녕하세요", 700_000)).toBe(false);
  });

  it("최대 개수를 넘으면 가장 오래된 것부터 잊는다", () => {
    const tracker = createDuplicateTracker({ maxEntries: 2 });
    tracker.seen("a", 0);
    tracker.seen("b", 0);
    tracker.seen("c", 0);
    expect(tracker.seen("a", 1)).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- messageTraits`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/server/src/detection/messageTraits.ts`:
```ts
/** ㅋ·ㅎ·ㄷ·ㅠ·ㅜ로만 된(또는 빈) 정규화 문장. 이모티콘·문장부호만 있던 채팅은 정규화 후 빈 문자열이 된다. */
const TRIVIAL_PATTERN = /^[ㅋㅎㄷㅠㅜ]*$/u;

/** AI 단계를 건너뛰어도 되는 가벼운 반응인지 본다(스펙 5.2 ③). */
export function isTrivialMessage(normalized: string): boolean {
  return TRIVIAL_PATTERN.test(normalized);
}

/** 최근에 같은 정규화 문장을 봤는지 추적한다. 1단계에서는 통계(중복 비율 측정)에만 쓴다. */
export interface DuplicateTracker {
  seen(normalized: string, now: number): boolean;
}

/** 기본값: 10분, 최대 1만 건(스펙 5.2 ③). */
const DUPLICATE_DEFAULTS = { ttlMs: 600_000, maxEntries: 10_000 };

/** Map의 삽입 순서를 LRU로 쓰는 중복 추적기를 만든다. */
export function createDuplicateTracker(options: Partial<typeof DUPLICATE_DEFAULTS> = {}): DuplicateTracker {
  const settings = { ...DUPLICATE_DEFAULTS, ...options };
  const lastSeen = new Map<string, number>();
  return {
    seen(normalized, now) {
      const previous = lastSeen.get(normalized);
      lastSeen.delete(normalized);
      lastSeen.set(normalized, now);
      if (lastSeen.size > settings.maxEntries) lastSeen.delete(lastSeen.keys().next().value as string);
      return previous !== undefined && now - previous <= settings.ttlMs;
    },
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- messageTraits`
Expected: PASS (9 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/detection/messageTraits.ts apps/server/test/detection/messageTraits.test.ts
git commit -m "feat: 가벼운 반응 건너뛰기와 중복 문장 추적 추가" -m "1단계에서는 실채팅의 건너뛰기·중복 비율을 재는 데 쓰고, 2단계 AI 부하를 줄이는 데 그대로 쓴다."
```

---

### Task 14: 판정 파이프라인

**Files:**
- Create: `apps/server/src/detection/pipeline.ts`
- Test: `apps/server/test/detection/pipeline.test.ts`

**Interfaces:**
- Consumes: `ChatEvent`·`isPrivilegedRole`(Task 7), `normalizeForMatching`(Task 8), `RuleRepository`·`stripExceptions`·`findFirstMatch`(Task 9), 패턴 함수(Task 10), 도배 감지기·`MessageRef`(Task 11), `AuditLog`(Task 12), `isTrivialMessage`·`DuplicateTracker`(Task 13)
- Produces: `interface DetectionResult { decision: "auto_hide" | "candidate" | "pass"; reason: string; ref: MessageRef; earlierFloodRefs: MessageRef[]; trivial: boolean; duplicate: boolean }`, `interface DetectionPipeline { evaluate(event: ChatEvent): DetectionResult }`, `createDetectionPipeline(deps: { rules; groupFlood; personalFlood; duplicates; auditLog })`, `WATCH_WINDOW_MS`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/detection/pipeline.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../../src/chat/chatEvent.js";
import { openDatabase } from "../../src/db/database.js";
import { createGroupFloodDetector, createPersonalFloodDetector } from "../../src/detection/floodDetectors.js";
import { createDuplicateTracker } from "../../src/detection/messageTraits.js";
import { createDetectionPipeline, type DetectionPipeline } from "../../src/detection/pipeline.js";
import { createRuleRepository, type RuleRepository } from "../../src/detection/ruleRepository.js";
import { createAuditLog, type AuditLog } from "../../src/records/auditLog.js";

let pipeline: DetectionPipeline;
let rules: RuleRepository;
let auditLog: AuditLog;
let clock = 0;

beforeEach(() => {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
  rules = createRuleRepository(database, () => 0);
  rules.seedDefaults("c1");
  rules.add("c1", "allow", "적팀 죽여버려!!", "m");
  auditLog = createAuditLog(database, () => clock);
  pipeline = createDetectionPipeline({
    rules, auditLog, groupFlood: createGroupFloodDetector(), personalFlood: createPersonalFloodDetector(), duplicates: createDuplicateTracker(),
  });
});

/** 채팅 이벤트를 만든다. receivedAt이 겹치지 않게 시계를 1초씩 민다. */
function chat(content: string, overrides: Partial<ChatEvent> = {}): ChatEvent {
  clock += 1_000;
  return {
    channelId: "c1", senderChannelId: "viewer-1", chatChannelId: "chat-1", nickname: "시청자1", userRoleCode: "common_user",
    content, messageTime: clock, receivedAt: clock, ...overrides,
  };
}

describe("DetectionPipeline", () => {
  it.each([
    ["홍어들은 다 이래", "auto_hide", /^rule:strong:\d+$/],
    ["무료 치킨 쿠폰 받기 👉 bit.ly/free-chk", "auto_hide", /^rule:link$/],
    ["010-1234-5678 이 번호로 연락해봐", "auto_hide", /^rule:phone$/],
    ["씨@발 방송 꺼라", "candidate", /^rule:weak:\d+$/],
    ["방송 끝나고 칼 들고 기다린다", "candidate", /^rule:threat:\d+$/],
    ["101동 1203호 맞지?", "candidate", /^rule:address$/],
    ["여기가 시발점이다", "pass", /^none$/],
    ["안녕하세요~", "pass", /^none$/],
  ])("%s → %s", (content, decision, reason) => {
    const result = pipeline.evaluate(chat(content));
    expect(result.decision).toBe(decision);
    expect(result.reason).toMatch(reason);
  });

  it("허용어는 메시지 전체가 같을 때만 통과시킨다", () => {
    expect(pipeline.evaluate(chat("적팀 죽여버려!!")).decision).toBe("pass");
    expect(pipeline.evaluate(chat("적팀 죽여버려 시발")).decision).toBe("candidate");
  });

  it("허용어여도 금칙어 강보다 앞서지 않는다", () => {
    rules.add("c1", "allow", "홍어", "m");
    expect(pipeline.evaluate(chat("홍어")).decision).toBe("auto_hide");
  });

  it("스트리머·매니저 메시지는 자동 숨김 대신 후보", () => {
    const result = pipeline.evaluate(chat("홍어들은 다 이래", { userRoleCode: "streaming_chat_manager" }));
    expect(result.decision).toBe("candidate");
    expect(result.reason).toMatch(/:privileged$/);
  });

  it("떼도배는 다섯 번째에 앞선 메시지까지 넘긴다(권한자 메시지는 빼고)", () => {
    const text = "구독하면 선물 드려요 진짜로";
    for (let user = 1; user <= 3; user += 1) pipeline.evaluate(chat(text, { senderChannelId: `user-${user}` }));
    pipeline.evaluate(chat(text, { senderChannelId: "manager-1", userRoleCode: "streaming_channel_manager" }));
    const fifth = pipeline.evaluate(chat(text, { senderChannelId: "user-5" }));
    expect(fifth).toMatchObject({ decision: "auto_hide", reason: "rule:group_flood" });
    expect(fifth.earlierFloodRefs.map((ref) => ref.senderChannelId)).toEqual(["user-1", "user-2", "user-3"]);
  });

  it("개인 도배는 다섯 번째부터 후보", () => {
    const decisions = [1, 2, 3, 4, 5].map((index) => pipeline.evaluate(chat(`그냥 말 ${index}`)).decision);
    expect(decisions).toEqual(["pass", "pass", "pass", "pass", "candidate"]);
  });

  it("최근 180일 안에 실제로 조치된 사용자는 후보", () => {
    auditLog.record({ channelId: "c1", actorType: "manager", actorChannelId: "m1", action: "hide", targetSenderChannelId: "viewer-9", verdictId: null, result: "ok", error: null });
    expect(pipeline.evaluate(chat("평범한 말", { senderChannelId: "viewer-9" }))).toMatchObject({ decision: "candidate", reason: "rule:watch_user" });
  });

  it("가벼운 반응과 중복을 표시한다", () => {
    expect(pipeline.evaluate(chat("ㅋㅋㅋㅋㅋ"))).toMatchObject({ trivial: true, duplicate: false });
    expect(pipeline.evaluate(chat("ㅋㅋㅋ", { senderChannelId: "viewer-2" }))).toMatchObject({ trivial: true, duplicate: true });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- pipeline`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/server/src/detection/pipeline.ts`:
```ts
import { isPrivilegedRole, type ChatEvent } from "../chat/chatEvent.js";
import type { AuditLog } from "../records/auditLog.js";
import type { GroupFloodDetector, MessageRef, PersonalFloodDetector } from "./floodDetectors.js";
import { isTrivialMessage, type DuplicateTracker } from "./messageTraits.js";
import { normalizeForMatching } from "./normalize.js";
import { containsBlockedLink, containsPhoneNumber, looksLikeAddress } from "./patterns.js";
import type { RuleRepository, RuleSnapshot } from "./ruleRepository.js";
import { findFirstMatch, stripExceptions } from "./wordMatch.js";

/** 메시지 1건의 판정. 1단계에서는 AI가 없어 needs_care가 나오지 않는다. */
export interface DetectionResult {
  decision: "auto_hide" | "candidate" | "pass";
  reason: string;
  ref: MessageRef;
  earlierFloodRefs: MessageRef[];
  trivial: boolean;
  duplicate: boolean;
}

/** 판정 파이프라인. */
export interface DetectionPipeline {
  evaluate(event: ChatEvent): DetectionResult;
}

/** 파이프라인이 쓰는 구성 요소. */
export interface DetectionPipelineDeps {
  rules: RuleRepository;
  groupFlood: GroupFloodDetector;
  personalFlood: PersonalFloodDetector;
  duplicates: DuplicateTracker;
  auditLog: AuditLog;
}

/** 요주의 사용자 판단 기간: 감사 기록 보관 기간과 같은 180일. */
export const WATCH_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

/** 규칙 하나의 결과. null이면 다음 규칙으로 넘어간다. */
type RuleOutcome = { decision: DetectionResult["decision"]; reason: string } | null;

/** 규칙 검사에 필요한 메시지 정보. */
interface RuleContext {
  event: ChatEvent;
  normalized: string;
  withoutExceptions: string;
  snapshot: RuleSnapshot;
  groupFloodTriggered: boolean;
  personalFloodTriggered: boolean;
}

/** 파이프라인을 만든다. */
export function createDetectionPipeline(deps: DetectionPipelineDeps): DetectionPipeline {
  return { evaluate: (event) => evaluate(deps, event) };
}

/** 관측(도배·중복은 모든 메시지를 세야 한다) → 규칙 순서대로 판정 → 권한자 예외 적용. */
function evaluate(deps: DetectionPipelineDeps, event: ChatEvent): DetectionResult {
  const normalized = normalizeForMatching(event.content);
  const ref = toMessageRef(event);
  const flood = deps.groupFlood.observe(normalized, ref, event.receivedAt);
  const context = buildContext(deps, event, normalized, flood.triggered);
  const outcome = decide(deps, context);
  const traits = { trivial: isTrivialMessage(normalized), duplicate: deps.duplicates.seen(normalized, event.receivedAt) };
  const earlierFloodRefs = outcome.reason === "rule:group_flood" ? flood.earlierRefs.filter((item) => !item.privileged) : [];
  return applyPrivilege({ ...outcome, ref, earlierFloodRefs, ...traits });
}

/** 규칙 검사용 정보를 모은다. */
function buildContext(deps: DetectionPipelineDeps, event: ChatEvent, normalized: string, groupFloodTriggered: boolean): RuleContext {
  const snapshot = deps.rules.snapshot(event.channelId);
  return {
    event, normalized, snapshot, groupFloodTriggered,
    withoutExceptions: stripExceptions(normalized, snapshot.exception),
    personalFloodTriggered: deps.personalFlood.observe(event.senderChannelId, event.receivedAt),
  };
}

/**
 * 스펙 5.2 순서: 금칙어 강 → 떼도배 → 광고 → 전화번호 → 허용어 → 금칙어 약 → 개인 도배 → 협박 → 주소 → 요주의 사용자.
 * 허용어는 금칙어 강·떼도배·광고·전화번호보다 뒤라서 그것들을 무력화하지 못한다.
 */
function decide(deps: DetectionPipelineDeps, context: RuleContext): { decision: DetectionResult["decision"]; reason: string } {
  const checks: Array<(context: RuleContext) => RuleOutcome> = [
    (c) => matchRule(c.withoutExceptions, c.snapshot.strong, "auto_hide", "strong"),
    (c) => (c.groupFloodTriggered ? { decision: "auto_hide", reason: "rule:group_flood" } : null),
    (c) => (containsBlockedLink(c.event.content, c.snapshot.allowDomains) ? { decision: "auto_hide", reason: "rule:link" } : null),
    (c) => (containsPhoneNumber(c.event.content) ? { decision: "auto_hide", reason: "rule:phone" } : null),
    (c) => (c.snapshot.allow.has(c.normalized) ? { decision: "pass", reason: "rule:allow" } : null),
    (c) => matchRule(c.withoutExceptions, c.snapshot.weak, "candidate", "weak"),
    (c) => (c.personalFloodTriggered ? { decision: "candidate", reason: "rule:personal_flood" } : null),
    (c) => matchRule(c.withoutExceptions, c.snapshot.threat, "candidate", "threat"),
    (c) => (looksLikeAddress(c.event.content) ? { decision: "candidate", reason: "rule:address" } : null),
    (c) => (isWatched(deps, c.event) ? { decision: "candidate", reason: "rule:watch_user" } : null),
  ];
  for (const check of checks) {
    const outcome = check(context);
    if (outcome) return outcome;
  }
  return { decision: "pass", reason: "none" };
}

/** 단어 규칙 일치를 판정으로 바꾼다. reason에 규칙 번호를 남겨 오판 신고 때 어떤 규칙인지 알 수 있게 한다. */
function matchRule(text: string, entries: RuleSnapshot["strong"], decision: DetectionResult["decision"], kind: string): RuleOutcome {
  const matched = findFirstMatch(text, entries);
  return matched ? { decision, reason: `rule:${kind}:${matched.id}` } : null;
}

/** 최근 180일 안에 실제 조치를 받은 사용자인지 본다. */
function isWatched(deps: DetectionPipelineDeps, event: ChatEvent): boolean {
  return deps.auditLog.hasEnforcedAction(event.channelId, event.senderChannelId, event.receivedAt - WATCH_WINDOW_MS);
}

/** 스트리머·매니저 메시지는 자동 숨김 대신 후보로 낮춘다(Global Constraints). */
function applyPrivilege(result: DetectionResult): DetectionResult {
  if (result.decision !== "auto_hide" || !result.ref.privileged) return result;
  return { ...result, decision: "candidate", reason: `${result.reason}:privileged`, earlierFloodRefs: [] };
}

/** 채팅 이벤트에서 숨기기·표시에 필요한 값만 뽑는다. */
function toMessageRef(event: ChatEvent): MessageRef {
  return {
    chatChannelId: event.chatChannelId, messageTime: event.messageTime, senderChannelId: event.senderChannelId,
    nickname: event.nickname, content: event.content, privileged: isPrivilegedRole(event.userRoleCode),
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- pipeline`
Expected: PASS (15 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/detection/pipeline.ts apps/server/test/detection/pipeline.test.ts
git commit -m "feat: 규칙 판정 파이프라인 추가" -m "스펙 5.2 순서로 규칙을 적용하고, 스트리머·매니저 메시지는 자동 숨김 대신 후보로 낮추며, 떼도배는 앞선 메시지까지 함께 넘긴다."
```

---

### Task 15: 실행기(쓰기 API의 유일한 통로)

**Files:**
- Create: `apps/server/src/actions/executor.ts`
- Create: `apps/server/test/fakes/stubTokenManager.ts`
- Test: `apps/server/test/actions/executor.test.ts`

**Interfaces:**
- Consumes: `ChzzkApi`·`ChzzkApiError`·`MessageTarget`(Task 5), `TokenManager`·`WriteLockedError`(Task 6), `AuditLog`·`VerdictRepository`(Task 12), `Logger`·`describeError`(Task 7)
- Produces: `type ActionRequest = { kind: "hide"; target: MessageTarget; verdictId: number | null } | { kind: "temporary_restrict"; targetChannelId; chatChannelId; verdictId: number | null } | { kind: "restrict"; targetChannelId; verdictId: number | null } | { kind: "unrestrict"; targetChannelId } | { kind: "update_chat_settings"; settings: ChatSettingsDto }`, `interface Actor { type: "manager" | "rule" | "system"; channelId: string | null }`, `type ActionOutcome = { ok: true; note: string | null } | { ok: false; message: string }`, `interface Executor { submit(channelId, request, actor): Promise<ActionOutcome>; pendingCount(): number; onFailureRateExceeded(listener: (channelId: string) => void): void }`, `createExecutor(options: ExecutorOptions)`, 테스트용 `stubTokenManager(overrides?: Partial<TokenManager>): TokenManager`

- [ ] **Step 1: 테스트용 토큰 관리자 작성**

`apps/server/test/fakes/stubTokenManager.ts`:
```ts
import type { TokenManager } from "../../src/connection/tokenManager.js";

/** 항상 같은 토큰을 주는 가짜 토큰 관리자. 필요한 메서드만 덮어쓴다. */
export function stubTokenManager(overrides: Partial<TokenManager> = {}): TokenManager {
  return {
    getAccessToken: async () => "owner-token",
    forceRefresh: async () => "owner-token-refreshed",
    isWriteLocked: () => false,
    accessExpiresAt: () => null,
    adoptCredential: () => undefined,
    disconnect: () => undefined,
    onLockChange: () => undefined,
    ...overrides,
  };
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/server/test/actions/executor.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { createExecutor, type ActionRequest } from "../../src/actions/executor.js";
import { ChzzkApiError, type ChzzkApi } from "../../src/chzzk/apiClient.js";
import { WriteLockedError } from "../../src/connection/tokenManager.js";
import { openDatabase } from "../../src/db/database.js";
import { silentLogger } from "../../src/logger.js";
import { createAuditLog } from "../../src/records/auditLog.js";
import { createVerdictRepository } from "../../src/records/verdictRepository.js";
import { createFakeApi } from "../fakes/fakeApi.js";
import { stubTokenManager } from "../fakes/stubTokenManager.js";

/** 실패를 정해진 순서로 낸 뒤 성공하는 blindMessage. */
function failingThenOk(errors: unknown[]): ChzzkApi["blindMessage"] {
  return vi.fn(async () => {
    const next = errors.shift();
    if (next) throw next;
  });
}

/** 실행기와 기록 저장소를 함께 만든다. */
function setup(api: Partial<ChzzkApi>, tokenOverrides = {}) {
  const database = openDatabase(":memory:");
  const verdicts = createVerdictRepository(database, () => 0);
  const auditLog = createAuditLog(database, () => 0);
  const sleeps: number[] = [];
  const statusEvents: Array<[number, string]> = [];
  const executor = createExecutor({
    api: createFakeApi(api), tokenManager: stubTokenManager(tokenOverrides), auditLog, verdicts, clock: () => 0, logger: silentLogger,
    onVerdictStatus: (id, status) => statusEvents.push([id, status]),
    sleep: async (ms) => void sleeps.push(ms),
  });
  const verdict = verdicts.insert({
    channelId: "c1", chatChannelId: "chat-1", messageTime: 7, senderChannelId: "bad", senderNickname: "악플러",
    content: "나쁜 말", decision: "candidate", reason: "rule:weak:1",
  });
  const hide: ActionRequest = { kind: "hide", target: { chatChannelId: "chat-1", messageTime: 7, senderChannelId: "bad" }, verdictId: verdict.id };
  return { executor, verdicts, auditLog, sleeps, statusEvents, verdict, hide };
}

/** 매니저 행위자. */
const manager = { type: "manager" as const, channelId: "manager-1" };

describe("Executor", () => {
  it("숨기면 감사 기록을 남기고 판정 상태를 hidden으로 바꾼다", async () => {
    const blindMessage = vi.fn(async () => undefined);
    const { executor, verdicts, auditLog, statusEvents, verdict, hide } = setup({ blindMessage });
    await expect(executor.submit("c1", hide, manager)).resolves.toEqual({ ok: true, note: null });
    expect(blindMessage).toHaveBeenCalledWith("owner-token", hide.kind === "hide" ? hide.target : null);
    expect(verdicts.get(verdict.id)?.status).toBe("hidden");
    expect(statusEvents).toEqual([[verdict.id, "hidden"]]);
    expect(auditLog.list("c1", 10, null)[0]).toMatchObject({ action: "hide", actorChannelId: "manager-1", targetSenderChannelId: "bad", result: "ok" });
  });

  it("429는 1·2초 기다리며 다시 시도한다", async () => {
    const blindMessage = failingThenOk([new ChzzkApiError(429, "TOO_MANY_REQUESTS", "/x"), new ChzzkApiError(429, "TOO_MANY_REQUESTS", "/x")]);
    const { executor, sleeps, hide } = setup({ blindMessage });
    await expect(executor.submit("c1", hide, manager)).resolves.toMatchObject({ ok: true });
    expect(blindMessage).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("서버 오류가 계속되면 3번 다시 시도한 뒤 실패를 기록한다", async () => {
    const serverError = () => new ChzzkApiError(500, "INTERNAL_SERVER_ERROR", "/x");
    const blindMessage = failingThenOk([serverError(), serverError(), serverError(), serverError()]);
    const { executor, sleeps, auditLog, hide } = setup({ blindMessage });
    const outcome = await executor.submit("c1", hide, manager);
    expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/서버 오류/) });
    expect(blindMessage).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(auditLog.list("c1", 10, null)[0]).toMatchObject({ result: "error" });
  });

  it("400은 다시 시도하지 않고 치지직 메시지를 보여 준다", async () => {
    const blindMessage = failingThenOk([new ChzzkApiError(400, "스트리머가 아닙니다", "/x")]);
    const { executor, hide } = setup({ blindMessage });
    await expect(executor.submit("c1", hide, manager)).resolves.toEqual({ ok: false, message: "치지직이 요청을 거부했습니다: 스트리머가 아닙니다" });
    expect(blindMessage).toHaveBeenCalledTimes(1);
  });

  it("숨기려던 메시지가 이미 없으면(404) 숨김 완료로 정리한다", async () => {
    const { executor, verdicts, verdict, hide } = setup({ blindMessage: failingThenOk([new ChzzkApiError(404, "NOT_FOUND", "/x")]) });
    await expect(executor.submit("c1", hide, manager)).resolves.toEqual({ ok: true, note: "이미 사라진 메시지입니다" });
    expect(verdicts.get(verdict.id)?.status).toBe("hidden");
  });

  it("401이면 토큰을 강제로 갱신하고 한 번 더 시도한다", async () => {
    const forceRefresh = vi.fn(async () => "refreshed");
    const blindMessage = failingThenOk([new ChzzkApiError(401, "INVALID_TOKEN", "/x")]);
    const { executor, hide } = setup({ blindMessage }, { forceRefresh });
    await expect(executor.submit("c1", hide, manager)).resolves.toMatchObject({ ok: true });
    expect(forceRefresh).toHaveBeenCalledTimes(1);
  });

  it("쓰기가 잠겨 있으면 호출하지 않고 이유를 알려 준다", async () => {
    const blindMessage = vi.fn(async () => undefined);
    const { executor, hide } = setup({ blindMessage }, { getAccessToken: async () => { throw new WriteLockedError("다시 연결해야 합니다"); } });
    await expect(executor.submit("c1", hide, manager)).resolves.toEqual({ ok: false, message: "다시 연결해야 합니다" });
    expect(blindMessage).not.toHaveBeenCalled();
  });

  it("1분 안에 10건 이상이고 절반 넘게 실패하면 한 번 알린다", async () => {
    const blindMessage = vi.fn(async () => { throw new ChzzkApiError(400, "bad", "/x"); });
    const { executor, hide } = setup({ blindMessage });
    const listener = vi.fn();
    executor.onFailureRateExceeded(listener);
    for (let index = 0; index < 12; index += 1) await executor.submit("c1", hide, manager);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("c1");
  });

  it("요청을 들어온 순서대로 하나씩 처리한다", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const blindMessage = vi.fn(async (_token: string, target: { senderChannelId: string }) => {
      order.push(`start:${target.senderChannelId}`);
      if (target.senderChannelId === "first") await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push(`end:${target.senderChannelId}`);
    });
    const { executor } = setup({ blindMessage: blindMessage as ChzzkApi["blindMessage"] });
    const request = (sender: string): ActionRequest => ({ kind: "hide", target: { chatChannelId: "c", messageTime: 1, senderChannelId: sender }, verdictId: null });
    const first = executor.submit("c1", request("first"), manager);
    const second = executor.submit("c1", request("second"), manager);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executor.pendingCount()).toBe(2);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- executor`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: 구현**

`apps/server/src/actions/executor.ts`:
```ts
import type { ChatSettingsDto, VerdictStatus } from "@zzirit-guard/shared";
import { ChzzkApiError, type ChzzkApi, type MessageTarget } from "../chzzk/apiClient.js";
import { WriteLockedError, type TokenManager } from "../connection/tokenManager.js";
import { describeError, type Logger } from "../logger.js";
import type { AuditLog } from "../records/auditLog.js";
import type { VerdictRepository } from "../records/verdictRepository.js";
import type { Clock } from "../time.js";

/** 실행기가 처리하는 쓰기 요청. */
export type ActionRequest =
  | { kind: "hide"; target: MessageTarget; verdictId: number | null }
  | { kind: "temporary_restrict"; targetChannelId: string; chatChannelId: string; verdictId: number | null }
  | { kind: "restrict"; targetChannelId: string; verdictId: number | null }
  | { kind: "unrestrict"; targetChannelId: string }
  | { kind: "update_chat_settings"; settings: ChatSettingsDto };

/** 요청한 주체. rule은 자동 숨김, system은 서버 자체 동작이다. */
export interface Actor {
  type: "manager" | "rule" | "system";
  channelId: string | null;
}

/** 처리 결과. message·note는 매니저 화면에 그대로 보여 준다. */
export type ActionOutcome = { ok: true; note: string | null } | { ok: false; message: string };

/** 모든 쓰기 API가 지나는 유일한 통로(스펙 4장). */
export interface Executor {
  submit(channelId: string, request: ActionRequest, actor: Actor): Promise<ActionOutcome>;
  pendingCount(): number;
  onFailureRateExceeded(listener: (channelId: string) => void): void;
}

/** createExecutor 옵션. sleep은 테스트에서 기다리지 않으려고 바꿔 끼운다. */
export interface ExecutorOptions {
  api: ChzzkApi;
  tokenManager: TokenManager;
  auditLog: AuditLog;
  verdicts: VerdictRepository;
  clock: Clock;
  logger: Logger;
  onVerdictStatus(verdictId: number, status: VerdictStatus): void;
  sleep?: (ms: number) => Promise<void>;
}

/** 최대 재시도 횟수(스펙 10장). */
const MAX_RETRIES = 3;
/** 재시도 대기 기본값. 1·2·4초로 늘린다. */
const RETRY_BASE_MS = 1000;
/** 실패율을 보는 창(1분). */
const FAILURE_WINDOW_MS = 60_000;
/** 실패율을 판단하기 위한 최소 표본 수. 한두 번 실패로 스위치가 꺼지지 않게 한다. */
const FAILURE_MIN_SAMPLES = 10;
/** 이 비율을 넘으면 알린다(50%). */
const FAILURE_RATE_LIMIT = 0.5;

/** 실패 처리 결정: 끝내거나(done) 다시 시도(retry). */
type FailureDecision = { kind: "done"; outcome: ActionOutcome } | { kind: "retry" };

/** 실행기를 만든다. */
export function createExecutor(options: ExecutorOptions): Executor {
  return new SerialExecutor(options);
}

/** 요청을 순서대로 하나씩 실행한다. 치지직 호출 한도가 문서에 없어 한꺼번에 보내지 않는다. */
class SerialExecutor implements Executor {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private readonly outcomes: Array<{ at: number; ok: boolean }> = [];
  private readonly listeners: Array<(channelId: string) => void> = [];
  private lastAlertAt = Number.NEGATIVE_INFINITY;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ExecutorOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  submit(channelId: string, request: ActionRequest, actor: Actor): Promise<ActionOutcome> {
    this.pending += 1;
    const run = this.tail.then(() => this.execute(channelId, request, actor));
    // 대기열 사슬은 한 요청이 예외로 끝나도 이어져야 한다. 예외 자체는 run을 통해 호출자에게 그대로 전달된다.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.pending -= 1;
    });
  }

  pendingCount(): number {
    return this.pending;
  }

  onFailureRateExceeded(listener: (channelId: string) => void): void {
    this.listeners.push(listener);
  }

  /** 실행 → 기록. 예외를 밖으로 던지지 않아 대기열이 끊기지 않는다. */
  private async execute(channelId: string, request: ActionRequest, actor: Actor): Promise<ActionOutcome> {
    const outcome = await this.performWithRetry(request);
    this.recordOutcome(channelId, request, actor, outcome);
    return outcome;
  }

  /** 성공하거나 끝내기로 결정할 때까지 시도한다. */
  private async performWithRetry(request: ActionRequest): Promise<ActionOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await performRequest(this.options.api, await this.options.tokenManager.getAccessToken(), request);
        return { ok: true, note: null };
      } catch (error) {
        const decision = await this.decideAfterFailure(request, error, attempt);
        if (decision.kind === "done") return decision.outcome;
      }
    }
  }

  /** 실패 종류별 처리: 잠금·404·401·재시도 가능 오류·그 밖. */
  private async decideAfterFailure(request: ActionRequest, error: unknown, attempt: number): Promise<FailureDecision> {
    if (error instanceof WriteLockedError) return { kind: "done", outcome: { ok: false, message: error.message } };
    if (isStatus(error, 404) && request.kind === "hide") return { kind: "done", outcome: { ok: true, note: "이미 사라진 메시지입니다" } };
    if (isStatus(error, 401) && attempt === 0) return this.refreshAfterUnauthorized();
    if (isRetryable(error) && attempt < MAX_RETRIES) {
      await this.sleep(RETRY_BASE_MS * 2 ** attempt);
      return { kind: "retry" };
    }
    return { kind: "done", outcome: { ok: false, message: toUserMessage(error) } };
  }

  /** 401: 토큰을 강제로 갱신하고 한 번 더 시도한다. 갱신도 실패하면 그 이유로 끝낸다. */
  private async refreshAfterUnauthorized(): Promise<FailureDecision> {
    try {
      await this.options.tokenManager.forceRefresh();
      return { kind: "retry" };
    } catch (error) {
      return { kind: "done", outcome: { ok: false, message: toUserMessage(error) } };
    }
  }

  /** 감사 기록·판정 상태·실패율을 갱신한다. */
  private recordOutcome(channelId: string, request: ActionRequest, actor: Actor, outcome: ActionOutcome): void {
    const verdictId = "verdictId" in request ? request.verdictId : null;
    this.options.auditLog.record({
      channelId, actorType: actor.type, actorChannelId: actor.channelId, action: request.kind, targetSenderChannelId: targetOf(request),
      verdictId, result: outcome.ok ? "ok" : "error", error: outcome.ok ? null : outcome.message,
    });
    if (!outcome.ok) this.options.logger.warn("쓰기 요청 실패", { action: request.kind, verdictId, message: outcome.message });
    if (outcome.ok && verdictId !== null) this.updateVerdict(verdictId, request.kind);
    this.trackFailureRate(channelId, outcome.ok);
  }

  /** 성공한 조치에 맞게 판정 상태를 바꾸고 알린다. */
  private updateVerdict(verdictId: number, kind: ActionRequest["kind"]): void {
    const status: VerdictStatus | null = kind === "hide" ? "hidden" : kind === "temporary_restrict" || kind === "restrict" ? "restricted" : null;
    if (!status) return;
    this.options.verdicts.updateStatus(verdictId, status);
    this.options.onVerdictStatus(verdictId, status);
  }

  /** 최근 1분 실패율이 기준을 넘으면 1분에 한 번만 알린다. */
  private trackFailureRate(channelId: string, ok: boolean): void {
    const now = this.options.clock();
    this.outcomes.push({ at: now, ok });
    while (this.outcomes.length > 0 && (this.outcomes[0] as { at: number }).at <= now - FAILURE_WINDOW_MS) this.outcomes.shift();
    const failures = this.outcomes.filter((outcome) => !outcome.ok).length;
    const exceeded = this.outcomes.length >= FAILURE_MIN_SAMPLES && failures / this.outcomes.length > FAILURE_RATE_LIMIT;
    if (!exceeded || now - this.lastAlertAt < FAILURE_WINDOW_MS) return;
    this.lastAlertAt = now;
    this.listeners.forEach((listener) => listener(channelId));
  }
}

/** 요청 종류에 맞는 치지직 API를 부른다. */
function performRequest(api: ChzzkApi, token: string, request: ActionRequest): Promise<void> {
  switch (request.kind) {
    case "hide":
      return api.blindMessage(token, request.target);
    case "temporary_restrict":
      return api.addTemporaryRestriction(token, request.targetChannelId, request.chatChannelId);
    case "restrict":
      return api.addRestriction(token, request.targetChannelId);
    case "unrestrict":
      return api.removeRestriction(token, request.targetChannelId);
    case "update_chat_settings":
      return api.updateChatSettings(token, request.settings);
  }
}

/** 감사 기록에 남길 대상 사용자. */
function targetOf(request: ActionRequest): string | null {
  if (request.kind === "hide") return request.target.senderChannelId;
  if (request.kind === "update_chat_settings") return null;
  return request.targetChannelId;
}

/** 특정 HTTP 상태의 치지직 오류인지 본다. */
function isStatus(error: unknown, status: number): boolean {
  return error instanceof ChzzkApiError && error.status === status;
}

/** 다시 시도할 만한 오류: 429, 5xx, 그리고 네트워크 오류(치지직 오류가 아닌 예외). */
function isRetryable(error: unknown): boolean {
  if (error instanceof ChzzkApiError) return error.status === 429 || error.status >= 500;
  return true;
}

/** 오류를 매니저에게 보여 줄 문장으로 바꾼다(원인과 해결 방향 포함). */
function toUserMessage(error: unknown): string {
  if (error instanceof WriteLockedError) return error.message;
  if (!(error instanceof ChzzkApiError)) return `치지직에 연결하지 못했습니다(${describeError(error)}). 네트워크를 확인하세요.`;
  if (error.status === 429) return "치지직 호출 한도를 넘었습니다. 잠시 뒤 다시 시도하세요.";
  if (error.status === 403) return "치지직이 권한 없음으로 거부했습니다. 스트리머 연결 때 동의한 권한(Scope)을 확인하세요.";
  if (error.status >= 500) return "치지직 서버 오류로 실패했습니다. 잠시 뒤 다시 시도하세요.";
  return `치지직이 요청을 거부했습니다: ${error.apiMessage}`;
}
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- executor`
Expected: PASS (9 tests)

- [ ] **Step 6: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/actions/executor.ts apps/server/test/actions/executor.test.ts apps/server/test/fakes/stubTokenManager.ts
git commit -m "feat: 쓰기 API 실행기 추가" -m "요청을 순서대로 하나씩 실행하고 429·5xx·네트워크 오류는 1·2·4초 간격으로 최대 3회 다시 시도한다. 결과는 감사 기록에 남기고, 1분 실패율이 50%를 넘으면 알린다."
```

---

### Task 16: 설정 저장소·자동 숨김 스위치·판정 처리

**Files:**
- Create: `apps/server/src/records/settingsRepository.ts`, `apps/server/src/actions/autoHideSwitch.ts`, `apps/server/src/actions/decisionHandler.ts`
- Test: `apps/server/test/actions/autoHideSwitch.test.ts`, `apps/server/test/actions/decisionHandler.test.ts`

**Interfaces:**
- Consumes: `Executor`·`Actor`(Task 15), `DetectionResult`·`MessageRef`(Task 11·14), `VerdictRepository`·`AuditLog`·`MinuteStats`(Task 12), `ChatEvent`(Task 7)
- Produces: `interface ChannelSettings extends SettingsDto { autoHideEnabled: boolean }`, `interface SettingsRepository { get(channelId): ChannelSettings; update(channelId, patch: Partial<SettingsDto>): ChannelSettings; setAutoHide(channelId, enabled): void }`, `createSettingsRepository(database)`, `class SettingsValidationError extends Error`; `interface AutoHideSwitch { isEnabled(channelId): boolean; setEnabled(channelId, enabled, actor, reason): void; tryConsume(channelId): boolean; onChange(listener: (channelId: string, enabled: boolean, reason: string) => void): void }`, `createAutoHideSwitch(deps: { settings; auditLog; clock })`; `interface Broadcaster { broadcast(event: RealtimeEvent): void; pushChatLine(line: ChatLine): void }`, `interface DecisionHandler { handle(event: ChatEvent, result: DetectionResult): void }`, `createDecisionHandler(deps: { verdicts; executor; autoHide; stats; broadcaster; logger })`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/actions/autoHideSwitch.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoHideSwitch, type AutoHideSwitch } from "../../src/actions/autoHideSwitch.js";
import { openDatabase } from "../../src/db/database.js";
import { createAuditLog, type AuditLog } from "../../src/records/auditLog.js";
import { createSettingsRepository, type SettingsRepository } from "../../src/records/settingsRepository.js";

let settings: SettingsRepository;
let auditLog: AuditLog;
let autoHide: AutoHideSwitch;
let now = 0;

beforeEach(() => {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
  database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
  settings = createSettingsRepository(database);
  auditLog = createAuditLog(database, () => now);
  autoHide = createAutoHideSwitch({ settings, auditLog, clock: () => now });
});

describe("AutoHideSwitch", () => {
  it("기본값은 꺼짐이고, 켜고 끈 기록을 남긴다", () => {
    const listener = vi.fn();
    autoHide.onChange(listener);
    expect(autoHide.isEnabled("c1")).toBe(false);
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    expect(autoHide.isEnabled("c1")).toBe(true);
    expect(settings.get("c1").autoHideEnabled).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(auditLog.list("c1", 10, null).map((entry) => entry.action)).toEqual(["auto_hide_on:manual"]);
  });

  it("1분 한도를 넘는 순간 스스로 꺼지고 그 건은 막는다", () => {
    settings.update("c1", { breakerPerMinute: 2 });
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    expect([autoHide.tryConsume("c1"), autoHide.tryConsume("c1"), autoHide.tryConsume("c1")]).toEqual([true, true, false]);
    expect(autoHide.isEnabled("c1")).toBe(false);
    expect(auditLog.list("c1", 1, null)[0]).toMatchObject({ action: "auto_hide_off:breaker", actorType: "system" });
  });

  it("1분이 지나면 다시 센다", () => {
    settings.update("c1", { breakerPerMinute: 1 });
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    expect(autoHide.tryConsume("c1")).toBe(true);
    now = 60_001;
    expect(autoHide.tryConsume("c1")).toBe(true);
  });

  it("잘못된 설정값을 거부한다", () => {
    expect(() => settings.update("c1", { breakerPerMinute: 0 })).toThrow(/1~1000/);
    expect(() => settings.update("c1", { retentionDaysContent: 400 })).toThrow(/1~365/);
  });
});
```

`apps/server/test/actions/decisionHandler.test.ts`:
```ts
import type { RealtimeEvent } from "@zzirit-guard/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoHideSwitch, type AutoHideSwitch } from "../../src/actions/autoHideSwitch.js";
import { createDecisionHandler, type DecisionHandler } from "../../src/actions/decisionHandler.js";
import type { Executor } from "../../src/actions/executor.js";
import type { ChatEvent } from "../../src/chat/chatEvent.js";
import { openDatabase } from "../../src/db/database.js";
import type { MessageRef } from "../../src/detection/floodDetectors.js";
import type { DetectionResult } from "../../src/detection/pipeline.js";
import { silentLogger } from "../../src/logger.js";
import { createAuditLog } from "../../src/records/auditLog.js";
import { createMinuteStats, type MinuteStats } from "../../src/records/minuteStats.js";
import { createSettingsRepository } from "../../src/records/settingsRepository.js";
import { createVerdictRepository, type VerdictRepository } from "../../src/records/verdictRepository.js";

let handler: DecisionHandler;
let verdicts: VerdictRepository;
let stats: MinuteStats;
let autoHide: AutoHideSwitch;
let submit: ReturnType<typeof vi.fn>;
let events: RealtimeEvent[];
let chatLines: string[];

beforeEach(() => {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
  database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
  verdicts = createVerdictRepository(database, () => 0);
  stats = createMinuteStats(database, () => 0);
  autoHide = createAutoHideSwitch({ settings: createSettingsRepository(database), auditLog: createAuditLog(database, () => 0), clock: () => 0 });
  submit = vi.fn(async () => ({ ok: true, note: null }));
  events = [];
  chatLines = [];
  handler = createDecisionHandler({
    verdicts, autoHide, stats, logger: silentLogger,
    executor: { submit, pendingCount: () => 0, onFailureRateExceeded: () => undefined } as Executor,
    broadcaster: { broadcast: (event) => events.push(event), pushChatLine: (line) => chatLines.push(`${line.decision}:${line.content}`) },
  });
});

/** 메시지 참조. */
function ref(sender: string, content: string): MessageRef {
  return { chatChannelId: "chat-1", messageTime: 1, senderChannelId: sender, nickname: sender, content, privileged: false };
}

/** 채팅 이벤트. */
function chat(content: string): ChatEvent {
  return { channelId: "c1", senderChannelId: "viewer-1", chatChannelId: "chat-1", nickname: "viewer-1", userRoleCode: "common_user", content, messageTime: 1, receivedAt: 1 };
}

/** 판정 결과. */
function result(decision: DetectionResult["decision"], content: string, extra: Partial<DetectionResult> = {}): DetectionResult {
  return { decision, reason: "rule:test", ref: ref("viewer-1", content), earlierFloodRefs: [], trivial: false, duplicate: false, ...extra };
}

/** 통계를 저장하고 첫 분의 값을 읽는다. */
function flushedStats() {
  stats.flush();
  return stats.recent("c1", 0)[0];
}

describe("DecisionHandler", () => {
  it("통과는 저장하지 않고 채팅 줄과 통계만 남긴다", () => {
    handler.handle(chat("안녕"), result("pass", "안녕", { trivial: true, duplicate: true }));
    expect(verdicts.listRecent("c1", 0)).toEqual([]);
    expect(chatLines).toEqual(["pass:안녕"]);
    expect(flushedStats()).toMatchObject({ received: 1, skipped: 1, deduplicated: 1 });
  });

  it("후보는 저장하고 방송한다", () => {
    handler.handle(chat("나쁜 말"), result("candidate", "나쁜 말"));
    expect(events).toEqual([{ type: "verdict", verdict: expect.objectContaining({ decision: "candidate", content: "나쁜 말" }) }]);
    expect(flushedStats()).toMatchObject({ candidates: 1 });
  });

  it("스위치가 꺼져 있으면 숨기지 않고 섀도로 기록한다", () => {
    handler.handle(chat("홍어"), result("auto_hide", "홍어"));
    expect(verdicts.listRecent("c1", 0)[0]).toMatchObject({ decision: "shadow" });
    expect(submit).not.toHaveBeenCalled();
    expect(chatLines).toEqual(["shadow:홍어"]);
    expect(flushedStats()).toMatchObject({ shadow: 1, auto_hidden: 0 });
  });

  it("스위치가 켜져 있으면 실행기로 숨기고, 떼도배의 앞선 메시지도 함께 숨긴다", () => {
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    handler.handle(chat("도배 문장"), result("auto_hide", "도배 문장", { earlierFloodRefs: [ref("user-1", "도배 문장"), ref("user-2", "도배 문장")] }));
    expect(submit).toHaveBeenCalledTimes(3);
    expect(submit.mock.calls.map((call) => call[1].target.senderChannelId)).toEqual(["viewer-1", "user-1", "user-2"]);
    expect(submit.mock.calls[0]?.[2]).toEqual({ type: "rule", channelId: null });
    expect(verdicts.listRecent("c1", 0).map((verdict) => verdict.decision)).toEqual(["auto_hide", "auto_hide", "auto_hide"]);
    expect(flushedStats()).toMatchObject({ auto_hidden: 3 });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- autoHideSwitch decisionHandler`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/server/src/records/settingsRepository.ts`:
```ts
import type { SettingsDto } from "@zzirit-guard/shared";
import type { Database } from "../db/database.js";

/** 채널 설정과 자동 숨김 스위치 상태. */
export interface ChannelSettings extends SettingsDto {
  autoHideEnabled: boolean;
}

/** 설정 값이 범위를 벗어난 경우. 메시지를 매니저에게 그대로 보여 준다. */
export class SettingsValidationError extends Error {
  override readonly name = "SettingsValidationError";
}

/** setting 테이블 저장소. */
export interface SettingsRepository {
  get(channelId: string): ChannelSettings;
  update(channelId: string, patch: Partial<SettingsDto>): ChannelSettings;
  setAutoHide(channelId: string, enabled: boolean): void;
}

/** 설정별 허용 범위와 DB 열 이름. */
const SETTING_RULES: Record<keyof SettingsDto, { column: string; min: number; max: number }> = {
  breakerPerMinute: { column: "breaker_per_minute", min: 1, max: 1000 },
  retentionDaysContent: { column: "retention_days_content", min: 1, max: 365 },
  retentionDaysAudit: { column: "retention_days_audit", min: 1, max: 365 },
};

/** setting 행. */
interface SettingRow {
  auto_hide_enabled: number;
  breaker_per_minute: number;
  retention_days_content: number;
  retention_days_audit: number;
}

/** 설정 저장소를 만든다. */
export function createSettingsRepository(database: Database): SettingsRepository {
  const repository: SettingsRepository = {
    get: (channelId) => readSettings(database, channelId),
    update: (channelId, patch) => {
      database.transaction(() => Object.entries(patch).forEach(([key, value]) => writeSetting(database, channelId, key as keyof SettingsDto, value)))();
      return readSettings(database, channelId);
    },
    setAutoHide: (channelId, enabled) => void database.prepare("UPDATE setting SET auto_hide_enabled = ? WHERE channel_id = ?").run(enabled ? 1 : 0, channelId),
  };
  return repository;
}

/** 설정을 읽는다. 행이 없으면 채널이 연결되지 않은 것이다. */
function readSettings(database: Database, channelId: string): ChannelSettings {
  const row = database.prepare("SELECT * FROM setting WHERE channel_id = ?").get(channelId) as SettingRow | undefined;
  if (!row) throw new SettingsValidationError("채널 설정이 없습니다. 스트리머가 먼저 채널을 연결하세요.");
  return {
    autoHideEnabled: row.auto_hide_enabled === 1,
    breakerPerMinute: row.breaker_per_minute,
    retentionDaysContent: row.retention_days_content,
    retentionDaysAudit: row.retention_days_audit,
  };
}

/** 범위를 확인한 뒤 한 항목을 쓴다. 열 이름은 고정 표에서만 가져와 SQL 주입 여지를 없앤다. */
function writeSetting(database: Database, channelId: string, key: keyof SettingsDto, value: unknown): void {
  const rule = SETTING_RULES[key];
  if (!rule) throw new SettingsValidationError(`알 수 없는 설정입니다: ${String(key)}`);
  if (typeof value !== "number" || !Number.isInteger(value) || value < rule.min || value > rule.max) {
    throw new SettingsValidationError(`${key}는 ${rule.min}~${rule.max} 사이 정수여야 합니다.`);
  }
  database.prepare(`UPDATE setting SET ${rule.column} = ? WHERE channel_id = ?`).run(value, channelId);
}
```

`apps/server/src/actions/autoHideSwitch.ts`:
```ts
import type { AuditLog } from "../records/auditLog.js";
import type { SettingsRepository } from "../records/settingsRepository.js";
import type { Clock } from "../time.js";
import type { Actor } from "./executor.js";

/** 자동 숨김 스위치와 폭주 차단기. */
export interface AutoHideSwitch {
  isEnabled(channelId: string): boolean;
  setEnabled(channelId: string, enabled: boolean, actor: Actor, reason: string): void;
  tryConsume(channelId: string): boolean;
  onChange(listener: (channelId: string, enabled: boolean, reason: string) => void): void;
}

/** createAutoHideSwitch 의존성. */
export interface AutoHideSwitchDeps {
  settings: SettingsRepository;
  auditLog: AuditLog;
  clock: Clock;
}

/** 폭주 차단 창(1분). */
const BREAKER_WINDOW_MS = 60_000;
/** 서버 자체 동작을 나타내는 행위자. */
const SYSTEM_ACTOR: Actor = { type: "system", channelId: null };

/** 스위치를 만든다. 상태는 DB(setting)에 두어 재시작해도 유지한다. */
export function createAutoHideSwitch(deps: AutoHideSwitchDeps): AutoHideSwitch {
  const recentHides = new Map<string, number[]>();
  const listeners: Array<(channelId: string, enabled: boolean, reason: string) => void> = [];
  const autoHide: AutoHideSwitch = {
    isEnabled: (channelId) => deps.settings.get(channelId).autoHideEnabled,
    setEnabled(channelId, enabled, actor, reason) {
      if (autoHide.isEnabled(channelId) === enabled) return;
      deps.settings.setAutoHide(channelId, enabled);
      deps.auditLog.record({
        channelId, actorType: actor.type, actorChannelId: actor.channelId, action: `auto_hide_${enabled ? "on" : "off"}:${reason}`,
        targetSenderChannelId: null, verdictId: null, result: "ok", error: null,
      });
      listeners.forEach((listener) => listener(channelId, enabled, reason));
    },
    tryConsume: (channelId) => consumeOrTrip(deps, autoHide, recentHides, channelId),
    onChange: (listener) => void listeners.push(listener),
  };
  return autoHide;
}

/**
 * 자동 숨김 1건을 허락할지 정한다. 1분 동안 한도만큼 이미 숨겼다면 스위치를 끄고 거절한다.
 * 실수로 "ㅋ"를 금칙어에 넣는 사고가 채팅 전체 숨김으로 번지지 않게 하려는 것이다(스펙 5.5).
 */
function consumeOrTrip(deps: AutoHideSwitchDeps, autoHide: AutoHideSwitch, recentHides: Map<string, number[]>, channelId: string): boolean {
  const now = deps.clock();
  const times = (recentHides.get(channelId) ?? []).filter((time) => time > now - BREAKER_WINDOW_MS);
  recentHides.set(channelId, times);
  if (times.length >= deps.settings.get(channelId).breakerPerMinute) {
    autoHide.setEnabled(channelId, false, SYSTEM_ACTOR, "breaker");
    return false;
  }
  times.push(now);
  return true;
}
```

`apps/server/src/actions/decisionHandler.ts`:
```ts
import type { ChatLine, RealtimeEvent } from "@zzirit-guard/shared";
import type { ChatEvent } from "../chat/chatEvent.js";
import type { MessageRef } from "../detection/floodDetectors.js";
import type { DetectionResult } from "../detection/pipeline.js";
import type { Logger } from "../logger.js";
import type { MinuteStats } from "../records/minuteStats.js";
import type { VerdictRepository } from "../records/verdictRepository.js";
import type { AutoHideSwitch } from "./autoHideSwitch.js";
import type { Executor } from "./executor.js";

/** 실시간 화면으로 보내는 통로. Task 18의 RealtimeHub가 구현한다. */
export interface Broadcaster {
  broadcast(event: RealtimeEvent): void;
  pushChatLine(line: ChatLine): void;
}

/** 판정 결과를 실제 동작(숨김·섀도·후보 저장·방송·통계)으로 옮긴다. */
export interface DecisionHandler {
  handle(event: ChatEvent, result: DetectionResult): void;
}

/** createDecisionHandler 의존성. */
export interface DecisionHandlerDeps {
  verdicts: VerdictRepository;
  executor: Executor;
  autoHide: AutoHideSwitch;
  stats: MinuteStats;
  broadcaster: Broadcaster;
  logger: Logger;
}

/** 규칙에 의한 자동 숨김 행위자. */
const RULE_ACTOR = { type: "rule" as const, channelId: null };

/** 판정 처리기를 만든다. */
export function createDecisionHandler(deps: DecisionHandlerDeps): DecisionHandler {
  return {
    handle(event, result) {
      recordTraits(deps, event.channelId, result);
      deps.broadcaster.pushChatLine({ senderNickname: event.nickname, content: event.content, messageTime: event.messageTime, decision: displayedDecision(deps, event, result) });
      if (result.decision === "candidate") saveCandidate(deps, event.channelId, result);
      if (result.decision === "auto_hide") [result.ref, ...result.earlierFloodRefs].forEach((ref) => applyAutoHide(deps, event.channelId, ref, result.reason));
    },
  };
}

/** 수신·건너뛰기·중복 건수를 센다(1단계의 핵심 측정값). */
function recordTraits(deps: DecisionHandlerDeps, channelId: string, result: DetectionResult): void {
  deps.stats.increment(channelId, "received");
  if (result.trivial) deps.stats.increment(channelId, "skipped");
  if (result.duplicate) deps.stats.increment(channelId, "deduplicated");
}

/** 실시간 채팅 화면에 보일 판정. 스위치가 꺼져 있으면 auto_hide 대신 shadow로 보인다. */
function displayedDecision(deps: DecisionHandlerDeps, event: ChatEvent, result: DetectionResult): ChatLine["decision"] {
  return result.decision === "auto_hide" && !deps.autoHide.isEnabled(event.channelId) ? "shadow" : result.decision;
}

/** 후보를 저장하고 방송한다. */
function saveCandidate(deps: DecisionHandlerDeps, channelId: string, result: DetectionResult): void {
  const verdict = deps.verdicts.insert({ ...toVerdictFields(channelId, result.ref), decision: "candidate", reason: result.reason });
  deps.broadcaster.broadcast({ type: "verdict", verdict });
  deps.stats.increment(channelId, "candidates");
}

/** 스위치가 켜져 있고 폭주 한도 안이면 숨기고, 아니면 섀도로 기록한다. */
function applyAutoHide(deps: DecisionHandlerDeps, channelId: string, ref: MessageRef, reason: string): void {
  const allowed = deps.autoHide.isEnabled(channelId) && deps.autoHide.tryConsume(channelId);
  const verdict = deps.verdicts.insert({ ...toVerdictFields(channelId, ref), decision: allowed ? "auto_hide" : "shadow", reason });
  deps.broadcaster.broadcast({ type: "verdict", verdict });
  deps.stats.increment(channelId, allowed ? "auto_hidden" : "shadow");
  if (!allowed) return;
  const target = { chatChannelId: ref.chatChannelId, messageTime: ref.messageTime, senderChannelId: ref.senderChannelId };
  void deps.executor.submit(channelId, { kind: "hide", target, verdictId: verdict.id }, RULE_ACTOR).then((outcome) => {
    if (!outcome.ok) deps.logger.warn("자동 숨김 실패", { verdictId: verdict.id, message: outcome.message });
  });
}

/** 메시지 참조를 판정 저장 필드로 옮긴다. */
function toVerdictFields(channelId: string, ref: MessageRef) {
  return {
    channelId, chatChannelId: ref.chatChannelId, messageTime: ref.messageTime,
    senderChannelId: ref.senderChannelId, senderNickname: ref.nickname, content: ref.content,
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- autoHideSwitch decisionHandler`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/records/settingsRepository.ts apps/server/src/actions/autoHideSwitch.ts apps/server/src/actions/decisionHandler.ts apps/server/test/actions/autoHideSwitch.test.ts apps/server/test/actions/decisionHandler.test.ts
git commit -m "feat: 자동 숨김 스위치·폭주 차단·판정 처리 추가" -m "스위치가 꺼져 있으면 섀도로만 기록하고, 켜져 있어도 1분 한도를 넘는 순간 스스로 꺼진다. 후보·섀도·자동 숨김은 저장 후 실시간으로 방송한다."
```

---

### Task 17: 매니저 권한·세션·로그인

**Files:**
- Create: `apps/server/src/managers/permissions.ts`, `apps/server/src/managers/roleVerifier.ts`, `apps/server/src/managers/sessionStore.ts`, `apps/server/src/managers/authFlow.ts`, `apps/server/src/managers/roleRecheck.ts`
- Test: `apps/server/test/managers/permissions.test.ts`, `apps/server/test/managers/sessionStore.test.ts`, `apps/server/test/managers/authFlow.test.ts`

**Interfaces:**
- Consumes: `ChzzkApi`(Task 5), `TokenManager`·`CredentialStore`(Task 6), `RuleRepository`(Task 9), `AppConfig`(Task 2), `Logger`
- Produces: `permissionsFor(role): Permission[]`, `hasPermission(role, permission): boolean`, `toManagerRole(userRole: string): ManagerRole | null`; `interface RoleVerifier { roleOf(channelId): Promise<ManagerRole | null>; invalidate(): void }`, `createRoleVerifier(deps: { api; tokenManager; credentialStore; clock; logger; cacheMs? })`; `interface ManagerSession { id; managerChannelId; managerChannelName; role; expiresAt; lastRoleCheckAt }`, `interface SessionStore { create(manager: { channelId; channelName; role }): { session: ManagerSession; rawId: string }; get(rawId): ManagerSession | null; getById(id): ManagerSession | null; deleteByRawId(rawId): void; deleteById(id): void; updateRole(id, role): void; listActive(): ManagerSession[]; deleteExpired(): number; issueTicket(sessionId): string; redeemTicket(ticket): ManagerSession | null }`, `SESSION_TTL_MS`, `createSessionStore(database, clock)`; `class AuthError extends Error`, `type AuthPurpose = "connect" | "login"`, `CALLBACK_PATH = "/auth/callback"`, `interface AuthFlow { authorizeUrl(purpose): string; complete(code, state): Promise<{ session: ManagerSession; rawId: string }> }`, `createAuthFlow(deps: AuthFlowDeps)`; `recheckSessionRoles(deps: { sessions; roleVerifier; logger; onRevoked(sessionIds: string[]): void }): Promise<void>`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/managers/permissions.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { hasPermission, permissionsFor, toManagerRole } from "../../src/managers/permissions.js";

describe("permissions", () => {
  it("스펙 7장 권한 표를 따른다", () => {
    expect(permissionsFor("STREAMING_CHANNEL_OWNER")).toContain("connect_channel");
    expect(hasPermission("STREAMING_CHANNEL_MANAGER", "connect_channel")).toBe(false);
    expect(hasPermission("STREAMING_CHANNEL_MANAGER", "enable_auto_hide")).toBe(true);
    expect(permissionsFor("STREAMING_CHAT_MANAGER").sort()).toEqual(["disable_auto_hide", "hide_message", "temporary_restrict"]);
  });

  it("정산 관리자와 모르는 역할은 접근할 수 없다", () => {
    expect(toManagerRole("STREAMING_SETTLEMENT_MANAGER")).toBeNull();
    expect(toManagerRole("SOMETHING_NEW")).toBeNull();
    expect(toManagerRole("STREAMING_CHAT_MANAGER")).toBe("STREAMING_CHAT_MANAGER");
  });
});
```

`apps/server/test/managers/sessionStore.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createSessionStore, SESSION_TTL_MS } from "../../src/managers/sessionStore.js";

/** 예시 매니저. */
const manager = { channelId: "m1", channelName: "매니저1", role: "STREAMING_CHAT_MANAGER" as const };

describe("SessionStore", () => {
  it("원래 세션 ID는 저장하지 않고 해시로만 찾는다", () => {
    const database = openDatabase(":memory:");
    const store = createSessionStore(database, () => 0);
    const { session, rawId } = store.create(manager);
    expect(session.id).not.toBe(rawId);
    expect(JSON.stringify(database.prepare("SELECT * FROM manager_session").all())).not.toContain(rawId);
    expect(store.get(rawId)?.managerChannelId).toBe("m1");
    expect(store.get("wrong")).toBeNull();
  });

  it("12시간이 지나면 만료된다", () => {
    let now = 0;
    const store = createSessionStore(openDatabase(":memory:"), () => now);
    const { rawId } = store.create(manager);
    now = SESSION_TTL_MS + 1;
    expect(store.get(rawId)).toBeNull();
  });

  it("WebSocket 티켓은 한 번만, 30초 안에만 쓸 수 있다", () => {
    let now = 0;
    const store = createSessionStore(openDatabase(":memory:"), () => now);
    const { session } = store.create(manager);
    const ticket = store.issueTicket(session.id);
    expect(store.redeemTicket(ticket)?.id).toBe(session.id);
    expect(store.redeemTicket(ticket)).toBeNull();
    const late = store.issueTicket(session.id);
    now = 30_001;
    expect(store.redeemTicket(late)).toBeNull();
  });
});
```

`apps/server/test/managers/authFlow.test.ts`:
```ts
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChzzkApi } from "../../src/chzzk/apiClient.js";
import { createCredentialStore, type CredentialStore } from "../../src/connection/credentialStore.js";
import { createTokenManager } from "../../src/connection/tokenManager.js";
import { openDatabase } from "../../src/db/database.js";
import { createRuleRepository, type RuleRepository } from "../../src/detection/ruleRepository.js";
import { silentLogger } from "../../src/logger.js";
import { AuthError, createAuthFlow, type AuthFlow } from "../../src/managers/authFlow.js";
import { recheckSessionRoles } from "../../src/managers/roleRecheck.js";
import { createRoleVerifier, type RoleVerifier } from "../../src/managers/roleVerifier.js";
import { createSessionStore, type SessionStore } from "../../src/managers/sessionStore.js";
import { createTokenCipher } from "../../src/security/tokenCipher.js";
import { startFakeChzzk, type FakeChzzk } from "../fakes/fakeChzzk.js";

let fake: FakeChzzk;
let authFlow: AuthFlow;
let credentialStore: CredentialStore;
let sessions: SessionStore;
let rules: RuleRepository;
let roleVerifier: RoleVerifier;
let connectedCount: number;

beforeEach(async () => {
  fake = await startFakeChzzk();
  const database = openDatabase(":memory:");
  const api = createChzzkApi({ apiBase: fake.baseUrl, clientId: "test-client", clientSecret: "test-secret" });
  credentialStore = createCredentialStore(database, createTokenCipher(randomBytes(32)), Date.now);
  const tokenManager = createTokenManager({ store: credentialStore, api, clock: Date.now });
  sessions = createSessionStore(database, Date.now);
  rules = createRuleRepository(database, Date.now);
  roleVerifier = createRoleVerifier({ api, tokenManager, credentialStore, clock: Date.now, logger: silentLogger });
  connectedCount = 0;
  authFlow = createAuthFlow({
    config: { chzzkClientId: "test-client", chzzkAuthorizeUrl: "https://chzzk.example/account-interlock", publicOrigin: "https://guard.example", channelId: fake.owner.channelId },
    api, tokenManager, credentialStore, roleVerifier, sessions, rules, clock: Date.now, onChannelConnected: () => { connectedCount += 1; },
  });
});
afterEach(async () => fake.close());

/** authorizeUrl에서 state를 꺼낸다. */
function stateFor(purpose: "connect" | "login"): string {
  const url = new URL(authFlow.authorizeUrl(purpose));
  expect(url.searchParams.get("redirectUri")).toBe("https://guard.example/auth/callback");
  expect(url.searchParams.get("clientId")).toBe("test-client");
  return url.searchParams.get("state") as string;
}

/** 매니저 계정. */
const managerUser = { channelId: "manager-1", channelName: "매니저1" };

describe("AuthFlow", () => {
  it("스트리머가 연결하면 토큰을 저장하고 기본 규칙을 넣고 소유자 세션을 만든다", async () => {
    const { session } = await authFlow.complete(fake.grantCode(fake.owner), stateFor("connect"));
    expect(session.role).toBe("STREAMING_CHANNEL_OWNER");
    expect(credentialStore.loadChannel()).toEqual(fake.owner);
    expect(rules.list(fake.owner.channelId).length).toBeGreaterThan(0);
    expect(connectedCount).toBe(1);
  });

  it("설정한 채널이 아니면 연결을 거부한다(공개 주소 가로채기 방지)", async () => {
    await expect(authFlow.complete(fake.grantCode(managerUser), stateFor("connect"))).rejects.toThrow(/연결할 수 있는 채널이 아닙니다/);
    expect(credentialStore.loadChannel()).toBeNull();
  });

  it("연결 전에는 로그인할 수 없다", async () => {
    await expect(authFlow.complete(fake.grantCode(managerUser), stateFor("login"))).rejects.toThrow(/스트리머가 먼저/);
  });

  it("관리자 목록에 있는 매니저는 그 역할로, 없으면 거부한다", async () => {
    await authFlow.complete(fake.grantCode(fake.owner), stateFor("connect"));
    fake.streamingRoles.push({ managerChannelId: "manager-1", managerChannelName: "매니저1", userRole: "STREAMING_CHAT_MANAGER" });
    roleVerifier.invalidate();
    const { session } = await authFlow.complete(fake.grantCode(managerUser), stateFor("login"));
    expect(session.role).toBe("STREAMING_CHAT_MANAGER");
    const stranger = { channelId: "stranger", channelName: "모르는 사람" };
    await expect(authFlow.complete(fake.grantCode(stranger), stateFor("login"))).rejects.toThrow(/매니저가 아닙니다/);
  });

  it("state는 한 번만 쓸 수 있다", async () => {
    const state = stateFor("connect");
    await authFlow.complete(fake.grantCode(fake.owner), state);
    await expect(authFlow.complete(fake.grantCode(fake.owner), state)).rejects.toBeInstanceOf(AuthError);
  });

  it("스트리머가 로그인하면 새 토큰으로 바꿔 둔다", async () => {
    await authFlow.complete(fake.grantCode(fake.owner), stateFor("connect"));
    const before = credentialStore.loadCredential()?.accessToken;
    await authFlow.complete(fake.grantCode(fake.owner), stateFor("login"));
    expect(credentialStore.loadCredential()?.accessToken).not.toBe(before);
  });

  it("치지직에서 해임된 매니저의 세션은 다음 확인 때 끊긴다", async () => {
    await authFlow.complete(fake.grantCode(fake.owner), stateFor("connect"));
    fake.streamingRoles.push({ managerChannelId: "manager-1", managerChannelName: "매니저1", userRole: "STREAMING_CHANNEL_MANAGER" });
    roleVerifier.invalidate();
    const { session } = await authFlow.complete(fake.grantCode(managerUser), stateFor("login"));
    fake.streamingRoles.splice(0);
    roleVerifier.invalidate();
    const onRevoked = vi.fn();
    await recheckSessionRoles({ sessions, roleVerifier, logger: silentLogger, onRevoked });
    expect(onRevoked).toHaveBeenCalledWith([session.id]);
    expect(sessions.getById(session.id)).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- managers`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/server/src/managers/permissions.ts`:
```ts
import type { ManagerRole, Permission } from "@zzirit-guard/shared";

/** 모든 권한. */
const ALL_PERMISSIONS: readonly Permission[] = [
  "connect_channel", "disable_auto_hide", "enable_auto_hide", "edit_rules", "hide_message",
  "temporary_restrict", "restrict", "edit_chat_settings", "view_audit",
];

/**
 * 역할별 권한(스펙 7장). 끄기는 안전한 방향이라 채팅 운영자에게도 준다.
 * 채널 연결·해제는 스트리머만 한다.
 */
const ROLE_PERMISSIONS: Readonly<Record<ManagerRole, readonly Permission[]>> = {
  STREAMING_CHANNEL_OWNER: ALL_PERMISSIONS,
  STREAMING_CHANNEL_MANAGER: ALL_PERMISSIONS.filter((permission) => permission !== "connect_channel"),
  STREAMING_CHAT_MANAGER: ["disable_auto_hide", "hide_message", "temporary_restrict"],
};

/** 역할의 권한 목록. */
export function permissionsFor(role: ManagerRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/** 역할이 권한을 가졌는지 본다. */
export function hasPermission(role: ManagerRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** 치지직 userRole 문자열을 앱 역할로 바꾼다. 정산 관리자·모르는 역할은 null(접근 불가). */
export function toManagerRole(userRole: string): ManagerRole | null {
  return userRole in ROLE_PERMISSIONS ? (userRole as ManagerRole) : null;
}
```

`apps/server/src/managers/roleVerifier.ts`:
```ts
import type { ManagerRole } from "@zzirit-guard/shared";
import type { ChzzkApi, StreamingRole } from "../chzzk/apiClient.js";
import type { CredentialStore } from "../connection/credentialStore.js";
import type { TokenManager } from "../connection/tokenManager.js";
import { describeError, type Logger } from "../logger.js";
import type { Clock } from "../time.js";
import { toManagerRole } from "./permissions.js";

/** 치지직 계정이 이 채널에서 어떤 역할인지 확인한다. */
export interface RoleVerifier {
  roleOf(channelId: string): Promise<ManagerRole | null>;
  invalidate(): void;
}

/** createRoleVerifier 의존성. */
export interface RoleVerifierDeps {
  api: ChzzkApi;
  tokenManager: TokenManager;
  credentialStore: CredentialStore;
  clock: Clock;
  logger: Logger;
  cacheMs?: number;
}

/** 관리자 목록 캐시 기본값(5분, 스펙 7장). */
const DEFAULT_CACHE_MS = 5 * 60 * 1000;

/** 역할 확인기를 만든다. */
export function createRoleVerifier(deps: RoleVerifierDeps): RoleVerifier {
  let cache: { fetchedAt: number; roles: StreamingRole[] } | null = null;
  const cacheMs = deps.cacheMs ?? DEFAULT_CACHE_MS;

  /** 캐시가 신선하면 쓰고, 아니면 스트리머 토큰으로 다시 받는다. 받기에 실패하면 오래된 캐시라도 쓴다. */
  async function loadRoles(): Promise<StreamingRole[]> {
    if (cache && deps.clock() - cache.fetchedAt < cacheMs) return cache.roles;
    try {
      cache = { fetchedAt: deps.clock(), roles: await deps.api.getStreamingRoles(await deps.tokenManager.getAccessToken()) };
      return cache.roles;
    } catch (error) {
      if (!cache) throw new Error(`치지직 관리자 목록을 확인하지 못했습니다(${describeError(error)}). 잠시 뒤 다시 시도하세요.`);
      deps.logger.warn("관리자 목록 갱신 실패, 이전 목록을 씁니다", { error: describeError(error) });
      return cache.roles;
    }
  }

  return {
    async roleOf(channelId) {
      const channel = deps.credentialStore.loadChannel();
      if (!channel) return null;
      if (channel.channelId === channelId) return "STREAMING_CHANNEL_OWNER";
      const match = (await loadRoles()).find((role) => role.managerChannelId === channelId);
      return match ? toManagerRole(match.userRole) : null;
    },
    invalidate: () => {
      cache = null;
    },
  };
}
```

`apps/server/src/managers/sessionStore.ts`:
```ts
import { createHash, randomBytes } from "node:crypto";
import type { ManagerRole } from "@zzirit-guard/shared";
import type { Database } from "../db/database.js";
import type { Clock } from "../time.js";

/** 매니저 세션. id는 쿠키 값의 SHA-256이다(DB가 새도 세션을 훔칠 수 없게). */
export interface ManagerSession {
  id: string;
  managerChannelId: string;
  managerChannelName: string;
  role: ManagerRole;
  expiresAt: number;
  lastRoleCheckAt: number;
}

/** 세션·WebSocket 티켓 저장소. */
export interface SessionStore {
  create(manager: { channelId: string; channelName: string; role: ManagerRole }): { session: ManagerSession; rawId: string };
  get(rawId: string): ManagerSession | null;
  getById(id: string): ManagerSession | null;
  deleteByRawId(rawId: string): void;
  deleteById(id: string): void;
  updateRole(id: string, role: ManagerRole): void;
  listActive(): ManagerSession[];
  deleteExpired(): number;
  issueTicket(sessionId: string): string;
  redeemTicket(ticket: string): ManagerSession | null;
}

/** 세션 유효 기간(12시간, 스펙 8장). */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** WebSocket 티켓 유효 기간(30초). */
const TICKET_TTL_MS = 30_000;

/** manager_session 행. */
interface SessionRow {
  id: string;
  manager_channel_id: string;
  manager_channel_name: string;
  role: ManagerRole;
  expires_at: number;
  last_role_check_at: number;
}

/** 쿠키 값 → 저장용 해시. */
function hashSessionId(rawId: string): string {
  return createHash("sha256").update(rawId).digest("hex");
}

/** 세션 저장소를 만든다. 티켓은 수명이 짧아 메모리에만 둔다. */
export function createSessionStore(database: Database, clock: Clock): SessionStore {
  const tickets = new Map<string, { sessionId: string; expiresAt: number }>();
  const getById = (id: string) => readSession(database, id, clock());
  return {
    create: (manager) => insertSession(database, manager, clock()),
    get: (rawId) => getById(hashSessionId(rawId)),
    getById,
    deleteByRawId: (rawId) => void database.prepare("DELETE FROM manager_session WHERE id = ?").run(hashSessionId(rawId)),
    deleteById: (id) => void database.prepare("DELETE FROM manager_session WHERE id = ?").run(id),
    updateRole: (id, role) => void database.prepare("UPDATE manager_session SET role = ?, last_role_check_at = ? WHERE id = ?").run(role, clock(), id),
    listActive: () => (database.prepare("SELECT * FROM manager_session WHERE expires_at > ?").all(clock()) as SessionRow[]).map(toSession),
    deleteExpired: () => database.prepare("DELETE FROM manager_session WHERE expires_at <= ?").run(clock()).changes,
    issueTicket: (sessionId) => issueTicket(tickets, sessionId, clock()),
    redeemTicket: (ticket) => {
      const entry = tickets.get(ticket);
      tickets.delete(ticket);
      return entry && entry.expiresAt > clock() ? getById(entry.sessionId) : null;
    },
  };
}

/** 무작위 세션 ID를 만들어 해시만 저장한다. */
function insertSession(database: Database, manager: { channelId: string; channelName: string; role: ManagerRole }, now: number) {
  const rawId = randomBytes(32).toString("base64url");
  const session: ManagerSession = {
    id: hashSessionId(rawId), managerChannelId: manager.channelId, managerChannelName: manager.channelName,
    role: manager.role, expiresAt: now + SESSION_TTL_MS, lastRoleCheckAt: now,
  };
  database
    .prepare("INSERT INTO manager_session (id, manager_channel_id, manager_channel_name, role, expires_at, last_role_check_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(session.id, session.managerChannelId, session.managerChannelName, session.role, session.expiresAt, session.lastRoleCheckAt);
  return { session, rawId };
}

/** 만료되지 않은 세션을 읽는다. 만료됐으면 지우고 null. */
function readSession(database: Database, id: string, now: number): ManagerSession | null {
  const row = database.prepare("SELECT * FROM manager_session WHERE id = ?").get(id) as SessionRow | undefined;
  if (!row) return null;
  if (row.expires_at <= now) {
    database.prepare("DELETE FROM manager_session WHERE id = ?").run(id);
    return null;
  }
  return toSession(row);
}

/** 일회용 티켓을 발급한다. 오래된 티켓도 함께 치운다. */
function issueTicket(tickets: Map<string, { sessionId: string; expiresAt: number }>, sessionId: string, now: number): string {
  for (const [key, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(key);
  const ticket = randomBytes(24).toString("base64url");
  tickets.set(ticket, { sessionId, expiresAt: now + TICKET_TTL_MS });
  return ticket;
}

/** 행을 세션으로 바꾼다. */
function toSession(row: SessionRow): ManagerSession {
  return {
    id: row.id, managerChannelId: row.manager_channel_id, managerChannelName: row.manager_channel_name,
    role: row.role, expiresAt: row.expires_at, lastRoleCheckAt: row.last_role_check_at,
  };
}
```

`apps/server/src/managers/authFlow.ts`:
```ts
import { randomBytes } from "node:crypto";
import type { ChzzkApi, ChzzkUser, TokenSet } from "../chzzk/apiClient.js";
import type { AppConfig } from "../config.js";
import type { CredentialStore } from "../connection/credentialStore.js";
import type { TokenManager } from "../connection/tokenManager.js";
import type { RuleRepository } from "../detection/ruleRepository.js";
import type { Clock } from "../time.js";
import type { RoleVerifier } from "./roleVerifier.js";
import type { ManagerSession, SessionStore } from "./sessionStore.js";

/** 로그인·연결 실패. 메시지를 로그인 화면에 그대로 보여 준다. */
export class AuthError extends Error {
  override readonly name = "AuthError";
}

/** connect: 스트리머 채널 연결, login: 매니저(또는 스트리머) 로그인. */
export type AuthPurpose = "connect" | "login";

/** 치지직 앱 설정의 "로그인 리디렉션 URL"에 publicOrigin + 이 경로를 등록해야 한다. */
export const CALLBACK_PATH = "/auth/callback";

/** OAuth state 유효 기간(10분). */
const STATE_TTL_MS = 10 * 60 * 1000;

/** createAuthFlow 의존성. */
export interface AuthFlowDeps {
  config: Pick<AppConfig, "chzzkClientId" | "chzzkAuthorizeUrl" | "publicOrigin" | "channelId">;
  api: ChzzkApi;
  tokenManager: TokenManager;
  credentialStore: CredentialStore;
  roleVerifier: RoleVerifier;
  sessions: SessionStore;
  rules: RuleRepository;
  clock: Clock;
  onChannelConnected(): void;
}

/** 치지직 OAuth로 채널을 연결하고 매니저를 로그인시킨다. */
export interface AuthFlow {
  authorizeUrl(purpose: AuthPurpose): string;
  complete(code: string, state: string): Promise<{ session: ManagerSession; rawId: string }>;
}

/** 인증 흐름을 만든다. state는 메모리에 두고 한 번 쓰면 지운다(재사용·위조 방지). */
export function createAuthFlow(deps: AuthFlowDeps): AuthFlow {
  const states = new Map<string, { purpose: AuthPurpose; createdAt: number }>();
  return {
    authorizeUrl: (purpose) => buildAuthorizeUrl(deps, states, purpose),
    async complete(code, state) {
      const purpose = takeState(states, state, deps.clock());
      const tokens = await deps.api.exchangeCode(code, state);
      const user = await deps.api.getMe(tokens.accessToken);
      return purpose === "connect" ? connectChannel(deps, user, tokens) : login(deps, user, tokens);
    },
  };
}

/** 치지직 인증 페이지 주소를 만든다. */
function buildAuthorizeUrl(deps: AuthFlowDeps, states: Map<string, { purpose: AuthPurpose; createdAt: number }>, purpose: AuthPurpose): string {
  const now = deps.clock();
  for (const [key, entry] of states) if (now - entry.createdAt > STATE_TTL_MS) states.delete(key);
  const state = randomBytes(16).toString("base64url");
  states.set(state, { purpose, createdAt: now });
  const url = new URL(deps.config.chzzkAuthorizeUrl);
  url.searchParams.set("clientId", deps.config.chzzkClientId);
  url.searchParams.set("redirectUri", deps.config.publicOrigin + CALLBACK_PATH);
  url.searchParams.set("state", state);
  return url.toString();
}

/** state를 꺼내고 지운다. 없거나 만료됐으면 AuthError. */
function takeState(states: Map<string, { purpose: AuthPurpose; createdAt: number }>, state: string, now: number): AuthPurpose {
  const entry = states.get(state);
  states.delete(state);
  if (!entry || now - entry.createdAt > STATE_TTL_MS) throw new AuthError("로그인 요청이 만료되었거나 잘못되었습니다. 처음부터 다시 시도하세요.");
  return entry.purpose;
}

/** 스트리머 채널 연결: 설정한 채널만 허용하고, 토큰 저장·기본 규칙·소유자 세션까지 만든다. */
function connectChannel(deps: AuthFlowDeps, user: ChzzkUser, tokens: TokenSet) {
  if (user.channelId !== deps.config.channelId) {
    throw new AuthError(`이 서버에 연결할 수 있는 채널이 아닙니다(${user.channelName}). 운영자가 설정한 스트리머 계정으로 로그인하세요.`);
  }
  adoptTokens(deps, user, tokens);
  deps.rules.seedDefaults(user.channelId);
  return deps.sessions.create({ channelId: user.channelId, channelName: user.channelName, role: "STREAMING_CHANNEL_OWNER" });
}

/** 로그인: 스트리머 본인이면 토큰을 새것으로 바꾸고, 아니면 관리자 목록으로 역할을 확인한다. 매니저 토큰은 버린다(revoke 금지). */
async function login(deps: AuthFlowDeps, user: ChzzkUser, tokens: TokenSet) {
  const channel = deps.credentialStore.loadChannel();
  if (!channel) throw new AuthError("아직 연결된 채널이 없습니다. 스트리머가 먼저 '채널 연결'을 해야 합니다.");
  if (user.channelId === channel.channelId) return connectChannel(deps, user, tokens);
  const role = await deps.roleVerifier.roleOf(user.channelId);
  if (!role) throw new AuthError("이 채널의 매니저가 아닙니다. 치지직에서 채널 관리자나 채팅 운영자로 등록돼 있어야 합니다.");
  return deps.sessions.create({ channelId: user.channelId, channelName: user.channelName, role });
}

/** 새 토큰을 채널 연결로 저장하고, 수신기 재시작 등을 알린다. */
function adoptTokens(deps: AuthFlowDeps, user: ChzzkUser, tokens: TokenSet): void {
  try {
    deps.tokenManager.adoptCredential(
      { channelId: user.channelId, channelName: user.channelName },
      { channelId: user.channelId, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessExpiresAt: deps.clock() + tokens.expiresInSeconds * 1000 },
    );
  } catch (error) {
    throw new AuthError(error instanceof Error ? error.message : String(error));
  }
  deps.roleVerifier.invalidate();
  deps.onChannelConnected();
}
```

`apps/server/src/managers/roleRecheck.ts`:
```ts
import { describeError, type Logger } from "../logger.js";
import type { RoleVerifier } from "./roleVerifier.js";
import type { SessionStore } from "./sessionStore.js";

/** recheckSessionRoles 의존성. onRevoked는 끊긴 세션의 WebSocket을 닫는 데 쓴다. */
export interface RoleRecheckDeps {
  sessions: SessionStore;
  roleVerifier: RoleVerifier;
  logger: Logger;
  onRevoked(sessionIds: string[]): void;
}

/**
 * 활성 세션의 역할을 다시 확인한다(5분마다). 치지직에서 해임된 매니저는 세션을 지우고,
 * 역할이 바뀌었으면 갱신한다. 치지직 장애로 확인을 못 하면 세션을 유지한다(모두를 끊지 않도록).
 */
export async function recheckSessionRoles(deps: RoleRecheckDeps): Promise<void> {
  const revoked: string[] = [];
  for (const session of deps.sessions.listActive()) {
    try {
      const role = await deps.roleVerifier.roleOf(session.managerChannelId);
      if (!role) revoked.push(session.id);
      else if (role !== session.role) deps.sessions.updateRole(session.id, role);
    } catch (error) {
      deps.logger.warn("역할 재확인 실패, 세션을 유지합니다", { sessionManager: session.managerChannelId, error: describeError(error) });
    }
  }
  revoked.forEach((id) => deps.sessions.deleteById(id));
  if (revoked.length > 0) deps.onRevoked(revoked);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- managers`
Expected: PASS (12 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/managers apps/server/test/managers
git commit -m "feat: 매니저 권한·세션·치지직 로그인 추가" -m "설정한 스트리머 채널만 연결할 수 있고, 매니저는 관리자 목록으로 역할을 확인한다. 세션 ID는 해시로만 저장하고, 해임된 매니저는 5분마다 다시 확인해 끊는다. 매니저 토큰은 저장하지도 폐기하지도 않는다."
```

---

### Task 18: 실시간 허브(WebSocket 방송)

**Files:**
- Create: `apps/server/src/realtime/hub.ts`
- Test: `apps/server/test/realtime/hub.test.ts`

**Interfaces:**
- Consumes: `Broadcaster`(Task 16), `ManagerSession`(Task 17)
- Produces: `interface SocketSink { readyState: number; send(data: string): void; close(code?: number, reason?: string): void; on(event: "close", listener: () => void): unknown }`, `interface RealtimeHub extends Broadcaster { attach(socket: SocketSink, session: ManagerSession): void; closeSessions(sessionIds: readonly string[], reason: string): void; connectionCount(): number; flush(): void; stop(): void }`, `createRealtimeHub(options?: { flushIntervalMs?: number; maxLinesPerFlush?: number })`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/realtime/hub.test.ts`:
```ts
import type { RealtimeEvent } from "@zzirit-guard/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagerSession } from "../../src/managers/sessionStore.js";
import { createRealtimeHub, type RealtimeHub, type SocketSink } from "../../src/realtime/hub.js";

let hub: RealtimeHub;
afterEach(() => hub.stop());

/** 받은 메시지를 모으는 가짜 소켓. */
function fakeSocket(readyState = 1) {
  const sent: RealtimeEvent[] = [];
  let closeListener: () => void = () => undefined;
  const socket: SocketSink & { sent: RealtimeEvent[]; closedWith: number | null; fireClose(): void } = {
    readyState, sent, closedWith: null,
    send: (data) => void sent.push(JSON.parse(data) as RealtimeEvent),
    close: (code) => void (socket.closedWith = code ?? null),
    on: (_event, listener) => void (closeListener = listener),
    fireClose: () => closeListener(),
  };
  return socket;
}

/** 세션 예시. */
function session(id: string): ManagerSession {
  return { id, managerChannelId: id, managerChannelName: id, role: "STREAMING_CHAT_MANAGER", expiresAt: 0, lastRoleCheckAt: 0 };
}

describe("RealtimeHub", () => {
  it("열린 소켓에만 방송하고, 닫힌 소켓은 목록에서 뺀다", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    const open = fakeSocket();
    const closing = fakeSocket(2);
    hub.attach(open, session("s1"));
    hub.attach(closing, session("s2"));
    hub.broadcast({ type: "verdict_status", verdictId: 1, status: "hidden" });
    expect(open.sent).toHaveLength(1);
    expect(closing.sent).toHaveLength(0);
    open.fireClose();
    expect(hub.connectionCount()).toBe(1);
  });

  it("채팅 줄을 모아 한 번에 보내고, 넘치면 최신 것만 남긴다", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000, maxLinesPerFlush: 2 });
    const socket = fakeSocket();
    hub.attach(socket, session("s1"));
    for (const content of ["a", "b", "c"]) hub.pushChatLine({ senderNickname: "n", content, messageTime: 1, decision: "pass" });
    hub.flush();
    hub.flush();
    expect(socket.sent).toEqual([{ type: "chat_batch", lines: [expect.objectContaining({ content: "b" }), expect.objectContaining({ content: "c" })] }]);
  });

  it("끊을 세션에는 이유를 보낸 뒤 닫는다", () => {
    hub = createRealtimeHub({ flushIntervalMs: 60_000 });
    const target = fakeSocket();
    const other = fakeSocket();
    hub.attach(target, session("s1"));
    hub.attach(other, session("s2"));
    hub.closeSessions(["s1"], "매니저 권한이 해제되었습니다");
    expect(target.sent).toEqual([{ type: "session_ended", reason: "매니저 권한이 해제되었습니다" }]);
    expect(target.closedWith).toBe(4001);
    expect(other.closedWith).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- hub`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/server/src/realtime/hub.ts`:
```ts
import type { ChatLine, RealtimeEvent } from "@zzirit-guard/shared";
import type { Broadcaster } from "../actions/decisionHandler.js";
import type { ManagerSession } from "../managers/sessionStore.js";

/** 허브가 쓰는 WebSocket 기능(ws 라이브러리 소켓이 그대로 맞는다). */
export interface SocketSink {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): unknown;
}

/** 매니저 화면으로 실시간 이벤트를 보낸다. */
export interface RealtimeHub extends Broadcaster {
  attach(socket: SocketSink, session: ManagerSession): void;
  closeSessions(sessionIds: readonly string[], reason: string): void;
  connectionCount(): number;
  flush(): void;
  stop(): void;
}

/** WebSocket OPEN 상태 값. */
const OPEN = 1;
/** 세션 종료로 닫을 때 쓰는 앱 전용 닫기 코드. 화면은 이 코드를 보고 재연결 대신 로그인으로 보낸다. */
const SESSION_ENDED_CLOSE_CODE = 4001;
/** 채팅 묶음 전송 기본값: 250ms마다 최대 100줄. 초당 수십 건이어도 휴대폰이 버틸 만큼만 보낸다. */
const DEFAULTS = { flushIntervalMs: 250, maxLinesPerFlush: 100 };

/** 허브를 만든다. */
export function createRealtimeHub(options: Partial<typeof DEFAULTS> = {}): RealtimeHub {
  const settings = { ...DEFAULTS, ...options };
  const connections = new Map<SocketSink, string>();
  let pendingLines: ChatLine[] = [];

  const sendToAll = (event: RealtimeEvent) => {
    const data = JSON.stringify(event);
    connections.forEach((_sessionId, socket) => {
      if (socket.readyState === OPEN) socket.send(data);
    });
  };
  const flush = () => {
    if (pendingLines.length === 0) return;
    const lines = pendingLines.slice(-settings.maxLinesPerFlush);
    pendingLines = [];
    sendToAll({ type: "chat_batch", lines });
  };
  const timer = setInterval(flush, settings.flushIntervalMs);

  return {
    broadcast: sendToAll,
    pushChatLine: (line) => void pendingLines.push(line),
    attach(socket, session) {
      connections.set(socket, session.id);
      socket.on("close", () => connections.delete(socket));
    },
    closeSessions: (sessionIds, reason) => closeMatching(connections, new Set(sessionIds), reason),
    connectionCount: () => connections.size,
    flush,
    stop() {
      clearInterval(timer);
      connections.forEach((_sessionId, socket) => socket.close(1001, "server stopping"));
      connections.clear();
    },
  };
}

/** 지정한 세션의 소켓에 종료 이유를 보내고 닫는다. */
function closeMatching(connections: Map<SocketSink, string>, sessionIds: ReadonlySet<string>, reason: string): void {
  const message = JSON.stringify({ type: "session_ended", reason } satisfies RealtimeEvent);
  for (const [socket, sessionId] of connections) {
    if (!sessionIds.has(sessionId)) continue;
    if (socket.readyState === OPEN) socket.send(message);
    socket.close(SESSION_ENDED_CLOSE_CODE, "session ended");
    connections.delete(socket);
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- hub`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/realtime apps/server/test/realtime
git commit -m "feat: WebSocket 실시간 허브 추가" -m "판정·상태는 바로 방송하고, 채팅 줄은 250ms마다 최대 100줄로 묶어 보낸다. 끊을 세션에는 이유를 보내고 전용 코드(4001)로 닫는다."
```

---

### Task 19: Web Push 알림

**Files:**
- Create: `apps/server/src/push/pushNotifier.ts`
- Test: `apps/server/test/push/pushNotifier.test.ts`

**Interfaces:**
- Consumes: `Database`, `Clock`, `Logger`
- Produces: `interface PushSubscriptionInput { endpoint: string; keys: { p256dh: string; auth: string } }`, `interface PushMessage { title: string; body: string }`, `type PushSender = (subscription: PushSubscriptionInput, payload: string, options: webpush.RequestOptions) => Promise<unknown>`, `interface PushNotifier { publicKey(): string; subscribe(managerChannelId, subscription): void; unsubscribe(endpoint): void; notifyAll(message): Promise<void> }`, `createPushNotifier(deps: { database; clock; logger; vapid: { publicKey; privateKey; subject }; send?: PushSender })`

- [ ] **Step 1: 의존성 설치**

```bash
npm install --save-exact -w @zzirit-guard/server web-push@3.6.7
npm install --save-dev --save-exact -w @zzirit-guard/server @types/web-push@3.6.4
```

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/server/test/push/pushNotifier.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import type { Logger } from "../../src/logger.js";
import { createPushNotifier, type PushSender } from "../../src/push/pushNotifier.js";

/** VAPID 설정 예시. */
const vapid = { publicKey: "public-key", privateKey: "private-key", subject: "mailto:owner@example.com" };

/** 구독 예시. */
function subscription(endpoint: string) {
  return { endpoint, keys: { p256dh: "p", auth: "a" } };
}

describe("PushNotifier", () => {
  it("같은 endpoint는 한 번만 저장하고 모두에게 보낸다", async () => {
    const database = openDatabase(":memory:");
    const send = vi.fn<PushSender>(async () => ({}));
    const notifier = createPushNotifier({ database, clock: () => 0, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, vapid, send });
    notifier.subscribe("m1", subscription("https://push.example/1"));
    notifier.subscribe("m1", subscription("https://push.example/1"));
    notifier.subscribe("m2", subscription("https://push.example/2"));
    await notifier.notifyAll({ title: "찌리릿 가드", body: "재연결이 필요합니다" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[0]?.[1] as string)).toEqual({ title: "찌리릿 가드", body: "재연결이 필요합니다" });
    expect(send.mock.calls[0]?.[2]).toMatchObject({ vapidDetails: vapid });
  });

  it("사라진 구독(410)은 지우고, 다른 실패는 기록만 한다", async () => {
    const database = openDatabase(":memory:");
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const send = vi.fn<PushSender>(async (target) => {
      throw Object.assign(new Error("push failed"), { statusCode: target.endpoint.endsWith("gone") ? 410 : 500 });
    });
    const notifier = createPushNotifier({ database, clock: () => 0, logger, vapid, send });
    notifier.subscribe("m1", subscription("https://push.example/gone"));
    notifier.subscribe("m2", subscription("https://push.example/flaky"));
    await notifier.notifyAll({ title: "t", body: "b" });
    const endpoints = database.prepare("SELECT endpoint FROM push_subscription").all();
    expect(endpoints).toEqual([{ endpoint: "https://push.example/flaky" }]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- pushNotifier`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: 구현**

`apps/server/src/push/pushNotifier.ts`:
```ts
import webpush from "web-push";
import type { Database } from "../db/database.js";
import { describeError, type Logger } from "../logger.js";
import type { Clock } from "../time.js";

/** 브라우저가 준 푸시 구독 정보. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** 알림 내용. 서비스 워커가 그대로 표시한다. */
export interface PushMessage {
  title: string;
  body: string;
}

/** 실제 전송 함수. 테스트에서 바꿔 끼운다. */
export type PushSender = (subscription: PushSubscriptionInput, payload: string, options: webpush.RequestOptions) => Promise<unknown>;

/** 매니저 휴대폰으로 장애 알림을 보낸다(스펙 6장). */
export interface PushNotifier {
  publicKey(): string;
  subscribe(managerChannelId: string, subscription: PushSubscriptionInput): void;
  unsubscribe(endpoint: string): void;
  notifyAll(message: PushMessage): Promise<void>;
}

/** createPushNotifier 의존성. */
export interface PushNotifierDeps {
  database: Database;
  clock: Clock;
  logger: Logger;
  vapid: { publicKey: string; privateKey: string; subject: string };
  send?: PushSender;
}

/** 구독이 사라졌다는 뜻의 상태 코드. 이 구독은 지운다. */
const GONE_STATUS_CODES: ReadonlySet<number> = new Set([404, 410]);
/** 푸시 서비스가 알림을 보관하는 시간(초). 장애 알림은 늦게 오면 의미가 없어 짧게 둔다. */
const PUSH_TTL_SECONDS = 300;

/** push_subscription 행. */
interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** 푸시 알림기를 만든다. */
export function createPushNotifier(deps: PushNotifierDeps): PushNotifier {
  const send: PushSender = deps.send ?? ((subscription, payload, options) => webpush.sendNotification(subscription, payload, options));
  return {
    publicKey: () => deps.vapid.publicKey,
    subscribe: (managerChannelId, subscription) =>
      void deps.database
        .prepare(
          `INSERT INTO push_subscription (manager_channel_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (endpoint) DO UPDATE SET manager_channel_id = excluded.manager_channel_id, p256dh = excluded.p256dh, auth = excluded.auth`,
        )
        .run(managerChannelId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, deps.clock()),
    unsubscribe: (endpoint) => void deps.database.prepare("DELETE FROM push_subscription WHERE endpoint = ?").run(endpoint),
    notifyAll: (message) => notifyAll(deps, send, message),
  };
}

/** 모든 구독에 보낸다. 하나가 실패해도 나머지는 보낸다. */
async function notifyAll(deps: PushNotifierDeps, send: PushSender, message: PushMessage): Promise<void> {
  const rows = deps.database.prepare("SELECT endpoint, p256dh, auth FROM push_subscription").all() as SubscriptionRow[];
  const options: webpush.RequestOptions = { vapidDetails: deps.vapid, TTL: PUSH_TTL_SECONDS };
  const payload = JSON.stringify(message);
  await Promise.all(rows.map((row) => sendOne(deps, send, row, payload, options)));
}

/** 한 구독에 보낸다. 사라진 구독은 지우고, 그 밖의 실패는 기록한다. */
async function sendOne(deps: PushNotifierDeps, send: PushSender, row: SubscriptionRow, payload: string, options: webpush.RequestOptions): Promise<void> {
  try {
    await send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload, options);
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode !== undefined && GONE_STATUS_CODES.has(statusCode)) {
      deps.database.prepare("DELETE FROM push_subscription WHERE endpoint = ?").run(row.endpoint);
      return;
    }
    deps.logger.warn("푸시 알림 전송 실패", { statusCode, error: describeError(error) });
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- pushNotifier`
Expected: PASS (2 tests)

- [ ] **Step 6: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/push apps/server/test/push apps/server/package.json package-lock.json
git commit -m "feat: Web Push 장애 알림 추가" -m "매니저 휴대폰에 재연결 필요·자동 숨김 꺼짐 같은 알림을 보낸다. 사라진 구독(404·410)은 지우고, 그 밖의 실패는 기록한다."
```

---

### Task 20: HTTP 서버와 REST·WebSocket 라우트

**Files:**
- Create: `apps/server/src/http/constants.ts`, `apps/server/src/http/errors.ts`, `apps/server/src/http/routes.ts`, `apps/server/src/http/server.ts`
- Create: `apps/server/test/helpers/httpHarness.ts`
- Test: `apps/server/test/http/server.test.ts`

**Interfaces:**
- Consumes: Task 12·15·16·17·18·19의 모든 서비스, `AppConfig`, `ChzzkApiError`, `WriteLockedError`, `RuleValidationError`, `SettingsValidationError`
- Produces: `SESSION_COOKIE = "zg_session"`, `REQUEST_MARKER_HEADER = "x-zzirit-request"`, `CANDIDATE_WINDOW_MS`; `class RouteError extends Error { statusCode; code }`, `errorBody(code, message): ApiErrorBody`; `interface RouteServices { channel(): ConnectedChannel | null; status(): ServerStatus; verdicts; executor; autoHide; rules; settings; auditLog; stats; push; broadcaster; getChatSettings(): Promise<ChatSettingsDto>; verifyRole(managerChannelId: string): Promise<ManagerRole | null>; disconnectChannel(): void; clock }`, `registerApiRoutes(app, services, sessions)`; `interface HttpDeps { config: Pick<AppConfig, "publicOrigin" | "webDistDirectory">; sessions; authFlow; hub; services; logger }`, `buildHttpServer(deps: HttpDeps): Promise<FastifyInstance>`

REST 목록(모두 JSON, 상태 변경 요청은 `x-zzirit-request: 1` 헤더 필수):

| 메서드·경로 | 권한 | 설명 |
|---|---|---|
| GET `/auth/connect`, `/auth/login` | 없음 | 치지직 인증 페이지로 302 |
| GET `/auth/callback` | 없음 | 로그인 완료 → 쿠키 → `/`(실패 시 `/?loginError=`) |
| POST `/api/logout` | 없음 | 세션 삭제 |
| GET `/api/me`, `/api/status`, `/api/candidates`, `/api/rules`, `/api/settings`, `/api/chat-settings`, `/api/stats`, `/api/push/public-key` | 로그인 | 조회 |
| POST `/api/ws-ticket` | 로그인 | WebSocket 티켓 |
| POST `/api/verdicts/:id/hide`·`/ignore`·`/false-positive` | hide_message | 숨김·무시·오판 |
| POST `/api/senders/:senderChannelId/temporary-restrict` | temporary_restrict | 임시 제한 |
| POST·DELETE `/api/senders/:senderChannelId/restrict` | restrict | 활동 제한·해제 |
| POST `/api/auto-hide` | 켜기 enable_auto_hide / 끄기 disable_auto_hide | 스위치 |
| POST `/api/rules`, DELETE `/api/rules/:id`, PUT `/api/settings` | edit_rules | 규칙·설정 |
| PUT `/api/chat-settings` | edit_chat_settings | 저속 모드 등 |
| GET `/api/audit` | view_audit | 감사 기록 |
| POST·DELETE `/api/push/subscriptions` | 로그인 | 푸시 구독 |
| POST `/api/channel/disconnect` | connect_channel | 채널 연결 해제 |
| GET `/ws?ticket=` | 티켓 | 실시간 이벤트 |

- [ ] **Step 1: 의존성 설치**

```bash
npm install --save-exact -w @zzirit-guard/server fastify@5.12.5 @fastify/cookie@11.1.3 @fastify/static@10.1.6 @fastify/websocket@11.3.4
npm install --save-dev --save-exact -w @zzirit-guard/server @types/ws@8.18.2
```

- [ ] **Step 2: 테스트 도우미 작성**

`apps/server/test/helpers/httpHarness.ts`:
```ts
import type { ManagerRole } from "@zzirit-guard/shared";
import { vi } from "vitest";
import { createAutoHideSwitch } from "../../src/actions/autoHideSwitch.js";
import type { ActionOutcome, Executor } from "../../src/actions/executor.js";
import { openDatabase } from "../../src/db/database.js";
import { createRuleRepository } from "../../src/detection/ruleRepository.js";
import type { RouteServices } from "../../src/http/routes.js";
import { buildHttpServer } from "../../src/http/server.js";
import { silentLogger } from "../../src/logger.js";
import { AuthError, type AuthFlow } from "../../src/managers/authFlow.js";
import { createSessionStore } from "../../src/managers/sessionStore.js";
import { createPushNotifier } from "../../src/push/pushNotifier.js";
import { createRealtimeHub } from "../../src/realtime/hub.js";
import { createAuditLog } from "../../src/records/auditLog.js";
import { createMinuteStats } from "../../src/records/minuteStats.js";
import { createSettingsRepository } from "../../src/records/settingsRepository.js";
import { createVerdictRepository } from "../../src/records/verdictRepository.js";

/** 테스트 서버의 공개 출처. */
export const ORIGIN = "https://guard.test";

/** 상태 변경 요청에 필요한 헤더(쿠키·출처·표식). */
export function mutatingHeaders(rawId: string): Record<string, string> {
  return { cookie: `zg_session=${rawId}`, origin: ORIGIN, "x-zzirit-request": "1" };
}

/** 실제 저장소와 가짜 실행기로 HTTP 서버를 띄운다. */
export async function createHttpHarness(authFlowOverrides: Partial<AuthFlow> = {}) {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
  database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
  const clock = () => 1_000_000;
  const verdicts = createVerdictRepository(database, clock);
  const auditLog = createAuditLog(database, clock);
  const settings = createSettingsRepository(database);
  const sessions = createSessionStore(database, clock);
  const hub = createRealtimeHub({ flushIntervalMs: 60_000 });
  const submit = vi.fn<Executor["submit"]>(async () => ({ ok: true, note: null }) as ActionOutcome);
  const services: RouteServices = {
    channel: () => ({ channelId: "c1", channelName: "채널" }),
    status: () => ({ channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, lastChatAt: null, pendingActions: 0 }),
    verdicts, auditLog, settings, clock,
    executor: { submit, pendingCount: () => 0, onFailureRateExceeded: () => undefined },
    autoHide: createAutoHideSwitch({ settings, auditLog, clock }),
    rules: createRuleRepository(database, clock),
    stats: createMinuteStats(database, clock),
    push: createPushNotifier({ database, clock, logger: silentLogger, vapid: { publicKey: "pk", privateKey: "sk", subject: "mailto:a@b.c" }, send: async () => ({}) }),
    broadcaster: hub,
    getChatSettings: async () => ({ chatAvailableCondition: "NONE", chatAvailableGroup: "ALL", minFollowerMinute: 0, allowSubscriberInFollowerMode: false, chatSlowModeSec: 0, chatEmojiMode: false }),
    /** login()이 만든 채널 ID("<역할>-id")에서 역할을 그대로 돌려준다. 해임을 흉내 내려면 테스트에서 덮어쓴다. */
    verifyRole: async (managerChannelId) => managerChannelId.replace(/-id$/, "") as ManagerRole,
    disconnectChannel: vi.fn(),
  };
  const authFlow: AuthFlow = {
    authorizeUrl: (purpose) => `https://chzzk.example/account-interlock?purpose=${purpose}`,
    complete: async () => { throw new AuthError("이 채널의 매니저가 아닙니다."); },
    ...authFlowOverrides,
  };
  const app = await buildHttpServer({ config: { publicOrigin: ORIGIN, webDistDirectory: "/nonexistent-web-dist" }, sessions, authFlow, hub, services, logger: silentLogger });
  /** 역할로 로그인한 세션의 쿠키 값. */
  const login = (role: ManagerRole) => sessions.create({ channelId: `${role}-id`, channelName: role, role }).rawId;
  return { app, verdicts, auditLog, sessions, hub, services, submit, login, close: async () => { hub.stop(); await app.close(); } };
}
```

- [ ] **Step 3: 실패하는 테스트 작성**

`apps/server/test/http/server.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    const foreign = await harness.app.inject({ method: "POST", url: "/api/auto-hide", headers: { ...mutatingHeaders(rawId), origin: "https://evil.example" }, payload: { enabled: true } });
    expect(foreign.statusCode).toBe(403);
  });

  it("보안 헤더를 붙인다", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/me" });
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
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

  it("감사 기록은 채팅 운영자에게 보이지 않는다", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/audit", headers: { cookie: `zg_session=${harness.login("STREAMING_CHAT_MANAGER")}` } });
    expect(response.statusCode).toBe(403);
  });
});

describe("로그인 콜백", () => {
  it("실패하면 이유를 담아 첫 화면으로 보낸다", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/auth/callback?code=c&state=s" });
    expect(response.statusCode).toBe(302);
    expect(decodeURIComponent(response.headers.location as string)).toBe("/?loginError=이 채널의 매니저가 아닙니다.");
  });

  it("성공하면 HttpOnly·Secure·SameSite=Lax 쿠키를 준다", async () => {
    await harness.close();
    harness = await createHttpHarness({
      complete: async () => ({ rawId: "raw-session", session: { id: "h", managerChannelId: "m", managerChannelName: "m", role: "STREAMING_CHAT_MANAGER", expiresAt: 0, lastRoleCheckAt: 0 } }),
    });
    const response = await harness.app.inject({ method: "GET", url: "/auth/callback?code=c&state=s" });
    expect(response.headers.location).toBe("/");
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toMatch(/^zg_session=raw-session;/);
    for (const attribute of [/;\s*HttpOnly/i, /;\s*Secure/i, /;\s*SameSite=Lax/i, /;\s*Path=\//i]) expect(cookie).toMatch(attribute);
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

  it("치지직에서 해임된 매니저는 티켓을 받지 못하고 세션이 지워진다", async () => {
    const rawId = harness.login("STREAMING_CHAT_MANAGER");
    harness.services.verifyRole = async () => null;
    const response = await harness.app.inject({ method: "POST", url: "/api/ws-ticket", headers: mutatingHeaders(rawId) });
    expect(response.statusCode).toBe(401);
    expect(harness.sessions.get(rawId)).toBeNull();
  });

  it("잘못된 티켓은 4003으로 닫는다", async () => {
    const socket = await harness.app.injectWS("/ws?ticket=wrong", { headers: { origin: ORIGIN } });
    const code = await new Promise<number>((resolve) => socket.on("close", (closeCode) => resolve(closeCode)));
    expect(code).toBe(4003);
  });
});
```

- [ ] **Step 4: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- http`
Expected: FAIL — 모듈 없음

- [ ] **Step 5: 구현**

`apps/server/src/http/constants.ts`:
```ts
/** 세션 쿠키 이름. */
export const SESSION_COOKIE = "zg_session";
/**
 * 상태 변경 요청에 붙여야 하는 표식 헤더. 다른 사이트의 form은 임의 헤더를 붙일 수 없어 CSRF를 막는다
 * (다른 출처의 fetch는 CORS 사전 요청에서 막힌다. 이 서버는 CORS를 허용하지 않는다).
 */
export const REQUEST_MARKER_HEADER = "x-zzirit-request";
/** 후보 목록에 보여 줄 기간(최근 10분, 스펙 6장). */
export const CANDIDATE_WINDOW_MS = 10 * 60 * 1000;
```

`apps/server/src/http/errors.ts`:
```ts
import type { ApiErrorBody } from "@zzirit-guard/shared";
import type { FastifyReply } from "fastify";
import { ZodError } from "zod";
import { ChzzkApiError } from "../chzzk/apiClient.js";
import { WriteLockedError } from "../connection/tokenManager.js";
import { RuleValidationError } from "../detection/ruleRepository.js";
import { describeError, type Logger } from "../logger.js";
import { SettingsValidationError } from "../records/settingsRepository.js";

/** 라우트에서 던지는 HTTP 오류. message는 사용자에게 그대로 보여 준다. */
export class RouteError extends Error {
  override readonly name = "RouteError";
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** 오류 응답 본문. */
export function errorBody(code: string, message: string): ApiErrorBody {
  return { error: code, message };
}

/**
 * 예외를 HTTP 응답으로 바꾼다. 사용자에게는 원인과 해결 방향이 담긴 문구를, 개발자에게는 로그를 남긴다.
 * 500은 내부 사정을 감추고 일반 문구만 보낸다.
 */
export function sendError(logger: Logger, error: unknown, reply: FastifyReply): FastifyReply {
  const status = statusFor(error);
  if (status >= 500) logger.error("요청 처리 실패", { status, error: describeError(error) });
  const body = status === 500 ? errorBody("internal", "서버 오류가 발생했습니다. 잠시 뒤 다시 시도하세요.") : errorBody(codeFor(error, status), messageFor(error));
  return reply.code(status).send(body);
}

/** 예외 종류별 HTTP 상태. */
function statusFor(error: unknown): number {
  if (error instanceof ZodError || error instanceof RuleValidationError || error instanceof SettingsValidationError) return 400;
  if (error instanceof WriteLockedError) return 409;
  if (error instanceof ChzzkApiError) return 502;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
}

/** 오류 코드(화면이 분기할 때 쓴다). */
function codeFor(error: unknown, status: number): string {
  if (error instanceof RouteError) return error.code;
  if (error instanceof ZodError) return "invalid_input";
  if (error instanceof WriteLockedError) return "write_locked";
  if (error instanceof ChzzkApiError) return "chzzk_failed";
  return status === 404 ? "not_found" : "bad_request";
}

/** 사용자에게 보여 줄 문구. */
function messageFor(error: unknown): string {
  if (error instanceof ZodError) return `입력값이 올바르지 않습니다: ${error.issues.map((issue) => issue.path.join(".") || "(본문)").join(", ")}`;
  if (error instanceof ChzzkApiError) return `치지직 오류(${error.status}): ${error.apiMessage}`;
  return error instanceof Error ? error.message : String(error);
}
```

`apps/server/src/http/routes.ts`:
```ts
import type { ChatSettingsDto, ManagerRole, MeDto, Permission, ServerStatus, SettingsDto, VerdictStatus } from "@zzirit-guard/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AutoHideSwitch } from "../actions/autoHideSwitch.js";
import type { Broadcaster } from "../actions/decisionHandler.js";
import type { ActionOutcome, Actor, Executor } from "../actions/executor.js";
import type { ConnectedChannel } from "../connection/credentialStore.js";
import type { RuleRepository } from "../detection/ruleRepository.js";
import { hasPermission, permissionsFor } from "../managers/permissions.js";
import type { ManagerSession, SessionStore } from "../managers/sessionStore.js";
import type { PushNotifier } from "../push/pushNotifier.js";
import type { AuditLog } from "../records/auditLog.js";
import type { MinuteStats } from "../records/minuteStats.js";
import type { ChannelSettings, SettingsRepository } from "../records/settingsRepository.js";
import type { VerdictRepository } from "../records/verdictRepository.js";
import type { Clock } from "../time.js";
import { CANDIDATE_WINDOW_MS, SESSION_COOKIE } from "./constants.js";
import { errorBody, RouteError } from "./errors.js";

/** 라우트가 쓰는 서비스 묶음. app.ts가 실제 구성 요소로 채운다. */
export interface RouteServices {
  channel(): ConnectedChannel | null;
  status(): ServerStatus;
  verdicts: VerdictRepository;
  executor: Executor;
  autoHide: AutoHideSwitch;
  rules: RuleRepository;
  settings: SettingsRepository;
  auditLog: AuditLog;
  stats: MinuteStats;
  push: PushNotifier;
  broadcaster: Broadcaster;
  getChatSettings(): Promise<ChatSettingsDto>;
  /** 치지직 관리자 목록으로 지금 역할을 확인한다(5분 캐시). WebSocket 티켓을 줄 때 쓴다(스펙 7장). */
  verifyRole(managerChannelId: string): Promise<ManagerRole | null>;
  disconnectChannel(): void;
  clock: Clock;
}

/** 권한 이름(오류 문구용). */
const PERMISSION_LABELS: Record<Permission, string> = {
  connect_channel: "채널 연결", disable_auto_hide: "자동 숨김 끄기", enable_auto_hide: "자동 숨김 켜기", edit_rules: "규칙 수정",
  hide_message: "메시지 숨김", temporary_restrict: "임시 제한", restrict: "활동 제한", edit_chat_settings: "채팅 설정", view_audit: "감사 기록 보기",
};
/** 치지직이 허용하는 최소 팔로우 시간(분) 값. */
const ALLOWED_FOLLOWER_MINUTES = [0, 5, 10, 30, 60, 1440, 10080, 43200, 86400, 129600, 172800, 216000, 259200];
/** 치지직이 허용하는 저속 모드(초) 값. */
const ALLOWED_SLOW_MODE_SECONDS = [0, 3, 5, 10, 30, 60, 120, 300];

/** 입력 검증 규칙. */
const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const senderParamSchema = z.object({ senderChannelId: z.string().min(1).max(100) });
const autoHideBodySchema = z.object({ enabled: z.boolean() });
const ruleBodySchema = z.object({
  kind: z.enum(["strong", "weak", "exception", "allow", "allow_domain", "threat", "keyword_route"]),
  pattern: z.string().min(1).max(100),
});
const settingsBodySchema = z
  .object({ breakerPerMinute: z.number().int().optional(), retentionDaysContent: z.number().int().optional(), retentionDaysAudit: z.number().int().optional() })
  .strict();
const chatSettingsBodySchema = z.object({
  chatAvailableCondition: z.enum(["NONE", "REAL_NAME"]),
  chatAvailableGroup: z.enum(["ALL", "FOLLOWER", "MANAGER", "SUBSCRIBER"]),
  minFollowerMinute: z.number().refine((value) => ALLOWED_FOLLOWER_MINUTES.includes(value), "치지직이 허용하지 않는 값입니다"),
  allowSubscriberInFollowerMode: z.boolean(),
  chatSlowModeSec: z.number().refine((value) => ALLOWED_SLOW_MODE_SECONDS.includes(value), "치지직이 허용하지 않는 값입니다"),
  chatEmojiMode: z.boolean(),
});
const temporaryRestrictBodySchema = z.object({ chatChannelId: z.string().min(1), verdictId: z.number().int().nullable().optional() });
const restrictBodySchema = z.object({ verdictId: z.number().int().nullable().optional() }).optional();
const pushSubscriptionSchema = z.object({ endpoint: z.url(), keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }) });
const pushDeleteSchema = z.object({ endpoint: z.string().min(1) });
const auditQuerySchema = z.object({ beforeId: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const statsQuerySchema = z.object({ sinceMinutes: z.coerce.number().int().min(1).max(1440).default(60) });

/** 권한 확인을 통과한 요청 정보. */
interface GuardedContext {
  request: FastifyRequest;
  reply: FastifyReply;
  manager: ManagerSession;
  channelId: string;
}

/** 로그인·권한·채널 연결을 확인한 뒤 실행하는 핸들러를 만든다. */
function guarded(services: RouteServices, permission: Permission | null, handler: (context: GuardedContext) => unknown) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const manager = request.manager;
    if (!manager) throw new RouteError(401, "unauthorized", "로그인이 필요합니다.");
    if (permission && !hasPermission(manager.role, permission)) {
      throw new RouteError(403, "forbidden", `이 기능을 쓸 권한이 없습니다(${PERMISSION_LABELS[permission]}).`);
    }
    const channel = services.channel();
    if (!channel) throw new RouteError(409, "no_channel", "연결된 채널이 없습니다. 스트리머가 먼저 채널을 연결하세요.");
    return handler({ request, reply, manager, channelId: channel.channelId });
  };
}

/** REST 라우트를 등록한다. */
export function registerApiRoutes(app: FastifyInstance, services: RouteServices, sessions: SessionStore): void {
  registerSessionRoutes(app, services, sessions);
  registerVerdictRoutes(app, services);
  registerSenderRoutes(app, services);
  registerConfigurationRoutes(app, services);
  registerPushRoutes(app, services);
}

/** 세션·상태·티켓·연결 해제. */
function registerSessionRoutes(app: FastifyInstance, services: RouteServices, sessions: SessionStore): void {
  app.post("/api/logout", async (request, reply) => {
    const rawId = request.cookies[SESSION_COOKIE];
    if (rawId) sessions.deleteByRawId(rawId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
  app.get("/api/me", guarded(services, null, ({ manager }) => toMe(manager)));
  app.get("/api/status", guarded(services, null, () => services.status()));
  app.post("/api/ws-ticket", guarded(services, null, ({ manager }) => issueTicketAfterRoleCheck(services, sessions, manager)));
  app.post(
    "/api/channel/disconnect",
    guarded(services, "connect_channel", () => {
      services.disconnectChannel();
      return { ok: true };
    }),
  );
}

/** 후보 목록과 판정 조치. */
function registerVerdictRoutes(app: FastifyInstance, services: RouteServices): void {
  app.get("/api/candidates", guarded(services, null, ({ channelId }) => services.verdicts.listRecent(channelId, services.clock() - CANDIDATE_WINDOW_MS)));
  app.post(
    "/api/verdicts/:id/hide",
    guarded(services, "hide_message", async ({ request, reply, manager, channelId }) => {
      const verdict = findVerdict(services, request.params, channelId);
      const target = { chatChannelId: verdict.chatChannelId, messageTime: verdict.messageTime, senderChannelId: verdict.senderChannelId };
      return sendOutcome(reply, await services.executor.submit(channelId, { kind: "hide", target, verdictId: verdict.id }, actorOf(manager)));
    }),
  );
  app.post("/api/verdicts/:id/ignore", guarded(services, "hide_message", (context) => markVerdict(services, context, "ignored")));
  app.post("/api/verdicts/:id/false-positive", guarded(services, "hide_message", (context) => markVerdict(services, context, "false_positive")));
}

/** 사용자 단위 제재. */
function registerSenderRoutes(app: FastifyInstance, services: RouteServices): void {
  app.post(
    "/api/senders/:senderChannelId/temporary-restrict",
    guarded(services, "temporary_restrict", async ({ request, reply, manager, channelId }) => {
      const { senderChannelId } = senderParamSchema.parse(request.params);
      const body = temporaryRestrictBodySchema.parse(request.body);
      const action = { kind: "temporary_restrict" as const, targetChannelId: senderChannelId, chatChannelId: body.chatChannelId, verdictId: body.verdictId ?? null };
      return sendOutcome(reply, await services.executor.submit(channelId, action, actorOf(manager)));
    }),
  );
  app.post(
    "/api/senders/:senderChannelId/restrict",
    guarded(services, "restrict", async ({ request, reply, manager, channelId }) => {
      const { senderChannelId } = senderParamSchema.parse(request.params);
      const verdictId = restrictBodySchema.parse(request.body)?.verdictId ?? null;
      return sendOutcome(reply, await services.executor.submit(channelId, { kind: "restrict", targetChannelId: senderChannelId, verdictId }, actorOf(manager)));
    }),
  );
  app.delete(
    "/api/senders/:senderChannelId/restrict",
    guarded(services, "restrict", async ({ request, reply, manager, channelId }) => {
      const { senderChannelId } = senderParamSchema.parse(request.params);
      return sendOutcome(reply, await services.executor.submit(channelId, { kind: "unrestrict", targetChannelId: senderChannelId }, actorOf(manager)));
    }),
  );
}

/** 스위치·규칙·설정·채팅 설정·감사 기록·통계. */
function registerConfigurationRoutes(app: FastifyInstance, services: RouteServices): void {
  app.post("/api/auto-hide", guarded(services, null, (context) => toggleAutoHide(services, context)));
  app.get("/api/rules", guarded(services, null, ({ channelId }) => services.rules.list(channelId)));
  app.post("/api/rules", guarded(services, "edit_rules", (context) => addRule(services, context)));
  app.delete("/api/rules/:id", guarded(services, "edit_rules", (context) => removeRule(services, context)));
  app.get("/api/settings", guarded(services, null, ({ channelId }) => toSettingsDto(services.settings.get(channelId))));
  app.put("/api/settings", guarded(services, "edit_rules", (context) => updateSettings(services, context)));
  app.get("/api/chat-settings", guarded(services, null, () => services.getChatSettings()));
  app.put(
    "/api/chat-settings",
    guarded(services, "edit_chat_settings", async ({ request, reply, manager, channelId }) =>
      sendOutcome(reply, await services.executor.submit(channelId, { kind: "update_chat_settings", settings: chatSettingsBodySchema.parse(request.body) }, actorOf(manager))),
    ),
  );
  app.get(
    "/api/audit",
    guarded(services, "view_audit", ({ request, channelId }) => {
      const query = auditQuerySchema.parse(request.query);
      return services.auditLog.list(channelId, query.limit, query.beforeId ?? null);
    }),
  );
  app.get(
    "/api/stats",
    guarded(services, null, ({ request, channelId }) => services.stats.recent(channelId, services.clock() - statsQuerySchema.parse(request.query).sinceMinutes * 60_000)),
  );
}

/** 푸시 구독. */
function registerPushRoutes(app: FastifyInstance, services: RouteServices): void {
  app.get("/api/push/public-key", guarded(services, null, () => ({ publicKey: services.push.publicKey() })));
  app.post(
    "/api/push/subscriptions",
    guarded(services, null, ({ request, manager }) => {
      services.push.subscribe(manager.managerChannelId, pushSubscriptionSchema.parse(request.body));
      return { ok: true };
    }),
  );
  app.delete(
    "/api/push/subscriptions",
    guarded(services, null, ({ request }) => {
      services.push.unsubscribe(pushDeleteSchema.parse(request.body).endpoint);
      return { ok: true };
    }),
  );
}

/**
 * WebSocket을 열기 전에 역할을 다시 확인한다(스펙 7장: 연결할 때와 5분마다).
 * 해임됐으면 세션을 지우고 401, 역할이 바뀌었으면 세션을 갱신한 뒤 티켓을 준다.
 */
async function issueTicketAfterRoleCheck(services: RouteServices, sessions: SessionStore, manager: ManagerSession) {
  const role = await services.verifyRole(manager.managerChannelId);
  if (!role) {
    sessions.deleteById(manager.id);
    throw new RouteError(401, "unauthorized", "치지직에서 매니저 권한이 해제되었습니다. 다시 로그인하세요.");
  }
  if (role !== manager.role) sessions.updateRole(manager.id, role);
  return { ticket: sessions.issueTicket(manager.id) };
}

/** 스위치 켜기·끄기. 켜기와 끄기의 권한이 다르다(끄기는 안전한 방향이라 더 넓게 준다). */
function toggleAutoHide(services: RouteServices, { request, manager, channelId }: GuardedContext) {
  const { enabled } = autoHideBodySchema.parse(request.body);
  const needed: Permission = enabled ? "enable_auto_hide" : "disable_auto_hide";
  if (!hasPermission(manager.role, needed)) throw new RouteError(403, "forbidden", `이 기능을 쓸 권한이 없습니다(${PERMISSION_LABELS[needed]}).`);
  services.autoHide.setEnabled(channelId, enabled, actorOf(manager), "manual");
  return { enabled };
}

/** 규칙을 추가하고 감사 기록을 남긴다. */
function addRule(services: RouteServices, { request, manager, channelId }: GuardedContext) {
  const body = ruleBodySchema.parse(request.body);
  const rule = services.rules.add(channelId, body.kind, body.pattern, manager.managerChannelId);
  recordConfigChange(services, channelId, manager, `rule_add:${body.kind}`);
  return rule;
}

/** 규칙을 지우고 감사 기록을 남긴다. */
function removeRule(services: RouteServices, { request, manager, channelId }: GuardedContext) {
  const { id } = idParamSchema.parse(request.params);
  if (!services.rules.remove(channelId, id)) throw new RouteError(404, "not_found", "해당 규칙이 없습니다. 이미 지워졌을 수 있습니다.");
  recordConfigChange(services, channelId, manager, "rule_remove");
  return { ok: true };
}

/** 설정을 바꾸고 감사 기록을 남긴다. */
function updateSettings(services: RouteServices, { request, manager, channelId }: GuardedContext) {
  const updated = services.settings.update(channelId, settingsBodySchema.parse(request.body));
  recordConfigChange(services, channelId, manager, "settings_update");
  return toSettingsDto(updated);
}

/** 설정 변경 감사 기록. */
function recordConfigChange(services: RouteServices, channelId: string, manager: ManagerSession, action: string): void {
  services.auditLog.record({ channelId, actorType: "manager", actorChannelId: manager.managerChannelId, action, targetSenderChannelId: null, verdictId: null, result: "ok", error: null });
}

/** 판정을 찾는다. 다른 채널의 판정이나 보관 기간이 지난 판정은 404. */
function findVerdict(services: RouteServices, params: unknown, channelId: string) {
  const { id } = idParamSchema.parse(params);
  const verdict = services.verdicts.get(id);
  if (!verdict || verdict.channelId !== channelId) throw new RouteError(404, "not_found", "해당 판정을 찾을 수 없습니다. 보관 기간이 지났을 수 있습니다.");
  return verdict;
}

/** 무시·오판으로 표시하고 기록·방송한다. 오판은 해당 규칙을 검토할 근거가 된다. */
function markVerdict(services: RouteServices, { request, manager, channelId }: GuardedContext, status: Extract<VerdictStatus, "ignored" | "false_positive">) {
  const verdict = findVerdict(services, request.params, channelId);
  services.verdicts.updateStatus(verdict.id, status);
  services.auditLog.record({
    channelId, actorType: "manager", actorChannelId: manager.managerChannelId, action: status,
    targetSenderChannelId: verdict.senderChannelId, verdictId: verdict.id, result: "ok", error: null,
  });
  services.broadcaster.broadcast({ type: "verdict_status", verdictId: verdict.id, status });
  return { ok: true };
}

/** 실행 결과를 응답으로 바꾼다. 치지직 실패는 502와 이유. */
function sendOutcome(reply: FastifyReply, outcome: ActionOutcome) {
  if (outcome.ok) return reply.send({ ok: true, note: outcome.note });
  return reply.code(502).send(errorBody("chzzk_failed", outcome.message));
}

/** 매니저 행위자. */
function actorOf(manager: ManagerSession): Actor {
  return { type: "manager", channelId: manager.managerChannelId };
}

/** 세션을 MeDto로 바꾼다. */
function toMe(manager: ManagerSession): MeDto {
  const role: ManagerRole = manager.role;
  return { channelId: manager.managerChannelId, channelName: manager.managerChannelName, role, permissions: permissionsFor(role) };
}

/** 스위치 상태를 뺀 설정 DTO. */
function toSettingsDto(settings: ChannelSettings): SettingsDto {
  return { breakerPerMinute: settings.breakerPerMinute, retentionDaysContent: settings.retentionDaysContent, retentionDaysAudit: settings.retentionDaysAudit };
}
```

`apps/server/src/http/server.ts`:
```ts
import { existsSync } from "node:fs";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { RealtimeEvent } from "@zzirit-guard/shared";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { describeError, type Logger } from "../logger.js";
import { AuthError, CALLBACK_PATH, type AuthFlow } from "../managers/authFlow.js";
import { SESSION_TTL_MS, type ManagerSession, type SessionStore } from "../managers/sessionStore.js";
import type { RealtimeHub, SocketSink } from "../realtime/hub.js";
import { REQUEST_MARKER_HEADER, SESSION_COOKIE } from "./constants.js";
import { errorBody, sendError } from "./errors.js";
import { registerApiRoutes, type RouteServices } from "./routes.js";

declare module "fastify" {
  interface FastifyRequest {
    /** 쿠키로 확인한 매니저 세션(없으면 null). */
    manager: ManagerSession | null;
  }
}

/** buildHttpServer 의존성. */
export interface HttpDeps {
  config: Pick<AppConfig, "publicOrigin" | "webDistDirectory">;
  sessions: SessionStore;
  authFlow: AuthFlow;
  hub: RealtimeHub;
  services: RouteServices;
  logger: Logger;
}

/** 부작용이 없는 메서드. CSRF 검사에서 뺀다. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
/** 잘못된 티켓으로 WebSocket을 열었을 때의 닫기 코드. */
const UNAUTHORIZED_CLOSE_CODE = 4003;
/** 콜백 쿼리. */
const callbackQuerySchema = z.object({ code: z.string().min(1), state: z.string().min(1) });

/** Fastify 서버를 만든다(아직 listen하지 않는다). */
export async function buildHttpServer(deps: HttpDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);
  app.decorateRequest("manager", null);
  app.addHook("onRequest", async (request) => {
    const rawId = request.cookies[SESSION_COOKIE];
    request.manager = rawId ? deps.sessions.get(rawId) : null;
  });
  app.addHook("preHandler", async (request, reply) => rejectCrossSite(deps.config.publicOrigin, request, reply));
  app.addHook("onSend", async (_request, reply, payload) => applySecurityHeaders(reply, deps.config.publicOrigin, payload));
  app.setErrorHandler((error, _request, reply) => sendError(deps.logger, error, reply));
  registerAuthRoutes(app, deps);
  registerWebSocket(app, deps);
  registerApiRoutes(app, deps.services, deps.sessions);
  await registerStatic(app, deps.config.webDistDirectory);
  return app;
}

/** /api의 상태 변경 요청은 표식 헤더가 있고 출처가 같아야 한다(CSRF 방지, 스펙 8장). */
async function rejectCrossSite(publicOrigin: string, request: FastifyRequest, reply: FastifyReply) {
  if (!request.url.startsWith("/api/") || SAFE_METHODS.has(request.method)) return;
  const origin = request.headers.origin;
  if (request.headers[REQUEST_MARKER_HEADER] === "1" && (origin === undefined || origin === publicOrigin)) return;
  return reply.code(403).send(errorBody("cross_site", "요청 출처를 확인할 수 없습니다. 앱을 새로고침한 뒤 다시 시도하세요."));
}

/** 보안 헤더: CSP(스크립트는 같은 출처만, 인라인 스크립트 금지), MIME 추측 금지, 리퍼러 숨김. */
async function applySecurityHeaders(reply: FastifyReply, publicOrigin: string, payload: unknown) {
  const websocketOrigin = publicOrigin.replace(/^http/, "ws");
  reply.header(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${websocketOrigin}; frame-ancestors 'none'; base-uri 'none'`,
  );
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  return payload;
}

/** 치지직 OAuth 시작·콜백. */
function registerAuthRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.get("/auth/connect", async (_request, reply) => reply.redirect(deps.authFlow.authorizeUrl("connect")));
  app.get("/auth/login", async (_request, reply) => reply.redirect(deps.authFlow.authorizeUrl("login")));
  app.get(CALLBACK_PATH, async (request, reply) => completeLogin(deps, request, reply));
}

/** 콜백 처리: 성공하면 세션 쿠키를 주고 첫 화면으로, 실패하면 이유를 쿼리에 담아 첫 화면으로 보낸다. */
async function completeLogin(deps: HttpDeps, request: FastifyRequest, reply: FastifyReply) {
  const query = callbackQuerySchema.safeParse(request.query);
  if (!query.success) return reply.redirect(`/?loginError=${encodeURIComponent("치지직에서 돌아온 값이 없습니다. 다시 시도하세요.")}`);
  try {
    const { rawId } = await deps.authFlow.complete(query.data.code, query.data.state);
    reply.setCookie(SESSION_COOKIE, rawId, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_MS / 1000 });
    return reply.redirect("/");
  } catch (error) {
    if (!(error instanceof AuthError)) deps.logger.error("로그인 처리 실패", { error: describeError(error) });
    const message = error instanceof AuthError ? error.message : "로그인 중 오류가 발생했습니다. 잠시 뒤 다시 시도하세요.";
    return reply.redirect(`/?loginError=${encodeURIComponent(message)}`);
  }
}

/** WebSocket: 일회용 티켓과 출처를 확인한 뒤 허브에 붙이고 현재 상태를 보낸다. */
function registerWebSocket(app: FastifyInstance, deps: HttpDeps): void {
  app.get("/ws", { websocket: true }, (socket, request) => {
    const ticket = (request.query as { ticket?: unknown }).ticket;
    const session = typeof ticket === "string" ? deps.sessions.redeemTicket(ticket) : null;
    const origin = request.headers.origin;
    if (!session || (origin !== undefined && origin !== deps.config.publicOrigin)) {
      socket.close(UNAUTHORIZED_CLOSE_CODE, "unauthorized");
      return;
    }
    deps.hub.attach(toSocketSink(socket), session);
    socket.send(JSON.stringify({ type: "status", status: deps.services.status() } satisfies RealtimeEvent));
  });
}

/** ws 소켓을 허브가 쓰는 최소 형태로 감싼다(ws의 겹친 on 시그니처와 타입을 분리). */
function toSocketSink(socket: WebSocket): SocketSink {
  return {
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    on: (_event, listener) => socket.on("close", listener),
  };
}

/** PWA 정적 파일. 빌드 결과가 없으면(서버만 테스트할 때) 건너뛴다. 알 수 없는 화면 경로는 index.html로 보낸다. */
async function registerStatic(app: FastifyInstance, directory: string): Promise<void> {
  if (!existsSync(directory)) return;
  await app.register(fastifyStatic, { root: directory, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/auth/") || request.url.startsWith("/ws")) {
      return reply.code(404).send(errorBody("not_found", "없는 주소입니다."));
    }
    return reply.sendFile("index.html");
  });
}
```

- [ ] **Step 6: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- http`
Expected: PASS (16 tests)

- [ ] **Step 7: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/http apps/server/test/http apps/server/test/helpers/httpHarness.ts apps/server/package.json package-lock.json
git commit -m "feat: REST·WebSocket 서버 추가" -m "세션 쿠키(HttpOnly·Secure·SameSite=Lax)와 표식 헤더·출처 검사로 CSRF를 막고, 역할별 권한을 라우트마다 확인한다. 오류는 원인과 해결 방향을 담은 문구로 돌려준다."
```

---

### Task 21: 보관 기한 정리와 백업

**Files:**
- Create: `apps/server/src/records/maintenance.ts`
- Test: `apps/server/test/records/maintenance.test.ts`

**Interfaces:**
- Consumes: `Database`, `Clock`, `VerdictRepository`·`AuditLog`(Task 12), `SessionStore`(Task 17)
- Produces: `interface RetentionResult { verdicts: number; audits: number; stats: number; sessions: number }`, `runRetention(deps: { database; verdicts; auditLog; sessions; clock }): RetentionResult`, `runBackup(database, backupDirectory, clock, keep?: number): Promise<string>`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/records/maintenance.test.ts`:
```ts
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createSessionStore } from "../../src/managers/sessionStore.js";
import { createAuditLog } from "../../src/records/auditLog.js";
import { runBackup, runRetention } from "../../src/records/maintenance.js";
import { createVerdictRepository } from "../../src/records/verdictRepository.js";

/** 하루(ms). */
const DAY = 24 * 60 * 60 * 1000;

describe("runRetention", () => {
  it("원문은 30일, 감사 기록·통계는 180일이 지나면 지운다", () => {
    let now = 0;
    const database = openDatabase(":memory:");
    database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
    const verdicts = createVerdictRepository(database, () => now);
    const auditLog = createAuditLog(database, () => now);
    const sessions = createSessionStore(database, () => now);
    const verdict = { channelId: "c1", chatChannelId: "x", messageTime: 0, senderChannelId: "s", senderNickname: "n", content: "c", decision: "candidate" as const, reason: "r" };
    verdicts.insert(verdict);
    auditLog.record({ channelId: "c1", actorType: "rule", actorChannelId: null, action: "hide", targetSenderChannelId: "s", verdictId: null, result: "ok", error: null });
    database.prepare("INSERT INTO minute_stat (channel_id, minute, received) VALUES ('c1', 0, 1)").run();
    sessions.create({ channelId: "m", channelName: "m", role: "STREAMING_CHAT_MANAGER" });
    now = 31 * DAY;
    verdicts.insert(verdict);
    expect(runRetention({ database, verdicts, auditLog, sessions, clock: () => now })).toEqual({ verdicts: 1, audits: 0, stats: 0, sessions: 1 });
    now = 181 * DAY;
    expect(runRetention({ database, verdicts, auditLog, sessions, clock: () => now })).toMatchObject({ audits: 1, stats: 1 });
  });
});

describe("runBackup", () => {
  it("백업 파일을 만들고 최근 7개만 남긴다", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zg-backup-"));
    const database = openDatabase(":memory:");
    for (let day = 0; day < 9; day += 1) await runBackup(database, directory, () => Date.UTC(2026, 9, 1 + day));
    const files = readdirSync(directory).sort();
    expect(files).toHaveLength(7);
    expect(files[0]).toBe("zzirit-guard-20261003-000000.sqlite");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- maintenance`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/server/src/records/maintenance.ts`:
```ts
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../db/database.js";
import type { SessionStore } from "../managers/sessionStore.js";
import type { Clock } from "../time.js";
import type { AuditLog } from "./auditLog.js";
import type { VerdictRepository } from "./verdictRepository.js";

/** 보관 기한 정리 결과(지운 행 수). */
export interface RetentionResult {
  verdicts: number;
  audits: number;
  stats: number;
  sessions: number;
}

/** runRetention 의존성. */
export interface RetentionDeps {
  database: Database;
  verdicts: VerdictRepository;
  auditLog: AuditLog;
  sessions: SessionStore;
  clock: Clock;
}

/** 하루(ms). */
const DAY_MS = 24 * 60 * 60 * 1000;
/** 설정 행이 없을 때의 기본 보관 기간(스펙 9장). */
const DEFAULT_RETENTION = { content: 30, audit: 180 };
/** 남길 백업 개수 기본값(스펙 10장). */
const DEFAULT_BACKUP_KEEP = 7;
/** 백업 파일 이름 형식. 이름순 정렬이 곧 시간순이 되게 한다. */
const BACKUP_PATTERN = /^zzirit-guard-\d{8}-\d{6}\.sqlite$/;

/** 보관 기한이 지난 기록을 지운다(매일 실행). */
export function runRetention(deps: RetentionDeps): RetentionResult {
  const now = deps.clock();
  const days = readRetentionDays(deps.database);
  const auditCutoff = now - days.audit * DAY_MS;
  return {
    verdicts: deps.verdicts.deleteOlderThan(now - days.content * DAY_MS),
    audits: deps.auditLog.deleteOlderThan(auditCutoff),
    stats: deps.database.prepare("DELETE FROM minute_stat WHERE minute < ?").run(auditCutoff).changes,
    sessions: deps.sessions.deleteExpired(),
  };
}

/** 채널 설정의 보관 기간. 채널이 없으면 기본값. */
function readRetentionDays(database: Database): { content: number; audit: number } {
  const row = database.prepare("SELECT retention_days_content AS content, retention_days_audit AS audit FROM setting LIMIT 1").get() as
    | { content: number; audit: number }
    | undefined;
  return row ?? DEFAULT_RETENTION;
}

/**
 * SQLite 온라인 백업을 만들고 오래된 것을 지운다. 백업에는 암호화된 토큰과 30일 이내 원문이 들어 있어
 * FileVault로 보호되는 데이터 디렉터리 아래에만 둔다.
 * @returns 만든 백업 파일 경로
 */
export async function runBackup(database: Database, backupDirectory: string, clock: Clock, keep = DEFAULT_BACKUP_KEEP): Promise<string> {
  mkdirSync(backupDirectory, { recursive: true });
  const path = join(backupDirectory, `zzirit-guard-${formatTimestamp(clock())}.sqlite`);
  await database.backup(path);
  pruneBackups(backupDirectory, keep);
  return path;
}

/** UTC 기준 YYYYMMDD-HHmmss. */
function formatTimestamp(timestampMs: number): string {
  const iso = new Date(timestampMs).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

/** 백업 파일 중 최신 keep개만 남긴다. 형식이 다른 파일은 건드리지 않는다. */
function pruneBackups(backupDirectory: string, keep: number): void {
  const backups = readdirSync(backupDirectory).filter((name) => BACKUP_PATTERN.test(name)).sort();
  backups.slice(0, Math.max(0, backups.length - keep)).forEach((name) => rmSync(join(backupDirectory, name)));
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- maintenance`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/records/maintenance.ts apps/server/test/records/maintenance.test.ts
git commit -m "feat: 보관 기한 정리와 일일 백업 추가" -m "채널 설정의 보관 기간(기본 원문 30일·감사 기록 180일)에 따라 지우고, SQLite 온라인 백업을 최근 7개만 남긴다."
```

---

### Task 22: 구성 요소 조립·실행 진입점·종단 간 테스트

**Files:**
- Create: `apps/server/src/app.ts`, `apps/server/src/main.ts`
- Create: `apps/server/test/helpers/waitForAsync.ts`
- Modify: `apps/server/package.json`(scripts에 `start` 추가)
- Test: `apps/server/test/app.e2e.test.ts`

**Interfaces:**
- Consumes: 앞선 모든 Task의 생성 함수
- Produces: `interface AppOptions { encryptionKey: Buffer; clock?; logger?; fetchFunction?; connect?: SocketConnector; pushSender?: PushSender }`, `interface App { http: FastifyInstance; start(): Promise<void>; stop(): Promise<void>; status(): ServerStatus }`, `createApp(config: AppConfig, options: AppOptions): Promise<App>`

- [ ] **Step 1: 실패하는 종단 간 테스트 작성**

`apps/server/test/helpers/waitForAsync.ts`:
```ts
/** 비동기 조건이 참이 될 때까지 50ms 간격으로 기다린다(HTTP 조회로 상태를 확인할 때). */
export async function waitForAsync(condition: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`waitForAsync: ${timeoutMs}ms 안에 조건이 충족되지 않았습니다`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
```

`apps/server/test/app.e2e.test.ts`:
```ts
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerdictDto } from "@zzirit-guard/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { startFakeChzzk, type FakeChzzk } from "./fakes/fakeChzzk.js";
import { waitFor } from "./helpers/waitFor.js";
import { waitForAsync } from "./helpers/waitForAsync.js";

/** 테스트 서버의 공개 출처. */
const ORIGIN = "https://guard.test";

let fake: FakeChzzk;
let app: App;

beforeEach(async () => {
  fake = await startFakeChzzk();
  const dataDirectory = mkdtempSync(join(tmpdir(), "zg-e2e-"));
  const config: AppConfig = {
    port: 0, publicOrigin: ORIGIN, channelId: fake.owner.channelId, chzzkClientId: "test-client", chzzkClientSecret: "test-secret",
    chzzkApiBase: fake.baseUrl, chzzkAuthorizeUrl: "https://chzzk.example/account-interlock", dataDirectory,
    databasePath: join(dataDirectory, "zzirit-guard.sqlite"), backupDirectory: join(dataDirectory, "backups"), keychainService: "unused",
    webDistDirectory: join(dataDirectory, "no-web"), vapidPublicKey: "pk", vapidPrivateKey: "sk", vapidSubject: "mailto:a@b.c",
  };
  app = await createApp(config, { encryptionKey: randomBytes(32), logger: silentLogger, pushSender: async () => ({}) });
  await app.start();
});
afterEach(async () => {
  await app.stop();
  await fake.close();
});

/** OAuth 흐름을 가짜 치지직 코드로 끝내고 세션 쿠키 값을 돌려준다. */
async function signIn(path: "/auth/connect" | "/auth/login", user: { channelId: string; channelName: string }): Promise<string> {
  const start = await app.http.inject({ method: "GET", url: path });
  const state = new URL(start.headers.location as string).searchParams.get("state");
  const callback = await app.http.inject({ method: "GET", url: `/auth/callback?code=${fake.grantCode(user)}&state=${state}` });
  expect(callback.headers.location).toBe("/");
  return /zg_session=([^;]+)/.exec(String(callback.headers["set-cookie"]))?.[1] as string;
}

/** 후보 목록을 읽는다. */
async function candidates(rawId: string): Promise<VerdictDto[]> {
  return (await app.http.inject({ method: "GET", url: "/api/candidates", headers: { cookie: `zg_session=${rawId}` } })).json();
}

/** 문서 형식의 채팅 이벤트. */
function chatPayload(sender: string, content: string) {
  return { channelId: fake.owner.channelId, senderChannelId: sender, chatChannelId: "chat-1", profile: { nickname: sender }, userRoleCode: "common_user", content, emojis: {}, messageTime: Date.now() };
}

describe("종단 간: 연결 → 섀도 → 자동 숨김 → 매니저 권한", () => {
  it("전체 흐름이 동작한다", async () => {
    const owner = await signIn("/auth/connect", fake.owner);
    await waitFor(() => fake.subscribedSessionCount() === 1);

    fake.emitChat(chatPayload("viewer-1", "홍어들은 다 이래"));
    await waitForAsync(async () => (await candidates(owner)).length === 1);
    expect((await candidates(owner))[0]).toMatchObject({ decision: "shadow", senderChannelId: "viewer-1" });
    expect(fake.calls.some((call) => call.path === "/open/v1/chats/blind-message")).toBe(false);

    const headers = { cookie: `zg_session=${owner}`, origin: ORIGIN, "x-zzirit-request": "1" };
    expect((await app.http.inject({ method: "POST", url: "/api/auto-hide", headers, payload: { enabled: true } })).statusCode).toBe(200);
    fake.emitChat(chatPayload("viewer-2", "느금마 ㅋㅋ"));
    await waitForAsync(async () => (await candidates(owner)).some((verdict) => verdict.senderChannelId === "viewer-2" && verdict.status === "hidden"));
    expect(fake.calls.find((call) => call.path === "/open/v1/chats/blind-message")?.body).toMatchObject({ senderChannelId: "viewer-2", chatChannelId: "chat-1" });

    fake.streamingRoles.push({ managerChannelId: "manager-1", managerChannelName: "매니저1", userRole: "STREAMING_CHAT_MANAGER" });
    const manager = await signIn("/auth/login", { channelId: "manager-1", channelName: "매니저1" });
    const managerHeaders = { cookie: `zg_session=${manager}`, origin: ORIGIN, "x-zzirit-request": "1" };
    expect((await app.http.inject({ method: "POST", url: "/api/auto-hide", headers: managerHeaders, payload: { enabled: true } })).statusCode).toBe(403);
    expect((await app.http.inject({ method: "POST", url: "/api/auto-hide", headers: managerHeaders, payload: { enabled: false } })).statusCode).toBe(200);
    expect(app.status()).toMatchObject({ channelConnected: true, chatConnected: true, autoHideEnabled: false });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- app.e2e`
Expected: FAIL — `Cannot find module '../src/app.js'`

- [ ] **Step 3: 구현**

`apps/server/src/app.ts`:
```ts
import { mkdirSync } from "node:fs";
import type { ServerStatus } from "@zzirit-guard/shared";
import type { FastifyInstance } from "fastify";
import { createAutoHideSwitch } from "./actions/autoHideSwitch.js";
import { createDecisionHandler } from "./actions/decisionHandler.js";
import { createExecutor } from "./actions/executor.js";
import { connectWithSocketIo, createChatReceiver, type SocketConnector } from "./chat/chatReceiver.js";
import { createChzzkApi } from "./chzzk/apiClient.js";
import type { AppConfig } from "./config.js";
import { createCredentialStore } from "./connection/credentialStore.js";
import { createTokenManager } from "./connection/tokenManager.js";
import { openDatabase } from "./db/database.js";
import { createGroupFloodDetector, createPersonalFloodDetector } from "./detection/floodDetectors.js";
import { createDuplicateTracker } from "./detection/messageTraits.js";
import { createDetectionPipeline } from "./detection/pipeline.js";
import { createRuleRepository } from "./detection/ruleRepository.js";
import type { RouteServices } from "./http/routes.js";
import { buildHttpServer } from "./http/server.js";
import { createConsoleLogger, describeError, type Logger } from "./logger.js";
import { createAuthFlow } from "./managers/authFlow.js";
import { recheckSessionRoles } from "./managers/roleRecheck.js";
import { createRoleVerifier } from "./managers/roleVerifier.js";
import { createSessionStore } from "./managers/sessionStore.js";
import { createPushNotifier, type PushMessage, type PushSender } from "./push/pushNotifier.js";
import { createRealtimeHub } from "./realtime/hub.js";
import { createAuditLog } from "./records/auditLog.js";
import { runBackup, runRetention } from "./records/maintenance.js";
import { createMinuteStats } from "./records/minuteStats.js";
import { createSettingsRepository } from "./records/settingsRepository.js";
import { createVerdictRepository } from "./records/verdictRepository.js";
import { createTokenCipher } from "./security/tokenCipher.js";
import { systemClock, type Clock } from "./time.js";

/** createApp 옵션. 테스트에서 시계·네트워크·소켓·푸시를 바꿔 끼운다. */
export interface AppOptions {
  encryptionKey: Buffer;
  clock?: Clock;
  logger?: Logger;
  fetchFunction?: typeof fetch;
  connect?: SocketConnector;
  pushSender?: PushSender;
}

/** 조립된 서버. */
export interface App {
  http: FastifyInstance;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): ServerStatus;
}

/** 주기 작업 간격. */
const INTERVALS = {
  tokenCheckMs: 10 * 60 * 1000,
  statsFlushMs: 60 * 1000,
  roleRecheckMs: 5 * 60 * 1000,
  maintenanceMs: 24 * 60 * 60 * 1000,
  firstMaintenanceDelayMs: 5 * 60 * 1000,
};
/** 시스템 행위자. */
const SYSTEM_ACTOR = { type: "system" as const, channelId: null };

/** 모든 구성 요소를 만들고 이벤트를 연결한다. */
export async function createApp(config: AppConfig, options: AppOptions): Promise<App> {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createConsoleLogger();
  mkdirSync(config.backupDirectory, { recursive: true });
  const database = openDatabase(config.databasePath);
  const api = createChzzkApi({ apiBase: config.chzzkApiBase, clientId: config.chzzkClientId, clientSecret: config.chzzkClientSecret, ...(options.fetchFunction ? { fetchFunction: options.fetchFunction } : {}) });
  const credentialStore = createCredentialStore(database, createTokenCipher(options.encryptionKey), clock);
  const tokenManager = createTokenManager({ store: credentialStore, api, clock });
  const verdicts = createVerdictRepository(database, clock);
  const auditLog = createAuditLog(database, clock);
  const stats = createMinuteStats(database, clock);
  const settings = createSettingsRepository(database);
  const rules = createRuleRepository(database, clock);
  const sessions = createSessionStore(database, clock);
  const hub = createRealtimeHub();
  const push = createPushNotifier({ database, clock, logger, vapid: { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey, subject: config.vapidSubject }, ...(options.pushSender ? { send: options.pushSender } : {}) });
  const executor = createExecutor({ api, tokenManager, auditLog, verdicts, clock, logger, onVerdictStatus: (verdictId, status) => hub.broadcast({ type: "verdict_status", verdictId, status }) });
  const autoHide = createAutoHideSwitch({ settings, auditLog, clock });
  const decisionHandler = createDecisionHandler({ verdicts, executor, autoHide, stats, broadcaster: hub, logger });
  const pipeline = createDetectionPipeline({ rules, auditLog, groupFlood: createGroupFloodDetector(), personalFlood: createPersonalFloodDetector(), duplicates: createDuplicateTracker() });
  const roleVerifier = createRoleVerifier({ api, tokenManager, credentialStore, clock, logger });
  let lastChatAt: number | null = null;

  const notify = (message: PushMessage) => void push.notifyAll(message).catch((error: unknown) => logger.warn("푸시 알림 실패", { error: describeError(error) }));
  const status = (): ServerStatus => {
    const channel = credentialStore.loadChannel();
    return {
      channelConnected: channel !== null, channelName: channel?.channelName ?? null, chatConnected: receiver.isConnected(),
      writeLocked: channel === null || tokenManager.isWriteLocked(), accessExpiresAt: tokenManager.accessExpiresAt(),
      autoHideEnabled: channel ? autoHide.isEnabled(channel.channelId) : false, lastChatAt, pendingActions: executor.pendingCount(),
    };
  };
  const broadcastStatus = () => hub.broadcast({ type: "status", status: status() });

  const receiver = createChatReceiver({
    api, tokenManager, clock, logger, connect: options.connect ?? connectWithSocketIo,
    onChat: (event) => {
      lastChatAt = event.receivedAt;
      decisionHandler.handle(event, pipeline.evaluate(event));
    },
    onConnectionChange: () => broadcastStatus(),
    onInvalidEvent: () => {
      const channel = credentialStore.loadChannel();
      if (channel) stats.increment(channel.channelId, "invalid_events");
    },
    onRevoked: () => {
      notify({ title: "찌리릿 가드", body: "치지직이 채팅 권한을 회수했습니다. 스트리머가 다시 연결해야 합니다." });
      broadcastStatus();
    },
  });

  const restartReceiverIfIdle = () => {
    if (receiver.isConnected()) return;
    receiver.stop();
    receiver.start();
  };
  const disconnectChannel = () => {
    receiver.stop();
    tokenManager.disconnect();
    const ids = sessions.listActive().map((session) => session.id);
    ids.forEach((id) => sessions.deleteById(id));
    hub.closeSessions(ids, "채널 연결이 해제되었습니다");
  };
  const authFlow = createAuthFlow({ config, api, tokenManager, credentialStore, roleVerifier, sessions, rules, clock, onChannelConnected: () => { restartReceiverIfIdle(); broadcastStatus(); } });

  tokenManager.onLockChange((locked) => {
    if (locked) notify({ title: "찌리릿 가드", body: "치지직 토큰을 갱신하지 못해 숨김·제재를 멈췄습니다. 스트리머가 다시 연결해 주세요." });
    broadcastStatus();
  });
  executor.onFailureRateExceeded((channelId) => autoHide.setEnabled(channelId, false, SYSTEM_ACTOR, "failure_rate"));
  autoHide.onChange((_channelId, enabled, reason) => {
    if (!enabled && reason !== "manual") notify({ title: "찌리릿 가드", body: `자동 숨김이 꺼졌습니다(${reason === "breaker" ? "1분 한도 초과" : "치지직 호출 실패 증가"}).` });
    broadcastStatus();
  });

  const services: RouteServices = {
    channel: () => credentialStore.loadChannel(), status, verdicts, executor, autoHide, rules, settings, auditLog, stats, push, broadcaster: hub, clock,
    getChatSettings: async () => api.getChatSettings(await tokenManager.getAccessToken()),
    verifyRole: (managerChannelId) => roleVerifier.roleOf(managerChannelId),
    disconnectChannel,
  };
  const http = await buildHttpServer({ config, sessions, authFlow, hub, services, logger });
  const timers: Array<ReturnType<typeof setInterval>> = [];

  /** 주기 작업: 토큰 선제 갱신·통계 저장·역할 재확인·보관 기한 정리와 백업. */
  const startTimers = () => {
    timers.push(setInterval(() => void refreshTokenQuietly(), INTERVALS.tokenCheckMs));
    timers.push(setInterval(() => stats.flush(), INTERVALS.statsFlushMs));
    timers.push(setInterval(() => void recheckSessionRoles({ sessions, roleVerifier, logger, onRevoked: (ids) => hub.closeSessions(ids, "치지직에서 매니저 권한이 해제되었습니다") }), INTERVALS.roleRecheckMs));
    timers.push(setTimeout(() => void runMaintenance(), INTERVALS.firstMaintenanceDelayMs));
    timers.push(setInterval(() => void runMaintenance(), INTERVALS.maintenanceMs));
  };
  const refreshTokenQuietly = async () => {
    if (!credentialStore.loadChannel()) return;
    try {
      await tokenManager.getAccessToken();
    } catch (error) {
      logger.warn("토큰 선제 갱신 실패", { error: describeError(error) });
    }
  };
  const runMaintenance = async () => {
    try {
      logger.info("보관 기한 정리", { ...runRetention({ database, verdicts, auditLog, sessions, clock }) });
      logger.info("백업 완료", { path: await runBackup(database, config.backupDirectory, clock) });
    } catch (error) {
      logger.error("정리·백업 실패 — 디스크 공간과 데이터 디렉터리 권한을 확인하세요", { error: describeError(error) });
    }
  };

  return {
    http,
    status,
    async start() {
      await http.listen({ host: "127.0.0.1", port: config.port });
      if (credentialStore.loadChannel()) receiver.start();
      startTimers();
    },
    async stop() {
      timers.forEach((timer) => clearInterval(timer));
      receiver.stop();
      stats.flush();
      hub.stop();
      await http.close();
      database.close();
    },
  };
}
```

> 주: `createApp`은 조립만 하는 함수라 10줄 목표를 넘는다. 구성 요소 하나하나는 앞선 Task에서 작게 나눴고, 여기서 더 쪼개면 연결 관계가 오히려 흩어진다(CLAUDE.md의 "분리를 검토한다"에 따라 검토 후 유지).

`apps/server/src/main.ts`:
```ts
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { createConsoleLogger, describeError, type Logger } from "./logger.js";
import { loadEncryptionKey, runCommandWithExecFile } from "./security/keychain.js";

/** 실행 진입점. launchd가 `node --env-file=<.env> dist/main.js`로 실행한다(ops/launchd 참고). */
async function main(): Promise<void> {
  const logger = createConsoleLogger();
  const config = loadConfig(process.env);
  const encryptionKey = await loadEncryptionKey(config.keychainService, runCommandWithExecFile);
  const app = await createApp(config, { encryptionKey, logger });
  await app.start();
  logger.info("찌리릿 가드 서버를 시작했습니다", { port: config.port, origin: config.publicOrigin });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown(app, logger, signal));
}

/** 종료 신호를 받으면 통계를 저장하고 연결을 닫은 뒤 끝낸다. */
async function shutdown(app: App, logger: Logger, signal: string): Promise<void> {
  logger.info("종료 신호를 받았습니다", { signal });
  try {
    await app.stop();
    process.exit(0);
  } catch (error) {
    logger.error("종료 중 오류", { error: describeError(error) });
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: "error", message: "서버를 시작하지 못했습니다", error: describeError(error) }));
  process.exit(1);
});
```

`apps/server/package.json`의 `scripts`에 추가:
```json
"start": "node dist/main.js",
"replay": "node dist/tools/replayLoad.js"
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- app.e2e`
Expected: PASS (1 test)

- [ ] **Step 5: 빌드 확인**

Run: `npm run build -w @zzirit-guard/server && ls apps/server/dist/main.js`
Expected: 빌드 오류 없음, `apps/server/dist/main.js` 존재

- [ ] **Step 6: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/app.ts apps/server/src/main.ts apps/server/test/app.e2e.test.ts apps/server/test/helpers/waitForAsync.ts apps/server/package.json
git commit -m "feat: 서버 조립과 실행 진입점 추가" -m "구성 요소를 연결하고 토큰 선제 갱신·통계 저장·역할 재확인·정리와 백업을 주기적으로 돌린다. 가짜 치지직으로 연결부터 섀도·자동 숨김·매니저 권한까지 종단 간 테스트한다."
```

---

### Task 23: 부하 재생 도구

**Files:**
- Create: `apps/server/src/tools/replayLoad.ts`
- Test: `apps/server/test/tools/replayLoad.test.ts`

**Interfaces:**
- Consumes: 판정 파이프라인·판정 처리기(Task 14·16)와 저장소
- Produces: `interface ReplayOptions { ratePerSecond: number; seconds: number }`, `interface ReplayReport { messages; elapsedMs; achievedPerSecond; p50Ms; p95Ms; maxMs; decisions: Record<string, number> }`, `runReplay(options: ReplayOptions): Promise<ReplayReport>`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/tools/replayLoad.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { runReplay } from "../../src/tools/replayLoad.js";

describe("runReplay", () => {
  it("정한 속도로 합성 채팅을 흘리고 처리 시간을 잰다", async () => {
    const report = await runReplay({ ratePerSecond: 200, seconds: 0.5 });
    expect(report.messages).toBe(100);
    expect(report.p95Ms).toBeLessThan(50);
    expect(Object.values(report.decisions).reduce((sum, count) => sum + count, 0)).toBe(100);
    expect(report.decisions.candidate ?? 0).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @zzirit-guard/server -- replayLoad`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/server/src/tools/replayLoad.ts`:
```ts
// 부하 재생 도구: 합성 채팅을 초당 N건으로 판정 파이프라인에 흘려 처리 시간을 잰다(스펙 13장).
// 사용법: npm run build -w @zzirit-guard/server && npm run replay -w @zzirit-guard/server -- --rate 50 --seconds 600
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createAutoHideSwitch } from "../actions/autoHideSwitch.js";
import { createDecisionHandler } from "../actions/decisionHandler.js";
import type { Executor } from "../actions/executor.js";
import type { ChatEvent } from "../chat/chatEvent.js";
import { openDatabase } from "../db/database.js";
import { createGroupFloodDetector, createPersonalFloodDetector } from "../detection/floodDetectors.js";
import { createDuplicateTracker } from "../detection/messageTraits.js";
import { createDetectionPipeline } from "../detection/pipeline.js";
import { createRuleRepository } from "../detection/ruleRepository.js";
import { silentLogger } from "../logger.js";
import { createAuditLog } from "../records/auditLog.js";
import { createMinuteStats } from "../records/minuteStats.js";
import { createSettingsRepository } from "../records/settingsRepository.js";
import { createVerdictRepository } from "../records/verdictRepository.js";

/** 재생 설정. */
export interface ReplayOptions {
  ratePerSecond: number;
  seconds: number;
}

/** 재생 결과. achievedPerSecond가 목표보다 낮으면 처리가 밀린 것이다. */
export interface ReplayReport {
  messages: number;
  elapsedMs: number;
  achievedPerSecond: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  decisions: Record<string, number>;
}

/** 합성 채팅 문장. 실채팅 분포를 흉내 낸 것이 아니라 각 규칙 경로를 고루 지나가게 고른 것이다. */
const SAMPLE_TEXTS = [
  "ㅋㅋㅋㅋㅋ", "와 방금 컨트롤 미쳤다 ㄷㄷ", "오늘 몇 시까지 방송해요?", "GG", "저 보스 존나 세네",
  "씨발 방송 꺼라", "구독하면 선물 드려요 진짜로 지금", "다음 판은 원딜 해주세요", "ㅠㅠ", "헤드샷 개쩐다",
];

/** 메시지 1건을 만든다. 보낸 사람을 돌려 써서 도배 감지도 함께 돈다. */
function syntheticChat(index: number, receivedAt: number): ChatEvent {
  return {
    channelId: "replay", senderChannelId: `viewer-${index % 300}`, chatChannelId: "chat", nickname: `viewer-${index % 300}`,
    userRoleCode: "common_user", content: SAMPLE_TEXTS[index % SAMPLE_TEXTS.length] as string, messageTime: receivedAt, receivedAt,
  };
}

/** 메모리 DB 위에 파이프라인과 처리기를 만든다. 실행기는 호출만 세는 가짜다(치지직을 부르지 않는다). */
function buildPipeline() {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('replay', '재생', 0)").run();
  database.prepare("INSERT INTO setting (channel_id) VALUES ('replay')").run();
  const clock = () => Date.now();
  const rules = createRuleRepository(database, clock);
  rules.seedDefaults("replay");
  const auditLog = createAuditLog(database, clock);
  const executor: Executor = { submit: async () => ({ ok: true, note: null }), pendingCount: () => 0, onFailureRateExceeded: () => undefined };
  const pipeline = createDetectionPipeline({ rules, auditLog, groupFlood: createGroupFloodDetector(), personalFlood: createPersonalFloodDetector(), duplicates: createDuplicateTracker() });
  const handler = createDecisionHandler({
    verdicts: createVerdictRepository(database, clock), executor, stats: createMinuteStats(database, clock), logger: silentLogger,
    autoHide: createAutoHideSwitch({ settings: createSettingsRepository(database), auditLog, clock }),
    broadcaster: { broadcast: () => undefined, pushChatLine: () => undefined },
  });
  return { pipeline, handler };
}

/** 정한 속도로 메시지를 흘리며 한 건당 처리 시간(판정 + 처리)을 잰다. */
export async function runReplay(options: ReplayOptions): Promise<ReplayReport> {
  const { pipeline, handler } = buildPipeline();
  const total = Math.round(options.ratePerSecond * options.seconds);
  const intervalMs = 1000 / options.ratePerSecond;
  const durations: number[] = [];
  const decisions: Record<string, number> = {};
  const startedAt = performance.now();
  for (let index = 0; index < total; index += 1) {
    await waitUntil(startedAt + index * intervalMs);
    const event = syntheticChat(index, Date.now());
    const begin = performance.now();
    const result = pipeline.evaluate(event);
    handler.handle(event, result);
    durations.push(performance.now() - begin);
    decisions[result.decision] = (decisions[result.decision] ?? 0) + 1;
  }
  return summarize(durations, performance.now() - startedAt, decisions);
}

/** 목표 시각까지 기다린다(이미 지났으면 바로 진행해 밀림이 결과에 드러나게 한다). */
async function waitUntil(targetMs: number): Promise<void> {
  const delay = targetMs - performance.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

/** 분위수와 처리율을 계산한다. */
function summarize(durations: number[], elapsedMs: number, decisions: Record<string, number>): ReplayReport {
  const sorted = [...durations].sort((left, right) => left - right);
  const at = (ratio: number) => round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0);
  return { messages: durations.length, elapsedMs: round(elapsedMs), achievedPerSecond: round((durations.length / elapsedMs) * 1000), p50Ms: at(0.5), p95Ms: at(0.95), maxMs: round(sorted.at(-1) ?? 0), decisions };
}

/** 소수 둘째 자리 반올림. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 명령행 실행: --rate(초당 건수, 기본 50) --seconds(기본 60). 결과를 JSON으로 출력한다. */
async function runFromCommandLine(): Promise<void> {
  const { values } = parseArgs({ options: { rate: { type: "string", default: "50" }, seconds: { type: "string", default: "60" } } });
  console.log(JSON.stringify(await runReplay({ ratePerSecond: Number(values.rate), seconds: Number(values.seconds) }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromCommandLine().catch((error: unknown) => {
    console.error("부하 재생 실패:", error);
    process.exit(1);
  });
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @zzirit-guard/server -- replayLoad`
Expected: PASS (1 test)

- [ ] **Step 5: 초당 100건 10분 재생 실행(스펙 13장 기준)**

Run: `npm run build -w @zzirit-guard/server && npm run replay -w @zzirit-guard/server -- --rate 100 --seconds 600`
Expected: `achievedPerSecond` ≈ 100, `p95Ms` < 5. 결과 JSON을 PR 설명에 붙인다(1단계 규칙 경로의 처리 여유 근거).

- [ ] **Step 6: 커밋**

```bash
npm run lint && npm run typecheck
git add apps/server/src/tools apps/server/test/tools
git commit -m "feat: 판정 파이프라인 부하 재생 도구 추가" -m "합성 채팅을 정한 속도로 흘려 한 건당 처리 시간과 실제 처리율을 잰다. 치지직은 부르지 않는다."
```

---

### Task 24: 전체 검사와 PR

- [ ] **Step 1: 전체 검사**

Run: `npm run check`
Expected: lint 0건, typecheck 통과, 서버 테스트 전부 통과

- [ ] **Step 2: 의존성 감사 기록**

Run: `mkdir -p docs/operations && (npm audit --omit=dev -w @zzirit-guard/server > docs/operations/npm-audit-stage1a.txt; echo "npm audit exit=$?")`
Expected: 취약점이 있으면 npm audit은 0이 아닌 종료 코드를 낸다(실패가 아니라 보고). socket.io-client 2.0.3 계열(engine.io-client·ws 구버전) 경고가 나올 수 있다. 파일을 커밋해 위험을 알고 받아들였다는 기록을 남긴다(스펙 8장). 다른 패키지 경고가 있으면 버전을 올려 해결한다.

```bash
git add docs/operations/npm-audit-stage1a.txt
git commit -m "docs: 1단계 서버 의존성 감사 결과 기록" -m "치지직이 socket.io-client 2.0.3까지만 지원해 남는 구버전 경고를 알고 받아들였다는 근거로 남긴다."
```

- [ ] **Step 3: PR 만들기**

```bash
git push -u origin feature/stage1-server
gh pr create --base main --title "feat: 1단계-A 서버(규칙·섀도·매니저 조치)" --body "$(cat <<'EOF'
## 요약
- 치지직 채팅 수신(Session API) → 규칙 판정 → 섀도/자동 숨김/후보 → 매니저 REST·WebSocket
- 토큰 암호화·선제 갱신·쓰기 잠금, 실행기 재시도·감사 기록, 폭주 차단
- 가짜 치지직 서버로 종단 간 테스트

## 부하 재생 결과(초당 100건, 10분)
(Task 23 Step 5 결과 JSON)

## 확인 필요
- 실제 치지직에서 sessionKey 전달 방식(쿼리)과 CHAT 페이로드 형식(객체/문자열)을 0단계 실연결로 확인

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
