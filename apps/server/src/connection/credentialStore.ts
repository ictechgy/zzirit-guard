import type { Database } from "../db/database.js";
import type { TokenCipher } from "../security/tokenCipher.js";
import type { Clock } from "../time.js";

/** 연결된 스트리머 채널. */
export interface ConnectedChannel {
  /** 치지직 채널 식별자. 채팅 수신과 권한 확인의 기준이 된다. */
  channelId: string;
  /** 화면 표시용 채널 이름. */
  channelName: string;
}

/** 복호화된 토큰. accessExpiresAt은 ms 시각이다. 평문이므로 로그에 남기지 않는다. */
export interface StoredCredential {
  /** 토큰이 속한 채널 식별자. */
  channelId: string;
  /** 치지직 API 호출에 쓰는 access token(평문). */
  accessToken: string;
  /** 갱신에 쓰는 refresh token(평문). 일회용이다. */
  refreshToken: string;
  /** access token 만료 시각(ms). */
  accessExpiresAt: number;
}

/**
 * 채널 연결과 토큰을 저장한다. MVP는 채널 1곳만 허용한다.
 * 토큰 행은 암호화해 두고, 읽을 때만 복호화해 호출자에게 평문을 준다.
 */
export interface CredentialStore {
  /** 연결된 채널을 읽는다. 연결이 없으면 null. */
  loadChannel(): ConnectedChannel | null;
  /** 복호화된 토큰을 읽는다. 연결이 없으면 null. */
  loadCredential(): StoredCredential | null;
  /**
   * 채널·기본 설정·토큰을 한 번에 저장한다. 같은 트랜잭션이라 중간에 실패해도 반쯤 저장되지 않는다.
   * @throws Error 다른 채널이 이미 연결되어 있을 때
   */
  saveConnection(channel: ConnectedChannel, credential: StoredCredential): void;
  /** 갱신된 토큰만 교체한다. 채널 정보와 설정은 건드리지 않는다. */
  saveCredential(credential: StoredCredential): void;
  /**
   * 채널을 지운다. 외래키 cascade로 토큰은 함께 지워지지만, 설정·규칙은 상시 보관이라 남긴다(스펙 11장).
   * 자동 숨김 스위치는 끈다. 다시 연결했을 때 예전 스위치 상태로 곧바로 숨기기 시작하지 않게 하려는 것이다.
   */
  clearConnection(): void;
}

/** credential 테이블 행. 토큰 값은 암호문(v1 형식) 그대로 들어 있다. */
interface CredentialRow {
  /** 연결된 채널 식별자(channel 테이블 참조). */
  channel_id: string;
  /** 암호화된 access token. */
  access_token_enc: string;
  /** 암호화된 refresh token. */
  refresh_token_enc: string;
  /** access token 만료 시각(ms). */
  access_expires_at: number;
}

/** SQLite 기반 CredentialStore를 만든다. 토큰은 저장 전에 암호화한다. */
export function createCredentialStore(database: Database, cipher: TokenCipher, clock: Clock): CredentialStore {
  return {
    loadChannel: () => loadChannel(database),
    loadCredential: () => loadCredential(database, cipher),
    saveConnection: (channel, credential) => database.transaction(() => saveConnection(database, cipher, clock, channel, credential))(),
    saveCredential: (credential) => writeCredential(database, cipher, clock, credential),
    clearConnection: () => database.transaction(() => clearConnection(database))(),
  };
}

/** 스위치를 끄고 채널 행을 지운다(토큰은 cascade). 설정·규칙 행은 그대로 둔다. */
function clearConnection(database: Database): void {
  const channel = loadChannel(database);
  if (channel) database.prepare("UPDATE setting SET auto_hide_enabled = 0 WHERE channel_id = ?").run(channel.channelId);
  database.prepare("DELETE FROM channel").run();
}

/** 연결된 채널을 읽는다(없으면 null). */
function loadChannel(database: Database): ConnectedChannel | null {
  const row = database.prepare("SELECT channel_id, channel_name FROM channel LIMIT 1").get() as
    | { channel_id: string; channel_name: string }
    | undefined;
  return row ? { channelId: row.channel_id, channelName: row.channel_name } : null;
}

/** 토큰을 복호화해 읽는다(없으면 null). */
function loadCredential(database: Database, cipher: TokenCipher): StoredCredential | null {
  const row = database.prepare("SELECT * FROM credential LIMIT 1").get() as CredentialRow | undefined;
  if (!row) return null;
  return {
    channelId: row.channel_id,
    accessToken: cipher.decrypt(row.access_token_enc),
    refreshToken: cipher.decrypt(row.refresh_token_enc),
    accessExpiresAt: row.access_expires_at,
  };
}

/** 채널·기본 설정·토큰을 한 번에 저장한다. 다른 채널이 이미 있으면 거부한다. */
function saveConnection(database: Database, cipher: TokenCipher, clock: Clock, channel: ConnectedChannel, credential: StoredCredential): void {
  const existing = loadChannel(database);
  if (existing && existing.channelId !== channel.channelId) {
    throw new Error(`이미 다른 채널(${existing.channelName})이 연결되어 있습니다. 먼저 연결을 해제하세요.`);
  }
  database
    .prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES (?, ?, ?) ON CONFLICT (channel_id) DO UPDATE SET channel_name = excluded.channel_name")
    .run(channel.channelId, channel.channelName, clock());
  database.prepare("INSERT OR IGNORE INTO setting (channel_id) VALUES (?)").run(channel.channelId);
  writeCredential(database, cipher, clock, credential);
}

/** 토큰 행을 쓴다(있으면 교체). */
function writeCredential(database: Database, cipher: TokenCipher, clock: Clock, credential: StoredCredential): void {
  database
    .prepare(
      `INSERT INTO credential (channel_id, access_token_enc, refresh_token_enc, access_expires_at, refreshed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (channel_id) DO UPDATE SET access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
       access_expires_at = excluded.access_expires_at, refreshed_at = excluded.refreshed_at`,
    )
    .run(credential.channelId, cipher.encrypt(credential.accessToken), cipher.encrypt(credential.refreshToken), credential.accessExpiresAt, clock());
}
