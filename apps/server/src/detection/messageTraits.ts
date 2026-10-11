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
}

/** 기본값: 10분, 최대 1만 건(스펙 5.2 ③). */
const DUPLICATE_DEFAULTS = { ttlMs: 600_000, maxEntries: 10_000 };

/**
 * Map의 삽입 순서를 LRU로 쓰는 중복 추적기를 만든다.
 * 메모리가 무한히 늘지 않도록 최대 개수를 넘기면 가장 오래 안 나온 문장부터 버린다.
 * @param options ttlMs(중복으로 볼 기간)·maxEntries(보관 최대 개수). 생략하면 기본값을 쓴다.
 */
export function createDuplicateTracker(options: Partial<typeof DUPLICATE_DEFAULTS> = {}): DuplicateTracker {
  const settings = { ...DUPLICATE_DEFAULTS, ...options };
  const lastSeen = new Map<string, number>();
  return {
    /** 재삽입으로 Map 끝에 옮겨 LRU 순서를 갱신한 뒤, 한도를 넘었으면 가장 앞(가장 오래된) 항목을 지운다. */
    seen(normalized, now) {
      const previous = lastSeen.get(normalized);
      lastSeen.delete(normalized);
      lastSeen.set(normalized, now);
      if (lastSeen.size > settings.maxEntries) lastSeen.delete(lastSeen.keys().next().value as string);
      return previous !== undefined && now - previous <= settings.ttlMs;
    },
  };
}
