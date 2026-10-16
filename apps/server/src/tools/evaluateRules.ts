// 규칙 경로 평가 도구: 채팅 평가셋(workers/stage1/eval_data)의 문장을 실제 판정 파이프라인(기본 규칙)에 넣어,
// 문장마다 규칙 판정·이유와 키워드 경로 일치 여부를 JSONL로 쓴다. 원문은 쓰지 않는다(id만).
// 왜: 1차 분류기 평가(zg_stage1.evaluate_chat)는 1차 점수만 본다. 실제 경로는 "규칙 → 키워드 경로 → 1차"라서,
// 규칙이 먼저 잡는 문장(전화번호·주소·링크·금칙어)과 키워드 경로가 2차로 보내는 문장을 합쳐야 핵심 범주를 얼마나 지키는지 알 수 있다.
// 사용법: npm run build -w @zzirit-guard/server && node apps/server/dist/tools/evaluateRules.js --eval-file <평가셋> --output <결과> [--keywords <목록>] [--rules <TSV>]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { ChatEvent } from "../chat/chatEvent.js";
import { openDatabase } from "../db/database.js";
import { createGroupFloodDetector, createPersonalFloodDetector } from "../detection/floodDetectors.js";
import { DEFAULT_RULES } from "../detection/defaultRules.js";
import { createDuplicateTracker } from "../detection/messageTraits.js";
import { normalizeForMatching } from "../detection/normalize.js";
import { createDetectionPipeline, type DetectionPipeline } from "../detection/pipeline.js";
import { createRuleRepository, type RuleRepository } from "../detection/ruleRepository.js";
import { findFirstMatch, locateExceptions } from "../detection/wordMatch.js";
import { createAuditLog } from "../records/auditLog.js";
import type { RuleKind } from "@zzirit-guard/shared";

/**
 * 평가 도구 버전. 규칙 목록 지문에 함께 넣는다. 판정 순서나 정규화처럼 같은 목록이라도 결과가 바뀌는 변경을 하면 올린다.
 * 왜: 개발셋과 보류셋의 규칙 결과가 같은 목록이어도 서로 다른 판정 방식으로 만들어졌다면 섞으면 안 되기 때문이다.
 */
const EVALUATOR_VERSION = "evaluate-rules@1";

/** 평가용 채널 식별자. 메모리 DB에만 있다. */
const EVALUATION_CHANNEL_ID = "evaluation";

/**
 * 문장 사이 간격(ms). 떼도배(10초 창)·개인 도배(10초 창)·중복 판정(10분 보관)이 서로 다른 평가 문장끼리 걸리지 않게
 * 중복 판정 보관 시간보다 길게 띄운다. 평가는 문장 하나하나의 규칙 판정을 보려는 것이라, 도배·중복은 측정 대상이 아니다.
 */
const MESSAGE_SPACING_MS = 11 * 60_000;

/** 평가셋 한 줄에서 쓰는 값. split은 평가셋의 셋 이름(dev·holdout, 없으면 null)이다. */
export interface EvaluationItem {
  id: string;
  text: string;
  split: string | null;
}

/**
 * 문장 하나의 규칙 경로 결과.
 * keyword는 키워드 경로에 걸린 규칙 번호(없으면 null), skipAi는 AI 단계를 건너뛰는 가벼운 반응(스펙 5.2 ③)인지다.
 * evalSha256·policySha256은 어떤 평가셋과 어떤 규칙 목록으로 만든 결과인지 확인하는 값이다(줄마다 같다).
 */
export interface RuleRoute {
  id: string;
  decision: "auto_hide" | "candidate" | "pass";
  reason: string;
  keyword: number | null;
  skipAi: boolean;
  evalSha256: string;
  policySha256: string;
  rulesFileSha256: string | null;
  rulesCanonicalSha256: string | null;
}

/** 평가에 더할 수 있는 공개 규칙 종류. 기본 규칙과 같은 종류만 중복을 검사한다. */
export type EvaluationRuleKind = "critical" | "keyword_route";

/** TSV 한 줄에서 읽은 추가 규칙. 정규화·입력 줄은 오류와 해시를 설명할 때만 쓴다. */
export interface EvaluationRule {
  kind: EvaluationRuleKind;
  pattern: string;
  normalizedPattern?: string;
  inputLine?: number;
}

/** 규칙 TSV와 그 규칙에 대한 정규형 지문. 원문 파일 지문은 호출자가 바이트로 계산한다. */
export interface ParsedRulePatterns {
  rules: EvaluationRule[];
  canonical: string;
}

