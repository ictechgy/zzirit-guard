// 후보 규칙의 개발셋 오후보를 같은 정규화·예외 처리로 재현하는 결정적 도구다.
// 원문을 보고서에 복사하지 않아, 비공개 후보와 허용 문장이 산출물에 남지 않게 한다.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_RULES } from "../detection/defaultRules.js";
import { normalizeForMatching, normalizeKeepingWhitespace } from "../detection/normalize.js";
import { findFirstMatch, locateExceptions, type ExceptionAwareText } from "../detection/wordMatch.js";
import type { RuleEntry } from "../detection/ruleRepository.js";

export interface ScreenThresholds {
  maxHitsA: number;
  maxHitsB: number;
  maxUnionA: number;
  maxUnionB: number;
}

const DEFAULT_THRESHOLDS: ScreenThresholds = { maxHitsA: 3, maxHitsB: 9, maxUnionA: 41, maxUnionB: 139 };

export class ScreenRulesArgumentError extends Error {
  override readonly name = "ScreenRulesArgumentError";
}

export interface ScreenCandidateReport {
  input_line: number;
  pattern_sha256: string;
  hits_a: number;
  hits_b: number;
  stage1_kept: boolean;
  stage2_removed_order: number | null;
  duplicate_of: number | null;
}

export interface ScreenReport {
  candidates: ScreenCandidateReport[];
  corpus_a: { line_count: number; files: Array<{ line_count: number; sha256: string }> };
  corpus_b: { line_count: number; sha256: string };
  thresholds: ScreenThresholds;
  union_after_stage1: { a: number; b: number };
  union_after_stage2: { a: number; b: number };
  remaining_count: number;
  output_tsv_sha256: string;
  output_tsv_canonical_sha256: string;
}

export interface ScreenResult {
  outputTsv: string;
  report: ScreenReport;
}

interface CorpusSource {
  content: string;
  sha256?: string;
}

interface CorpusRow {
  lineNumber: number;
  text: string;
}

interface Candidate {
  inputLine: number;
  pattern: string;
  normalizedPattern: string;
  entry: RuleEntry;
  duplicateOf: number | null;
  hitsA: string[];
  hitsB: string[];
  stage1Kept: boolean;
  stage2RemovedOrder: number | null;
}

interface PreparedCorpus {
  rows: CorpusRow[];
  matches: ExceptionAwareText[];
}

/** 후보 TSV와 두 묶음을 읽어 1·2단계에서 남길 문구와 비공개 보고서를 만든다. */
export function screenCandidates(
  candidateContent: string,
  corpusAContents: readonly (string | CorpusSource)[],
  corpusBContent: string | CorpusSource,
  corpusBLabel: string,
  thresholds: ScreenThresholds = DEFAULT_THRESHOLDS,
): ScreenResult {
  validateThresholds(thresholds);
  const exceptions = defaultExceptionEntries();
  const candidates = parseCandidates(candidateContent);
  const corpusA = corpusAContents.map((source, index) => prepareCorpus(source, exceptions, `A 묶음 ${index + 1}`));
  const corpusB = prepareCorpus(corpusBContent, exceptions, "B 묶음", corpusBLabel);
  countCandidateHits(candidates, corpusA, corpusB);
  applyStage1(candidates, thresholds);
  const unionAfterStage1 = unionCounts(candidates.filter((candidate) => candidate.stage1Kept));
  applyStage2(candidates, thresholds);
  const remaining = candidates.filter((candidate) => candidate.stage1Kept && candidate.stage2RemovedOrder === null);
  const outputTsv = remaining.map((candidate) => `critical\t${candidate.pattern}`).join("\n") + (remaining.length > 0 ? "\n" : "");
  const report = buildReport(candidates, corpusA, corpusB, thresholds, unionAfterStage1, outputTsv, remaining);
  return { outputTsv, report };
}

