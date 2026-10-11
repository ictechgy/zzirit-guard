import type { SettingsDto } from "@zzirit-guard/shared";
import type { Database } from "../db/database.js";

/** 채널 설정과 자동 숨김 스위치 상태. */
export interface ChannelSettings extends SettingsDto {
  autoHideEnabled: boolean;
}

/** 설정 값이 범위를 벗어난 경우. 메시지를 매니저에게 그대로 보여 준다. */
export class SettingsValidationError extends Error {
  override readonly name = "SettingsValidationError";
}

/** setting 테이블 저장소. */
export interface SettingsRepository {
  get(channelId: string): ChannelSettings;
  update(channelId: string, patch: Partial<SettingsDto>): ChannelSettings;
  setAutoHide(channelId: string, enabled: boolean): void;
}

/**
 * 설정별 허용 범위와 DB 열 이름. 열 이름은 이 표에서만 가져와 SQL 문자열 조립을 안전하게 유지한다.
 */
const SETTING_RULES: Record<keyof SettingsDto, { column: string; min: number; max: number }> = {
  breakerPerMinute: { column: "breaker_per_minute", min: 1, max: 1000 },
  retentionDaysContent: { column: "retention_days_content", min: 1, max: 365 },
  retentionDaysAudit: { column: "retention_days_audit", min: 1, max: 365 },
};

/** setting 행. */
interface SettingRow {
  auto_hide_enabled: number;
  breaker_per_minute: number;
  retention_days_content: number;
  retention_days_audit: number;
}

/**
 * 설정 저장소를 만든다.
 * @param database 서버 SQLite 연결
 */
export function createSettingsRepository(database: Database): SettingsRepository {
  return {
    get: (channelId) => readSettings(database, channelId),
    update: (channelId, patch) => {
      // 여러 항목 중 하나라도 범위를 벗어나면 전부 롤백해, 반만 바뀐 설정이 남지 않게 한다.
      database.transaction(() => Object.entries(patch).forEach(([key, value]) => writeSetting(database, channelId, key as keyof SettingsDto, value)))();
      return readSettings(database, channelId);
    },
    setAutoHide: (channelId, enabled) => void database.prepare("UPDATE setting SET auto_hide_enabled = ? WHERE channel_id = ?").run(enabled ? 1 : 0, channelId),
  };
}

/**
 * 설정을 읽는다. 행이 없으면 채널이 연결되지 않은 것이므로 원인과 해결 방향을 담아 던진다.
 * @param database 서버 SQLite 연결
 * @param channelId 채널 ID
 */
function readSettings(database: Database, channelId: string): ChannelSettings {
  const row = database.prepare("SELECT * FROM setting WHERE channel_id = ?").get(channelId) as SettingRow | undefined;
  if (!row) throw new SettingsValidationError("채널 설정이 없습니다. 스트리머가 먼저 채널을 연결하세요.");
  return {
    autoHideEnabled: row.auto_hide_enabled === 1,
    breakerPerMinute: row.breaker_per_minute,
    retentionDaysContent: row.retention_days_content,
    retentionDaysAudit: row.retention_days_audit,
  };
}

/**
 * 범위를 확인한 뒤 설정 한 항목을 쓴다.
 * @param database 서버 SQLite 연결
 * @param channelId 채널 ID
 * @param key 설정 이름
 * @param value 새 값. 정수 여부와 범위를 모두 본다(API 입력은 신뢰하지 않는다).
 */
function writeSetting(database: Database, channelId: string, key: keyof SettingsDto, value: unknown): void {
  // Object.hasOwn으로 확인해야 "constructor" 같은 Object.prototype 키가 규칙으로 잘못 잡히지 않는다.
  const rule = Object.hasOwn(SETTING_RULES, key) ? SETTING_RULES[key] : undefined;
  if (!rule) throw new SettingsValidationError(`알 수 없는 설정입니다: ${String(key)}`);
  if (typeof value !== "number" || !Number.isInteger(value) || value < rule.min || value > rule.max) {
    throw new SettingsValidationError(`${key}는 ${rule.min}~${rule.max} 사이 정수여야 합니다.`);
  }
  database.prepare(`UPDATE setting SET ${rule.column} = ? WHERE channel_id = ?`).run(value, channelId);
}
