import { ChzzkApiError, type ChzzkApi, type TokenSet } from "../chzzk/apiClient.js";
import type { Clock } from "../time.js";
import type { ConnectedChannel, CredentialStore, StoredCredential } from "./credentialStore.js";

/** 쓰기를 할 수 없는 상태. 메시지는 매니저 화면에 그대로 보여 줄 수 있게 쓴다. */
export class WriteLockedError extends Error {
  override readonly name = "WriteLockedError";
}

/** 스트리머 토큰을 꺼내 주고, 만료 전에 갱신하며, 갱신이 불가능하면 쓰기를 잠근다. */
export interface TokenManager {
  getAccessToken(): Promise<string>;
  forceRefresh(): Promise<string>;
  isWriteLocked(): boolean;
  accessExpiresAt(): number | null;
  adoptCredential(channel: ConnectedChannel, credential: StoredCredential): void;
  disconnect(): void;
  onLockChange(listener: (locked: boolean) => void): void;
}

/** createTokenManager 옵션. */
export interface TokenManagerOptions {
  store: CredentialStore;
  api: ChzzkApi;
  clock: Clock;
  refreshMarginMs?: number;
}

/** 기본 선제 갱신 여유: 만료 2시간 전(스펙 4장). */
const DEFAULT_REFRESH_MARGIN_MS = 2 * 60 * 60 * 1000;

/** TokenManager를 만든다. */
export function createTokenManager(options: TokenManagerOptions): TokenManager {
  return new RefreshingTokenManager(options);
}

/** 단일 갱신(single-flight)과 쓰기 잠금을 구현한다. */
class RefreshingTokenManager implements TokenManager {
  private locked = false;
  private inFlight: Promise<string> | null = null;
  private readonly listeners: Array<(locked: boolean) => void> = [];
  private readonly marginMs: number;

  constructor(private readonly options: TokenManagerOptions) {
    this.marginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
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

  isWriteLocked(): boolean {
    return this.locked;
  }

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

  onLockChange(listener: (locked: boolean) => void): void {
    this.listeners.push(listener);
  }

  /** 잠겨 있거나 연결이 없으면 이유를 담아 예외를 던진다. */
  private requireCredential(): StoredCredential {
    const credential = this.options.store.loadCredential();
    if (!credential) throw new WriteLockedError("치지직 채널이 연결되어 있지 않습니다. 스트리머가 먼저 연결하세요.");
    if (this.locked) throw new WriteLockedError("치지직 토큰을 갱신할 수 없어 쓰기를 멈췄습니다. 스트리머가 다시 연결해야 합니다.");
    return credential;
  }

  /** 갱신을 시도하되, 일시 오류이고 토큰이 아직 유효하면 기존 토큰을 쓴다. */
  private async refreshKeepingValidToken(credential: StoredCredential): Promise<string> {
    try {
      return await this.refreshOnce(credential);
    } catch (error) {
      const stillValid = credential.accessExpiresAt > this.options.clock();
      if (error instanceof WriteLockedError || !stillValid) throw error;
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

  /** 치지직에 갱신을 요청한다. 401이면 refresh token이 무효이므로 잠근다. */
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

  /** 새 토큰을 저장한다. 실패하면 옛 refresh token도 이미 무효라 잠그고 원인을 알린다. */
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
    this.listeners.forEach((listener) => listener(locked));
  }
}
