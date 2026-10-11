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
