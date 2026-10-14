import type { SettingsDto } from "@zzirit-guard/shared";
import type { Database } from "../db/database.js";
import { silentLogger, type Logger } from "../logger.js";

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

/** 정수 설정(폭주 한도·보관 기간)의 규칙: 열 이름과 허용 범위(양 끝 포함). */
interface IntegerSettingRule {
  kind: "integer";
  column: string;
  min: number;
  max: number;
}

/**
 * 비율 설정(AI 임계값)의 규칙: 열 이름, 허용 범위, 기본값(스펙 11장). 0은 늘 제외하고, 1은 includesOne일 때만 포함한다.
 * 왜 기본값을 두나: DB 값이 깨졌을 때(손으로 고침 등) AI 판정이 조용히 틀어지지 않게, 읽을 때 기본값으로 되돌린다.
 */
interface FractionSettingRule {
  kind: "fraction";
  column: string;
  includesOne: boolean;
  defaultValue: number;
}

/**
 * 설정별 규칙. 열 이름은 이 표에서만 가져와 SQL 문자열 조립을 안전하게 유지한다.
 * 1차 임계값은 모델마다 맞는 값이 달라 운영자가 정한다(재학습한 모델은 0.003~0.03 근처, docs/ml/2026-10-14-stage1-retrain-results.md).
 */
const SETTING_RULES: Record<keyof SettingsDto, IntegerSettingRule | FractionSettingRule> = {
  breakerPerMinute: { kind: "integer", column: "breaker_per_minute", min: 1, max: 1000 },
  retentionDaysContent: { kind: "integer", column: "retention_days_content", min: 1, max: 365 },
  retentionDaysAudit: { kind: "integer", column: "retention_days_audit", min: 1, max: 365 },
  stage1Threshold: { kind: "fraction", column: "stage1_threshold", includesOne: false, defaultValue: 0.05 },
  candidateThreshold: { kind: "fraction", column: "candidate_threshold", includesOne: false, defaultValue: 0.5 },
  sureThreshold: { kind: "fraction", column: "sure_threshold", includesOne: true, defaultValue: 0.99 },
};

/** setting 행. */
interface SettingRow {
  auto_hide_enabled: number;
  breaker_per_minute: number;
  retention_days_content: number;
  retention_days_audit: number;
  stage1_threshold: unknown;
  candidate_threshold: unknown;
  sure_threshold: unknown;
}

/**
 * 설정 저장소를 만든다.
 * @param database 서버 SQLite 연결
 * @param logger 깨진 임계값을 기본값으로 되돌릴 때 경고를 남긴다
 */
export function createSettingsRepository(database: Database, logger: Logger = silentLogger): SettingsRepository {
  return {
    get: (channelId) => readSettings(database, channelId, logger),
    update: (channelId, patch) => {
      // 여러 항목 중 하나라도 범위를 벗어나면 전부 롤백해, 반만 바뀐 설정이 남지 않게 한다. 임계값 사이의 관계도 쓴 뒤에 확인한다.
      database.transaction(() => {
        Object.entries(patch).forEach(([key, value]) => writeSetting(database, channelId, key as keyof SettingsDto, value));
        ensureThresholdOrder(readStoredThresholds(database, channelId));
      })();
      return readSettings(database, channelId, logger);
    },
    setAutoHide: (channelId, enabled) => writeAutoHide(database, channelId, enabled),
  };
}

/**
 * 자동 숨김 스위치 값을 쓴다. 바뀐 행이 없으면(설정 행 없음) 성공으로 넘기지 않고 던진다(S6, C03).
 * 왜: 끄기 요청이 조용히 무시되면 매니저는 껐다고 믿는데 자동 숨김이 계속 나간다. 안전장치의 실패는 드러나야 한다.
 * @param database 서버 SQLite 연결
 * @param channelId 채널 ID
 * @param enabled 켤지 여부
 * @throws SettingsValidationError 이 채널의 설정 행이 없을 때
 */
function writeAutoHide(database: Database, channelId: string, enabled: boolean): void {
  const { changes } = database.prepare("UPDATE setting SET auto_hide_enabled = ? WHERE channel_id = ?").run(enabled ? 1 : 0, channelId);
  if (changes === 0) throw new SettingsValidationError("채널 설정이 없어 자동 숨김 상태를 바꾸지 못했습니다. 스트리머가 채널을 다시 연결하세요.");
}

/**
 * 설정을 읽는다. 행이 없으면 채널이 연결되지 않은 것이므로 원인과 해결 방향을 담아 던진다.
 * AI 임계값이 깨졌으면(범위 밖·숫자 아님·후보 > 확실) 기본값으로 읽고 경고를 남긴다.
 * @param database 서버 SQLite 연결
 * @param channelId 채널 ID
 * @param logger 경고 기록기
 */
function readSettings(database: Database, channelId: string, logger: Logger): ChannelSettings {
  const row = database.prepare("SELECT * FROM setting WHERE channel_id = ?").get(channelId) as SettingRow | undefined;
  if (!row) throw new SettingsValidationError("채널 설정이 없습니다. 스트리머가 먼저 채널을 연결하세요.");
  return {
    autoHideEnabled: row.auto_hide_enabled === 1,
    breakerPerMinute: row.breaker_per_minute,
    retentionDaysContent: row.retention_days_content,
    retentionDaysAudit: row.retention_days_audit,
    ...readThresholds(row, logger),
  };
}