/** 도구 인자가 잘못됐을 때 던진다. 원인을 그대로 사용자에게 보여 준다. */
export class EvaluateRulesArgumentError extends Error {
  override readonly name = "EvaluateRulesArgumentError";
}

/**
 * 메모리 DB 위에 기본 규칙과 추가 키워드 경로 패턴을 넣은 판정 파이프라인을 만든다. 치지직·실행기는 쓰지 않는다.
 * @param keywordPatterns 키워드 경로로 넣을 패턴 목록(기본 규칙에 더한다)
 */
function buildEvaluationPipeline(keywordPatterns: readonly string[], additionalRules: readonly EvaluationRule[]): { pipeline: DetectionPipeline; rules: RuleRepository } {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES (?, '평가', 0)").run(EVALUATION_CHANNEL_ID);
  database.prepare("INSERT INTO setting (channel_id) VALUES (?)").run(EVALUATION_CHANNEL_ID);
  const clock = () => Date.now();
  const rules = createRuleRepository(database, clock);
  rules.seedDefaults(EVALUATION_CHANNEL_ID);
  keywordPatterns.forEach((pattern) => rules.add(EVALUATION_CHANNEL_ID, "keyword_route", pattern, "evaluation"));
  additionalRules.forEach((rule) => rules.add(EVALUATION_CHANNEL_ID, rule.kind as RuleKind, rule.pattern, "evaluation"));
  const auditLog = createAuditLog(database, clock);
  const pipeline = createDetectionPipeline({ rules, auditLog, groupFlood: createGroupFloodDetector(), personalFlood: createPersonalFloodDetector(), duplicates: createDuplicateTracker() });
  return { pipeline, rules };
}

/**
 * 평가 문장 하나를 일반 시청자(서로 다른 사람)의 채팅 이벤트로 만든다. 권한자가 아니므로 auto_hide가 후보로 낮춰지지 않는다.
 * @param item 평가 문장
 * @param index 순번(보낸 사람과 시각을 정한다)
 */
function toEvaluationEvent(item: EvaluationItem, index: number): ChatEvent {
  const receivedAt = (index + 1) * MESSAGE_SPACING_MS;
  return {
    channelId: EVALUATION_CHANNEL_ID, senderChannelId: `viewer-${index}`, chatChannelId: "evaluation-chat", nickname: `viewer-${index}`,
    userRoleCode: "common_user", content: item.text, messageTime: receivedAt, receivedAt,
  };
}

/**
 * 키워드 경로 일치를 찾는다. 규칙 판정과 같은 정규화·예외 단어 처리를 쓴다(파이프라인이 연결되면 같은 방식으로 볼 것이다).
 * @param rules 규칙 저장소
 * @param text 원문
 * @returns 걸린 키워드 경로 규칙 번호(없으면 null)
 */
function findKeywordRoute(rules: RuleRepository, text: string): number | null {
  const snapshot = rules.snapshot(EVALUATION_CHANNEL_ID);
  return findFirstMatch(locateExceptions(normalizeForMatching(text), snapshot.exception), snapshot.keywordRoute)?.id ?? null;
}

/**
 * 규칙 목록의 지문(sha256). 종류·패턴을 정렬해 해시하므로 같은 목록이면 같은 값이다.
 * 왜: 개발셋과 보류셋을 같은 규칙 목록으로 평가했는지 평가 도구(evaluate_chat)가 확인하게 하기 위해서다.
 * @param rules 규칙 저장소
 */
function computePolicySha256(rules: RuleRepository): string {
  const lines = rules.list(EVALUATION_CHANNEL_ID).map((rule) => `${rule.kind}\t${rule.pattern}`).sort();
  return createHash("sha256").update([EVALUATOR_VERSION, ...lines].join("\n")).digest("hex");
}

/**
 * 평가 문장마다 규칙 판정·이유·키워드 경로 일치·AI 건너뜀 여부를 구한다.
 * @param items 평가 문장 목록
 * @param keywordPatterns 키워드 경로 패턴 목록(기본 규칙에 더한다)
 * @param evalSha256 평가셋 파일의 sha256(결과에 그대로 적는다)
 */
export function evaluateRuleRoutes(
  items: readonly EvaluationItem[],
  keywordPatterns: readonly string[] = [],
  evalSha256 = "",
  additionalRules: readonly EvaluationRule[] = [],
  rulesFileSha256: string | null = null,
  rulesCanonicalSha256: string | null = null,
): RuleRoute[] {
  const { pipeline, rules } = buildEvaluationPipeline(keywordPatterns, additionalRules);
  const policySha256 = computePolicySha256(rules);
  return items.map((item, index) => {
    const result = pipeline.evaluate(toEvaluationEvent(item, index));
    const keyword = findKeywordRoute(rules, item.text);
    return {
      id: item.id, decision: result.decision, reason: result.reason, keyword, skipAi: result.trivial, evalSha256, policySha256,
      rulesFileSha256, rulesCanonicalSha256,
    };
  });
}

