import { isKnownRole, isPrivilegedRole, type ChatEvent } from "../chat/chatEvent.js";
import type { AuditLog } from "../records/auditLog.js";
import type { GroupFloodDetector, MessageRef, PersonalFloodDetector } from "./floodDetectors.js";
import { isTrivialMessage, type DuplicateTracker } from "./messageTraits.js";
import { normalizeForMatching, normalizeKeepingWhitespace } from "./normalize.js";
import { containsBareHangulLink, containsBlockedLink, containsGluedAllowedLink, containsPhoneNumber, containsPortOnlyLink, looksLikeAddress } from "./patterns.js";
import type { RuleEntry, RuleRepository, RuleSnapshot } from "./ruleRepository.js";
import { findFirstIntactMatch, findFirstMatch, locateExceptions, locateExceptionsKeepingWhitespace, type ExceptionAwareText } from "./wordMatch.js";

/** 메시지 1건의 판정. 1단계에서는 AI가 없어 needs_care가 나오지 않는다. */
export interface DetectionResult {
  decision: "auto_hide" | "candidate" | "pass";
  reason: string;
  ref: MessageRef;
  /**
   * 이번 메시지로 떼도배가 막 발동했을 때, 앞선 비권한자 메시지들. 이 메시지의 자체 판정과 무관하게
   * 소비자가 숨긴다. 떼도배 발동은 한 번뿐이라, 다른 규칙이 이겨도 여기서 빠지면 영영 숨겨지지 않는다.
   */
  earlierFloodRefs: MessageRef[];
  trivial: boolean;
  duplicate: boolean;
}

/** 판정 파이프라인. */
export interface DetectionPipeline {
  evaluate(event: ChatEvent): DetectionResult;
}

/** 파이프라인이 쓰는 구성 요소. */
export interface DetectionPipelineDeps {
  rules: RuleRepository;
  groupFlood: GroupFloodDetector;
  personalFlood: PersonalFloodDetector;
  duplicates: DuplicateTracker;
  auditLog: AuditLog;
}

/** 요주의 사용자 판단 기간: 감사 기록 보관 기간과 같은 180일. */
export const WATCH_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

/** 규칙 하나의 결과. null이면 다음 규칙으로 넘어간다. */
type RuleOutcome = { decision: DetectionResult["decision"]; reason: string } | null;

/** 규칙 검사에 필요한 메시지 정보. */
interface RuleContext {
  event: ChatEvent;
  normalized: string;
  /** 공백까지 지운 문장과 그 안의 예외 단어 위치. 금칙어 약·협박·단어를 걸친 금칙어 강을 볼 때 쓴다. */
  compact: ExceptionAwareText;
  /** 공백을 남긴 문장과 그 안의 예외 단어 위치. 금칙어 강이 단어 안에 그대로 있는지 볼 때 쓴다(F4). */
  spaced: ExceptionAwareText;
  snapshot: RuleSnapshot;
  groupFloodTriggered: boolean;
  personalFloodTriggered: boolean;
}

/** 파이프라인을 만든다. */
export function createDetectionPipeline(deps: DetectionPipelineDeps): DetectionPipeline {
  return { evaluate: (event) => evaluate(deps, event) };
}

/** 관측(도배·중복은 모든 메시지를 세야 한다) → 규칙 순서대로 판정 → 권한자 예외 적용. */
function evaluate(deps: DetectionPipelineDeps, event: ChatEvent): DetectionResult {
  const normalized = normalizeForMatching(event.content);
  const ref = toMessageRef(event);
  const flood = deps.groupFlood.observe(normalized, ref, event.receivedAt);
  const context = buildContext(deps, event, normalized, flood.triggered);
  const outcome = decide(deps, context);
  const traits = { trivial: isTrivialMessage(normalized), duplicate: deps.duplicates.seen(normalized, event.receivedAt) };
  const earlierFloodRefs = flood.triggered ? flood.earlierRefs.filter(canAutoHide) : [];
  const result = applyPrivilege({ ...outcome, ref, earlierFloodRefs, ...traits });
  markAutoHiddenFloodEntry(deps.groupFlood, result);
  return result;
}

