import type { AiCategory, Stage2Policy } from "@zzirit-guard/shared";

/** M2 4차 T2에서 채택한 완화 범주. 운영 설정으로 넓히면 검증 없이 오후보 범위가 바뀌므로 코드에 고정한다. */
export const RELAXED_STAGE2_CATEGORIES: ReadonlySet<AiCategory> = new Set(["S3", "S4", "S5"]);

/**
 * 2차 정책 판정에 필요한 값. 채널 설정(정책·기준), 제출의 키워드 경로 여부, 2차 결과(확률·가장 높은 범주)를 함께 받는다.
 * 평가 코드(workers/stage1 evaluate_chat)와 같은 입력이어야 계약 벡터로 두 구현을 함께 검사할 수 있다.
 */
export interface Stage2DecisionInput {
  policy: Stage2Policy;
  candidateThreshold: number;
  relaxedCandidateThreshold: number;
  keywordRoute: boolean;
  unsafeProbability: number;
  category: AiCategory;
}

/** 2차 결과의 경로 끝 판정: 기록하지 않음(pass), 후보, 도움 필요(S6). */
export type Stage2EndpointDecision = "pass" | "candidate" | "needs_care";

/**
 * 2차 결과를 경로 끝 판정으로 바꾸는 순수 정책.
 * S6은 도움 필요 신호의 신뢰를 지키려고 언제나 기본 기준을 쓰고, 완화값은 기본 기준보다 문턱을 올리지 않는다.
 */
export function stage2EndpointDecision(input: Stage2DecisionInput): Stage2EndpointDecision {
  const categoryRelaxed = input.policy === "category" && RELAXED_STAGE2_CATEGORIES.has(input.category);
  const keywordRelaxed = input.policy === "keyword_route" && input.keywordRoute;
  const canRelax = input.category !== "S6" && (categoryRelaxed || keywordRelaxed);
  const threshold = canRelax ? Math.min(input.candidateThreshold, input.relaxedCandidateThreshold) : input.candidateThreshold;
  if (input.unsafeProbability < threshold) return "pass";
  return input.category === "S6" ? "needs_care" : "candidate";
}
