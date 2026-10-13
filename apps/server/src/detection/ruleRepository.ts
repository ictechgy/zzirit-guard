import type { RuleEntryDto, RuleKind } from "@zzirit-guard/shared";
import type { Database } from "../db/database.js";
import type { Clock } from "../time.js";
import { DEFAULT_RULES } from "./defaultRules.js";
import { normalizeForMatching, normalizeKeepingWhitespace } from "./normalize.js";

/** 사용자 입력 규칙이 잘못된 경우. 메시지를 그대로 매니저에게 보여 준다. */
export class RuleValidationError extends Error {
  override readonly name = "RuleValidationError";
}

/** 비교용 패턴을 함께 가진 규칙. */
export interface RuleEntry extends RuleEntryDto {
  /** 공백까지 지운 비교용 패턴(normalizeForMatching). */
  normalizedPattern: string;
  /** 공백을 한 칸씩 남긴 비교용 패턴(normalizeKeepingWhitespace). 금칙어 강의 단어 안 일치를 볼 때 쓴다(F4). */
  spacedPattern: string;
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
/**
 * 허용 도메인의 모양(K14): 영문 소문자·숫자·한글·하이픈 라벨을 점으로 이은 것, 라벨 둘 이상.
 * 왜: 허용 도메인은 그 하위 도메인까지 모두 허용한다. "com"처럼 점이 없는 한 단어를 받으면 ".com"으로 끝나는 모든 광고 링크가 통과한다.
 * 포트(:)·아이디(@)·쿼리(?)·와일드카드(*) 같은 글자는 링크 검사가 뽑는 호스트에 없어, 넣어도 아무것과 맞지 않는 실수다.
 */
const ALLOW_DOMAIN_SHAPE_PATTERN = /^[a-z0-9가-힣-]+(?:\.[a-z0-9가-힣-]+)+$/;
/**
 * 허용 도메인으로 받지 않는 흔한 2단계 공용 접미사(K14). 누구나 그 아래에 사이트를 만들 수 있어, 넣으면 모르는 광고 사이트까지 허용된다.
 * 공용 접미사 목록 전체가 아니라 이 채널에서 자주 보일 것만 둔다(전체 목록은 수천 개라 의존성을 늘리지 않으려고).
 */
const PUBLIC_SECOND_LEVEL_SUFFIXES: ReadonlySet<string> = new Set([
  "co.kr", "or.kr", "go.kr", "ne.kr", "re.kr", "ac.kr", "pe.kr", "hs.kr", "ms.kr", "es.kr", "sc.kr", "kg.kr", "mil.kr",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.cn", "net.cn", "org.cn", "com.au", "net.au", "org.au",
  "com.tw", "com.hk", "com.sg", "com.vn", "com.ph", "com.br", "co.nz", "co.in", "co.id",
]);
/** 허용 도메인 모양이 틀렸을 때의 안내 문구. */
const ALLOW_DOMAIN_SHAPE_MESSAGE = "허용 도메인은 'youtube.com'처럼 점이 있는 도메인만 넣으세요. 포트(:)·경로(/…)·아이디(@)·물음표는 넣을 수 없습니다.";

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

/** 길이와 비교용 결과가 비지 않는지 확인한다. 허용 도메인은 모양도 본다(K14). */
function validatePattern(kind: RuleKind, pattern: string): void {
  if (pattern.length > MAX_PATTERN_LENGTH) throw new RuleValidationError(`규칙은 ${MAX_PATTERN_LENGTH}자 이하로 입력하세요.`);
  if (!normalizePattern(kind, pattern)) {
    throw new RuleValidationError("규칙이 비었습니다. 특수문자·공백만으로는 규칙을 만들 수 없습니다.");
  }
  if (kind === "allow_domain") validateAllowDomain(pattern);
}

/**
 * 허용 도메인이 한 사이트를 가리키는지 확인한다(K14). 주소를 붙여 넣는 경우가 많아 scheme·www·끝의 "/"는 받고,
 * 그 밖의 경로·포트·아이디·한 단어·공용 접미사는 거부한다.
 * 왜 경로를 받지 않나: 저장할 때 경로를 떼어 도메인 전체를 허용하므로, "youtube.com/채널"을 넣은 매니저는 그 채널만 허용한 줄 안다.
 * @param pattern 매니저가 입력한 패턴(앞뒤 공백 제거됨)
 * @throws RuleValidationError 받을 수 없는 모양일 때(고칠 방법을 담는다)
 */
function validateAllowDomain(pattern: string): void {
  const withoutScheme = pattern.toLowerCase().replace(/^[a-z]+:\/\//, "");
  const [authority = "", ...pathParts] = withoutScheme.split("/");
  const domain = authority.replace(/^www\./, "");
  if (pathParts.join("/") !== "" || !ALLOW_DOMAIN_SHAPE_PATTERN.test(domain)) throw new RuleValidationError(ALLOW_DOMAIN_SHAPE_MESSAGE);
  if (PUBLIC_SECOND_LEVEL_SUFFIXES.has(domain)) {
    throw new RuleValidationError(`'${domain}'은 누구나 쓰는 공용 접미사라 허용 도메인으로 넣을 수 없습니다. 'example.${domain}'처럼 사이트 도메인을 넣으세요.`);
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
  const entries = rows.map((row) => {
    const normalizedPattern = normalizePattern(row.kind, row.pattern);
    // 도메인 규칙은 공백 개념이 없어 같은 값을 쓴다.
    const spacedPattern = row.kind === "allow_domain" ? normalizedPattern : normalizeKeepingWhitespace(row.pattern);
    return { ...toDto(row), normalizedPattern, spacedPattern };
  });
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
