import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AiCategory, Stage2Policy } from "@zzirit-guard/shared";
import { describe, expect, it } from "vitest";
import { stage2EndpointDecision } from "../../src/actions/stage2Policy.js";

interface PolicyVector {
  name: string;
  rule_decision: "candidate" | null;
  policy: Stage2Policy;
  base_threshold: number;
  relaxed_threshold: number;
  relaxed_categories: string[];
  keyword_route: boolean;
  probability: number;
  category: AiCategory;
  expected: "pass" | "candidate" | "needs_care";
}

/** 평가 코드와 서버가 같은 계약을 보도록 저장소의 벡터 파일을 직접 읽는다. */
function policyVectors(): PolicyVector[] {
  const path = fileURLToPath(new URL("../../../../workers/contract/stage2-policy-vectors.json", import.meta.url));
  return (JSON.parse(readFileSync(path, "utf8")) as { vectors: PolicyVector[] }).vectors;
}

describe("2차 후보 정책 계약", () => {
  it.each(policyVectors().filter(({ rule_decision }) => rule_decision === null))("$name", (vector) => {
    expect(stage2EndpointDecision({
      policy: vector.policy,
      candidateThreshold: vector.base_threshold,
      relaxedCandidateThreshold: vector.relaxed_threshold,
      keywordRoute: vector.keyword_route,
      unsafeProbability: vector.probability,
      category: vector.category,
    })).toBe(vector.expected);
  });
});
