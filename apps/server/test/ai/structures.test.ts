import { describe, expect, it } from "vitest";
import { createFirstChatters } from "../../src/ai/firstChatters.js";
import { createScoreCache } from "../../src/ai/scoreCache.js";
import { comparePriority, createStage2Queue, type QueuePriority } from "../../src/ai/stage2Queue.js";
import { createWorkerHealth } from "../../src/ai/workerHealth.js";

describe("원값 캐시", () => {
  it("같은 모델·원문이면 10분 동안 재사용하고, 기한이 지나면 버린다", () => {
    const cache = createScoreCache<number>(1_000, 10);
    cache.set("m@1", "k", 0.3, 0);
    expect(cache.get("m@1", "k", 999)).toBe(0.3);
    expect(cache.get("m@1", "k", 1_000)).toBeUndefined();
  });

  it("모델 식별자가 바뀌면 다른 모델의 값을 쓰지 않고, 새 값을 넣을 때 비운다", () => {
    const cache = createScoreCache<number>();
    cache.set("m@1", "a", 0.1, 0);
    expect(cache.get("m@2", "a", 0)).toBeUndefined();
    expect(cache.get(null, "a", 0)).toBeUndefined();
    cache.set("m@2", "b", 0.2, 0);
    expect(cache.get("m@2", "a", 0)).toBeUndefined();
    expect(cache.size()).toBe(1);
  });

  it("상한을 넘으면 가장 오래 넣은 것부터 뺀다", () => {
    const cache = createScoreCache<number>(10_000, 2);
    ["a", "b", "c"].forEach((key, index) => cache.set("m", key, index, 0));
    expect([cache.get("m", "a", 0), cache.get("m", "b", 0), cache.get("m", "c", 0)]).toEqual([undefined, 1, 2]);
  });
});

describe("첫 채팅 사용자", () => {
  it("이번 세션에서 처음 본 사람만 true이고, 비우면 다시 처음이다", () => {
    const chatters = createFirstChatters();
    expect([chatters.observe("a"), chatters.observe("a"), chatters.observe("b")]).toEqual([true, false, true]);
    chatters.clear();
    expect(chatters.observe("a")).toBe(true);
  });

  it("상한을 넘으면 가장 오래 안 본 사람부터 뺀다(한꺼번에 비우지 않는다)", () => {
    const chatters = createFirstChatters(2);
    chatters.observe("a");
    chatters.observe("b");
    chatters.observe("a");
    chatters.observe("c");
    expect([chatters.observe("a"), chatters.observe("b")]).toEqual([false, true]);
  });
});

describe("워커 상태", () => {
  it("시작은 unknown, 실패하면 down, 성공하면 ok와 모델이다", () => {
    const health = createWorkerHealth(0);
    expect(health.status()).toEqual({ state: "unknown", model: null, since: 0 });
    health.recordFailure(5);
    expect(health.status()).toMatchObject({ state: "down", since: 5 });
    health.recordSuccess("m@1", 9);
    expect(health.status()).toEqual({ state: "ok", model: "m@1", since: 9 });
  });

  it("아무 호출이 없으면 상태 확인이 필요하고, 확인 중에는 겹쳐 보내지 않는다", () => {
    const health = createWorkerHealth(0, 10_000);
    expect(health.needsProbe(0)).toBe(true);
    health.markProbing(0);
    expect(health.needsProbe(20_000)).toBe(false);
    health.clearProbing();
    expect(health.needsProbe(9_999)).toBe(false);
    expect(health.needsProbe(10_000)).toBe(true);
  });

  it("중지가 30초 넘게 이어지면 한 번만 알리고, 돌아온 뒤 다시 멈추면 또 알린다", () => {
    const health = createWorkerHealth(0, 10_000, 30_000);
    health.recordFailure(0);
    expect(health.takeDownNotice(29_999)).toBe(false);
    expect([health.takeDownNotice(30_000), health.takeDownNotice(40_000)]).toEqual([true, false]);
    health.recordSuccess("m", 50_000);
    health.recordFailure(60_000);
    expect(health.takeDownNotice(90_000)).toBe(true);
  });
});

/** 우선순위를 만든다. */
function priority(keyword: boolean, firstChatter: boolean, score: number): QueuePriority {
  return { keyword, firstChatter, score };
}

