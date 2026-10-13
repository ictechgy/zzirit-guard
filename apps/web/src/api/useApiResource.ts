import { useCallback, useEffect, useState } from "react";
import { ApiError, apiGet, describeApiError } from "./client";

/** 조회 결과 상태. */
export interface ApiResource<T> {
  /**
   * 지금 경로의 마지막 성공 응답. 같은 경로를 다시 읽다 일시 오류가 나면 지우지 않는다(주기 조회 중 잠깐의 오류로 표가 사라지지 않게).
   * 경로가 바뀌거나(권한 회수로 null 포함) 401·403·no_channel을 받으면 지운다(W1).
   */
  data: T | null;
  /** 마지막 조회의 오류 문구. 성공하면 null. */
  error: string | null;
  /** 지금 경로의 첫 응답을 기다리는 중인지. */
  loading: boolean;
  /** 지금 다시 읽는다. */
  reload(): void;
}

/** 내부 조회 상태. forPath는 이 결과가 어느 경로의 것인지다(경로가 바뀌면 이전 결과를 보여 주지 않으려고 둔다). */
interface ResourceState<T> {
  forPath: string | null;
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * 경로의 첫 상태. 경로가 있으면 불러오는 중, 없으면(권한 없음) 아무것도 없다.
 * @param path 조회할 경로(없으면 null)
 */
function emptyState<T>(path: string | null): ResourceState<T> {
  return { forPath: path, data: null, error: null, loading: path !== null };
}

/**
 * 접근이 끊긴 오류인지 본다: 세션 만료(401)·권한 없음(403)·채널 연결 없음(no_channel).
 * 왜: 이때 이전 응답(채팅 원문·닉네임·감사 기록)을 남기면 볼 수 없게 된 사람이 계속 보게 된다(W1, C04).
 * @param error 조회가 던진 오류
 */
function isAccessLost(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403 || error.code === "no_channel");
}

/**
 * 조회 실패 뒤의 상태. 접근이 끊겼거나 다른 경로의 결과였으면 데이터를 지우고, 같은 경로의 일시 오류면 이전 데이터를 남긴다.
 * @param previous 실패 직전 상태
 * @param path 실패한 경로
 * @param error 조회가 던진 오류
 */
function stateAfterFailure<T>(previous: ResourceState<T>, path: string, error: unknown): ResourceState<T> {
  const keepsData = previous.forPath === path && !isAccessLost(error);
  return { forPath: path, data: keepsData ? previous.data : null, error: describeApiError(error), loading: false };
}

/**
 * 경로를 조회하고 결과를 상태로 돌려준다. path가 null이면 조회하지 않는다(권한이 없을 때).
 * refreshIntervalMs를 주면 그 간격으로 다시 읽는다(상태 점검처럼 서버가 방송하지 않는 값, R-7).
 * refreshKey가 바뀌면 다시 읽는다(설정 탭을 다시 열거나 '새로 고침'을 눌렀을 때, F6).
 * 화면이 사라진 뒤 도착한 응답은 버린다. 경로가 바뀌면 새 응답이 오기 전에도 이전 경로의 결과를 내주지 않는다(W1).
 * 경로가 null이 되면(권한을 잃으면) 이전 응답을 상태에서도 지운다(K23).
 */
export function useApiResource<T>(path: string | null, refreshIntervalMs: number | null = null, refreshKey = 0): ApiResource<T> {
  const [state, setState] = useState<ResourceState<T>>(() => emptyState<T>(path));
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (path === null) {
      // 왜 상태에서도 지우나: 가리기만 하면 메모리에 남고, 권한을 되찾아 같은 경로로 돌아오는 순간 새 응답 전에 옛 데이터가 보인다.
      setState((previous) => (previous.forPath === null ? previous : emptyState<T>(null)));
      return;
    }
    let cancelled = false;
    apiGet<T>(path).then(
      (data) => {
        if (!cancelled) setState({ forPath: path, data, error: null, loading: false });
      },
      (error: unknown) => {
        if (!cancelled) setState((previous) => stateAfterFailure(previous, path, error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, version, refreshKey]);
  useEffect(() => {
    if (path === null || refreshIntervalMs === null) return;
    const timer = setInterval(() => setVersion((value) => value + 1), refreshIntervalMs);
    return () => clearInterval(timer);
  }, [path, refreshIntervalMs]);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  // 상태가 다른 경로의 것이면(경로가 막 바뀌었으면) 그 결과 대신 새 경로의 첫 상태를 보여 준다.
  const current = state.forPath === path ? state : emptyState<T>(path);
  return { data: current.data, error: current.error, loading: current.loading, reload };
}
