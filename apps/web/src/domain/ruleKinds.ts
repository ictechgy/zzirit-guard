import type { RuleKind } from "@zzirit-guard/shared";

/** 규칙 종류 이름. 규칙 목록·감사 기록(rule_add:<종류>)에서 함께 쓴다. */
export const KIND_LABELS: Readonly<Record<RuleKind, string>> = {
  strong: "금칙어 강(자동 숨김)", weak: "금칙어 약(후보)", exception: "예외 단어", allow: "허용어(메시지 전체 일치)",
  allow_domain: "허용 도메인", threat: "협박 표현(후보)", keyword_route: "AI 키워드 경로",
};

/** 1단계에서 화면으로 추가할 수 있는 종류(AI 키워드 경로는 2단계). */
export const EDITABLE_KINDS: readonly RuleKind[] = ["strong", "weak", "exception", "allow", "allow_domain", "threat"];

/** 서버가 보낸 종류 문자열을 이름으로 바꾼다. 모르는 값이면 그대로 둔다(Object.hasOwn: 프로토타입 키를 이름으로 꺼내지 않게). */
export function describeRuleKind(kind: string): string {
  return Object.hasOwn(KIND_LABELS, kind) ? KIND_LABELS[kind as RuleKind] : kind;
}
