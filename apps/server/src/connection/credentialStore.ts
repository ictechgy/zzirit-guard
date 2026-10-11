import type { Database } from "../db/database.js";
import type { TokenCipher } from "../security/tokenCipher.js";
import type { Clock } from "../time.js";

/** 연결된 스트리머 채널. */
export interface ConnectedChannel {
  channelId: string;
  channelName: string;
}

/** 복호화된 토큰. accessExpiresAt은 ms 시각이다. */
export interface StoredCredential {
  channelId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
}

/** 채널 연결과 토큰을 저장한다. MVP는 채널 1곳만 허용한다. */
export interface CredentialStore {
  loadChannel(): ConnectedChannel | null;
  loadCredential(): StoredCredential | null;
  saveConnection(channel: ConnectedChannel, credential: StoredCredential): void;
  saveCredential(credential: StoredCredential): void;
  clearConnection(): void;
}

/** credential 테이블 행. */
interface CredentialRow {
  channel_id: string;
  access_token_enc: string;
  refresh_token_enc: string;
  access_expires_at: number;
}

/** SQLite 기반 CredentialStore를 만든다. 토큰은 저장 전에 암호화한다. */
export function createCredentialStore(database: Database, cipher: TokenCipher, clock: Clock): CredentialStore {
  return {
    loadChannel: () => loadChannel(database),
    loadCredential: () => loadCredential(database, cipher),
    saveConnection: (channel, credential) => database.transaction(() => saveConnection(database, cipher, clock, channel, credential))(),
    saveCredential: (credential) => writeCredential(database, cipher, clock, credential),
    clearConnection: () => void database.prepare("DELETE FROM channel").run(),
  };
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
