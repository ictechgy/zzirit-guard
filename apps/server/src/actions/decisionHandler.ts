import type { ChatLine, RealtimeEvent } from "@zzirit-guard/shared";
import type { ChatEvent } from "../chat/chatEvent.js";
import type { MessageRef } from "../detection/floodDetectors.js";
import type { DetectionResult } from "../detection/pipeline.js";
import { describeError, type Logger } from "../logger.js";
import type { MinuteStats } from "../records/minuteStats.js";
import type { VerdictRepository } from "../records/verdictRepository.js";
import type { AutoHideSwitch } from "./autoHideSwitch.js";
import type { Executor } from "./executor.js";

/** 실시간 화면으로 보내는 통로. Task 18의 RealtimeHub가 구현한다. */
export interface Broadcaster {
  broadcast(event: RealtimeEvent): void;
  pushChatLine(line: ChatLine): void;
}

/** 판정 결과를 실제 동작(숨김·섀도·후보 저장·방송·통계)으로 옮긴다. */
export interface DecisionHandler {
  handle(event: ChatEvent, result: DetectionResult): void;
}

/** createDecisionHandler 의존성. */
export interface DecisionHandlerDeps {
  verdicts: VerdictRepository;
  executor: Executor;
  autoHide: AutoHideSwitch;
  stats: MinuteStats;
  broadcaster: Broadcaster;
  logger: Logger;
}

/** 규칙에 의한 자동 숨김 행위자. */
const RULE_ACTOR = { type: "rule" as const, channelId: null };
/** 떼도배로 앞선 메시지를 숨길 때 쓰는 판정 이유. 파이프라인은 이유를 넘기지 않으므로 여기서 고정한다. */
const GROUP_FLOOD_REASON = "rule:group_flood";

/**
 * 판정 처리기를 만든다.
 * @param deps 저장소·실행기·스위치·통계·방송·로거
 */
export function createDecisionHandler(deps: DecisionHandlerDeps): DecisionHandler {
  return {
    handle(event, result) {
      recordTraits(deps, event.channelId, result);
      deps.broadcaster.pushChatLine({ senderNickname: event.nickname, content: event.content, messageTime: event.messageTime, decision: displayedDecision(deps, event, result) });
      if (result.decision === "candidate") saveCandidate(deps, event.channelId, result);
      if (result.decision === "auto_hide") applyAutoHide(deps, event.channelId, result.ref, result.reason);
      // 떼도배 발동은 한 번뿐이라 현재 메시지의 판정과 무관하게 앞선 메시지를 숨긴다(R17). 현재 메시지보다 뒤에 처리한다.
      result.earlierFloodRefs.forEach((ref) => applyAutoHide(deps, event.channelId, ref, GROUP_FLOOD_REASON));
    },
  };
}

/**
 * 수신·건너뛰기·중복 건수를 센다(1단계의 핵심 측정값).
 * @param deps 통계 저장소
 * @param channelId 채널 ID
 * @param result 판정 결과
 */
function recordTraits(deps: DecisionHandlerDeps, channelId: string, result: DetectionResult): void {
  deps.stats.increment(channelId, "received");
  if (result.trivial) deps.stats.increment(channelId, "skipped");
  if (result.duplicate) deps.stats.increment(channelId, "deduplicated");
}

/**
 * 실시간 채팅 화면에 보일 판정. 스위치가 꺼져 있으면 auto_hide 대신 shadow로 보인다.
 * @param deps 스위치 조회용 의존성
 * @param event 채팅 이벤트
 * @param result 판정 결과
 */
function displayedDecision(deps: DecisionHandlerDeps, event: ChatEvent, result: DetectionResult): ChatLine["decision"] {
  return result.decision === "auto_hide" && !deps.autoHide.isEnabled(event.channelId) ? "shadow" : result.decision;
}

/**
 * 후보를 저장하고 방송한다. 후보는 숨기지 않고 매니저 검토 큐에만 올린다.
 * @param deps 저장소·방송·통계
 * @param channelId 채널 ID
 * @param result 판정 결과
 */
function saveCandidate(deps: DecisionHandlerDeps, channelId: string, result: DetectionResult): void {
  const verdict = deps.verdicts.insert({ ...toVerdictFields(channelId, result.ref), decision: "candidate", reason: result.reason });
  deps.broadcaster.broadcast({ type: "verdict", verdict });
  deps.stats.increment(channelId, "candidates");
}

/**
 * 스위치가 켜져 있고 폭주 한도 안이면 숨기고, 아니면 섀도로 기록한다.
 * 숨김 요청은 대기열에서 나중에 끝나므로 결과는 비동기로 기록한다. 실패는 로그로만 남긴다.
 * @param deps 저장소·실행기·스위치·통계·방송·로거
 * @param channelId 채널 ID
 * @param ref 숨길 후보 메시지
 * @param reason 판정 이유(감사·오판 신고용)
 */
function applyAutoHide(deps: DecisionHandlerDeps, channelId: string, ref: MessageRef, reason: string): void {
  const allowed = deps.autoHide.isEnabled(channelId) && deps.autoHide.tryConsume(channelId);
  const verdict = deps.verdicts.insert({ ...toVerdictFields(channelId, ref), decision: allowed ? "auto_hide" : "shadow", reason });
  deps.broadcaster.broadcast({ type: "verdict", verdict });
  deps.stats.increment(channelId, allowed ? "auto_hidden" : "shadow");
  if (!allowed) return;
  const target = { chatChannelId: ref.chatChannelId, messageTime: ref.messageTime, senderChannelId: ref.senderChannelId };
  // submit은 거절하지 않도록 설계됐지만, 예외가 나면 Node 22가 프로세스를 끝내므로 반드시 잡는다.
  void deps.executor
    .submit(channelId, { kind: "hide", target, verdictId: verdict.id }, RULE_ACTOR)
    .then((outcome) => {
      if (!outcome.ok) deps.logger.warn("자동 숨김 실패", { verdictId: verdict.id, message: outcome.message });
    })
    .catch((error: unknown) => {
      deps.logger.error("자동 숨김 요청 처리 중 예외", { verdictId: verdict.id, error: describeError(error) });
    });
}

/**
 * 메시지 참조를 판정 저장 필드로 옮긴다.
 * @param channelId 채널 ID
 * @param ref 메시지 참조
 */
function toVerdictFields(channelId: string, ref: MessageRef) {
  return {
    channelId, chatChannelId: ref.chatChannelId, messageTime: ref.messageTime,
    senderChannelId: ref.senderChannelId, senderNickname: ref.nickname, content: ref.content,
  };
}