describe("2차 대기열", () => {
  it("키워드 경로 > 첫 채팅 사용자 > 1차 점수 > 먼저 온 것 순으로 꺼낸다", () => {
    const queue = createStage2Queue<string>();
    queue.add("score", "s", "s", priority(false, false, 0.9), 0);
    queue.add("first", "f", "f", priority(false, true, 0.1), 1);
    queue.add("keyword", "k", "k", priority(true, false, -1), 2);
    queue.add("score-late", "s2", "s2", priority(false, false, 0.9), 3);
    expect([queue.takeNext()?.key, queue.takeNext()?.key, queue.takeNext()?.key, queue.takeNext()?.key]).toEqual(["keyword", "first", "score", "score-late"]);
  });

  it("꽉 차면 새 항목이 가장 낮은 항목보다 높을 때만 그것을 밀어내고, 같거나 낮으면 새 항목을 버린다", () => {
    const queue = createStage2Queue<string>({ capacity: 2 });
    queue.add("a", "a", "a", priority(false, false, 0.5), 0);
    queue.add("b", "b", "b", priority(false, false, 0.2), 1);
    expect(queue.add("same", "x", "x", priority(false, false, 0.2), 2)).toEqual({ kind: "rejected" });
    const outcome = queue.add("high", "h", "h", priority(true, false, -1), 3);
    expect(outcome).toMatchObject({ kind: "evicted", evicted: { key: "b" } });
    expect(queue.length()).toBe(2);
  });

  it("만료는 머리가 아닌 곳에서도 걸러 내고, 가장 이른 만료 시각을 알려 준다", () => {
    const queue = createStage2Queue<string>({ ttlMs: 100 });
    queue.add("high", "h", "h", priority(true, false, -1), 50);
    queue.add("low", "l", "l", priority(false, false, 0.1), 0);
    expect(queue.nextExpiry()).toBe(100);
    expect(queue.purgeExpired(100).map((entry) => entry.key)).toEqual(["low"]);
    expect(queue.length()).toBe(1);
  });

  it("같은 원문은 대기 중이든 처리 중이든 한 항목에 붙이고, 우선순위는 높은 메시지의 것을 통째로 쓰며, 상한을 넘으면 버린다", () => {
    const queue = createStage2Queue<string>({ maxMembers: 2 });
    queue.add("k", "같은 문장", "m1", priority(false, false, 0.2), 0);
    expect(queue.add("k", "같은 문장", "m2", priority(false, true, 0.1), 1)).toEqual({ kind: "merged" });
    const entry = queue.takeNext();
    expect(entry?.priority).toEqual(priority(false, true, 0.1));
    expect(queue.add("k", "같은 문장", "m3", priority(false, false, 0.1), 2)).toEqual({ kind: "overflow" });
    expect(queue.finish("k", entry?.token ?? -1)?.members).toEqual(["m1", "m2"]);
    expect(queue.add("k", "같은 문장", "m4", priority(false, false, 0.1), 3)).toEqual({ kind: "queued" });
  });

  it("키워드 메시지와 점수 높은 메시지를 합쳐도 없던 우선순위(키워드이면서 높은 점수)를 만들지 않는다", () => {
    const queue = createStage2Queue<string>();
    queue.add("k", "같은 문장", "keyword", priority(true, false, -1), 0);
    queue.add("k", "같은 문장", "scored", priority(false, false, 0.9), 1);
    expect(queue.takeNext()?.priority).toEqual(priority(true, false, -1));
  });

  it("다른 항목 번호로는 처리 중 항목을 끝내지 않는다(세션 초기화 뒤 같은 원문의 새 항목을 지키기 위해서다)", () => {
    const queue = createStage2Queue<string>();
    queue.add("k", "같은 문장", "old", priority(false, false, 0.5), 0);
    const old = queue.takeNext();
    queue.drain();
    queue.add("k", "같은 문장", "new", priority(false, false, 0.5), 1);
    const fresh = queue.takeNext();
    expect(queue.finish("k", old?.token ?? -1)).toBeNull();
    expect(queue.finish("k", fresh?.token ?? -1)?.members).toEqual(["new"]);
  });

  it("비우면 대기 중·처리 중 항목을 모두 돌려준다", () => {
    const queue = createStage2Queue<string>();
    queue.add("a", "a", "a", priority(false, false, 0.5), 0);
    queue.add("b", "b", "b", priority(false, false, 0.4), 0);
    queue.takeNext();
    expect(queue.drain().map((entry) => entry.key).sort()).toEqual(["a", "b"]);
    expect([queue.length(), queue.takeNext()]).toEqual([0, null]);
  });

  it("우선순위 비교는 대칭이다", () => {
    const a = { priority: priority(false, true, 0.1), enqueuedAt: 0 };
    const b = { priority: priority(false, false, 0.9), enqueuedAt: 0 };
    expect(Math.sign(comparePriority(a, b))).toBe(-Math.sign(comparePriority(b, a)));
  });
});
