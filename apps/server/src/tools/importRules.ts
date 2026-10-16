// 비공개 규칙 가져오기 도구. 파일 해시를 먼저 검증한 뒤 한 트랜잭션으로 채널 규칙을 넣는다.
// 사용법: node apps/server/dist/tools/importRules.js --db <DB 파일> --channel <채널 id> --rules <TSV> --expected-sha256 <파일 sha256>
// 실행 중인 서버는 규칙 스냅숏을 메모리에 보관하므로, 가져온 뒤 서버를 재시작해야 새 규칙이 반영된다.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Database } from "../db/database.js";
import { openDatabase } from "../db/database.js";
import { MAX_RULE_PATTERN_LENGTH } from "../detection/ruleRepository.js";
import { normalizeForMatching } from "../detection/normalize.js";

/** 인자·파일·DB 상태가 잘못됐을 때 원문 없이 원인과 해결 방향을 알린다. */
export class ImportRulesError extends Error {
  override readonly name = "ImportRulesError";
}

interface ImportRule {
  pattern: string;
  normalizedPattern: string;
}

interface ImportCounts {
  inserted: number;
  converted: number;
  existing: number;
}

interface ImportArguments {
  db: string;
  channel: string;
  rules: string;
  expectedSha256: string;
}

interface ExistingRuleMaps {
  critical: Map<string, number>;
  keywordRoute: Map<string, number>;
}

/** TSV를 검사한다. 오류에는 비공개 문구 대신 줄 번호와 고칠 방법만 쓴다. */
function parseImportRules(content: string): ImportRule[] {
  const rules: ImportRule[] = [];
  const seen = new Set<string>();
  content.split("\n").forEach((rawLine, index) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    const lineNumber = index + 1;
    if ((line.match(/\t/g) ?? []).length !== 1) throw fileError(lineNumber, "탭은 종류와 문구를 나누는 하나만 사용하세요");
    const [kind, rawPattern] = line.split("\t") as [string, string];
    const pattern = rawPattern.trim();
    if (kind !== "critical") throw fileError(lineNumber, "종류는 critical만 사용할 수 있습니다");
    if (pattern.length > MAX_RULE_PATTERN_LENGTH) throw fileError(lineNumber, `문구는 ${MAX_RULE_PATTERN_LENGTH}자 이하로 줄이세요`);
    const normalizedPattern = normalizeForMatching(pattern);
    if (normalizedPattern === "") throw fileError(lineNumber, "빈 문구가 되지 않도록 문자를 입력하세요");
    if (seen.has(normalizedPattern)) throw fileError(lineNumber, "파일 안의 정규화 중복을 제거하세요");
    seen.add(normalizedPattern);
    rules.push({ pattern, normalizedPattern });
  });
  return rules;
}

function fileError(lineNumber: number, guidance: string): ImportRulesError {
  return new ImportRulesError(`규칙 파일 ${lineNumber}번째 줄이 잘못되었습니다: ${guidance}. critical<TAB>문구 형식으로 고치세요.`);
}

/** 필수 인자와 sha256 모양을 확인한다. */
function readArguments(argv: readonly string[]): ImportArguments {
  let values: { db?: string; channel?: string; rules?: string; "expected-sha256"?: string };
  try {
    ({ values } = parseArgs({ args: [...argv], options: {
      db: { type: "string" }, channel: { type: "string" }, rules: { type: "string" }, "expected-sha256": { type: "string" },
    } }));
  } catch (error) {
    throw new ImportRulesError(`인자를 읽지 못했습니다. --db, --channel, --rules, --expected-sha256를 확인하세요. 원인: ${safeErrorName(error)}`);
  }
  if (!values.db || !values.channel || !values.rules || !values["expected-sha256"]) {
    throw new ImportRulesError("--db, --channel, --rules, --expected-sha256를 모두 주세요.");
  }
  const expectedSha256 = values["expected-sha256"].toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new ImportRulesError("--expected-sha256는 64자리 16진수여야 합니다. 파일 해시를 다시 확인하세요.");
  return { db: values.db, channel: values.channel, rules: values.rules, expectedSha256 };
}

/** 파일 해시를 DB를 열기 전에 확인한다. */
function readVerifiedRules(path: string, expectedSha256: string): ImportRule[] {
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch (error) {
    throw new ImportRulesError(`규칙 파일을 읽지 못했습니다. 경로와 권한을 확인하세요. 원인: ${safeErrorName(error)}`);
  }
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== expectedSha256) throw new ImportRulesError("규칙 파일 sha256이 기대값과 다릅니다. 파일을 직접 확인한 뒤 올바른 해시로 다시 실행하세요.");
  return parseImportRules(content.toString("utf8"));
}

