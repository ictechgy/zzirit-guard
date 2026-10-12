import type { ChatLine, RealtimeEvent } from "@zzirit-guard/shared";
import type { ChatEvent } from "../chat/chatEvent.js";
import type { MessageRef } from "../detection/floodDetectors.js";
import type { DetectionResult } from "../detection/pipeline.js";
import { describeError, type Logger } from "../logger.js";
import type { MinuteStats } from "../records/minuteStats.js";
import type { VerdictRepository } from "../records/verdictRepository.js";
import type { AutoHideSwitch } from "./autoHideSwitch.js";
import type { Executor } from "./executor.js";
import type { VerdictClaims } from "./verdictClaims.js";

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
  /** 숨김을 보내는 중인 판정 모음. 자동 숨김이 대기열에 있는 동안 매니저의 숨기기·무시가 겹치지 않게 붙잡는다(S12). */
  claims: VerdictClaims;
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
      // 자동 숨김 허락(스위치·폭주 한도)을 먼저 정해, 실시간 채팅 줄과 저장되는 판정이 같은 결과를 보이게 한다(S5, M02).
      const isAutoHideAllowed = result.decision === "auto_hide" && consumeAutoHide(deps, event.channelId);
      deps.broadcaster.pushChatLine({ senderNickname: event.nickname, content: event.content, messageTime: event.messageTime, decision: displayedDecision(result.decision, isAutoHideAllowed) });
      if (result.decision === "candidate") saveCandidate(deps, event.channelId, result);
      if (result.decision === "auto_hide") recordAutoHide(deps, event.channelId, result.ref, result.reason, isAutoHideAllowed);
      // 떼도배 발동은 한 번뿐이라 현재 메시지의 판정과 무관하게 앞선 메시지를 숨긴다(R17). 현재 메시지보다 뒤에 처리한다.
      // 파이프라인이 이미 권한자·역할 모르는 사람을 빼지만, 그들의 자동 숨김 금지(Global Constraints, S18)를 여기서도 한 번 더 막는다.
      result.earlierFloodRefs
        .filter((ref) => !ref.privileged && !ref.isRoleUnknown)
        .forEach((ref) => recordAutoHide(deps, event.channelId, ref, GROUP_FLOOD_REASON, consumeAutoHide(deps, event.channelId)));
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
 * 자동 숨김 1건을 허락할지 정한다: 스위치가 켜져 있고 폭주 한도 안이어야 한다. 허락하면 한도를 1건 쓴다.
 * @param deps 스위치 의존성
 * @param channelId 채널 ID
 * @returns 숨겨도 되면 true, 섀도로 남겨야 하면 false
 */
function consumeAutoHide(deps: DecisionHandlerDeps, channelId: string): boolean {
  return deps.autoHide.isEnabled(channelId) && deps.autoHide.tryConsume(channelId);
}

/**
 * 실시간 채팅 화면에 보일 판정. auto_hide인데 허락되지 않았으면(스위치 꺼짐·폭주 한도) 저장 판정과 같게 shadow로 보인다.
 * @param decision 파이프라인 판정
 * @param isAutoHideAllowed consumeAutoHide 결과
 */
function displayedDecision(decision: DetectionResult["decision"], isAutoHideAllowed: boolean): ChatLine["decision"] {
  return decision === "auto_hide" && !isAutoHideAllowed ? "shadow" : decision;
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
 * 허락된 자동 숨김이면 auto_hide로 저장하고 숨김을 보내며, 아니면 섀도로 저장한다. 둘 다 방송한다.
 * 섀도 통계는 바로 세고, 자동 숨김 통계는 숨김이 성공한 뒤에 센다(submitAutoHide).
 * @param deps 저장소·실행기·스위치·통계·방송·로거
 * @param channelId 채널 ID
 * @param ref 숨길 후보 메시지
 * @param reason 판정 이유(감사·오판 신고용)
 * @param isAllowed consumeAutoHide 결과(스위치·폭주 한도)
 */
function recordAutoHide(deps: DecisionHandlerDeps, channelId: string, ref: MessageRef, reason: string, isAllowed: boolean): void {
  const verdict = deps.verdicts.insert({ ...toVerdictFields(channelId, ref), decision: isAllowed ? "auto_hide" : "shadow", reason });
  deps.broadcaster.broadcast({ type: "verdict", verdict });
  if (!isAllowed) {
    deps.stats.increment(channelId, "shadow");
    return;
  }
  submitAutoHide(deps, channelId, ref, verdict.id);
}

/**
 * 숨김을 실행기에 보내고, 결과가 오면 기록한다. 대기열에서 나중에 끝나므로 결과는 비동기로 처리한다.
 * 성공했을 때만 auto_hidden을 센다(S5, M01). 왜: 취소(스위치 꺼짐)·실패까지 세면 통계가 실제로 숨긴 수보다 많아 보인다.
 * 실패·취소는 따로 세는 칸이 없어 세지 않고 경고 로그(원문 없음)만 남긴다.
 * @param deps 실행기·스위치·통계·로거
 * @param channelId 채널 ID
 * @param ref 숨길 메시지
 * @param verdictId 저장한 판정 번호
 */
function submitAutoHide(deps: DecisionHandlerDeps, channelId: string, ref: MessageRef, verdictId: number): void {
  const target = { chatChannelId: ref.chatChannelId, messageTime: ref.messageTime, senderChannelId: ref.senderChannelId };
  // 방금 만든 판정이라 붙잡기는 늘 성공한다. 결과가 오기 전까지 매니저의 숨기기·무시가 같은 판정에 겹치지 않게 한다(S12).
  deps.claims.tryClaim(verdictId, "auto_hide");
  // submit은 거절하지 않도록 설계됐지만, 예외가 나면 Node 22가 프로세스를 끝내므로 반드시 잡는다.
  void deps.executor
    .submit(channelId, { kind: "hide", target, verdictId }, RULE_ACTOR, { shouldRun: () => deps.autoHide.isEnabled(channelId) })
    .then((outcome) => {
      if (outcome.ok) deps.stats.increment(channelId, "auto_hidden");
      else deps.logger.warn("자동 숨김 실패", { verdictId, outcomeMessage: outcome.message });
    })
    .catch((error: unknown) => {
      deps.logger.error("자동 숨김 요청 처리 중 예외", { verdictId, error: describeError(error) });
    })
    .finally(() => deps.claims.release(verdictId));
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
