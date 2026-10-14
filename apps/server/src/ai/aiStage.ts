import { createHash } from "node:crypto";
import type { AiCategory, AiStatus } from "@zzirit-guard/shared";
import type { MessageRef } from "../detection/floodDetectors.js";
import { describeError, type Logger } from "../logger.js";
import type { Clock } from "../time.js";
import { createFirstChatters } from "./firstChatters.js";
import { createScoreCache } from "./scoreCache.js";
import { createStage2Queue, type QueueEntry, type QueuePriority } from "./stage2Queue.js";
import { WorkerCallError, type WorkerClient, type WorkerItem, type WorkerStage } from "./workerClient.js";
import { createWorkerHealth, type WorkerHealth } from "./workerHealth.js";

/**
 * AI 단계(스펙 5.2 ④⑤, 5.4, 계획 R4~R17). 규칙이 판정하지 않은 채팅을 1차 워커로 묶어 보내고, 1차 점수가 임계값 이상이거나
 * 키워드 경로에 걸린 채팅을 2차 대기열로 보낸다. 2차 결과는 onResult로 넘긴다(판정 기록은 결정 처리기가 한다).
 * - 키워드 경로는 1차와 상관없이 2차로 간다(1차가 죽어도 간다).
 * - 메시지마다 결과(onOutcome)를 정확히 한 번만 확정한다. 세대가 바뀐 뒤(세션 초기화·종료) 늦게 온 결과는 버린다.
 * - 워커 호출은 중단 신호로 끊을 수 있다. 상태 확인으로 조용한 채널에서도 워커 중지를 알아챈다.
 * 주의: 채팅 원문은 로그에 남기지 않는다.
 */

/** AI 단계에 넘기는 채팅 한 건. ref는 판정 기록에 쓰는 메시지 식별(채널·보낸 사람·보낸 시각)과 표시 정보다. */
export interface AiSubmission {
  channelId: string;
  ref: MessageRef;
  /** 키워드 경로에 걸린 규칙 번호. 없으면 null. */
  keywordRouteId: number | null;
}

/** 2차 결과. */
export interface AiResult {
  unsafeProbability: number;
  category: AiCategory;
  model: string;
}

/**
 * 메시지 하나의 결과(집계용). forwarded는 2차 대기열에 넣었다는 중간 표시이고, 나머지는 끝 결과다.
 * - stage1_pass: 1차 미만으로 통과(따로 세지 않는다).
 * - stage2_done: 2차 결과를 적용(캐시 재사용 포함).
 * - stage2_dropped: 2차 대기열 넘침·15초 경과(과부하).
 * - ai_unchecked: 워커 장애·시간 초과·1차 대기 넘침·너무 긴 문장·종료 때 버림.
 */
export type AiOutcome = "forwarded" | "stage1_pass" | "stage2_done" | "stage2_dropped" | "ai_unchecked";

/** AI 단계 의존성. */
export interface AiStageDeps {
  stage1: WorkerClient;
  stage2: WorkerClient;
  clock: Clock;
  logger: Logger;
  /** 채널의 지금 1차 임계값. 결과가 나온 때 읽는다. */
  stage1Threshold(channelId: string): number;
  /** 2차 결과를 판정 기록으로 옮긴다(후보·도움 필요 여부와 겹침 정리는 받는 쪽이 한다). */
  onResult(submission: AiSubmission, result: AiResult): void;
  /** 메시지 하나의 결과를 센다. */
  onOutcome(channelId: string, outcome: AiOutcome): void;
  /** 워커 중지가 30초 넘게 이어졌다(알림을 한 번 보낸다). */
  onWorkerDown(stage: WorkerStage): void;
}

/** 시간·크기 설정. 기본값은 스펙과 계획의 값이고, 테스트에서 줄인다. */
export interface AiTiming {
  batchWindowMs: number;
  batchSize: number;
  stage1Backlog: number;
  /** 두 워커를 번갈아 확인하는 간격(ms). 워커마다 이 값의 두 배마다 확인하고, 두 워커는 이만큼 어긋난다(계획 R15). */
  probeIntervalMs: number;
  maxContentCodePoints: number;
  /** 1차 요청 본문 바이트 상한. 워커 계약(65,536바이트)보다 조금 작게 둔다. */
  maxRequestBytes: number;
}

/** 시간·크기 기본값. */
export const AI_TIMING_DEFAULTS: AiTiming = {
  batchWindowMs: 25, batchSize: 16, stage1Backlog: 512, probeIntervalMs: 5_000, maxContentCodePoints: 1_000, maxRequestBytes: 60_000,
};