/**
 * 최종 판정이 auto_hide인 비권한자 메시지는 떼도배 창에서 이미 넘긴 것으로 표시한다.
 * 왜: 이 메시지는 소비자가 이번에 숨기거나 섀도로 기록하므로, 뒤에 떼도배가 발동해 earlierFloodRefs로 다시 넘기면
 * 숨김 요청·판정 행·폭주 한도가 두 번 쓰인다(F1). 권한자 메시지는 earlierFloodRefs에서 이미 빠지므로 표시할 필요가 없다.
 * @param groupFlood 떼도배 감지기
 * @param result 권한자 예외까지 적용한 최종 판정
 */
function markAutoHiddenFloodEntry(groupFlood: GroupFloodDetector, result: DetectionResult): void {
  if (result.decision === "auto_hide" && !result.ref.privileged) groupFlood.markReported(result.ref);
}

/** 규칙 검사용 정보를 모은다. */
function buildContext(deps: DetectionPipelineDeps, event: ChatEvent, normalized: string, groupFloodTriggered: boolean): RuleContext {
  const snapshot = deps.rules.snapshot(event.channelId);
  return {
    event, normalized, snapshot, groupFloodTriggered,
    compact: locateExceptions(normalized, snapshot.exception),
    spaced: locateExceptionsKeepingWhitespace(normalizeKeepingWhitespace(event.content), snapshot.exception),
    personalFloodTriggered: deps.personalFlood.observe(event.senderChannelId, event.receivedAt),
  };
}

/**
 * 스펙 5.2 순서: 금칙어 강 → 떼도배 → 광고 → 전화번호 → 허용어 → 금칙어 약 → 개인 도배 → 협박 → 주소 → 요주의 사용자.
 * 허용어는 금칙어 강·떼도배·광고·전화번호보다 뒤라서 그것들을 무력화하지 못한다.
 * 금칙어 강은 공백을 남긴 문장에서 단어 안에 그대로 있을 때만 auto_hide다. 공백을 지워야만 걸리는 일치(단어를 걸친 우연한 일치,
 * 글자마다 띄운 우회)는 되돌릴 수 없는 숨김 대신 후보(rule:strong_spanning)로 낮춘다(F4). 이 후보 검사는 떼도배·광고·전화번호의
 * auto_hide를 가리지 않도록 그 뒤에, 금칙어 강의 일종이라 허용어보다는 앞에 둔다.
 * 허용 도메인 앞에 한글을 붙여 다른 주소일 수 있는 링크(rule:link_glued), 단서 없는 한글 링크(rule:link_idn, "좋아요.me"),
 * 모르는 최상위 도메인에 포트만 붙은 주소(rule:link_port, "evil.zzz:8080")도 광고 링크의 일종이라 같은 자리(허용어 앞)에서 후보로 올린다(N1, U3).
 */
function decide(deps: DetectionPipelineDeps, context: RuleContext): { decision: DetectionResult["decision"]; reason: string } {
  const checks: Array<(context: RuleContext) => RuleOutcome> = [
    (c) => matchRule(findFirstIntactMatch(c.spaced, c.snapshot.strong), "auto_hide", "strong"),
    (c) => (c.groupFloodTriggered ? { decision: "auto_hide", reason: "rule:group_flood" } : null),
    (c) => (containsBlockedLink(c.event.content, c.snapshot.allowDomains) ? { decision: "auto_hide", reason: "rule:link" } : null),
    (c) => (containsPhoneNumber(c.event.content) ? { decision: "auto_hide", reason: "rule:phone" } : null),
    (c) => (containsGluedAllowedLink(c.event.content, c.snapshot.allowDomains) ? { decision: "candidate", reason: "rule:link_glued" } : null),
    (c) => (containsBareHangulLink(c.event.content, c.snapshot.allowDomains) ? { decision: "candidate", reason: "rule:link_idn" } : null),
    (c) => (containsPortOnlyLink(c.event.content, c.snapshot.allowDomains) ? { decision: "candidate", reason: "rule:link_port" } : null),
    (c) => matchRule(findFirstMatch(c.compact, c.snapshot.strong), "candidate", "strong_spanning"),
    (c) => (c.snapshot.allow.has(c.normalized) ? { decision: "pass", reason: "rule:allow" } : null),
    (c) => matchRule(findFirstMatch(c.compact, c.snapshot.weak), "candidate", "weak"),
    (c) => (c.personalFloodTriggered ? { decision: "candidate", reason: "rule:personal_flood" } : null),
    (c) => matchRule(findFirstMatch(c.compact, c.snapshot.threat), "candidate", "threat"),
    (c) => (looksLikeAddress(c.event.content) ? { decision: "candidate", reason: "rule:address" } : null),
    (c) => (isWatched(deps, c.event) ? { decision: "candidate", reason: "rule:watch_user" } : null),
  ];
  for (const check of checks) {
    const outcome = check(context);
    if (outcome) return outcome;
  }
  return { decision: "pass", reason: "none" };
}

