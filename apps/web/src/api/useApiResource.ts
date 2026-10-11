import { useCallback, useEffect, useState } from "react";
import { apiGet, describeApiError } from "./client";

/** 조회 결과 상태. */
export interface ApiResource<T> {
  /** 마지막으로 성공한 응답. 다시 읽다 실패해도 지우지 않는다(주기 조회 중 잠깐의 오류로 표가 사라지지 않게). */
  data: T | null;
  /** 마지막 조회의 오류 문구. 성공하면 null. */
  error: string | null;
  /** 첫 응답을 기다리는 중인지. */
  loading: boolean;
  /** 지금 다시 읽는다. */
  reload(): void;
}

/** 내부 조회 상태(reload 제외). */
type ResourceState<T> = Omit<ApiResource<T>, "reload">;

/**
 * 경로를 조회하고 결과를 상태로 돌려준다. path가 null이면 조회하지 않는다(권한이 없을 때).
 * refreshIntervalMs를 주면 그 간격으로 다시 읽는다(상태 점검처럼 서버가 방송하지 않는 값, R-7).
 * 화면이 사라진 뒤 도착한 응답은 버린다.
 */
export function useApiResource<T>(path: string | null, refreshIntervalMs: number | null = null): ApiResource<T> {
  const [state, setState] = useState<ResourceState<T>>({ data: null, error: null, loading: path !== null });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    apiGet<T>(path).then(
      (data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (!cancelled) setState((previous) => ({ data: previous.data, error: describeApiError(error), loading: false }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, version]);
  useEffect(() => {
    if (path === null || refreshIntervalMs === null) return;
    const timer = setInterval(() => setVersion((value) => value + 1), refreshIntervalMs);
    return () => clearInterval(timer);
  }, [path, refreshIntervalMs]);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { ...state, reload };
}
