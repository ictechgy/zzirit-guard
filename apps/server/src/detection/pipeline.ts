import { isPrivilegedRole, type ChatEvent } from "../chat/chatEvent.js";
import type { AuditLog } from "../records/auditLog.js";
import type { GroupFloodDetector, MessageRef, PersonalFloodDetector } from "./floodDetectors.js";
import { isTrivialMessage, type DuplicateTracker } from "./messageTraits.js";
import { normalizeForMatching } from "./normalize.js";
import { containsBlockedLink, containsPhoneNumber, looksLikeAddress } from "./patterns.js";
import type { RuleRepository, RuleSnapshot } from "./ruleRepository.js";
import { findFirstMatch, stripExceptions } from "./wordMatch.js";

/** 메시지 1건의 판정. 1단계에서는 AI가 없어 needs_care가 나오지 않는다. */
export interface DetectionResult {
  decision: "auto_hide" | "candidate" | "pass";
  reason: string;
  ref: MessageRef;
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
  withoutExceptions: string;
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
  const earlierFloodRefs = outcome.reason === "rule:group_flood" ? flood.earlierRefs.filter((item) => !item.privileged) : [];
  return applyPrivilege({ ...outcome, ref, earlierFloodRefs, ...traits });
}

/** 규칙 검사용 정보를 모은다. */
function buildContext(deps: DetectionPipelineDeps, event: ChatEvent, normalized: string, groupFloodTriggered: boolean): RuleContext {
  const snapshot = deps.rules.snapshot(event.channelId);
  return {
    event, normalized, snapshot, groupFloodTriggered,
    withoutExceptions: stripExceptions(normalized, snapshot.exception),
    personalFloodTriggered: deps.personalFlood.observe(event.senderChannelId, event.receivedAt),
  };
}

/**
 * 스펙 5.2 순서: 금칙어 강 → 떼도배 → 광고 → 전화번호 → 허용어 → 금칙어 약 → 개인 도배 → 협박 → 주소 → 요주의 사용자.
 * 허용어는 금칙어 강·떼도배·광고·전화번호보다 뒤라서 그것들을 무력화하지 못한다.
 */
function decide(deps: DetectionPipelineDeps, context: RuleContext): { decision: DetectionResult["decision"]; reason: string } {
  const checks: Array<(context: RuleContext) => RuleOutcome> = [
    (c) => matchRule(c.withoutExceptions, c.snapshot.strong, "auto_hide", "strong"),
    (c) => (c.groupFloodTriggered ? { decision: "auto_hide", reason: "rule:group_flood" } : null),
    (c) => (containsBlockedLink(c.event.content, c.snapshot.allowDomains) ? { decision: "auto_hide", reason: "rule:link" } : null),
    (c) => (containsPhoneNumber(c.event.content) ? { decision: "auto_hide", reason: "rule:phone" } : null),
    (c) => (c.snapshot.allow.has(c.normalized) ? { decision: "pass", reason: "rule:allow" } : null),
    (c) => matchRule(c.withoutExceptions, c.snapshot.weak, "candidate", "weak"),
    (c) => (c.personalFloodTriggered ? { decision: "candidate", reason: "rule:personal_flood" } : null),
    (c) => matchRule(c.withoutExceptions, c.snapshot.threat, "candidate", "threat"),
    (c) => (looksLikeAddress(c.event.content) ? { decision: "candidate", reason: "rule:address" } : null),
    (c) => (isWatched(deps, c.event) ? { decision: "candidate", reason: "rule:watch_user" } : null),
  ];
  for (const check of checks) {
    const outcome = check(context);
    if (outcome) return outcome;
  }
  return { decision: "pass", reason: "none" };
}

/** 단어 규칙 일치를 판정으로 바꾼다. reason에 규칙 번호를 남겨 오판 신고 때 어떤 규칙인지 알 수 있게 한다. */
function matchRule(text: string, entries: RuleSnapshot["strong"], decision: DetectionResult["decision"], kind: string): RuleOutcome {
  const matched = findFirstMatch(text, entries);
  return matched ? { decision, reason: `rule:${kind}:${matched.id}` } : null;
}

/** 최근 180일 안에 실제 조치를 받은 사용자인지 본다. */
function isWatched(deps: DetectionPipelineDeps, event: ChatEvent): boolean {
  return deps.auditLog.hasEnforcedAction(event.channelId, event.senderChannelId, event.receivedAt - WATCH_WINDOW_MS);
}

/** 스트리머·매니저 메시지는 자동 숨김 대신 후보로 낮춘다(Global Constraints). */
function applyPrivilege(result: DetectionResult): DetectionResult {
  if (result.decision !== "auto_hide" || !result.ref.privileged) return result;
  return { ...result, decision: "candidate", reason: `${result.reason}:privileged`, earlierFloodRefs: [] };
}

/** 채팅 이벤트에서 숨기기·표시에 필요한 값만 뽑는다. */
function toMessageRef(event: ChatEvent): MessageRef {
  return {
    chatChannelId: event.chatChannelId, messageTime: event.messageTime, senderChannelId: event.senderChannelId,
    nickname: event.nickname, content: event.content, privileged: isPrivilegedRole(event.userRoleCode),
  };
}
