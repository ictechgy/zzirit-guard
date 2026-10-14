/**
 * 2차 대기열(스펙 5.4, 계획 R8).
 * - 300건까지 받고, 15초가 지난 항목은 버린다. 만료는 넣을 때와 꺼낼 때마다 걸러 낸다(머리가 아닌 곳의 만료도 자리를 차지하지 않게).
 * - 엄격한 우선순위: 키워드 경로 > 첫 채팅 사용자 > 1차 점수 > 먼저 온 것.
 *   높은 우선순위가 계속 들어오면 낮은 항목은 15초 뒤에 버려진다. 과부하 때 덜 중요한 것부터 포기하는 것이 스펙의 의도다.
 * - 꽉 찼을 때: 새 항목이 가장 낮은 항목보다 높으면 그 항목을 버리고 넣는다. 아니면(같아도) 새 항목을 버린다.
 * - 같은 문장 합치기: 원문이 같은 메시지가 대기 중이거나 처리 중이면 그 항목에 붙인다(항목당 maxMembers건). 결과는 붙은 모두에 쓴다.
 * 주의: 이 모듈은 항목을 옮기기만 한다. 버린 메시지의 집계는 부르는 쪽(AI 단계)이 한다.
 */

/** 우선순위. score는 1차 점수이고, 1차를 거치지 않은 키워드 경로는 -1이다. */
export interface QueuePriority {
  keyword: boolean;
  firstChatter: boolean;
  score: number;
}

/** 대기열 항목: 같은 원문을 가진 메시지 묶음. */
export interface QueueEntry<M> {
  /** 항목마다 다른 번호. 같은 원문의 다른 항목(세션 초기화 뒤 새로 넣은 것)과 가린다. */
  token: number;
  /** 원문 sha256. */
  key: string;
  /** 2차에 보낼 원문. */
  text: string;
  members: M[];
  priority: QueuePriority;
  enqueuedAt: number;
  expiresAt: number;
}

/** add 결과. evicted는 넣으려고 버린 항목, rejected는 새 메시지를 버림, overflow는 같은 문장 항목이 꽉 차 버림. */
export type AddOutcome<M> =
  | { kind: "queued" }
  | { kind: "merged" }
  | { kind: "evicted"; evicted: QueueEntry<M> }
  | { kind: "rejected" }
  | { kind: "overflow" };

/** 2차 대기열. */
export interface Stage2Queue<M> {
  /**
   * 메시지를 넣거나 같은 원문 항목에 붙인다.
   * @param key 원문 sha256
   * @param text 원문
   * @param member 메시지
   * @param priority 이 메시지의 우선순위
   * @param now 지금 시각(ms)
   */
  add(key: string, text: string, member: M, priority: QueuePriority, now: number): AddOutcome<M>;
  /** 만료된 항목을 꺼내 돌려준다(버림 집계용). */
  purgeExpired(now: number): QueueEntry<M>[];
  /** 가장 높은 항목을 꺼내 '처리 중'으로 옮긴다. 비었으면 null. */
  takeNext(): QueueEntry<M> | null;
  /**
   * 처리가 끝난 항목을 '처리 중'에서 빼고 돌려준다(처리 중에 붙은 메시지 포함).
   * token이 다르면(세션 초기화로 비운 뒤 같은 원문의 새 항목이 들어왔으면) 건드리지 않고 null이다.
   */
  finish(key: string, token: number): QueueEntry<M> | null;
  /** 대기 중·처리 중 항목을 모두 꺼낸다(세션 초기화). */
  drain(): QueueEntry<M>[];
  /** 가장 이른 만료 시각. 비었으면 null. */
  nextExpiry(): number | null;
  /** 대기 중인 항목 수(처리 중은 빼고). */
  length(): number;
}

/** 대기열 설정 기본값(스펙 5.4). */
export const STAGE2_QUEUE_DEFAULTS = { capacity: 300, ttlMs: 15_000, maxMembers: 20 };

/**
 * 두 우선순위를 비교한다. a가 높으면 양수, 낮으면 음수, 같으면 0. 먼저 온 것이 높다.
 * @param a 항목 a
 * @param b 항목 b
 */