/** 요청 본문의 겉(`{"items":[]}`) 바이트. */
const REQUEST_ENVELOPE_BYTES = 12;

/** AI 단계. */
export interface AiStage {
  /** 상태 확인 타이머를 시작한다. */
  start(): void;
  /** 채팅을 넣는다. 멈춘 뒤에는 무시한다. */
  submit(submission: AiSubmission): void;
  /** 채팅 세션이 끝났다(연결 해제·채널 바꾸기·권한 회수·다시 시작): 대기 중인 것을 미검사로 버리고 캐시를 비운다. */
  resetSession(): void;
  /** 멈춘다: 새 채팅을 받지 않고, 타이머를 지우고, 진행 중인 요청을 중단하고 끝나기를 기다린다. */
  stop(): Promise<void>;
  status(): Omit<AiStatus, "enabled">;
}

/** AI 단계가 추적하는 메시지. */
interface Tracked {
  submission: AiSubmission;
  workerId: string;
  contentKey: string;
  generation: number;
  firstChatter: boolean;
  isSettled: boolean;
}

/** 최근 1분 건수를 1초 칸으로 센다(상태 화면의 미검사 건수). */
function createRollingCount(): { add(now: number): void; total(now: number): number } {
  const buckets = new Map<number, number>();
  const prune = (now: number): void => {
    for (const second of buckets.keys()) if (second <= Math.floor(now / 1000) - 60) buckets.delete(second);
  };
  return {
    add(now) {
      prune(now);
      const second = Math.floor(now / 1000);
      buckets.set(second, (buckets.get(second) ?? 0) + 1);
    },
    total(now) {
      prune(now);
      return [...buckets.values()].reduce((sum, count) => sum + count, 0);
    },
  };
}

/** 문자열이 짝 없는 서로게이트 없이 올바른 유니코드인지. 워커 계약이 거절하므로 보내기 전에 거른다. */
function isWellFormed(text: string): boolean {
  return (text as string & { isWellFormed(): boolean }).isWellFormed();
}

/**
 * 워커에 보낼 수 있는 문장인지: 코드 포인트 수가 상한 이하이고 올바른 유니코드다.
 * 왜 이렇게 세나: 공격자가 아주 긴 채팅을 보내도 해시·배열 펼치기로 메모리를 쓰지 않게, 길이로 먼저 거르고 상한을 넘는 순간 멈춘다.
 * @param text 채팅 원문
 * @param maxCodePoints 코드 포인트 상한
 */
function isAcceptableContent(text: string, maxCodePoints: number): boolean {
  if (text.length > maxCodePoints * 2) return false;
  let count = 0;
  for (const _codePoint of text) {
    count += 1;
    if (count > maxCodePoints) return false;
  }
  return isWellFormed(text);
}

/**
 * AI 단계를 만든다.
 * @param deps 워커·시계·임계값·결과 처리
 * @param timing 시간·크기 설정(기본값을 덮어쓴다)
 */
