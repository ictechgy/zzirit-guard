import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "../../src/detection/defaultRules.js";
import { normalizeForMatching } from "../../src/detection/normalize.js";

/** 공개 판정 파일은 제품 기본값과 따로 바뀌면 안 되므로 테스트가 원본 TSV를 직접 읽는다. */
function publicCriticalPatterns(): string[] {
  const path = fileURLToPath(new URL("../../../../docs/ml/m2-round4-decisions/r1-public.tsv", import.meta.url));
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [kind, pattern] = line.split("\t");
      expect(kind).toBe("critical");
      expect(pattern).toBeTruthy();
      return normalizeForMatching(pattern as string);
    });
}

describe("M2 4차 공개 바로 후보 기본 규칙", () => {
  it("critical 목록이 채택된 공개 TSV와 정확히 같고 키워드 경로와 겹치지 않는다", () => {
    const expected = publicCriticalPatterns().sort();
    const actual = DEFAULT_RULES.filter(({ kind }) => kind === "critical").map(({ pattern }) => normalizeForMatching(pattern)).sort();
    const keywordRoutes = new Set(DEFAULT_RULES.filter(({ kind }) => kind === "keyword_route").map(({ pattern }) => normalizeForMatching(pattern)));

    expect(actual).toEqual(expected);
    expect(actual.filter((pattern) => keywordRoutes.has(pattern))).toEqual([]);
  });

  it("허용 묶음 오후보로 승격에서 빠진 12개는 키워드 경로에 남는다", () => {
    const keywordRoutes = new Set(DEFAULT_RULES.filter(({ kind }) => kind === "keyword_route").map(({ pattern }) => normalizeForMatching(pattern)));
    const excluded = ["기다려라", "테러", "폭파", "실명", "본명", "집주소", "사는곳", "다니는학교", "학교어디", "전화번호", "신상공개", "얼굴공개"];
    expect(excluded.filter((pattern) => !keywordRoutes.has(normalizeForMatching(pattern)))).toEqual([]);
  });
});
