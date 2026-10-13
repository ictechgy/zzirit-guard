import type { VerdictDto } from "@zzirit-guard/shared";
import { formatClockTime } from "./timeFormat";

/** 판정 번호 → 버튼 접근성 이름에 쓰는 메시지 설명. */
export type MessageLabels = ReadonlyMap<number, string>;

/**
 * 버튼 접근성 이름에 쓰는 메시지 설명: "닉네임의 시:분:초 메시지" 또는 "닉네임의 시:분:초 N번째 메시지".
 * @param verdict 판정
 * @param ordinal 같은 설명이 여럿일 때의 순번(없으면 붙이지 않는다)
 */
export function describeMessage(verdict: VerdictDto, ordinal?: number): string {
  const position = ordinal === undefined ? "" : `${ordinal}번째 `;
  return `${verdict.senderNickname}의 ${formatClockTime(verdict.createdAt)} ${position}메시지`;
}

/**
 * 화면에 보이는 판정들의 버튼 설명을 만든다(K22). 같은 사람이 같은 초(보이는 시각 기준)에 보낸 메시지가 여럿이면
 * 화면 순서대로 "N번째"를 붙여 서로 다르게 한다.
 * 왜: 스크린리더·음성 제어로는 이름이 같은 버튼을 가려낼 수 없어, 되돌릴 수 없는 숨기기를 엉뚱한 메시지에 할 수 있다.
 * 왜 원문 일부가 아니라 순번인가: 도배처럼 같은 글이면 원문 일부도 또 겹친다.
 * 왜 화면 전체로 세나: 같은 사람의 메시지가 후보와 숨김 대기처럼 다른 구역에 나뉘어도 숨기기 버튼 이름이 겹친다.
 * @param verdicts 화면 순서의 판정들
 */
export function buildMessageLabels(verdicts: readonly VerdictDto[]): MessageLabels {
  const totals = new Map<string, number>();
  for (const verdict of verdicts) increment(totals, describeMessage(verdict));
  const seen = new Map<string, number>();
  return new Map(verdicts.map((verdict) => [verdict.id, describeDistinctly(verdict, totals, seen)]));
}

/**
 * 판정의 버튼 설명. 설명 모음에 없으면(모음을 만든 뒤 들어온 판정) 순번 없는 설명으로 대신한다.
 * @param labels buildMessageLabels가 만든 모음
 * @param verdict 판정
 */
export function messageLabelOf(labels: MessageLabels, verdict: VerdictDto): string {
  return labels.get(verdict.id) ?? describeMessage(verdict);
}

/**
 * 같은 설명이 둘 이상이면 나온 순서대로 순번을 붙인다.
 * @param verdict 판정
 * @param totals 설명별 전체 수
 * @param seen 지금까지 나온 설명별 수(이 함수가 올린다)
 */
function describeDistinctly(verdict: VerdictDto, totals: ReadonlyMap<string, number>, seen: Map<string, number>): string {
  const base = describeMessage(verdict);
  if ((totals.get(base) ?? 0) < 2) return base;
  return describeMessage(verdict, increment(seen, base));
}

/**
 * 열쇠의 수를 1 올리고 올린 값을 돌려준다.
 * @param counts 열쇠별 수
 * @param key 올릴 열쇠
 */
function increment(counts: Map<string, number>, key: string): number {
  const next = (counts.get(key) ?? 0) + 1;
  counts.set(key, next);
  return next;
}