/** 임계값 세 개. */
type Thresholds = Pick<SettingsDto, "stage1Threshold" | "candidateThreshold" | "sureThreshold">;

/**
 * DB의 임계값을 검사해 읽는다. 하나라도 깨졌거나 후보 > 확실이면 그 값(관계가 깨졌으면 두 값)을 기본값으로 바꾸고 경고한다.
 * @param row setting 행
 * @param logger 경고 기록기
 */
function readThresholds(row: SettingRow, logger: Logger): Thresholds {
  const stored: Thresholds = {
    stage1Threshold: storedFraction(row.stage1_threshold, "stage1Threshold", logger),
    candidateThreshold: storedFraction(row.candidate_threshold, "candidateThreshold", logger),
    sureThreshold: storedFraction(row.sure_threshold, "sureThreshold", logger),
  };
  if (stored.candidateThreshold <= stored.sureThreshold) return stored;
  logger.warn("저장된 후보 임계값이 확실 임계값보다 커서 둘 다 기본값으로 씁니다. 설정 화면에서 다시 저장하세요.");
  return { ...stored, candidateThreshold: fractionRule("candidateThreshold").defaultValue, sureThreshold: fractionRule("sureThreshold").defaultValue };
}

/**
 * 저장된 비율 하나를 검사한다. 깨졌으면 기본값과 경고.
 * @param value DB 값
 * @param key 설정 이름
 * @param logger 경고 기록기
 */
function storedFraction(value: unknown, key: keyof Thresholds, logger: Logger): number {
  const rule = fractionRule(key);
  if (isValidFraction(value, rule)) return value;
  logger.warn("저장된 AI 임계값이 범위를 벗어나 기본값으로 씁니다. 설정 화면에서 다시 저장하세요.", { setting: key });
  return rule.defaultValue;
}

/** 비율 설정의 규칙. */
function fractionRule(key: keyof Thresholds): FractionSettingRule {
  return SETTING_RULES[key] as FractionSettingRule;
}

/** 값이 규칙에 맞는 유한한 비율인지: 0보다 크고, 1보다 작다(includesOne이면 1 이하). */
function isValidFraction(value: unknown, rule: FractionSettingRule): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && (rule.includesOne ? value <= 1 : value < 1);
}

/**
 * 쓴 뒤의 임계값을 기본값으로 바꾸지 않고 그대로 읽는다. 관계 검사(ensureThresholdOrder)용이다.
 * 왜 readSettings를 쓰지 않나: readSettings는 깨진 관계를 기본값으로 덮어 읽어, 검사가 잘못된 저장을 통과시킨다.
 * @param database 서버 SQLite 연결
 * @param channelId 채널 ID
 */
function readStoredThresholds(database: Database, channelId: string): Thresholds {
  const row = database.prepare("SELECT stage1_threshold, candidate_threshold, sure_threshold FROM setting WHERE channel_id = ?").get(channelId) as
    | Pick<SettingRow, "stage1_threshold" | "candidate_threshold" | "sure_threshold">
    | undefined;
  if (!row) throw new SettingsValidationError("채널 설정이 없습니다. 스트리머가 먼저 채널을 연결하세요.");
  return { stage1Threshold: Number(row.stage1_threshold), candidateThreshold: Number(row.candidate_threshold), sureThreshold: Number(row.sure_threshold) };
}

/**
 * 후보 임계값이 확실 임계값보다 크면 거부한다(트랜잭션 안에서 불러 전부 롤백한다).
 * @param settings 쓴 뒤의 설정
 */
function ensureThresholdOrder(settings: Thresholds): void {
  if (settings.candidateThreshold > settings.sureThreshold) {
    throw new SettingsValidationError("후보 임계값은 확실 임계값보다 클 수 없습니다.");
  }
}

/**
 * 범위를 확인한 뒤 설정 한 항목을 쓴다.
 * @param database 서버 SQLite 연결
 * @param channelId 채널 ID
 * @param key 설정 이름
 * @param value 새 값. 정수 설정은 정수 여부와 범위를, 비율 설정은 유한한 수와 범위를 본다(API 입력은 신뢰하지 않는다).
 */
function writeSetting(database: Database, channelId: string, key: keyof SettingsDto, value: unknown): void {
  // Object.hasOwn으로 확인해야 "constructor" 같은 Object.prototype 키가 규칙으로 잘못 잡히지 않는다.
  const rule = Object.hasOwn(SETTING_RULES, key) ? SETTING_RULES[key] : undefined;
  if (!rule) throw new SettingsValidationError(`알 수 없는 설정입니다: ${String(key)}`);
  if (rule.kind === "integer" && (typeof value !== "number" || !Number.isInteger(value) || value < rule.min || value > rule.max)) {
    throw new SettingsValidationError(`${key}는 ${rule.min}~${rule.max} 사이 정수여야 합니다.`);
  }
  if (rule.kind === "fraction" && !isValidFraction(value, rule)) {
    throw new SettingsValidationError(`${key}는 0보다 크고 1${rule.includesOne ? " 이하" : "보다 작은"} 수여야 합니다.`);
  }
  database.prepare(`UPDATE setting SET ${rule.column} = ? WHERE channel_id = ?`).run(value, channelId);
}
