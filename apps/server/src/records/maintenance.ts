import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../db/database.js";
import type { SessionStore } from "../managers/sessionStore.js";
import type { Clock } from "../time.js";
import type { AuditLog } from "./auditLog.js";
import type { VerdictRepository } from "./verdictRepository.js";

/** 보관 기한 정리 결과(지운 행 수). */
export interface RetentionResult {
  verdicts: number;
  audits: number;
  stats: number;
  sessions: number;
}

/** runRetention 의존성. */
export interface RetentionDeps {
  database: Database;
  verdicts: VerdictRepository;
  auditLog: AuditLog;
  sessions: SessionStore;
  clock: Clock;
}

/** 하루(ms). */
const DAY_MS = 24 * 60 * 60 * 1000;
/** 설정 행이 없을 때의 기본 보관 기간(스펙 9장). */
const DEFAULT_RETENTION = { content: 30, audit: 180 };
/** 남길 백업 개수 기본값(스펙 10장). */
const DEFAULT_BACKUP_KEEP = 7;
/** 백업 파일 이름 형식. 이름순 정렬이 곧 시간순이 되게 한다. */
const BACKUP_PATTERN = /^zzirit-guard-\d{8}-\d{6}\.sqlite$/;
/**
 * 백업 디렉터리 권한(소유자만 접근). 백업에는 암호화된 토큰과 원문이 들어 있어
 * 같은 기기의 다른 사용자가 읽지 못하게 한다.
 */
const BACKUP_DIRECTORY_MODE = 0o700;
/** 백업 파일 권한(소유자만 읽기·쓰기). 이유는 BACKUP_DIRECTORY_MODE와 같다. */
const BACKUP_FILE_MODE = 0o600;

/**
 * 보관 기한이 지난 기록을 지운다(매일 실행).
 * 판정 원문은 content 기간, 감사 기록과 분당 통계는 audit 기간을 따른다.
 * @returns 종류별로 지운 행 수
 */
export function runRetention(deps: RetentionDeps): RetentionResult {
  const now = deps.clock();
  const days = readRetentionDays(deps.database);
  const auditCutoff = now - days.audit * DAY_MS;
  return {
    verdicts: deps.verdicts.deleteOlderThan(now - days.content * DAY_MS),
    audits: deps.auditLog.deleteOlderThan(auditCutoff),
    stats: deps.database.prepare("DELETE FROM minute_stat WHERE minute < ?").run(auditCutoff).changes,
    sessions: deps.sessions.deleteExpired(),
  };
}

/**
 * 채널 설정의 보관 기간을 읽는다. 채널 설정이 없으면 스펙 기본값을 쓴다.
 * MVP는 채널 1곳이라 첫 행만 읽는다.
 */
function readRetentionDays(database: Database): { content: number; audit: number } {
  const row = database.prepare("SELECT retention_days_content AS content, retention_days_audit AS audit FROM setting LIMIT 1").get() as
    | { content: number; audit: number }
    | undefined;
  return row ?? DEFAULT_RETENTION;
}

/**
 * SQLite 온라인 백업을 만들고 오래된 것을 지운다. 백업에는 암호화된 토큰과 30일 이내 원문이 들어 있어
 * FileVault로 보호되는 데이터 디렉터리 아래에만 둔다.
 * 디렉터리와 파일 권한을 소유자 전용으로 좁히는 이유는 같은 기기의 다른 사용자가 원문과 토큰을 읽지 못하게 하려는 것이다.
 * @param database 백업할 서버 SQLite 연결
 * @param backupDirectory 백업을 둘 디렉터리. 없으면 만든다
 * @param clock 파일 이름에 넣을 시각을 정하는 시계
 * @param keep 남길 백업 개수
 * @returns 만든 백업 파일 경로
 */
export async function runBackup(database: Database, backupDirectory: string, clock: Clock, keep = DEFAULT_BACKUP_KEEP): Promise<string> {
  prepareBackupDirectory(backupDirectory);
  const path = join(backupDirectory, `zzirit-guard-${formatTimestamp(clock())}.sqlite`);
  await database.backup(path);
  // mkdir의 mode는 이미 있는 디렉터리에 적용되지 않고, 백업 파일은 umask에 따라 넓게 열릴 수 있어 명시적으로 고친다.
  chmodSync(path, BACKUP_FILE_MODE);
  pruneBackups(backupDirectory, keep);
  return path;
}

/**
 * 백업 디렉터리를 만들고 권한을 소유자 전용으로 맞춘다.
 * mkdir의 mode는 새로 만들 때만 적용되므로, 이미 0755로 있던 디렉터리는 chmod로 다시 좁힌다.
 */
function prepareBackupDirectory(backupDirectory: string): void {
  mkdirSync(backupDirectory, { recursive: true, mode: BACKUP_DIRECTORY_MODE });
  chmodSync(backupDirectory, BACKUP_DIRECTORY_MODE);
}

/** UTC 기준 YYYYMMDD-HHmmss. */
function formatTimestamp(timestampMs: number): string {
  const iso = new Date(timestampMs).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

/** 백업 파일 중 최신 keep개만 남긴다. 형식이 다른 파일은 건드리지 않는다. */
function pruneBackups(backupDirectory: string, keep: number): void {
  const backups = readdirSync(backupDirectory).filter((name) => BACKUP_PATTERN.test(name)).sort();
  backups.slice(0, Math.max(0, backups.length - keep)).forEach((name) => rmSync(join(backupDirectory, name)));
}
