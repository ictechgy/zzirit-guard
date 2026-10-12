import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
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
/** 백업 작성 중 임시 파일 접미사. BACKUP_PATTERN에 맞지 않아 정리 대상이 되지 않는다. */
const PARTIAL_SUFFIX = ".partial";
/** 이전 실행이 죽어 남은 임시 백업 파일 이름. 이 형식만 지워, 같은 디렉터리의 다른 파일은 건드리지 않는다. */
const STALE_PARTIAL_PATTERN = /^zzirit-guard-\d{8}-\d{6}\.sqlite\.partial$/;
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
 * 지운 뒤 WAL을 체크포인트하고 0바이트로 줄인다. 왜: WAL 모드에서는 지우기 전 페이지(원문 포함)가 WAL 파일에 남아 있어,
 * secure_delete만으로는 파기가 끝나지 않는다(F5). 읽는 쪽이 있어 다 비우지 못하면 다음 날 실행에서 다시 시도된다.
 * @returns 종류별로 지운 행 수
 */
export function runRetention(deps: RetentionDeps): RetentionResult {
  try {
    return deleteExpiredRecords(deps);
  } finally {
    // 앞 단계가 던져도 이미 지운 원문 페이지가 WAL에 남지 않게 체크포인트는 반드시 돈다(S8, M07).
    deps.database.pragma("wal_checkpoint(TRUNCATE)");
  }
}

/**
 * 종류별로 보관 기한이 지난 행을 지운다. 체크포인트는 호출자(runRetention)가 finally에서 한다.
 * @returns 종류별로 지운 행 수
 */
function deleteExpiredRecords(deps: RetentionDeps): RetentionResult {
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
 * 설정 행들 중 올바른 값(1 이상 정수) 가운데 가장 짧은 보관 기간을 읽는다. 올바른 값이 없으면 스펙 기본값을 쓴다.
 * 왜 MIN인가: 채널을 바꿔도 이전 채널의 설정 행이 남는데 삭제는 채널과 무관하게 전역으로 이뤄진다.
 * 첫 행이나 임의의 행을 쓰면 이전 채널의 더 긴 기간이 적용될 수 있어, 개인정보 보호를 위해 가장 엄격한 설정이 이기게 한다.
 * 왜 잘못된 값을 거르나: 쓰기 경로는 1~365로 검증하지만 DB에 CHECK가 없어, 0·음수가 들어가면 모든 기록이 지워진다(S8, X26).
 */
function readRetentionDays(database: Database): { content: number; audit: number } {
  const rows = database.prepare("SELECT retention_days_content AS content, retention_days_audit AS audit FROM setting").all() as Array<{ content: unknown; audit: unknown }>;
  return {
    content: shortestValidDays(rows.map((row) => row.content), DEFAULT_RETENTION.content),
    audit: shortestValidDays(rows.map((row) => row.audit), DEFAULT_RETENTION.audit),
  };
}

/**
 * 보관 기간 값들 중 1 이상 정수만 골라 가장 짧은 것을 돌려준다. 하나도 없으면 기본값.
 * @param values DB에서 읽은 값들(타입을 믿지 않는다)
 * @param fallback 올바른 값이 없을 때 쓸 기본값(스펙 9장)
 */
function shortestValidDays(values: readonly unknown[], fallback: number): number {
  const validDays = values.filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1);
  return validDays.length === 0 ? fallback : Math.min(...validDays);
}

/**
 * SQLite 온라인 백업을 만들고 오래된 것을 지운다. 백업에는 암호화된 토큰과 30일 이내 원문이 들어 있어
 * FileVault로 보호되는 데이터 디렉터리 아래에만 둔다.
 * 디렉터리와 파일 권한을 소유자 전용으로 좁히는 이유는 같은 기기의 다른 사용자가 원문과 토큰을 읽지 못하게 하려는 것이다.
 * 임시 이름으로 쓰고 끝나면 이름을 바꾸는 이유는, 중간에 실패한 부분 파일이 최신 백업으로 잘못 세지거나
 * 정리 때 좋은 백업을 밀어내지 않게 하려는 것이다.
 * @param database 백업할 서버 SQLite 연결
 * @param backupDirectory 백업을 둘 디렉터리. 없으면 만든다
 * @param clock 파일 이름에 넣을 시각을 정하는 시계
 * @param keep 남길 백업 개수. 0 이하여도 방금 만든 백업 1개는 남긴다
 * @returns 만든 백업 파일 경로
 */