/** 채널 규칙을 한 트랜잭션으로 바꾼다. */
function importRules(database: Database, channelId: string, rules: readonly ImportRule[]): ImportCounts {
  return database.transaction(() => {
    const channel = database.prepare("SELECT 1 FROM channel WHERE channel_id = ?").get(channelId);
    if (!channel) throw new ImportRulesError("채널이 DB에 없습니다. 채널 ID를 확인하거나 스트리머가 먼저 채널을 연결하세요.");
    const counts: ImportCounts = { inserted: 0, converted: 0, existing: 0 };
    const existing = readExistingRules(database, channelId);
    rules.forEach((rule) => importOne(database, channelId, rule, existing, counts));
    return counts;
  })();
}

/** 기존 승격 대상 행을 한 번만 읽고 정규형으로 찾을 수 있게 만든다. 같은 정규형이 여럿이면 가장 이른 번호를 쓴다. */
function readExistingRules(database: Database, channelId: string): ExistingRuleMaps {
  const rows = database.prepare("SELECT id, kind, pattern FROM rule_entry WHERE channel_id = ? AND kind IN ('keyword_route', 'critical') ORDER BY id").all(channelId) as
    Array<{ id: number; kind: "keyword_route" | "critical"; pattern: string }>;
  const existing: ExistingRuleMaps = { critical: new Map(), keywordRoute: new Map() };
  rows.forEach((row) => {
    const normalizedPattern = normalizeForMatching(row.pattern);
    if (row.kind === "critical" && !existing.critical.has(normalizedPattern)) existing.critical.set(normalizedPattern, row.id);
    else if (!existing.keywordRoute.has(normalizedPattern)) existing.keywordRoute.set(normalizedPattern, row.id);
  });
  return existing;
}

/** 같은 정규형 critical은 유지하고, keyword_route는 번호를 보존해 바꾸며, 없으면 새로 넣는다. */
function importOne(database: Database, channelId: string, rule: ImportRule, existing: ExistingRuleMaps, counts: ImportCounts): void {
  if (existing.critical.has(rule.normalizedPattern)) {
    counts.existing += 1;
    return;
  }
  const keywordId = existing.keywordRoute.get(rule.normalizedPattern);
  if (keywordId !== undefined) {
    // created_by는 이 도구가 keyword_route를 critical로 승격했다는 이력을 남기기 위해 import로 바꾼다.
    database.prepare("UPDATE rule_entry SET kind = 'critical', created_by = 'import' WHERE id = ?").run(keywordId);
    existing.keywordRoute.delete(rule.normalizedPattern);
    existing.critical.set(rule.normalizedPattern, keywordId);
    counts.converted += 1;
    return;
  }
  const inserted = database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES (?, 'critical', ?, 'import', ?)").run(channelId, rule.pattern, Date.now());
  existing.critical.set(rule.normalizedPattern, Number(inserted.lastInsertRowid));
  counts.inserted += 1;
}

/** 예상하지 못한 오류의 종류만 남겨 DB나 규칙 원문이 오류 메시지에 섞이지 않게 한다. */
function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "알 수 없는 오류";
}

/** 명령행 실행. 출력은 원문 없이 세 건수만 쓴다. */
export function runImportRulesCommand(argv: readonly string[] = process.argv.slice(2), write: (line: string) => void = console.log): ImportCounts {
  const options = readArguments(argv);
  const rules = readVerifiedRules(options.rules, options.expectedSha256);
  let database: Database | null = null;
  try {
    database = openDatabase(options.db);
    const counts = importRules(database, options.channel, rules);
    write(`새로 넣음 ${counts.inserted}, 바꿈 ${counts.converted}, 이미 있음 ${counts.existing}`);
    return counts;
  } catch (error) {
    if (error instanceof ImportRulesError) throw error;
    throw new ImportRulesError(`규칙을 가져오지 못했습니다. DB 상태와 규칙 충돌을 확인하세요. 원인: ${safeErrorName(error)}`);
  } finally {
    database?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runImportRulesCommand();
  } catch (error) {
    console.error(`규칙 가져오기 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    process.exitCode = error instanceof ImportRulesError ? 2 : 1;
  }
}