export function comparePriority(a: Pick<QueueEntry<unknown>, "priority" | "enqueuedAt">, b: Pick<QueueEntry<unknown>, "priority" | "enqueuedAt">): number {
  return (
    Number(a.priority.keyword) - Number(b.priority.keyword) ||
    Number(a.priority.firstChatter) - Number(b.priority.firstChatter) ||
    a.priority.score - b.priority.score ||
    b.enqueuedAt - a.enqueuedAt
  );
}

/**
 * 두 우선순위 중 높은 쪽을 통째로 고른다. 같은 문장에 붙은 메시지 중 가장 높은 메시지의 우선순위로 줄을 선다.
 * 왜 칸마다 섞지 않나: 섞으면 '키워드 경로이면서 1차 점수 0.9'처럼 어느 메시지에도 없던 우선순위가 생겨 진짜 키워드 항목을 밀어낸다.
 */
function higherPriority(a: QueuePriority, b: QueuePriority): QueuePriority {
  return comparePriority({ priority: a, enqueuedAt: 0 }, { priority: b, enqueuedAt: 0 }) >= 0 ? a : b;
}

/**
 * 2차 대기열을 만든다.
 * @param options 용량·만료·같은 문장 상한(기본값은 스펙 5.4)
 */
export function createStage2Queue<M>(options: Partial<typeof STAGE2_QUEUE_DEFAULTS> = {}): Stage2Queue<M> {
  const settings = { ...STAGE2_QUEUE_DEFAULTS, ...options };
  const queued = new Map<string, QueueEntry<M>>();
  const inFlight = new Map<string, QueueEntry<M>>();
  let nextToken = 0;
  /** 같은 원문 항목에 붙인다. 꽉 찼으면 overflow. */
  const attach = (entry: QueueEntry<M>, member: M, priority: QueuePriority): AddOutcome<M> => {
    if (entry.members.length >= settings.maxMembers) return { kind: "overflow" };
    entry.members.push(member);
    entry.priority = higherPriority(entry.priority, priority);
    return { kind: "merged" };
  };
  /** 꽉 찬 대기열에 넣는다. 새 항목이 가장 낮은 항목보다 높을 때만 그 항목을 버린다. */
  const replaceLowest = (entry: QueueEntry<M>): AddOutcome<M> => {
    const lowest = [...queued.values()].reduce((worst, candidate) => (comparePriority(candidate, worst) < 0 ? candidate : worst));
    if (comparePriority(entry, lowest) <= 0) return { kind: "rejected" };
    queued.delete(lowest.key);
    queued.set(entry.key, entry);
    return { kind: "evicted", evicted: lowest };
  };
  return {
    add(key, text, member, priority, now) {
      const existing = inFlight.get(key) ?? queued.get(key);
      if (existing) return attach(existing, member, priority);
      const entry: QueueEntry<M> = { token: (nextToken += 1), key, text, members: [member], priority, enqueuedAt: now, expiresAt: now + settings.ttlMs };
      if (queued.size >= settings.capacity) return replaceLowest(entry);
      queued.set(key, entry);
      return { kind: "queued" };
    },
    purgeExpired(now) {
      const expired = [...queued.values()].filter((entry) => entry.expiresAt <= now);
      expired.forEach((entry) => queued.delete(entry.key));
      return expired;
    },
    takeNext() {
      if (queued.size === 0) return null;
      const best = [...queued.values()].reduce((top, candidate) => (comparePriority(candidate, top) > 0 ? candidate : top));
      queued.delete(best.key);
      inFlight.set(best.key, best);
      return best;
    },
    finish(key, token) {
      const entry = inFlight.get(key);
      if (!entry || entry.token !== token) return null;
      inFlight.delete(key);
      return entry;
    },
    drain() {
      const all = [...queued.values(), ...inFlight.values()];
      queued.clear();
      inFlight.clear();
      return all;
    },
    nextExpiry: () => (queued.size === 0 ? null : Math.min(...[...queued.values()].map((entry) => entry.expiresAt))),
    length: () => queued.size,
  };
}
