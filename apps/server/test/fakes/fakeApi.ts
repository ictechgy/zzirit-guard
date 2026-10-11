import type { ChzzkApi } from "../../src/chzzk/apiClient.js";

/**
 * 필요한 메서드만 채운 가짜 ChzzkApi. 채우지 않은 메서드를 부르면 바로 실패해,
 * 테스트가 예상하지 못한 호출을 놓치지 않게 한다.
 */
export function createFakeApi(overrides: Partial<ChzzkApi>): ChzzkApi {
  return new Proxy(overrides as ChzzkApi, {
    get(target, property) {
      const value = target[property as keyof ChzzkApi];
      if (value) return value;
      return () => Promise.reject(new Error(`fakeApi.${String(property)}가 준비되지 않았습니다`));
    },
  });
}