/** 후보 파일의 빈 줄·주석을 건너뛰고 종류와 패턴을 검증한다. */
function parseCandidates(content: string): Candidate[] {
  const candidates: Candidate[] = [];
  const firstByNormalized = new Map<string, number>();
  content.split("\n").forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    const fields = line.split("\t");
    if (fields.length !== 2) throw new ScreenRulesArgumentError(`${lineNumber}번째 후보 줄의 탭 수가 잘못됐습니다. critical<TAB>문구 형식으로 고쳐 주세요`);
    const kind = fields[0] as string;
    const pattern = fields[1] as string;
    if (kind !== "critical") throw new ScreenRulesArgumentError(`${lineNumber}번째 후보 줄의 종류가 잘못됐습니다. 종류를 critical로 고쳐 주세요`);
    const normalizedPattern = normalizeForMatching(pattern);
    if (normalizedPattern === "") throw new ScreenRulesArgumentError(`${lineNumber}번째 후보 줄의 문구가 비었습니다. 정규화 후 글자가 남는 문구를 주세요`);
    const duplicateOf = firstByNormalized.get(normalizedPattern) ?? null;
    if (duplicateOf === null) firstByNormalized.set(normalizedPattern, lineNumber);
    const entry = {
      id: lineNumber,
      kind: "critical" as RuleEntry["kind"],
      pattern,
      createdBy: "screen-rules",
      createdAt: 0,
      normalizedPattern,
      spacedPattern: normalizeKeepingWhitespace(pattern),
    } as RuleEntry;
    candidates.push({ inputLine: lineNumber, pattern, normalizedPattern, entry, duplicateOf, hitsA: [], hitsB: [], stage1Kept: false, stage2RemovedOrder: null });
  });
  return candidates;
}

/** 기본 규칙의 exception만 도구용 비교 항목으로 바꾼다. */
function defaultExceptionEntries(): RuleEntry[] {
  return DEFAULT_RULES.filter((rule) => rule.kind === "exception").map((rule, index) => ({
    id: index + 1,
    kind: "exception",
    pattern: rule.pattern,
    createdBy: "default",
    createdAt: 0,
    normalizedPattern: normalizeForMatching(rule.pattern),
    spacedPattern: normalizeKeepingWhitespace(rule.pattern),
  }));
}

/** JSONL 묶음을 파싱하고, B라면 라벨이 일치하는 행만 선택한다. */
function prepareCorpus(source: string | CorpusSource, exceptions: readonly RuleEntry[], name: string, label?: string): PreparedCorpus & { sha256: string } {
  const input = typeof source === "string" ? { content: source } : source;
  const rows: CorpusRow[] = [];
  input.content.split("\n").forEach((rawLine, index) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new ScreenRulesArgumentError(`${name} ${index + 1}번째 줄이 JSON이 아닙니다. JSONL의 각 줄을 확인해 주세요`);
    }
    if (record === null || typeof record !== "object" || typeof (record as { text?: unknown }).text !== "string") {
      throw new ScreenRulesArgumentError(`${name} ${index + 1}번째 줄에 문자열 text가 없습니다. JSONL 형식을 확인해 주세요`);
    }
    if (label !== undefined) {
      const recordLabel = (record as { label?: unknown }).label;
      if (typeof recordLabel !== "string") throw new ScreenRulesArgumentError(`${name} ${index + 1}번째 줄에 문자열 label이 없습니다. 모든 줄에 라벨을 넣어 주세요`);
      if (recordLabel !== label) return;
    }
    rows.push({ lineNumber: index + 1, text: (record as { text: string }).text });
  });
  return { rows, matches: rows.map((row) => locateExceptions(normalizeForMatching(row.text), exceptions)), sha256: input.sha256 ?? sha256(input.content) };
}

/** 각 후보의 실제 적중 줄 식별자를 만든다. 후보 하나가 한 줄에서 여러 번 맞아도 한 번만 넣는다. */
function countCandidateHits(candidates: Candidate[], corpusA: readonly PreparedCorpus[], corpusB: PreparedCorpus): void {
  candidates.forEach((candidate) => {
    corpusA.forEach((corpus, fileIndex) => {
      corpus.matches.forEach((target, rowIndex) => {
        if (findFirstMatch(target, [candidate.entry]) !== null) candidate.hitsA.push(`${fileIndex}:${corpus.rows[rowIndex]?.lineNumber}`);
      });
    });
    corpusB.matches.forEach((target, rowIndex) => {
      if (findFirstMatch(target, [candidate.entry]) !== null) candidate.hitsB.push(`${corpusB.rows[rowIndex]?.lineNumber}`);
    });
  });
}

