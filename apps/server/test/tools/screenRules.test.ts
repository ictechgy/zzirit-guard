import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ScreenRulesArgumentError,
  screenCandidates,
  runScreenRulesCli,
  type ScreenThresholds,
} from "../../src/tools/screenRules.js";
import { parseRulePatterns } from "../../src/tools/evaluateRules.js";

const permissive: ScreenThresholds = { maxHitsA: 3, maxHitsB: 9, maxUnionA: 41, maxUnionB: 139 };

function jsonl(...rows: readonly unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

describe("screenCandidates", () => {
  it("한 줄은 문구가 여러 번 걸려도 한 번만 세고, 묶음 파일이 달라지면 따로 센다", () => {
    const result = screenCandidates(
      "critical\t위험\n",
      [jsonl({ text: "위험 위험" }), jsonl({ text: "위험" })],
      jsonl({ text: "위험", label: "normal" }),
      "normal",
      permissive,
    );
    expect(result.report.candidates).toEqual([
      expect.objectContaining({ input_line: 1, hits_a: 2, hits_b: 1, stage1_kept: true, duplicate_of: null }),
    ]);
  });

  it("예외 단어 안에만 있는 일치는 세지 않는다", () => {
    const result = screenCandidates(
      "critical\t시발\n",
      [jsonl({ text: "시발점" }), jsonl({ text: "시발" })],
      jsonl({ text: "시발점", label: "normal" }),
      "normal",
      permissive,
    );
    expect(result.report.candidates[0]).toMatchObject({ hits_a: 1, hits_b: 0 });
  });

  it("정규화 중복은 앞의 입력 줄을 남기고 뒤의 후보를 가리킨다", () => {
    const result = screenCandidates(
      "# 주석\ncritical\t위 험\ncritical\t위험\n\n",
      [jsonl({ text: "위험" })],
      jsonl({ text: "위험", label: "normal" }),
      "normal",
      permissive,
    );
    expect(result.outputTsv).toBe("critical\t위 험\n");
    expect(result.report.candidates).toEqual([
      expect.objectContaining({ input_line: 2, stage1_kept: true, duplicate_of: null }),
      expect.objectContaining({ input_line: 3, stage1_kept: false, duplicate_of: 2 }),
    ]);
  });

  it("1단계 문턱은 A=3·B=9를 포함하고 A=4·B=10을 제외한다", () => {
    const a = jsonl(
      ...Array.from({ length: 4 }, () => ({ text: "가" })),
      ...Array.from({ length: 3 }, () => ({ text: "다" })),
    );
    const b = jsonl(
      ...Array.from({ length: 9 }, () => ({ text: "나", label: "normal" })),
      ...Array.from({ length: 10 }, () => ({ text: "라", label: "normal" })),
    );
    const result = screenCandidates(
      "critical\t가\ncritical\t나\ncritical\t다\ncritical\t라\n",
      [a],
      b,
      "normal",
      permissive,
    );
    expect(result.report.candidates.map((candidate) => candidate.stage1_kept)).toEqual([false, true, true, false]);
    expect(result.report.candidates.map((candidate) => [candidate.hits_a, candidate.hits_b])).toEqual([[4, 0], [0, 9], [3, 0], [0, 10]]);
  });

  it("출력 TSV 해시는 원본 UTF-8 바이트와 정규화·중복 제거·정렬 형식을 각각 반영한다", () => {
    const result = screenCandidates("critical\t나\ncritical\t 가\ncritical\t가\n", [], "", "normal", permissive);
    const canonical = "critical\t가\ncritical\t나\n";
    expect(result.outputTsv).toBe("critical\t나\ncritical\t 가\n");
    expect(result.report.output_tsv_sha256).toBe(createHash("sha256").update(Buffer.from(result.outputTsv, "utf8")).digest("hex"));
    expect(result.report.output_tsv_canonical_sha256).toBe(createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex"));
    expect(result.outputTsv.endsWith("\n")).toBe(true);
    expect(canonical.endsWith("\n")).toBe(true);
  });

  it("출력 TSV를 평가 도구가 읽은 정규형 해시는 보고서의 정규형 해시와 같다", () => {
    const result = screenCandidates(
      "critical\t  ＡＢＣ  \ncritical\tabc\ncritical\t 가 나 \ncritical\t가나\ncritical\tＺＥＴＡ\n",
      [],
      "",
      "normal",
      permissive,
    );
    const parsed = parseRulePatterns(result.outputTsv);

    expect(createHash("sha256").update(parsed.canonical).digest("hex")).toBe(result.report.output_tsv_canonical_sha256);
  });

  it.each([
    ["critical\t비공개후보\t추가필드", "탭", "비공개후보"],
    [`critical\t${"비".repeat(51)}`, "50자", "비비비"],
  ])("잘못된 후보 줄은 줄 번호와 수정 방향만 알리고 원문은 숨긴다: %s", (candidate, guidance, forbidden) => {
    let thrown: unknown;
    try {
      screenCandidates(`# 설명\n${candidate}\n`, [], "", "normal", permissive);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ScreenRulesArgumentError);
    expect((thrown as Error).message).toContain("2번째 후보 줄");
    expect((thrown as Error).message).toContain(guidance);
    expect((thrown as Error).message).not.toContain(forbidden);
  });

  it("2단계는 합집합 감소량, 전체 적중 수, 정규화 사전순 동률 순서로 제거한다", () => {
    const input = "critical\t가\ncritical\t나\ncritical\t다\n";
    const a = jsonl({ text: "가 나" }, { text: "가 다" });
    const result = screenCandidates(input, [a], "", "normal", { ...permissive, maxUnionA: 1 });
    expect(result.outputTsv).toBe("critical\t다\n");
    expect(result.report.candidates).toEqual([
      expect.objectContaining({ input_line: 1, stage2_removed_order: 1 }),
      expect.objectContaining({ input_line: 2, stage2_removed_order: 2 }),
      expect.objectContaining({ input_line: 3, stage2_removed_order: null }),
    ]);
  });

  it("2단계는 총 적중 수보다 현재 합집합에서 줄어드는 줄 수를 우선한다", () => {
    const a = jsonl(
      { text: "가" }, { text: "가" },
      { text: "나 다" }, { text: "나 다" }, { text: "나 다" },
    );
    const result = screenCandidates(
      "critical\t가\ncritical\t나\ncritical\t다\n",
      [a],
      "",
      "normal",
      { ...permissive, maxUnionA: 3 },
    );
    expect(result.report.candidates).toEqual([
      expect.objectContaining({ input_line: 1, hits_a: 2, stage2_removed_order: 1 }),
      expect.objectContaining({ input_line: 2, hits_a: 3, stage2_removed_order: null }),
      expect.objectContaining({ input_line: 3, hits_a: 3, stage2_removed_order: null }),
    ]);
    expect(result.outputTsv).toBe("critical\t나\ncritical\t다\n");
  });

  it("B 묶음은 지정 라벨만 세고, 라벨이 없거나 문자열이 아니면 오류다", () => {
    const result = screenCandidates(
      "critical\t가\n",
      [],
      jsonl({ text: "가", label: "other" }, { text: "가", label: "normal" }),
      "normal",
      permissive,
    );
    expect(result.report.corpus_b.line_count).toBe(1);
    expect(() => screenCandidates("critical\t가\n", [], jsonl({ text: "가" }), "normal", permissive)).toThrow(ScreenRulesArgumentError);
    expect(() => screenCandidates("critical\t가\n", [], jsonl({ text: "가", label: 1 }), "normal", permissive)).toThrow(ScreenRulesArgumentError);
  });

  it("JSON 보고서에는 후보 문구나 입력 문장이 들어가지 않는다", () => {
    const result = screenCandidates(
      "critical\t비밀문구\n",
      [jsonl({ text: "원문비밀" })],
      jsonl({ text: "원문비밀", label: "normal" }),
      "normal",
      permissive,
    );
    const report = JSON.stringify(result.report);
    expect(report).not.toContain("비밀문구");
    expect(report).not.toContain("원문비밀");
  });

  it("CLI는 반복 corpus-a 파일과 기본 문턱으로 파일 해시·출력·건수 요약을 만든다", () => {
    const directory = mkdtempSync(join(tmpdir(), "zzirit-screen-rules-"));
    const candidatesPath = join(directory, "candidates.tsv");
    const corpusA1Path = join(directory, "corpus-a-1.jsonl");
    const corpusA2Path = join(directory, "corpus-a-2.jsonl");
    const corpusBPath = join(directory, "corpus-b.jsonl");
    const outputTsvPath = join(directory, "remaining.tsv");
    const outputJsonPath = join(directory, "report.json");
    const candidates = "critical\t비밀후보\ncritical\t다른후보\n";
    const corpusA1 = jsonl({ text: "비밀원문" });
    const corpusA2 = jsonl({ text: "다른원문" });
    const corpusB = jsonl({ text: "비밀원문", label: "normal" }, { text: "제외원문", label: "other" });
    writeFileSync(candidatesPath, candidates, "utf8");
    writeFileSync(corpusA1Path, corpusA1, "utf8");
    writeFileSync(corpusA2Path, corpusA2, "utf8");
    writeFileSync(corpusBPath, corpusB, "utf8");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      runScreenRulesCli([
        "--candidates", candidatesPath,
        "--corpus-a", corpusA1Path,
        "--corpus-a", corpusA2Path,
        "--corpus-b", corpusBPath,
        "--corpus-b-label", "normal",
        "--output-tsv", outputTsvPath,
        "--output-json", outputJsonPath,
      ]);
      const outputTsv = readFileSync(outputTsvPath, "utf8");
      const reportJson = readFileSync(outputJsonPath, "utf8");
      const report = JSON.parse(reportJson) as { corpus_a: { files: Array<{ sha256: string }> }; corpus_b: { line_count: number }; thresholds: ScreenThresholds };
      const summary = String(stdout.mock.calls[0]?.[0]);
      expect(outputTsv).toBe(candidates);
      expect(report.corpus_a.files.map((file) => file.sha256)).toEqual([
        createHash("sha256").update(Buffer.from(corpusA1, "utf8")).digest("hex"),
        createHash("sha256").update(Buffer.from(corpusA2, "utf8")).digest("hex"),
      ]);
      expect(report.corpus_b.line_count).toBe(1);
      expect(report.thresholds).toEqual(permissive);
      expect(stdout.mock.calls).toHaveLength(1);
      expect(summary).toContain('"candidates":2');
      expect(summary).not.toContain("비밀후보");
      expect(summary).not.toContain("비밀원문");
    } finally {
      stdout.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
