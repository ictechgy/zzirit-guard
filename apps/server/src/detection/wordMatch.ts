import type { RuleEntry } from "./ruleRepository.js";

/**
 * 예외 단어를 지운다. "시발점"처럼 금칙어를 품은 정상 단어가 걸리지 않게 하려는 것이다.
 * @param normalizedText normalizeForMatching을 거친 문장
 */
export function stripExceptions(normalizedText: string, exceptions: readonly RuleEntry[]): string {
  return exceptions.reduce((text, exception) => text.split(exception.normalizedPattern).join(""), normalizedText);
}

/** 정규화한 문장에 포함된 첫 번째 규칙(목록 순서)을 찾는다. */
export function findFirstMatch(normalizedText: string, entries: readonly RuleEntry[]): RuleEntry | null {
  return entries.find((entry) => normalizedText.includes(entry.normalizedPattern)) ?? null;
}

/**
 * 공백을 남긴 문장에서 단어 경계를 넘지 않고 그대로 들어 있는 첫 번째 규칙(목록 순서)을 찾는다.
 * 규칙에 공백이 없으면 normalizedPattern으로 보고, 매니저가 공백을 넣어 만든 규칙("나쁜 놈")은 그 공백까지 맞는 spacedPattern으로도 본다.
 * 왜 둘 다 보나: 공백 든 규칙을 공백 없는 형태로만 비교하면 규칙대로 쓴 문장이 영영 자동 숨김이 되지 않고, 공백 형태로만 비교하면 붙여 쓴 것을 놓친다.
 * @param spacedText normalizeKeepingWhitespace를 거친(예외 단어를 지운) 문장
 * @param entries 비교할 규칙 목록
 * @returns 처음 일치한 규칙, 없으면 null
 */
export function findFirstIntactMatch(spacedText: string, entries: readonly RuleEntry[]): RuleEntry | null {
  return entries.find((entry) => spacedText.includes(entry.normalizedPattern) || spacedText.includes(entry.spacedPattern)) ?? null;
}
