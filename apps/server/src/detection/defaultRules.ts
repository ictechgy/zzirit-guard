import type { RuleKind } from "@zzirit-guard/shared";

/**
 * 저장소에 두는 최소 기본 규칙. 공개 저장소라 목록이 길면 우회 연구에 쓰이므로 최소한만 둔다.
 * 실제 운영 목록은 채널 DB에서 매니저가 늘리고 줄인다(스펙 17장).
 * - strong: 정상 대화에서 거의 쓰지 않는 혐오 표현·패드립 → 스위치가 켜져 있으면 자동 숨김
 * - weak: 감탄사로도 쓰이는 일반 욕설 → 사람이 판단하는 후보
 * - exception: 금칙어를 포함하지만 정상인 단어
 * - threat: 협박 표현 → 후보
 */
export const DEFAULT_RULES: ReadonlyArray<{ kind: RuleKind; pattern: string }> = [
  { kind: "strong", pattern: "니애미" },
  { kind: "strong", pattern: "느금마" },
  { kind: "strong", pattern: "한남충" },
  { kind: "strong", pattern: "김치녀" },
  { kind: "strong", pattern: "틀딱" },
  { kind: "strong", pattern: "짱깨" },
  { kind: "weak", pattern: "씨발" },
  { kind: "weak", pattern: "시발" },
  { kind: "weak", pattern: "ㅅㅂ" },
  { kind: "weak", pattern: "병신" },
  { kind: "weak", pattern: "ㅂㅅ" },
  { kind: "weak", pattern: "개새끼" },
  // 홍어는 음식 이름(홍어삼합)으로도 흔히 써서, 되돌릴 수 없는 자동 숨김 대신 사람이 판단하는 후보로 둔다(F4).
  { kind: "weak", pattern: "홍어" },
  { kind: "exception", pattern: "시발점" },
  { kind: "exception", pattern: "시발택시" },
  { kind: "threat", pattern: "찾아간다" },
  { kind: "threat", pattern: "찾아갈게" },
  { kind: "threat", pattern: "칼들고" },
  { kind: "threat", pattern: "집주소" },
  { kind: "threat", pattern: "신상털" },
];