export function createAiStage(deps: AiStageDeps, timing: Partial<AiTiming> = {}): AiStage {
  const settings = { ...AI_TIMING_DEFAULTS, ...timing };
  const health: Record<WorkerStage, WorkerHealth> = { stage1: createWorkerHealth(deps.clock()), stage2: createWorkerHealth(deps.clock()) };
  const cache1 = createScoreCache<number>();
  const cache2 = createScoreCache<AiResult>();
  const firstChatters = createFirstChatters();
  const queue = createStage2Queue<Tracked>();
  const dropped = createRollingCount();
  const unchecked = createRollingCount();
  let generation = 0;
  let nextWorkerId = 0;
  let isStopped = false;
  let controller = new AbortController();
  let buffer: Tracked[] = [];
  let stage1InFlight: Tracked[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  let isStage2Busy = false;
  let probeTick = 0;
  const pending = new Set<Promise<unknown>>();

  /** 진행 중인 비동기 작업을 기억한다(stop이 끝나기를 기다린다). */
  const track = (promise: Promise<unknown>): void => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  };
  /** 끝 결과를 한 번만 확정한다. 이미 확정했거나 세대가 지난 메시지면 무시한다. */
  const settle = (tracked: Tracked, outcome: Exclude<AiOutcome, "forwarded">): void => {
    if (tracked.isSettled || tracked.generation !== generation) return;
    tracked.isSettled = true;
    if (outcome === "stage2_dropped") dropped.add(deps.clock());
    if (outcome === "ai_unchecked") unchecked.add(deps.clock());
    deps.onOutcome(tracked.submission.channelId, outcome);
  };
  /** 2차 결과를 넘기고 stage2_done으로 확정한다. 받는 쪽이 실패하면 미검사로 센다(원문은 남기지 않는다). */
  const deliver = (tracked: Tracked, result: AiResult): void => {
    if (tracked.isSettled || tracked.generation !== generation) return;
    try {
      deps.onResult(tracked.submission, result);
      settle(tracked, "stage2_done");
    } catch (error) {
      deps.logger.error("AI 결과를 판정으로 옮기지 못했습니다. DB 상태를 확인하세요.", { error: describeError(error) });
      settle(tracked, "ai_unchecked");
    }
  };

  /** 2차 대기열에 넣는다. 넣기 전에 만료를 거르고, 넣지 못하거나 밀려난 메시지는 stage2_dropped다. 실제로 들어간 메시지만 forwarded로 센다. */
  const enqueueStage2 = (tracked: Tracked, priority: QueuePriority): void => {
    dropExpired();
    const outcome = queue.add(tracked.contentKey, tracked.submission.ref.content, tracked, priority, deps.clock());
    if (outcome.kind === "rejected" || outcome.kind === "overflow") settle(tracked, "stage2_dropped");
    else deps.onOutcome(tracked.submission.channelId, "forwarded");
    if (outcome.kind === "evicted") outcome.evicted.members.forEach((member) => settle(member, "stage2_dropped"));
    scheduleExpiry();
    pumpStage2();
  };
  /** 1차 점수로 길을 정한다: 지금 임계값 이상이면 2차, 아니면 통과. */
  const routeByScore = (tracked: Tracked, score: number): void => {
    if (score >= deps.stage1Threshold(tracked.submission.channelId)) enqueueStage2(tracked, { keyword: false, firstChatter: tracked.firstChatter, score });
    else settle(tracked, "stage1_pass");
  };
  /** 만료된 2차 항목을 버리고 센다. */
  const dropExpired = (): void => {
    queue.purgeExpired(deps.clock()).forEach((entry) => entry.members.forEach((member) => settle(member, "stage2_dropped")));
  };
  /** 가장 이른 만료 시각에 맞춰 타이머 하나를 둔다. */
  const scheduleExpiry = (): void => {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    const next = queue.nextExpiry();
    if (next === null || isStopped) return;
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      dropExpired();
      scheduleExpiry();
    }, Math.max(0, next - deps.clock()));
  };

  /** 대기 중인 1차 항목에서 한 묶음을 꺼낸다: 16건과 요청 본문 바이트 상한을 함께 지킨다(남은 것은 다음 묶음으로). */
  const takeStage1Batch = (): Tracked[] => {
    const batch: Tracked[] = [];
    let bytes = REQUEST_ENVELOPE_BYTES;
    for (const tracked of buffer) {
      const size = Buffer.byteLength(JSON.stringify({ id: tracked.workerId, text: tracked.submission.ref.content })) + 1;
      if (batch.length >= settings.batchSize || (batch.length > 0 && bytes + size > settings.maxRequestBytes)) break;
      batch.push(tracked);
      bytes += size;
    }
    buffer = buffer.slice(batch.length);
    return batch;
  };
  /**
   * 1차 묶음을 보낸다. 요청은 한 번에 하나만 보내고, 끝나면 남은 것을 이어 보낸다.
   * 응답이 왔을 때 세대가 바뀌었으면(세션 초기화·종료) 상태·캐시·결과를 하나도 바꾸지 않는다.
   */
  const flushStage1 = (): void => {
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = null;
    if (stage1InFlight.length > 0 || buffer.length === 0 || isStopped) return;
    const batch = takeStage1Batch();
    stage1InFlight = batch;
    const requestGeneration = generation;
    const isCurrent = () => requestGeneration === generation;
    const items: WorkerItem[] = batch.map((tracked) => ({ id: tracked.workerId, text: tracked.submission.ref.content }));
    track(
      deps.stage1
        .classify(items, controller.signal)
        .then((result) => isCurrent() && applyStage1(batch, result.model, result.verdicts.map((verdict) => verdict.unsafeProbability)))
        .catch((error: unknown) => isCurrent() && failBatch("stage1", batch, error))
        .finally(() => {
          if (!isCurrent()) return;
          stage1InFlight = [];
          if (buffer.length > 0) scheduleStage1(buffer.length >= settings.batchSize);
        }),
    );
  };
  /** 1차 묶음을 예약한다: 꽉 찼으면 바로, 아니면 묶음 창(25ms) 뒤에. */
  const scheduleStage1 = (isFull: boolean): void => {
    if (isFull) flushStage1();
    else batchTimer ??= setTimeout(flushStage1, settings.batchWindowMs);
  };
  /** 1차 결과를 캐시에 넣고 길을 정한다. */
  const applyStage1 = (batch: Tracked[], model: string, scores: number[]): void => {
    health.stage1.recordSuccess(model, deps.clock());
    batch.forEach((tracked, index) => {
      const score = scores[index] ?? 0;
      cache1.set(model, tracked.contentKey, score, deps.clock());
      if (!tracked.isSettled && tracked.generation === generation) routeByScore(tracked, score);
    });
  };
  /** 워커 호출 실패: 장애면 상태를 내리고, 어느 경우든 묶음의 메시지는 미검사다(중단은 세션 초기화가 이미 확정했다). */
  const failBatch = (stage: WorkerStage, members: Tracked[], error: unknown): void => {
    const failure = error instanceof WorkerCallError ? error : new WorkerCallError("unavailable", "unexpected");
    if (failure.kind === "aborted") return;
    if (failure.kind === "unavailable") health[stage].recordFailure(deps.clock());
    else health[stage].recordAlive(deps.clock());
    if (!(error instanceof WorkerCallError)) deps.logger.error("AI 워커 호출 중 예상하지 못한 오류", { stage, error: describeError(error) });
    else deps.logger.warn("AI 워커 호출 실패", { stage, kind: failure.kind, code: failure.code, count: members.length });
    members.forEach((member) => settle(member, "ai_unchecked"));
  };

  /**
   * 2차를 하나씩 처리한다: 만료를 거르고 가장 높은 항목을 보낸다. 끝나면 다음 항목으로 이어 간다.
   * 응답이 왔을 때 세대가 바뀌었으면 상태·캐시·대기열·결과를 하나도 바꾸지 않는다(같은 원문의 새 항목을 건드리지 않게, 항목 번호로도 가린다).
   */
  const pumpStage2 = (): void => {
    if (isStage2Busy || isStopped) return;
    dropExpired();
    const entry = queue.takeNext();
    if (!entry) return;
    isStage2Busy = true;
    const requestGeneration = generation;
    const isCurrent = () => requestGeneration === generation;
    track(
      deps.stage2
        .classify([{ id: `q${(nextWorkerId += 1)}`, text: entry.text }], controller.signal)
        .then((result) => isCurrent() && applyStage2(entry, result.model, result.verdicts[0]))
        .catch((error: unknown) => isCurrent() && failBatch("stage2", queue.finish(entry.key, entry.token)?.members ?? entry.members, error))
        .finally(() => {
          if (!isCurrent()) return;
          isStage2Busy = false;
          scheduleExpiry();
          pumpStage2();
        }),
    );
  };
  /** 2차 결과를 캐시에 넣고, 처리 중에 붙은 메시지까지 모두에게 넘긴다. */
  const applyStage2 = (entry: QueueEntry<Tracked>, model: string, verdict: { unsafeProbability: number; category: AiCategory | null } | undefined): void => {
    health.stage2.recordSuccess(model, deps.clock());
    const members = queue.finish(entry.key, entry.token)?.members ?? entry.members;
    if (!verdict?.category) {
      members.forEach((member) => settle(member, "ai_unchecked"));
      return;
    }
    const result: AiResult = { unsafeProbability: verdict.unsafeProbability, category: verdict.category, model };
    cache2.set(model, entry.key, result, deps.clock());
    members.forEach((member) => deliver(member, result));
  };

  /** 들어온 채팅의 길을 정한다: 2차 캐시 → 결과, 키워드 경로 → 2차, 1차 캐시 → 점수로, 나머지 → 1차 묶음. */
  const route = (tracked: Tracked): void => {
    const cached2 = cache2.get(health.stage2.status().model, tracked.contentKey, deps.clock());
    if (cached2) return deliver(tracked, cached2);
    if (tracked.submission.keywordRouteId !== null) return enqueueStage2(tracked, { keyword: true, firstChatter: tracked.firstChatter, score: -1 });
    const cached1 = cache1.get(health.stage1.status().model, tracked.contentKey, deps.clock());
    if (cached1 !== undefined) return routeByScore(tracked, cached1);
    if (buffer.length >= settings.stage1Backlog) return settle(tracked, "ai_unchecked");
    buffer.push(tracked);
    scheduleStage1(buffer.length >= settings.batchSize);
  };

  /**
   * 워커를 번갈아 하나씩 확인한다(두 워커가 probeIntervalMs만큼 어긋나게, 계획 R15). 아무 호출이 없던 워커만 확인하고,
   * 중지가 오래간 워커는 한 번 알린다.
   */
  const probeWorkers = (): void => {
    const stage: WorkerStage = probeTick % 2 === 0 ? "stage1" : "stage2";
    probeTick += 1;
    if (health[stage].needsProbe(deps.clock())) probe(stage, stage === "stage1" ? deps.stage1 : deps.stage2);
    for (const each of ["stage1", "stage2"] as const) if (health[each].takeDownNotice(deps.clock())) deps.onWorkerDown(each);
  };
  /**
   * 상태 확인 한 번. 응답이 왔을 때 세대가 바뀌었으면(세션 초기화·종료) 상태를 바꾸지 않는다.
   * 왜: 초기화가 확인 중 표시를 이미 지웠으므로, 늦게 온 옛 응답이 그 뒤 새로 시작한 확인의 표시를 지우거나 상태를 덮으면 안 된다.
   */
  const probe = (stage: WorkerStage, client: WorkerClient): void => {
    health[stage].markProbing(deps.clock());
    const requestGeneration = generation;
    const isCurrent = () => requestGeneration === generation;
    track(
      client
        .health(controller.signal)
        .then((model) => isCurrent() && health[stage].recordSuccess(model, deps.clock()))
        .catch((error: unknown) => isCurrent() && recordProbeFailure(stage, error))
        .finally(() => isCurrent() && health[stage].clearProbing()),
    );
  };
  /** 상태 확인 실패를 반영한다. 중단은 무시하고, 바쁨은 살아 있음으로, 그 밖은 장애로 본다. */
  const recordProbeFailure = (stage: WorkerStage, error: unknown): void => {
    if (error instanceof WorkerCallError && error.kind === "aborted") return;
    if (error instanceof WorkerCallError && error.kind === "busy") health[stage].recordAlive(deps.clock());
    else health[stage].recordFailure(deps.clock());
  };

  /** 세대를 바꾸고 대기 중·처리 중인 메시지를 모두 미검사로 확정한 뒤, 요청을 중단하고 캐시를 비운다. */
  const resetSession = (): void => {
    const stale = [...buffer, ...stage1InFlight, ...queue.drain().flatMap((entry) => entry.members)];
    stale.forEach((tracked) => settle(tracked, "ai_unchecked"));
    generation += 1;
    controller.abort();
    controller = new AbortController();
    buffer = [];
    stage1InFlight = [];
    isStage2Busy = false;
    [batchTimer, expiryTimer].forEach((timer) => timer && clearTimeout(timer));
    batchTimer = null;
    expiryTimer = null;
    cache1.clear();
    cache2.clear();
    firstChatters.clear();
    // 처리 중이던 상태 확인은 중단했고 그 응답은 무시하므로, 확인 중 표시를 여기서 지워 다음 확인이 막히지 않게 한다.
    health.stage1.clearProbing();
    health.stage2.clearProbing();
  };

  return {
    start() {
      if (isStopped || probeTimer) return;
      probeTimer = setInterval(probeWorkers, settings.probeIntervalMs);
      probeWorkers();
    },
    submit(submission) {
      if (isStopped) return;
      // 첫 채팅 여부는 문장을 받든 버리든 먼저 본다. 왜: 버린 첫 채팅 뒤의 다음 채팅이 첫 채팅으로 앞줄에 서지 않게 한다.
      const firstChatter = firstChatters.observe(submission.ref.senderChannelId);
      if (!isAcceptableContent(submission.ref.content, settings.maxContentCodePoints)) {
        // 너무 길거나 올바르지 않은 문장은 해시하지도 추적하지도 않고 미검사로 센다(자르지 않는다).
        unchecked.add(deps.clock());
        deps.onOutcome(submission.channelId, "ai_unchecked");
        return;
      }
      route({
        submission,
        workerId: `m${(nextWorkerId += 1)}`,
        contentKey: createHash("sha256").update(submission.ref.content).digest("hex"),
        generation,
        firstChatter,
        isSettled: false,
      });
    },
    resetSession,
    async stop() {
      if (isStopped) return;
      resetSession();
      isStopped = true;
      if (probeTimer) clearInterval(probeTimer);
      probeTimer = null;
      await Promise.allSettled([...pending]);
    },
    status: () => ({
      stage1: health.stage1.status(),
      stage2: health.stage2.status(),
      queueLength: queue.length(),
      uncheckedLastMinute: { dropped: dropped.total(deps.clock()), unchecked: unchecked.total(deps.clock()) },
    }),
  };
}