/**
 * 평가셋 JSONL을 읽는다. 줄마다 id와 text가 문자열이어야 한다. 원문은 오류 메시지에 넣지 않는다.
 * @param content 파일 내용
 */
export function parseEvaluationItems(content: string): EvaluationItem[] {
  return content.split("\n").filter((line) => line.trim() !== "").map((line, index) => {
    const record: unknown = JSON.parse(line);
    const { id, text, split } = (record ?? {}) as { id?: unknown; text?: unknown; split?: unknown };
    if (typeof id !== "string" || typeof text !== "string") throw new EvaluateRulesArgumentError(`${index + 1}번째 줄에 문자열 id·text가 없습니다. 평가셋 파일인지 확인하세요`);
    return { id, text, split: typeof split === "string" ? split : null };
  });
}

/**
 * 키워드 목록 파일을 읽는다. 한 줄에 패턴 하나, 빈 줄과 '#'으로 시작하는 줄은 건너뛴다.
 * @param content 파일 내용
 */
export function parseKeywordPatterns(content: string): string[] {
  return content.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
}

/** 규칙 파일의 최대 문구 길이. 저장소의 사용자 규칙 제한과 맞춘다. */
const MAX_RULE_PATTERN_LENGTH = 50;

/** 규칙 TSV 오류를 줄 번호와 수정 방향만으로 설명한다. 문구 원문은 비공개 후보일 수 있어 넣지 않는다. */
function ruleFileError(line: number, guidance: string): EvaluateRulesArgumentError {
  return new EvaluateRulesArgumentError(`규칙 파일 ${line}번째 줄이 잘못되었습니다: ${guidance}. 종류<TAB>패턴 형식으로 고치세요`);
}

/** 규칙 종류와 정규화된 문구로 기본·입력 중복 키를 만든다. */
function ruleKey(kind: EvaluationRuleKind | string, normalizedPattern: string): string {
  return `${kind}\u0000${normalizedPattern}`;
}

/** 규칙 목록을 정규형(종류·정규화 문구 정렬, 줄 끝 개행)으로 만든다. */
export function canonicalizeRulePatterns(rules: readonly EvaluationRule[]): string {
  return rules
    .map((rule) => `${rule.kind}\t${rule.normalizedPattern ?? normalizeForMatching(rule.pattern)}`)
    .sort()
    .join("\n") + (rules.length > 0 ? "\n" : "");
}

/** 규칙 TSV를 읽고 저장소와 같은 길이·정규화 중복 규칙을 검사한다. */
export function parseRulePatterns(content: string): ParsedRulePatterns {
  const rules: EvaluationRule[] = [];
  const seen = new Set<string>();
  const defaultKeys = new Set(
    DEFAULT_RULES.map((rule) => ruleKey(rule.kind, normalizeForMatching(rule.pattern))),
  );
  content.split("\n").forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    if ((line.match(/\t/g) ?? []).length !== 1) throw ruleFileError(lineNumber, "탭은 종류와 패턴을 나누는 하나만 사용하세요");
    const [kind, rawPattern] = line.split("\t") as [string, string];
    // 저장소 add가 앞뒤 공백을 제거한 뒤 길이·빈 값·중복을 검사하므로 평가도 같은 값을 쓴다.
    const pattern = rawPattern.trim();
    if (kind !== "critical" && kind !== "keyword_route") throw ruleFileError(lineNumber, "종류는 critical 또는 keyword_route만 사용할 수 있습니다");
    if (pattern.length > MAX_RULE_PATTERN_LENGTH) throw ruleFileError(lineNumber, `패턴은 ${MAX_RULE_PATTERN_LENGTH}자 이하로 줄이세요`);
    const normalizedPattern = normalizeForMatching(pattern);
    if (normalizedPattern === "") throw ruleFileError(lineNumber, "빈 패턴이 되지 않도록 문자를 입력하세요");
    const key = ruleKey(kind, normalizedPattern);
    if (seen.has(key)) throw ruleFileError(lineNumber, "파일 안에서 같은 종류의 정규화 중복을 제거하세요");
    if (defaultKeys.has(key)) throw ruleFileError(lineNumber, "기본 규칙과 같은 종류의 정규화 중복을 제거하세요");
    seen.add(key);
    rules.push({ kind, pattern, normalizedPattern, inputLine: lineNumber });
  });
  return { rules, canonical: canonicalizeRulePatterns(rules) };
}