/** 1단계는 문구별 적중 줄 수의 경계값을 포함해 적용한다. */
function applyStage1(candidates: Candidate[], thresholds: ScreenThresholds): void {
  candidates.forEach((candidate) => {
    candidate.stage1Kept = candidate.duplicateOf === null && candidate.hitsA.length <= thresholds.maxHitsA && candidate.hitsB.length <= thresholds.maxHitsB;
  });
}

/** 합집합 제한을 넘으면 매번 현재 합집합에서 가장 많이 줄이는 후보를 제거한다. */
function applyStage2(candidates: Candidate[], thresholds: ScreenThresholds): void {
  let removedOrder = 0;
  while (true) {
    const active = candidates.filter((candidate) => candidate.stage1Kept && candidate.stage2RemovedOrder === null);
    const current = unionCounts(active);
    if (current.a <= thresholds.maxUnionA && current.b <= thresholds.maxUnionB) return;
    const before = current.a + current.b;
    const selected = active
      .map((candidate) => {
        const without = unionCounts(active.filter((other) => other !== candidate));
        return { candidate, reduction: before - (without.a + without.b) };
      })
      .sort((left, right) => right.reduction - left.reduction || (right.candidate.hitsA.length + right.candidate.hitsB.length) - (left.candidate.hitsA.length + left.candidate.hitsB.length) || compareLexically(left.candidate.normalizedPattern, right.candidate.normalizedPattern))[0]?.candidate;
    if (!selected) return;
    selected.stage2RemovedOrder = ++removedOrder;
  }
}

