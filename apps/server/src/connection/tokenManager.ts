import { ChzzkApiError, type ChzzkApi, type TokenSet } from "../chzzk/apiClient.js";
import type { Clock } from "../time.js";
import type { ConnectedChannel, CredentialStore, StoredCredential } from "./credentialStore.js";

/**
 * 쓰기를 할 수 없는 상태를 알리는 오류. 메시지는 매니저 화면에 그대로 보여 줄 수 있게 쓴다.
 * 별도 클래스로 두는 이유는 호출자가 instanceof로 "재연결 필요"와 일시 오류를 구분하기 위해서다.
 */
export class WriteLockedError extends Error {
  override readonly name = "WriteLockedError";
}

/**
 * 스트리머 토큰을 꺼내 주고, 만료 전에 갱신하며, 갱신이 불가능하면 쓰기를 잠근다.
 * 잠금 상태는 매니저 화면과 쓰기 경로가 함께 보므로 메서드로 노출한다.
 */
export interface TokenManager {
  /**
   * 유효한 access token을 돌려준다. 만료가 가까우면 먼저 갱신한다.
   * @throws WriteLockedError 연결이 없거나 쓰기가 잠긴 상태일 때
   */
  getAccessToken(): Promise<string>;
  /**
   * 만료 시각과 관계없이 갱신한다. 진행 중인 갱신이 있으면 그 결과를 함께 기다린다.
   * @throws WriteLockedError 연결이 없거나 쓰기가 잠긴 상태일 때
   */
  forceRefresh(): Promise<string>;
  /** 쓰기가 잠겼는지 돌려준다. 화면에 재연결 안내를 띄우는 판단에 쓴다. */
  isWriteLocked(): boolean;
  /** 저장된 access token의 만료 시각(ms)을 돌려준다. 연결이 없으면 null. */
  accessExpiresAt(): number | null;
  /** 새 연결과 토큰을 저장하고 잠금을 푼다. 스트리머 재연결 경로에서만 부른다. */
  adoptCredential(channel: ConnectedChannel, credential: StoredCredential): void;
  /** 연결을 해제하고 잠근다. 치지직 쪽 토큰은 건드리지 않는다. */
  disconnect(): void;
  /** 잠금 상태가 바뀔 때 호출될 리스너를 등록한다. 바뀐 값만 알린다. */
  onLockChange(listener: (locked: boolean) => void): void;
}

/**
 * createTokenManager 옵션.
 * store와 api는 저장과 갱신을 위해, clock은 만료 판단을 테스트에서 고정하려고 주입한다.
 */
export interface TokenManagerOptions {
  store: CredentialStore;
  api: ChzzkApi;
  clock: Clock;
  /** 선제 갱신 여유(ms). 생략하면 만료 2시간 전에 갱신한다. */
  refreshMarginMs?: number;
  /**
   * 삼키면 안 되는 오류를 기록하는 함수. 조용히 무시하면 갱신 실패 원인을 알 수 없으므로 필요하다.
   * 앱은 나중에 로거를 연결한다. 생략하면 콘솔 경고로 남긴다. context에는 토큰 값을 넣지 않는다.
   */
  reportError?: (context: string, error: unknown) => void;
}

/** 기본 선제 갱신 여유: 만료 2시간 전(스펙 4장). */
const DEFAULT_REFRESH_MARGIN_MS = 2 * 60 * 60 * 1000;

/**
 * 진행 중이던 갱신이 끝나기 전에 연결이 바뀌었을 때(다시 연결·연결 해제)의 문구.
 * 왜 WriteLockedError로 던지나: 옛 연결의 토큰으로 쓰기를 이어 가면 안 되고, 호출자(실행기)가 재시도 없이 끝내게 하려는 것이다(S7).
 */
const STALE_REFRESH_MESSAGE = "토큰을 갱신하는 동안 치지직 연결이 바뀌었거나 해제되어 요청을 멈췄습니다. 다시 시도하세요.";

/** reportError를 생략했을 때 쓰는 기본 기록기. 아직 로거가 없어 콘솔 경고로 남긴다. */
const consoleReportError = (context: string, error: unknown): void => {
  console.warn(context, error);
};

/**
 * TokenManager를 만든다.
 * @param options 저장소·API·시계와 선택 설정. 생략된 값은 기본값을 쓴다.
 */
export function createTokenManager(options: TokenManagerOptions): TokenManager {
  return new RefreshingTokenManager(options);
}

