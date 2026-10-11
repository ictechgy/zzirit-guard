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
  /** 진행 중인 갱신 Promise. 같은 refresh token을 두 번 쓰지 않으려고 공유한다. */
  private inFlight: Promise<string> | null = null;
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
    return this.refreshKeepingValidToken(credential);
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

  /** 스트리머가 다시 연결(또는 로그인)해 받은 새 토큰을 저장하고 잠금을 푼다. */
  adoptCredential(channel: ConnectedChannel, credential: StoredCredential): void {
    this.options.store.saveConnection(channel, credential);
    this.setLocked(false);
  }

  /** 연결을 해제한다. 저장된 토큰을 지우고 잠근다. 치지직 revoke는 부르지 않는다(Global Constraints). */
  disconnect(): void {
    this.options.store.clearConnection();
    this.setLocked(true);
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
   * 갱신을 시도하되, 일시 오류이고 토큰이 아직 유효하면 기존 토큰을 쓴다.
   * 일시 오류는 기록해 원인을 남기고, 토큰이 이미 만료됐으면 그 오류를 그대로 던진다.
   */
  private async refreshKeepingValidToken(credential: StoredCredential): Promise<string> {
    try {
      return await this.refreshOnce(credential);
    } catch (error) {
      const stillValid = credential.accessExpiresAt > this.options.clock();
      if (error instanceof WriteLockedError || !stillValid) throw error;
      this.reportError("토큰 갱신에 실패해 아직 유효한 기존 토큰을 계속 씁니다", error);
      return credential.accessToken;
    }
  }

  /** 진행 중인 갱신이 있으면 그 결과를 함께 기다린다. refresh token이 일회용이라 두 번 쓰면 안 된다. */
  private refreshOnce(credential: StoredCredential): Promise<string> {
    this.inFlight ??= this.refresh(credential).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** 갱신 → 저장 → 반환. 저장 실패는 복구할 수 없으므로 잠근다. */
  private async refresh(credential: StoredCredential): Promise<string> {
    const tokens = await this.requestRefresh(credential.refreshToken);
    const renewed: StoredCredential = {
      channelId: credential.channelId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: this.options.clock() + tokens.expiresInSeconds * 1000,
    };
    this.saveOrLock(renewed);
    return renewed.accessToken;
  }

  /** 치지직에 갱신을 요청한다. 401이면 refresh token이 무효이므로 잠근다. 그 밖의 오류는 호출자에게 넘긴다. */
  private async requestRefresh(refreshToken: string): Promise<TokenSet> {
    try {
      return await this.options.api.refreshToken(refreshToken);
    } catch (error) {
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

  /**
   * 잠금 상태를 바꾸고, 바뀌었을 때만 알린다.
   * 리스너 하나가 던져도 나머지 리스너와 원래 던질 WriteLockedError가 살아남도록 각각 격리한다.
   * 삼킨 리스너 오류는 reportError로 기록해 조용히 사라지지 않게 한다.
   */
  private setLocked(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    for (const listener of this.listeners) {
      try {
        listener(locked);
      } catch (error) {
        this.reportError("토큰 잠금 상태 리스너가 실패했습니다", error);
      }
    }
  }
}