export async function runBackup(database: Database, backupDirectory: string, clock: Clock, keep = DEFAULT_BACKUP_KEEP): Promise<string> {
  prepareBackupDirectory(backupDirectory);
  removeStalePartials(backupDirectory);
  const finalPath = join(backupDirectory, `zzirit-guard-${formatTimestamp(clock())}.sqlite`);
  await writeBackupFile(database, finalPath);
  pruneBackups(backupDirectory, Math.max(1, keep), finalPath);
  return finalPath;
}

/**
 * 임시 파일에 백업을 쓰고 권한을 맞춘 뒤 최종 이름으로 바꾼다. 실패하면 임시 파일을 지우고 원래 오류를 그대로 던진다.
 * 임시 이름은 BACKUP_PATTERN과 겹치지 않아, 정리 로직이 미완성 파일을 백업으로 세지 않는다.
 */
async function writeBackupFile(database: Database, finalPath: string): Promise<void> {
  const partialPath = `${finalPath}${PARTIAL_SUFFIX}`;
  try {
    await database.backup(partialPath);
    // umask에 따라 넓게 열릴 수 있으므로 이름을 바꾸기 전에 소유자 전용으로 고친다.
    chmodSync(partialPath, BACKUP_FILE_MODE);
    renameSync(partialPath, finalPath);
  } catch (error) {
    rmSync(partialPath, { force: true });
    throw error;
  }
}

/**
 * 백업 디렉터리를 만들고 권한을 소유자 전용으로 맞춘다.
 * mkdir의 mode는 새로 만들 때만 적용되므로, 이미 0755로 있던 디렉터리는 chmod로 다시 좁힌다.
 */
function prepareBackupDirectory(backupDirectory: string): void {
  mkdirSync(backupDirectory, { recursive: true, mode: BACKUP_DIRECTORY_MODE });
  chmodSync(backupDirectory, BACKUP_DIRECTORY_MODE);
}

/**
 * 이전 실행이 백업 도중 죽어 남긴 임시 파일을 지운다.
 * 왜: 임시 파일에도 원문이 들어 있는데 BACKUP_PATTERN에 맞지 않아 보존 개수 정리에 걸리지 않으므로, 그대로 두면 보관 기한 없이 남는다(F5).
 * @param backupDirectory 백업 디렉터리
 */
function removeStalePartials(backupDirectory: string): void {
  readdirSync(backupDirectory)
    .filter((name) => STALE_PARTIAL_PATTERN.test(name))
    .forEach((name) => rmSync(join(backupDirectory, name), { force: true }));
}

/** UTC 기준 YYYYMMDD-HHmmss. */
function formatTimestamp(timestampMs: number): string {
  const iso = new Date(timestampMs).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

/**
 * 백업 파일 중 최신 keep개만 남긴다. 형식이 다른 파일은 건드리지 않는다.
 * 방금 만든 백업(keepPath)은 시각이 더 미래인 파일이 있어도 지우지 않는다. 시계가 어긋나면 새 백업이 가장 오래된 것으로 보일 수 있기 때문이다.
 */
function pruneBackups(backupDirectory: string, keep: number, keepPath: string): void {
  const keepName = basename(keepPath);
  const backups = readdirSync(backupDirectory).filter((name) => BACKUP_PATTERN.test(name)).sort();
  backups
    .slice(0, Math.max(0, backups.length - keep))
    .filter((name) => name !== keepName)
    .forEach((name) => rmSync(join(backupDirectory, name)));
}
