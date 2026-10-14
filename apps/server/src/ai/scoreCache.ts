/**
 * AI 원값 캐시: (모델 식별자, 원문 sha256) → 값(1차 점수나 2차 결과). 스펙 5.2 ③의 "AI 판정 10분 재사용, 최대 1만 건".
 * 왜 판정이 아니라 원값인가: 임계값을 바꾸면 같은 점수라도 결과가 달라진다. 쓸 때마다 지금 임계값을 다시 적용한다(계획 R16).
 * 왜 원문 해시인가: 정규화 문장(공백·문장부호를 지운 것)으로 묶으면 서로 다른 입력이 한 결과를 나눠 쓴다.
 * 워커의 모델 식별자가 바뀌면 캐시를 비운다(다른 모델의 점수를 쓰지 않게).
 */
export interface ScoreCache<T> {
  /**
   * 값을 꺼낸다. 모델이 다르거나 기한이 지났으면 undefined.
   * @param model 지금 워커의 모델 식별자(모르면 null → 늘 undefined)
   * @param key 원문 sha256
   * @param now 지금 시각(ms)
   */
  get(model: string | null, key: string, now: number): T | undefined;
  /**
   * 값을 넣는다. 모델이 바뀌었으면 먼저 비운다. 상한을 넘으면 가장 오래 넣은 것부터 뺀다.
   * @param model 값을 낸 모델 식별자
   * @param key 원문 sha256
   * @param value 원값
   * @param now 지금 시각(ms)
   */
  set(model: string, key: string, value: T, now: number): void;
  /** 모두 비운다(세션 초기화). */
  clear(): void;
  /** 담긴 항목 수. */
  size(): number;
}

/** 재사용 기간 기본값(10분, 스펙 5.2 ③). */
export const SCORE_CACHE_TTL_MS = 10 * 60 * 1000;
/** 항목 수 상한 기본값(1만 건, 스펙 5.2 ③). */
export const SCORE_CACHE_CAPACITY = 10_000;

/**
 * 원값 캐시를 만든다.
 * @param ttlMs 재사용 기간(넣은 때부터)
 * @param capacity 항목 수 상한
 */
export function createScoreCache<T>(ttlMs = SCORE_CACHE_TTL_MS, capacity = SCORE_CACHE_CAPACITY): ScoreCache<T> {
  let entries = new Map<string, { value: T; expiresAt: number }>();
  let currentModel: string | null = null;
  return {
    get(model, key, now) {
      if (model === null || model !== currentModel) return undefined;
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt > now) return entry.value;
      entries.delete(key);
      return undefined;
    },
    set(model, key, value, now) {
      if (model !== currentModel) {
        entries = new Map();
        currentModel = model;
      }
      entries.delete(key);
      entries.set(key, { value, expiresAt: now + ttlMs });
      if (entries.size > capacity) entries.delete(entries.keys().next().value as string);
    },
    clear: () => void (entries = new Map()),
    size: () => entries.size,
  };
}