/** 단일 갱신(single-flight)과 쓰기 잠금을 구현한다. */
class RefreshingTokenManager implements TokenManager {
  /** 쓰기 잠금 여부. true인 동안 갱신과 쓰기를 모두 거부한다. */
  private locked = false;
  /**
   * 연결 세대. adoptCredential·disconnect마다 1씩 올린다(S7, M06).
   * 왜: 옛 연결로 시작한 갱신이 늦게 끝나면 새 연결의 토큰을 덮어쓰거나 새 연결을 잠글 수 있다. 시작한 세대와 다르면 결과를 버린다.
   */
  private generation = 0;
  /** 진행 중인 갱신과 그 갱신을 시작한 세대. 같은 refresh token을 두 번 쓰지 않으려고 같은 세대 안에서만 공유한다. */
  private inFlight: { generation: number; promise: Promise<string> } | null = null;
  /** 잠금 상태 변화를 받을 리스너 목록. */
  private readonly listeners: Array<(locked: boolean) => void> = [];
  /** 선제 갱신 여유(ms). 옵션이 없으면 기본값을 쓴다. */
  private readonly marginMs: number;
  /** 삼킨 오류를 기록하는 함수. 옵션이 없으면 콘솔 기록기를 쓴다. */
  private readonly reportError: (context: string, error: unknown) => void;

  /**
   * 옵션을 받아 기본값을 채운다.
   * @param options createTokenManager에 받은 옵션 그대로
   */
  constructor(private readonly options: TokenManagerOptions) {
    this.marginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
    this.reportError = options.reportError ?? consoleReportError;
  }

  /** 유효한 access token을 돌려준다. 만료가 가까우면 먼저 갱신한다. */
  async getAccessToken(): Promise<string> {
    const credential = this.requireCredential();
    if (credential.accessExpiresAt - this.options.clock() > this.marginMs) return credential.accessToken;
    return this.refreshKeepingValidToken(credential, this.generation);
  }

  /** 401을 받은 직후처럼 만료 시각과 관계없이 갱신해야 할 때 쓴다. */
  forceRefresh(): Promise<string> {
    return this.refreshOnce(this.requireCredential());
  }

  /** 쓰기 잠금 상태를 돌려준다. */
  isWriteLocked(): boolean {
    return this.locked;
  }

  /** 저장된 access token 만료 시각을 돌려준다. 저장소를 직접 읽어 항상 최신 값을 준다. */
  accessExpiresAt(): number | null {
    return this.options.store.loadCredential()?.accessExpiresAt ?? null;
  }

  /** 스트리머가 다시 연결(또는 로그인)해 받은 새 토큰을 저장하고 잠금을 푼다. 진행 중이던 갱신의 결과는 버리도록 세대를 올린다. */
  adoptCredential(channel: ConnectedChannel, credential: StoredCredential): void {
    this.startNewGeneration();
    this.options.store.saveConnection(channel, credential);
    this.setLocked(false);
  }

  /**
   * 연결을 해제한다. 쓰기를 먼저 잠근 뒤 저장된 토큰을 지운다. 치지직 revoke는 부르지 않는다(Global Constraints). 진행 중이던 갱신의 결과는 버린다.
   * 왜 잠금이 먼저인가(K6): 지우기(DB 쓰기)가 실패하면 옛 토큰이 남아, 잠그지 않았다면 대기 중이던 조치가 비상 해제 뒤에도 치지직에 나간다.
   * 지우기가 실패해도 잠금은 풀지 않고 오류를 호출자에게 그대로 넘긴다. 잠금 알림은 지우기를 시도한 뒤에 보내,
   * 상태 방송이 연결이 사라진 상태를 보여 주게 한다.
   */
  disconnect(): void {
    this.startNewGeneration();
    const wasLocked = this.locked;
    this.locked = true;
    try {
      this.options.store.clearConnection();
    } finally {
      if (!wasLocked) this.notifyLockChange(true);
    }
  }

  /** 잠금 상태 변화 리스너를 등록한다. 등록 순서대로 호출된다. */
  onLockChange(listener: (locked: boolean) => void): void {
    this.listeners.push(listener);
  }

  /**
   * 잠겨 있거나 연결이 없으면 이유를 담아 예외를 던진다.
   * 잠금 검사를 갱신보다 먼저 하는 이유는 무효 refresh token으로 치지직을 다시 부르지 않기 위해서다.
   */
  private requireCredential(): StoredCredential {
    const credential = this.options.store.loadCredential();
    if (!credential) throw new WriteLockedError("치지직 채널이 연결되어 있지 않습니다. 스트리머가 먼저 연결하세요.");
    if (this.locked) throw new WriteLockedError("치지직 토큰을 갱신할 수 없어 쓰기를 멈췄습니다. 스트리머가 다시 연결해야 합니다.");
    return credential;
  }

  /**
   * 세대를 올리고 진행 중 갱신의 공유를 끊는다. 이후 호출은 새 연결의 refresh token으로 따로 갱신한다.
   * 옛 갱신은 끝나도 저장·잠금을 하지 않는다(assertSameGeneration).
   */
  private startNewGeneration(): void {
    this.generation += 1;
    this.inFlight = null;
  }

  /**
   * 갱신을 시작한 뒤 연결이 바뀌었으면(세대가 다르면) 옛 연결의 결과를 쓰지 않도록 던진다.
   * @param generation 갱신을 시작할 때의 세대
   * @throws WriteLockedError 세대가 바뀌었을 때
   */
  private assertSameGeneration(generation: number): void {
    if (generation !== this.generation) throw new WriteLockedError(STALE_REFRESH_MESSAGE);
  }

