import { createHash } from "node:crypto";

/** ㅋ·ㅎ·ㄷ·ㅠ·ㅜ로만 된(또는 빈) 정규화 문장. 이모티콘·문장부호만 있던 채팅은 정규화 후 빈 문자열이 된다. */
const TRIVIAL_PATTERN = /^[ㅋㅎㄷㅠㅜ]*$/u;

/**
 * AI 단계를 건너뛰어도 되는 가벼운 반응인지 본다(스펙 5.2 ③).
 * 입력은 normalizeChatText를 거친 문장이어야 하며, 여기서 다시 정규화하지 않는다.
 */
export function isTrivialMessage(normalized: string): boolean {
  return TRIVIAL_PATTERN.test(normalized);
}

/** 최근에 같은 정규화 문장을 봤는지 추적한다. 1단계에서는 통계(중복 비율 측정)에만 쓴다. */
export interface DuplicateTracker {
  /**
   * 같은 문장이 ttl 안에 다시 나왔는지 판정하고, 이번 관측 시각을 기록한다.
   * @param normalized 정규화된 문장
   * @param now 관측 시각(밀리초)
   * @returns 직전 관측이 ttl 안이면 true
   */
  seen(normalized: string, now: number): boolean;
  /**
   * ttl(10분)이 지난 문장을 지운다(K16). 앱이 1분마다 부른다.
   * 왜: 같은 문장이 다시 오거나 1만 건이 차야 지워져, 조용한 채널에서는 오래전 채팅의 흔적이 계속 남았다.
   * @param now 지금 시각(ms, seen에 넘긴 시각과 같은 시계)
   */
  pruneExpired(now: number): void;
  /** 지금 기억하는 문장 수(점검·테스트용). */
  retainedCount(): number;
}

/** 기본값: 10분, 최대 1만 건(스펙 5.2 ③). */
const DUPLICATE_DEFAULTS = { ttlMs: 600_000, maxEntries: 10_000 };
/**
 * 중복 열쇠로 쓰는 SHA-256 16진수의 앞 글자 수(32자 = 128비트, K16).
 * 왜 해시인가: 이 추적기는 같은 문장인지만 알면 되므로 채팅 원문(전화번호 등)을 메모리에 두지 않는다. 128비트면 우연히 겹칠 일이 없다.
 */
const DUPLICATE_KEY_HEX_LENGTH = 32;

/**
 * 정규화 문장의 중복 열쇠(SHA-256 16진수 앞 32자)를 만든다(K16).
 * @param normalized 정규화된 문장
 */
export function duplicateKeyOf(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, DUPLICATE_KEY_HEX_LENGTH);
}

/**
 * Map의 삽입 순서를 LRU로 쓰는 중복 추적기를 만든다.
 * 메모리가 무한히 늘지 않도록 최대 개수를 넘기면 가장 오래 안 나온 문장부터 버린다.
 * @param options ttlMs(중복으로 볼 기간)·maxEntries(보관 최대 개수). 생략하면 기본값을 쓴다.
 */
export function createDuplicateTracker(options: Partial<typeof DUPLICATE_DEFAULTS> = {}): DuplicateTracker {
  const settings = { ...DUPLICATE_DEFAULTS, ...options };
  const lastSeen = new Map<string, number>();
  return {
    /** 재삽입으로 Map 끝에 옮겨 LRU 순서를 갱신한 뒤, 한도를 넘었으면 가장 앞(가장 오래된) 항목을 지운다. 열쇠는 문장의 해시다. */
    seen(normalized, now) {
      const key = duplicateKeyOf(normalized);
      const previous = lastSeen.get(key);
      lastSeen.delete(key);
      lastSeen.set(key, now);
      if (lastSeen.size > settings.maxEntries) lastSeen.delete(lastSeen.keys().next().value as string);
      return previous !== undefined && now - previous <= settings.ttlMs;
    },
    pruneExpired: (now) => forgetExpired(lastSeen, now, settings.ttlMs),
    retainedCount: () => lastSeen.size,
  };
}

/**
 * ttl이 지난 열쇠를 앞(가장 오래 안 나온 것)부터 지운다. 처음으로 ttl 안인 열쇠에서 멈춰 한 번에 드는 비용이 작다.
 * @param lastSeen 열쇠 → 마지막으로 본 시각(삽입 순서가 곧 오래된 순서)
 * @param now 지금 시각(ms)
 * @param ttlMs 중복으로 볼 기간
 */
function forgetExpired(lastSeen: Map<string, number>, now: number, ttlMs: number): void {
  for (const [key, seenAt] of lastSeen) {
    if (now - seenAt <= ttlMs) return;
    lastSeen.delete(key);
  }
}
