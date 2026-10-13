import { useCallback, useState } from "react";

/** usePageLimit 결과. */
export interface PageLimit {
  /** 지금 그릴 최대 개수. */
  limit: number;
  /** 한 쪽(pageSize)만큼 더 그린다('더 보기'). 렌더마다 같은 함수다. */
  showMore(): void;
}

/**
 * 목록을 처음 pageSize개만 그리고 '더 보기'를 누를 때마다 pageSize개씩 늘린다(K21).
 * 왜: 처리해야 하는 목록은 잘라 버릴 수 없지만, 떼도배 때 수천 줄을 한 번에 그리면 휴대폰이 멈춰 자동 숨김 끄기조차 늦어진다.
 * @param pageSize 처음 그릴 개수이자 한 번에 더 그릴 개수
 */
export function usePageLimit(pageSize: number): PageLimit {
  const [limit, setLimit] = useState(pageSize);
  const showMore = useCallback(() => setLimit((current) => current + pageSize), [pageSize]);
  return { limit, showMore };
}