  /**
   * 갱신을 시도하되, 일시 오류이고 토큰이 아직 유효하면 기존 토큰을 쓴다.
   * 일시 오류는 기록해 원인을 남기고, 토큰이 이미 만료됐으면 그 오류를 그대로 던진다.
   * 기다리는 사이 연결이 바뀌었으면 옛 토큰을 내주지 않는다(연결 해제 뒤 옛 토큰으로 쓰기가 나가지 않게).
   * @param credential 갱신을 시작할 때 읽은 토큰
   * @param generation 갱신을 시작할 때의 세대
   */
  private async refreshKeepingValidToken(credential: StoredCredential, generation: number): Promise<string> {
    try {
      return await this.refreshOnce(credential);
    } catch (error) {
      const stillValid = credential.accessExpiresAt > this.options.clock();
      if (error instanceof WriteLockedError || !stillValid) throw error;
      this.assertSameGeneration(generation);
      this.reportError("토큰 갱신에 실패해 아직 유효한 기존 토큰을 계속 씁니다", error);
      return credential.accessToken;
    }
  }

  /**
   * 같은 세대의 진행 중 갱신이 있으면 그 결과를 함께 기다린다. refresh token이 일회용이라 두 번 쓰면 안 된다.
   * 세대가 바뀌었으면(다시 연결) 옛 갱신에 합류하지 않고 새 refresh token으로 새로 갱신한다.
   */
  private refreshOnce(credential: StoredCredential): Promise<string> {
    if (this.inFlight?.generation === this.generation) return this.inFlight.promise;
    const generation = this.generation;
    const promise = this.refresh(credential, generation).finally(() => {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    });
    this.inFlight = { generation, promise };
    return promise;
  }

  /**
   * 갱신 → 저장 → 반환. 저장 실패는 복구할 수 없으므로 잠근다.
   * 응답을 기다리는 사이 연결이 바뀌었으면 저장하지 않고 던진다(S7).
   * @param credential 갱신할 토큰
   * @param generation 갱신을 시작할 때의 세대
   */
  private async refresh(credential: StoredCredential, generation: number): Promise<string> {
    const tokens = await this.requestRefresh(credential.refreshToken, generation);
    this.assertSameGeneration(generation);
    const renewed: StoredCredential = {
      channelId: credential.channelId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: this.options.clock() + tokens.expiresInSeconds * 1000,
    };
    this.saveOrLock(renewed);
    return renewed.accessToken;
  }

  /**
   * 치지직에 갱신을 요청한다. 401이면 refresh token이 무효이므로 잠근다. 그 밖의 오류는 호출자에게 넘긴다.
   * 기다리는 사이 연결이 바뀌었으면 옛 연결의 실패로 새 연결을 잠그지 않도록 먼저 세대를 확인한다.
   * @param refreshToken 쓸 refresh token
   * @param generation 갱신을 시작할 때의 세대
   */
  private async requestRefresh(refreshToken: string, generation: number): Promise<TokenSet> {
    try {
      return await this.options.api.refreshToken(refreshToken);
    } catch (error) {
      this.assertSameGeneration(generation);
      if (error instanceof ChzzkApiError && error.status === 401) {
        this.setLocked(true);
        throw new WriteLockedError("치지직이 토큰 갱신을 거부했습니다(만료·철회). 스트리머가 다시 연결해야 합니다.");
      }
      throw error;
    }
  }

  /**
   * 새 토큰을 저장한다. 실패하면 옛 refresh token도 이미 무효라 잠그고 원인을 알린다.
   * 저장 전에 메모리 밖으로 토큰을 내보내지 않으려고, 저장이 성공한 뒤에만 호출자가 토큰을 쓴다.
   */
  private saveOrLock(renewed: StoredCredential): void {
    try {
      this.options.store.saveCredential(renewed);
    } catch (error) {
      this.setLocked(true);
      const reason = error instanceof Error ? error.message : String(error);
      throw new WriteLockedError(`새 토큰을 저장하지 못해 쓰기를 멈췄습니다(${reason}). 디스크를 확인한 뒤 스트리머가 다시 연결하세요.`);
    }
  }

  /** 잠금 상태를 바꾸고, 바뀌었을 때만 알린다. */
  private setLocked(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    this.notifyLockChange(locked);
  }

  /**
   * 잠금 상태 변화를 리스너에게 알린다. 연결 해제는 잠금과 알림 사이에 저장소 지우기가 있어 따로 부른다(K6).
   * 리스너 하나가 던져도 나머지 리스너와 원래 던질 WriteLockedError가 살아남도록 각각 격리한다.
   * 삼킨 리스너 오류는 reportError로 기록해 조용히 사라지지 않게 한다.
   * @param locked 바뀐 잠금 상태
   */
  private notifyLockChange(locked: boolean): void {
    for (const listener of this.listeners) {
      try {
        listener(locked);
      } catch (error) {
        this.reportError("토큰 잠금 상태 리스너가 실패했습니다", error);
      }
    }
  }
}
