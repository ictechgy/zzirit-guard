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
