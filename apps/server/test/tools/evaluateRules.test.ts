import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EvaluateRulesArgumentError, ensureHoldoutUsesDefaults, ensureRulesDoNotDuplicateKeywords, evaluateRuleRoutes, parseEvaluationItems, parseKeywordPatterns,
  parseRulePatterns, runEvaluateRulesCommand,
  type EvaluationItem,
} from "../../src/tools/evaluateRules.js";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_RULES } from "../../src/detection/defaultRules.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function temporaryFile(name: string, content: string | Buffer): string {
  const directory = mkdtempSync(join(tmpdir(), "zzirit-evaluate-rules-"));
  temporaryDirectories.push(directory);
  const file = join(directory, name);
  writeFileSync(file, content);
  return file;
}

/** 개발셋 문장 하나. */
function devItem(id: string, text: string): EvaluationItem {
  return { id, text, split: "dev" };
}

describe("evaluateRuleRoutes", () => {
  it("기본 규칙으로 전화번호는 자동 숨김, 협박은 후보, 일반 문장은 통과로 판정한다", () => {
    const routes = evaluateRuleRoutes([devItem("phone", "연락 주세요 010-1234-5678"), devItem("threat", "너 집 앞으로 찾아간다"), devItem("normal", "오늘 방송 몇 시까지 해요")]);
    expect(routes.map((route) => [route.id, route.decision])).toEqual([["phone", "auto_hide"], ["threat", "candidate"], ["normal", "pass"]]);
    expect(routes[0]?.reason).toBe("rule:phone");
  });

  it("같은 문장이 반복돼도 서로 다른 사람·시각(중복 보관 시간보다 멀리)이라 도배·중복 규칙이 걸리지 않는다", () => {
    const routes = evaluateRuleRoutes(Array.from({ length: 8 }, (_, index) => devItem(`same-${index}`, "오늘 방송 진짜 재밌어요 다들 화이팅")));
    expect(new Set(routes.map((route) => route.reason))).toEqual(new Set(["none"]));
  });

  it("키워드 경로 패턴은 규칙 판정과 따로 일치 여부를 알려 준다", () => {
    const routes = evaluateRuleRoutes([devItem("hit", "요즘 너무 우울 해서"), devItem("miss", "날씨 좋네요")], ["우울"]);
    expect(routes[0]?.keyword).not.toBeNull();
    expect(routes[0]?.decision).toBe("pass");
    expect(routes[1]?.keyword).toBeNull();
  });

  it("가벼운 반응(ㅋㅋ 등)은 AI 단계를 건너뛴다고 표시한다", () => {
    const routes = evaluateRuleRoutes([devItem("laugh", "ㅋㅋㅋㅋㅋ"), devItem("text", "ㅋㅋ 웃기다")]);
    expect(routes.map((route) => route.skipAi)).toEqual([true, false]);
  });

  it("평가셋 해시를 그대로 적고, 규칙 목록 지문은 목록이 같으면 같고 다르면 다르다", () => {
    const base = evaluateRuleRoutes([devItem("a", "가")], [], "abc");
    const same = evaluateRuleRoutes([devItem("b", "나")], [], "def");
    const extra = evaluateRuleRoutes([devItem("a", "가")], ["우울"], "abc");
    const criticalExtra = evaluateRuleRoutes([devItem("a", "가")], [], "abc", [{ kind: "critical", pattern: "핵심" }]);
    expect(base[0]?.evalSha256).toBe("abc");
    expect(base[0]?.policySha256).toBe(same[0]?.policySha256);
    expect(extra[0]?.policySha256).not.toBe(base[0]?.policySha256);
    expect(criticalExtra[0]?.policySha256).not.toBe(base[0]?.policySha256);
    expect(base[0]?.rulesFileSha256).toBeNull();
    expect(base[0]?.rulesCanonicalSha256).toBeNull();
  });

  it("critical 판정 단계를 포함한 evaluate-rules@2로 정책 지문을 만든다", () => {
    const [route] = evaluateRuleRoutes([devItem("a", "일반")]);
    const expected = createHash("sha256")
      .update(["evaluate-rules@2", ...DEFAULT_RULES.map((rule) => `${rule.kind}\t${rule.pattern}`).sort()].join("\n"))
      .digest("hex");

    expect(route?.policySha256).toBe(expected);
  });

  it("추가 critical 규칙은 후보와 critical 이유로 평가되고 AI 대상으로 보내지지 않는다", () => {
    const routes = evaluateRuleRoutes([devItem("critical", "자살 관련")], [], "", [{ kind: "critical", pattern: "자 살" }]);
    expect(routes[0]).toMatchObject({ decision: "candidate" });
    expect(routes[0]?.reason).toMatch(/^rule:critical:\d+$/);
  });

  it("규칙 파일의 원본·정규형 해시를 결과 줄마다 기록한다", () => {
    const content = "keyword_route\t우 울\ncritical\t핵심\n";
    const parsed = parseRulePatterns(content);
    const expectedCanonical = "critical\t핵심\nkeyword_route\t우울\n";
    const routes = evaluateRuleRoutes(
      [devItem("a", "일반")], [], "", parsed.rules,
      createHash("sha256").update(content).digest("hex"),
      createHash("sha256").update(expectedCanonical).digest("hex"),
    );
    expect(routes[0]?.rulesFileSha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(routes[0]?.rulesCanonicalSha256).toBe(createHash("sha256").update(expectedCanonical).digest("hex"));
  });

  it("규칙 파일이 없으면 두 규칙 해시는 null이다", () => {
    const [route] = evaluateRuleRoutes([devItem("a", "일반")]);
    expect(route?.rulesFileSha256).toBeNull();
    expect(route?.rulesCanonicalSha256).toBeNull();
  });
});

describe("기본 목록이 흔한 방송 채팅을 건드리지 않는다", () => {
  it.each([
    "방송 잘 보고 있다", "특정 캐릭터만 가능?", "이 게임 다 끝낼 수 있나", "오늘 이거 끝내려고 함", "버프 없어지면 바로 빼",
    "집 앞 편의점 다녀옴", "동선 좋네", "옥상 파밍 가자", "볼륨 늘려드릴까요?", "본인 인증이 왜 안 돼?", "카지노 하이스트 하자",
    "홀덤 방송 언제 해요", "후원 먹튀 ㅋㅋ", "가슴이 웅장해진다", "여기서 벗어나야 해", "샤워하고 올게요", "오픈채팅방 있어요?",
    "부업으로 유튜브 하세요?", "몇 학년이에요?", "호텔 뷔페 맛있음",
  ])("%s", (text) => {
    const [route] = evaluateRuleRoutes([devItem("normal", text)]);
    expect(route?.keyword).toBeNull();
    expect(route?.reason).not.toMatch(/^rule:spam/);
  });

  it.each(["너네 집 앞에 찾아가서 기다릴게", "집 앞까지 따라갈거임", "퇴근길 따라간다 조심해"])("집 앞·따라가기 협박은 키워드 경로로 간다: %s", (text) => {
    const [route] = evaluateRuleRoutes([devItem("threat", text)]);
    expect(route?.keyword).not.toBeNull();
  });

  it("벗어나 예외가 옷 벗어 요구를 가리지 않는다", () => {
    const [route] = evaluateRuleRoutes([devItem("sexual", "옷 벗어봐 나한테 보여줘")]);
    expect(route?.keyword).not.toBeNull();
  });
});

describe("입력 읽기와 보류셋 보호", () => {
  it("평가셋 JSONL에서 id·text·split을 읽고, 빠지면 줄 번호로 알려 준다", () => {
    expect(parseEvaluationItems('{"id":"a","text":"가","split":"dev"}\n\n{"id":"b","text":"나"}\n')).toEqual([
      { id: "a", text: "가", split: "dev" }, { id: "b", text: "나", split: null },
    ]);
    expect(() => parseEvaluationItems('{"id":"a"}\n')).toThrow(EvaluateRulesArgumentError);
    expect(() => parseEvaluationItems('{"id":"a"}\n')).toThrow("1번째 줄");
  });

  it("키워드 목록은 빈 줄과 # 주석을 건너뛴다", () => {
    expect(parseKeywordPatterns("# 자해\n우울\n\n  죽고싶  \n")).toEqual(["우울", "죽고싶"]);
  });

  it("규칙 TSV는 빈 줄·주석을 건너뛰고 허용된 종류를 읽는다", () => {
    expect(parseRulePatterns("# 설명\n\ncritical\t  핵심  \nkeyword_route\t우울\n").rules).toEqual([
      { kind: "critical", pattern: "핵심", normalizedPattern: "핵심", inputLine: 3 },
      { kind: "keyword_route", pattern: "우울", normalizedPattern: "우울", inputLine: 4 },
    ]);
  });

  it.each([
    ["critical\t두\t탭", "탭은 종류와 패턴"],
    ["unknown\t비밀문구", "종류는 critical 또는 keyword_route", "비밀문구"],
    ["critical\t   ", "빈 패턴", "   "],
    [`critical\t${"가".repeat(51)}`, "패턴은 50자 이하", "가가가"],
  ])("규칙 TSV 오류는 입력 줄과 해결 방향을 보여 주고 문구 원문은 숨긴다: %s", (line, guidance, forbidden = "") => {
    expect(() => parseRulePatterns(`${line}\n`)).toThrow(/1번째 줄/);
    expect(() => parseRulePatterns(`${line}\n`)).toThrow(guidance);
    if (forbidden !== "") expect(() => parseRulePatterns(`${line}\n`)).not.toThrow(forbidden);
  });

  it("규칙 파일 안에서는 같은 종류의 정규화 중복을 거부하고, 종류가 다르면 허용한다", () => {
    expect(() => parseRulePatterns("critical\t핵 심\ncritical\t핵심\n")).toThrow(/중복/);
    expect(() => parseRulePatterns("critical\t승격\nkeyword_route\t승 격\n")).not.toThrow();
  });

  it("--keywords와 같은 keyword_route는 rules 입력 줄을 기준으로 원문 없이 거부하고 critical 승격은 허용한다", () => {
    expect(() => ensureRulesDoNotDuplicateKeywords([{ kind: "keyword_route", pattern: "비밀", inputLine: 7 }], [" 비 밀 "])).toThrow(/7번째 줄/);
    expect(() => ensureRulesDoNotDuplicateKeywords([{ kind: "keyword_route", pattern: "비밀", inputLine: 7 }], [" 비 밀 "])).toThrow(/중복|겹치는/);
    try {
      ensureRulesDoNotDuplicateKeywords([{ kind: "keyword_route", pattern: "비밀", inputLine: 7 }], [" 비 밀 "]);
    } catch (error) {
      expect((error as Error).message).not.toContain("비밀");
    }
    expect(() => ensureRulesDoNotDuplicateKeywords([{ kind: "critical", pattern: "비밀", inputLine: 7 }], [" 비 밀 "])).not.toThrow();
  });

  it("기본 규칙과 같은 종류의 정규화 중복을 거부한다", () => {
    expect(() => parseRulePatterns("keyword_route\t자 살\n")).toThrow(/기본 규칙/);
    expect(() => parseRulePatterns("critical\t자 살\n")).not.toThrow();
  });

  it("보류셋에는 추가 키워드·규칙을 쓸 수 없고, 개발셋에는 쓸 수 있다", () => {
    expect(() => ensureHoldoutUsesDefaults([{ id: "h", text: "가", split: "holdout" }], ["우울"])).toThrow(EvaluateRulesArgumentError);
    expect(() => ensureHoldoutUsesDefaults([{ id: "h", text: "가", split: "holdout" }], [])).not.toThrow();
    expect(() => ensureHoldoutUsesDefaults([devItem("d", "가")], ["우울"])).not.toThrow();
    expect(() => ensureHoldoutUsesDefaults([{ id: "h", text: "가", split: "holdout" }], [], [{ kind: "critical", pattern: "핵심" }])).toThrow(EvaluateRulesArgumentError);
    expect(() => ensureHoldoutUsesDefaults([{ id: "h", text: "가", split: "holdout" }], [], [], true)).toThrow(EvaluateRulesArgumentError);
    expect(() => ensureHoldoutUsesDefaults([devItem("d", "가")], [], [{ kind: "critical", pattern: "핵심" }])).not.toThrow();
  });

  it("실제 명령 경로는 rules 파일의 raw/canonical 해시와 출력 파일을 기록한다", () => {
    const evalFile = temporaryFile("eval.jsonl", '{"id":"a","text":"고유평가원문","split":"dev"}\n');
    const rulesContent = Buffer.from("keyword_route\t  사용자규칙  \r\n", "utf8");
    const rulesFile = temporaryFile("rules.tsv", rulesContent);
    const outputDirectory = mkdtempSync(join(tmpdir(), "zzirit-evaluate-rules-output-"));
    temporaryDirectories.push(outputDirectory);
    const outputFile = join(outputDirectory, "routes.jsonl");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    runEvaluateRulesCommand(["--eval-file", evalFile, "--output", outputFile, "--rules", rulesFile]);

    const [route] = readFileSync(outputFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(route?.rulesFileSha256).toBe(createHash("sha256").update(rulesContent).digest("hex"));
    expect(route?.rulesCanonicalSha256).toBe(createHash("sha256").update("keyword_route\t사용자규칙\n").digest("hex"));
    expect(log).toHaveBeenCalledWith(JSON.stringify({ items: 1, keywordPatterns: 0, keywordMatches: 0, decisions: { pass: 1 } }));
    expect(log.mock.calls.flat().join(" ")).not.toContain("사용자규칙");
    expect(log.mock.calls.flat().join(" ")).not.toContain("고유평가원문");
  });

  it.each([
    ["critical\t비공개규칙\t추가필드", "탭", "비공개규칙"],
    [`critical\t${"비".repeat(51)}`, "50자", "비비비"],
  ])("실제 --rules 오류는 줄 번호와 수정 방향만 알리고 원문은 숨긴다: %s", (rulesContent, guidance, forbidden) => {
    const evalFile = temporaryFile("eval.jsonl", '{"id":"a","text":"일반","split":"dev"}\n');
    const rulesFile = temporaryFile("rules.tsv", `${rulesContent}\n`);
    const outputDirectory = mkdtempSync(join(tmpdir(), "zzirit-evaluate-rules-output-"));
    temporaryDirectories.push(outputDirectory);
    const outputFile = join(outputDirectory, "routes.jsonl");
    let thrown: unknown;

    try {
      runEvaluateRulesCommand(["--eval-file", evalFile, "--output", outputFile, "--rules", rulesFile]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EvaluateRulesArgumentError);
    expect((thrown as Error).message).toContain("1번째 줄");
    expect((thrown as Error).message).toContain(guidance);
    expect((thrown as Error).message).not.toContain(forbidden);
    expect(existsSync(outputFile)).toBe(false);
  });

  it("실제 명령 경로에서 rules가 없으면 해시는 null이고 요약 형식은 기존과 같다", () => {
    const evalFile = temporaryFile("eval.jsonl", '{"id":"a","text":"일반","split":"dev"}\n');
    const outputDirectory = mkdtempSync(join(tmpdir(), "zzirit-evaluate-rules-output-"));
    temporaryDirectories.push(outputDirectory);
    const outputFile = join(outputDirectory, "routes.jsonl");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    runEvaluateRulesCommand(["--eval-file", evalFile, "--output", outputFile]);

    const [route] = readFileSync(outputFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(route?.rulesFileSha256).toBeNull();
    expect(route?.rulesCanonicalSha256).toBeNull();
    expect(log).toHaveBeenCalledWith(JSON.stringify({ items: 1, keywordPatterns: 0, keywordMatches: 0, decisions: { pass: 1 } }));
  });

  it("실제 명령 경로에서 --keywords와 --rules 충돌은 원문 없이 rules 줄에서 거부한다", () => {
    const evalFile = temporaryFile("eval.jsonl", '{"id":"a","text":"일반","split":"dev"}\n');
    const keywordsFile = temporaryFile("keywords.txt", "비 밀\n");
    const rulesFile = temporaryFile("rules.tsv", "keyword_route\t비밀\n");
    const outputDirectory = mkdtempSync(join(tmpdir(), "zzirit-evaluate-rules-output-"));
    temporaryDirectories.push(outputDirectory);
    const outputFile = join(outputDirectory, "routes.jsonl");

    let thrown: unknown;
    try {
      runEvaluateRulesCommand(["--eval-file", evalFile, "--output", outputFile, "--keywords", keywordsFile, "--rules", rulesFile]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EvaluateRulesArgumentError);
    expect((thrown as Error).message).toContain("1번째 줄");
    expect((thrown as Error).message).not.toContain("비밀");
    expect(existsSync(outputFile)).toBe(false);
  });

  it("빈 --rules도 보류셋에서 금지한다", () => {
    const evalFile = temporaryFile("holdout.jsonl", '{"id":"h","text":"일반","split":"holdout"}\n');
    const rulesFile = temporaryFile("empty-rules.tsv", "\n# only comment\n");
    const outputDirectory = mkdtempSync(join(tmpdir(), "zzirit-evaluate-rules-output-"));
    temporaryDirectories.push(outputDirectory);
    const outputFile = join(outputDirectory, "routes.jsonl");

    expect(() => runEvaluateRulesCommand(["--eval-file", evalFile, "--output", outputFile, "--rules", rulesFile])).toThrow(/보류셋/);
    expect(existsSync(outputFile)).toBe(false);
  });
});