/** --keywords와 같은 keyword_route를 --rules에서 다시 넣지 않게 막는다. critical 승격은 허용한다. */
export function ensureRulesDoNotDuplicateKeywords(rules: readonly EvaluationRule[], keywords: readonly string[]): void {
  const keywordKeys = new Set(keywords.map((pattern) => normalizeForMatching(pattern)));
  const duplicate = rules.find((rule) => rule.kind === "keyword_route" && keywordKeys.has(rule.normalizedPattern ?? normalizeForMatching(rule.pattern)));
  if (duplicate) throw ruleFileError(duplicate.inputLine ?? 0, "--keywords와 겹치는 keyword_route를 제거하세요");
}

/** 명령행 인자를 읽는다. 평가셋과 결과 경로는 꼭 있어야 한다. */
function readArguments(argv: readonly string[] = process.argv.slice(2)): { evalFile: string; output: string; keywords: string | undefined; rules: string | undefined } {
  const { values } = parseArgs({ args: [...argv], options: { "eval-file": { type: "string" }, output: { type: "string" }, keywords: { type: "string" }, rules: { type: "string" } } });
  if (!values["eval-file"] || !values.output) throw new EvaluateRulesArgumentError("--eval-file과 --output을 주세요");
  return { evalFile: values["eval-file"], output: values.output, keywords: values.keywords, rules: values.rules };
}

/**
 * 보류셋에는 저장소 기본 목록만 쓴다. 임의 키워드로 보류셋을 몇 번이고 돌리면 보류셋으로 목록을 다듬게 되기 때문이다.
 * 목록을 바꾸려면 기본 목록(defaultRules.ts)을 커밋으로 바꾸고 개발셋부터 다시 본다.
 * @param items 평가 문장 목록
 * @param keywords 추가 키워드 패턴
 */
export function ensureHoldoutUsesDefaults(
  items: readonly EvaluationItem[],
  keywords: readonly string[],
  additionalRules: readonly EvaluationRule[] = [],
  rulesOptionProvided = additionalRules.length > 0,
): void {
  if ((keywords.length > 0 || rulesOptionProvided) && items.some((item) => item.split === "holdout")) {
    throw new EvaluateRulesArgumentError("보류셋에는 --keywords와 --rules를 쓸 수 없습니다. 목록은 개발셋으로 다듬고 기본 목록에 넣은 뒤 보류셋을 보세요");
  }
}

/** 명령행 실행: 평가셋을 판정해 결과 JSONL을 쓰고, 판정별 건수만 출력한다. */
export function runEvaluateRulesCommand(argv: readonly string[] = process.argv.slice(2)): void {
  const options = readArguments(argv);
  const content = readFileSync(options.evalFile);
  const items = parseEvaluationItems(content.toString("utf8"));
  const keywords = options.keywords ? parseKeywordPatterns(readFileSync(options.keywords, "utf8")) : [];
  const rulesContent = options.rules ? readFileSync(options.rules) : null;
  const parsedRules = rulesContent ? parseRulePatterns(rulesContent.toString("utf8")) : { rules: [], canonical: "" };
  ensureRulesDoNotDuplicateKeywords(parsedRules.rules, keywords);
  ensureHoldoutUsesDefaults(items, keywords, parsedRules.rules, options.rules !== undefined);
  const rulesFileSha256 = rulesContent ? createHash("sha256").update(rulesContent).digest("hex") : null;
  const rulesCanonicalSha256 = rulesContent ? createHash("sha256").update(parsedRules.canonical).digest("hex") : null;
  const routes = evaluateRuleRoutes(
    items, keywords, createHash("sha256").update(content).digest("hex"), parsedRules.rules, rulesFileSha256, rulesCanonicalSha256,
  );
  writeFileSync(options.output, routes.map((route) => JSON.stringify(route)).join("\n") + "\n");
  const counts: Record<string, number> = {};
  routes.forEach((route) => { counts[route.decision] = (counts[route.decision] ?? 0) + 1; });
  console.log(JSON.stringify({ items: routes.length, keywordPatterns: keywords.length, keywordMatches: routes.filter((route) => route.keyword !== null).length, decisions: counts }));
}

function runFromCommandLine(): void {
  runEvaluateRulesCommand();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runFromCommandLine();
  } catch (error) {
    console.error(`규칙 경로 평가 실패: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(error instanceof EvaluateRulesArgumentError ? 2 : 1);
  }
}