/** locale 설정에 따라 달라지지 않는 정규화 문구 사전순 비교다. */
function compareLexically(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** 선택 후보의 A·B 물리 줄 합집합 크기를 센다. */
function unionCounts(candidates: readonly Candidate[]): { a: number; b: number } {
  const a = new Set<string>();
  const b = new Set<string>();
  candidates.forEach((candidate) => { candidate.hitsA.forEach((hit) => a.add(hit)); candidate.hitsB.forEach((hit) => b.add(hit)); });
  return { a: a.size, b: b.size };
}

/** 내부 결과를 문구 없는 JSON 보고서로 직렬화할 값으로 바꾼다. */
function buildReport(candidates: readonly Candidate[], corpusA: readonly (PreparedCorpus & { sha256: string })[], corpusB: PreparedCorpus & { sha256: string }, thresholds: ScreenThresholds, unionAfterStage1: { a: number; b: number }, outputTsv: string, remaining: readonly Candidate[]): ScreenReport {
  const unionAfterStage2 = unionCounts(remaining);
  return {
    candidates: candidates.map((candidate) => ({
      input_line: candidate.inputLine,
      pattern_sha256: sha256(candidate.normalizedPattern),
      hits_a: candidate.hitsA.length,
      hits_b: candidate.hitsB.length,
      stage1_kept: candidate.stage1Kept,
      stage2_removed_order: candidate.stage2RemovedOrder,
      duplicate_of: candidate.duplicateOf,
    })),
    corpus_a: { line_count: corpusA.reduce((sum, corpus) => sum + corpus.rows.length, 0), files: corpusA.map((corpus) => ({ line_count: corpus.rows.length, sha256: corpus.sha256 })) },
    corpus_b: { line_count: corpusB.rows.length, sha256: corpusB.sha256 },
    thresholds: { ...thresholds },
    union_after_stage1: unionAfterStage1,
    union_after_stage2: unionAfterStage2,
    remaining_count: remaining.length,
    output_tsv_sha256: sha256(outputTsv),
    output_tsv_canonical_sha256: sha256(remaining.map((candidate) => `critical\t${candidate.normalizedPattern}`).sort().join("\n") + (remaining.length > 0 ? "\n" : "")),
  };
}

function validateThresholds(thresholds: ScreenThresholds): void {
  for (const [name, value] of Object.entries(thresholds)) {
    if (!Number.isInteger(value) || value < 0) throw new ScreenRulesArgumentError(`${name} 문턱은 0 이상의 정수여야 합니다. 옵션 값을 고쳐 주세요`);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function readNonNegativeInteger(name: string, raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new ScreenRulesArgumentError(`--${name}은 0 이상의 정수여야 합니다. 문턱 값을 고쳐 주세요`);
  return value;
}

function readArguments(args: readonly string[] = process.argv.slice(2)): { candidates: string; corpusA: string[]; corpusB: string; corpusBLabel: string; outputTsv: string; outputJson: string; thresholds: ScreenThresholds } {
  let values: { candidates?: string; "corpus-a"?: string[]; "corpus-b"?: string; "corpus-b-label"?: string; "output-tsv"?: string; "output-json"?: string; "max-hits-a"?: string; "max-hits-b"?: string; "max-union-a"?: string; "max-union-b"?: string };
  try {
    ({ values } = parseArgs({ args: [...args], options: {
      candidates: { type: "string" }, "corpus-a": { type: "string", multiple: true }, "corpus-b": { type: "string" }, "corpus-b-label": { type: "string" },
      "output-tsv": { type: "string" }, "output-json": { type: "string" }, "max-hits-a": { type: "string" }, "max-hits-b": { type: "string" }, "max-union-a": { type: "string" }, "max-union-b": { type: "string" },
    } }));
  } catch (error) {
    throw new ScreenRulesArgumentError(`인자를 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
  const corpusA = values["corpus-a"] ?? [];
  if (!values.candidates || corpusA.length === 0 || !values["corpus-b"] || values["corpus-b-label"] === undefined || !values["output-tsv"] || !values["output-json"]) {
    throw new ScreenRulesArgumentError("--candidates, --corpus-a, --corpus-b, --corpus-b-label, --output-tsv, --output-json을 모두 주세요. --corpus-a는 하나 이상 필요합니다");
  }
  return {
    candidates: values.candidates, corpusA, corpusB: values["corpus-b"], corpusBLabel: values["corpus-b-label"], outputTsv: values["output-tsv"], outputJson: values["output-json"],
    thresholds: {
      maxHitsA: readNonNegativeInteger("max-hits-a", values["max-hits-a"], DEFAULT_THRESHOLDS.maxHitsA), maxHitsB: readNonNegativeInteger("max-hits-b", values["max-hits-b"], DEFAULT_THRESHOLDS.maxHitsB),
      maxUnionA: readNonNegativeInteger("max-union-a", values["max-union-a"], DEFAULT_THRESHOLDS.maxUnionA), maxUnionB: readNonNegativeInteger("max-union-b", values["max-union-b"], DEFAULT_THRESHOLDS.maxUnionB),
    },
  };
}

export function runScreenRulesCli(args: readonly string[] = process.argv.slice(2)): ScreenResult {
  const options = readArguments(args);
  const readSource = (path: string): CorpusSource => { const content = readFileSync(path); return { content: content.toString("utf8"), sha256: sha256(content) }; };
  const result = screenCandidates(readFileSync(options.candidates, "utf8"), options.corpusA.map(readSource), readSource(options.corpusB), options.corpusBLabel, options.thresholds);
  writeFileSync(options.outputTsv, result.outputTsv, "utf8");
  writeFileSync(options.outputJson, `${JSON.stringify(result.report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ candidates: result.report.candidates.length, stage1Kept: result.report.candidates.filter((candidate) => candidate.stage1_kept).length, remaining: result.report.remaining_count }));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runScreenRulesCli();
  } catch (error) {
    console.error(`규칙 거르기 실패: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(error instanceof ScreenRulesArgumentError ? 2 : 1);
  }
}
