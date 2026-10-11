import type { RuleEntry } from "./ruleRepository.js";

/** 문장 안의 구간. start는 포함하고 end는 포함하지 않는다(UTF-16 위치, String.prototype.indexOf와 같은 기준). */
export interface TextSpan {
  /** 구간이 시작하는 위치. */
  start: number;
  /** 구간이 끝난 바로 다음 위치. */
  end: number;
}

/**
 * 비교할 문장과, 그 안에서 예외 단어가 차지한 구간들.
 * 왜 예외 단어를 지우지 않고 위치만 기억하나: 지우면 두 가지가 틀어진다.
 * ① 지운 자리의 앞뒤가 이어져 원문에 없던 금칙어가 생긴다("출시시발점발표"에서 "시발점"을 지우면 "출시발표", F7).
 * ② 금칙어가 예외 단어와 일부만 겹쳐도 함께 지워져 놓친다("개새끼손가락"에서 "새끼손가락"을 지우면 "개새끼"가 사라진다, S4).
 * 그래서 금칙어는 예외를 지우지 않은 문장에서 찾고, 그 일치가 예외 단어 한 곳 안에 완전히 들어 있을 때만 버린다.
 */
export interface ExceptionAwareText {
  /** 정규화한 비교용 문장(예외 단어를 지우지 않은 그대로). */
  text: string;
  /** text 안에서 예외 단어가 나온 모든 구간. 겹쳐 나온 것도 모두 담는다. */
  exceptionSpans: readonly TextSpan[];
}

/**
 * 공백까지 지운 문장에서 예외 단어 위치를 찾는다. "시발점"처럼 금칙어를 품은 정상 단어가 걸리지 않게 하려는 것이다.
 * @param normalizedText normalizeForMatching을 거친 문장
 * @param exceptions 예외 단어 규칙 목록
 * @returns 문장과 예외 단어 구간
 */
export function locateExceptions(normalizedText: string, exceptions: readonly RuleEntry[]): ExceptionAwareText {
  return { text: normalizedText, exceptionSpans: exceptions.flatMap((exception) => findSpans(normalizedText, exception.normalizedPattern)) };
}

/**
 * 공백을 남긴 문장에서 예외 단어 위치를 찾는다. 공백 든 예외("짱깨 집")는 공백 형태(spacedPattern)와 붙여 쓴 형태(normalizedPattern)를 모두 찾는다.
 * 왜: 금칙어 강 쪽은 spacedPattern까지 보는데 예외 쪽이 normalizedPattern만 보면, 공백 든 예외 문장이 auto_hide가 된다(R2).
 * @param spacedText normalizeKeepingWhitespace를 거친 문장
 * @param exceptions 예외 단어 규칙 목록
 * @returns 문장과 예외 단어 구간
 */
export function locateExceptionsKeepingWhitespace(spacedText: string, exceptions: readonly RuleEntry[]): ExceptionAwareText {
  const patterns = exceptions.flatMap((exception) => [...new Set([exception.spacedPattern, exception.normalizedPattern])]);
  return { text: spacedText, exceptionSpans: patterns.flatMap((pattern) => findSpans(spacedText, pattern)) };
}

/**
 * 공백까지 지운 문장에서, 예외 단어에 가려지지 않은 일치가 있는 첫 번째 규칙(목록 순서)을 찾는다.
 * @param target locateExceptions로 만든 문장과 예외 구간
 * @param entries 비교할 규칙 목록
 * @returns 처음 일치한 규칙, 없으면 null
 */
export function findFirstMatch(target: ExceptionAwareText, entries: readonly RuleEntry[]): RuleEntry | null {
  return entries.find((entry) => hasUncoveredMatch(target, entry.normalizedPattern)) ?? null;
}

/**
 * 공백을 남긴 문장에서 단어 경계를 넘지 않고 그대로 들어 있고 예외 단어에 가려지지 않은 첫 번째 규칙(목록 순서)을 찾는다.
 * 규칙에 공백이 없으면 normalizedPattern으로 보고, 매니저가 공백을 넣어 만든 규칙("나쁜 놈")은 그 공백까지 맞는 spacedPattern으로도 본다.
 * 왜 둘 다 보나: 공백 든 규칙을 공백 없는 형태로만 비교하면 규칙대로 쓴 문장이 영영 자동 숨김이 되지 않고, 공백 형태로만 비교하면 붙여 쓴 것을 놓친다.
 * @param target locateExceptionsKeepingWhitespace로 만든 문장과 예외 구간
 * @param entries 비교할 규칙 목록
 * @returns 처음 일치한 규칙, 없으면 null
 */
export function findFirstIntactMatch(target: ExceptionAwareText, entries: readonly RuleEntry[]): RuleEntry | null {
  return entries.find((entry) => hasUncoveredMatch(target, entry.normalizedPattern) || hasUncoveredMatch(target, entry.spacedPattern)) ?? null;
}

/**
 * pattern이 나오는 자리 중 예외 단어 한 곳 안에 완전히 들지 않는 자리가 하나라도 있는지 본다.
 * 왜 "한 곳 안에 완전히"인가: 예외 단어 밖으로 한 글자라도 삐져나오면 그 정상 단어의 일부가 아니라 따로 쓴 금칙어이기 때문이다.
 */
function hasUncoveredMatch(target: ExceptionAwareText, pattern: string): boolean {
  return findSpans(target.text, pattern).some((span) => !target.exceptionSpans.some((exception) => covers(exception, span)));
}

/** outer가 inner를 완전히 품는지 본다. */
function covers(outer: TextSpan, inner: TextSpan): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * text에서 pattern이 나오는 모든 자리를 찾는다. 겹쳐 나오는 자리도 모두 센다(예: "시발시발"의 "시발"은 0과 2).
 * 빈 패턴은 아무 데도 없는 것으로 본다. 왜: 빈 문자열은 모든 위치에 일치해, 금칙어면 모든 메시지를 걸고 예외면 모든 일치를 가린다.
 * @param text 찾을 문장
 * @param pattern 찾을 문자열
 * @returns 나온 자리의 구간 목록(앞에서부터)
 */
function findSpans(text: string, pattern: string): TextSpan[] {
  const spans: TextSpan[] = [];
  if (!pattern) return spans;
  for (let start = text.indexOf(pattern); start >= 0; start = text.indexOf(pattern, start + 1)) spans.push({ start, end: start + pattern.length });
  return spans;
}