/**
 * 단어 규칙 일치를 판정으로 바꾼다. reason에 규칙 번호를 남겨 오판 신고 때 어떤 규칙인지 알 수 있게 한다.
 * @param matched 찾은 규칙(없으면 null → 다음 규칙으로)
 * @param decision 일치했을 때의 판정
 * @param kind reason에 넣을 규칙 종류(strong·strong_spanning·weak·threat)
 */
function matchRule(matched: RuleEntry | null, decision: DetectionResult["decision"], kind: string): RuleOutcome {
  return matched ? { decision, reason: `rule:${kind}:${matched.id}` } : null;
}

/** 최근 180일 안에 실제 조치를 받은 사용자인지 본다. */
function isWatched(deps: DetectionPipelineDeps, event: ChatEvent): boolean {
  return deps.auditLog.hasEnforcedAction(event.channelId, event.senderChannelId, event.receivedAt - WATCH_WINDOW_MS);
}

/**
 * 보낸 사람 메시지를 자동 숨김해도 되는지 본다: 권한자가 아니고 역할을 알아야 한다(Global Constraints, S18).
 * @param ref 메시지 참조
 */
function canAutoHide(ref: MessageRef): boolean {
  return !ref.privileged && !ref.isRoleUnknown;
}

/**
 * 스트리머·매니저 본인 메시지와 역할을 모르는 사람의 메시지는 자동 숨김 대신 후보로 낮춘다(Global Constraints, S18).
 * 이유 꼬리표로 둘을 가린다: 권한자는 :privileged, 역할 코드가 빠졌거나 처음 보는 값이면 :unknown_role.
 * 왜 모르는 역할도 낮추나: 역할 코드가 빠진 매니저 메시지를 일반 시청자로 보고 되돌릴 수 없게 숨기면 안 된다.
 * 앞선 떼도배 메시지(earlierFloodRefs)는 다른 사람의 도배이므로 여기서 바꾸지 않는다(evaluate가 canAutoHide로 이미 걸렀다).
 */
function applyPrivilege(result: DetectionResult): DetectionResult {
  if (result.decision !== "auto_hide" || canAutoHide(result.ref)) return result;
  const suffix = result.ref.privileged ? "privileged" : "unknown_role";
  return { ...result, decision: "candidate", reason: `${result.reason}:${suffix}` };
}

/**
 * 채팅 이벤트에서 숨기기·표시에 필요한 값만 뽑는다.
 * 권한자 여부는 역할 코드와 함께 "보낸 사람이 채널 주인인가"로도 본다. 왜: 역할 코드가 빠지거나 틀리면
 * 그것만 믿어서는 스트리머 본인 메시지가 자동 숨김될 수 있다(Global Constraints, F9.5).
 * 권한자가 아닌데 역할 코드가 빠졌거나 처음 보는 값이면 isRoleUnknown이다(S18).
 */
function toMessageRef(event: ChatEvent): MessageRef {
  const privileged = isPrivilegedRole(event.userRoleCode) || event.senderChannelId === event.channelId;
  return {
    chatChannelId: event.chatChannelId, messageTime: event.messageTime, senderChannelId: event.senderChannelId,
    nickname: event.nickname, content: event.content,
    privileged, isRoleUnknown: !privileged && !isKnownRole(event.userRoleCode),
  };
}
