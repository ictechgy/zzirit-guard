import type { AutoHideOffReason } from "@zzirit-guard/shared";
import type { Database } from "../db/database.js";
import { describeError, type Logger } from "../logger.js";
import type { AuditLog, AuditRecord } from "../records/auditLog.js";
import type { SettingsRepository } from "../records/settingsRepository.js";
import type { Clock } from "../time.js";
import type { Actor } from "./executor.js";

/** 자동 숨김 스위치와 폭주 차단기. */
export interface AutoHideSwitch {
  isEnabled(channelId: string): boolean;
  setEnabled(channelId: string, enabled: boolean, actor: Actor, reason: AutoHideOffReason): void;
  tryConsume(channelId: string): boolean;
  onChange(listener: (channelId: string, enabled: boolean, reason: AutoHideOffReason) => void): void;
}

/** createAutoHideSwitch 의존성. logger를 생략하면 콘솔 경고로 남긴다. */
export interface AutoHideSwitchDeps {
  /**
   * settings·auditLog와 같은 SQLite 연결. 켜기의 설정 변경과 감사 기록을 한 트랜잭션으로 묶으려고 받는다(K3).
   * 왜 같은 연결이어야 하나: better-sqlite3 트랜잭션은 연결 단위라, 다른 연결의 쓰기는 함께 되돌려지지 않는다.
   */
  database: Database;
  settings: SettingsRepository;
  auditLog: AuditLog;
  clock: Clock;
  logger?: Logger;
}

/** 폭주 차단 창(1분). */
const BREAKER_WINDOW_MS = 60_000;
/** 서버 자체 동작을 나타내는 행위자. */
const SYSTEM_ACTOR: Actor = { type: "system", channelId: null };
/**
 * 로거를 생략했을 때 쓰는 기본 기록기. tokenManager와 같이 아직 로거가 연결되지 않은 상태라 콘솔 경고로 남긴다.
 * 모든 레벨을 console.warn으로 보내는 이유는 기본값이 조용히 사라지지 않게 하려는 것이다.
 */
const consoleWarnLogger: Logger = {
  info: (message, details) => console.warn(message, details),
  warn: (message, details) => console.warn(message, details),
  error: (message, details) => console.warn(message, details),
};

/** 스위치를 만든다. 상태는 DB(setting)에 두어 재시작해도 유지한다. */
export function createAutoHideSwitch(deps: AutoHideSwitchDeps): AutoHideSwitch {
  const recentHides = new Map<string, number[]>();
  const listeners: Array<(channelId: string, enabled: boolean, reason: AutoHideOffReason) => void> = [];
  const logger = deps.logger ?? consoleWarnLogger;
  const autoHide: AutoHideSwitch = {
    isEnabled: (channelId) => deps.settings.get(channelId).autoHideEnabled,
    setEnabled(channelId, enabled, actor, reason) {
      if (autoHide.isEnabled(channelId) === enabled) return;
      if (enabled) enableWithAudit(deps, switchAuditRecord(channelId, actor, true, reason));
      else disableThenAudit(deps, logger, switchAuditRecord(channelId, actor, false, reason));
      // 켜고 끌 때마다(한도 트립 포함) 폭주 창을 비운다. 왜: 남겨 두면 1분 안에 다시 켰을 때 꺼지기 전 숨김이 그대로 세져 첫 건에서 바로 다시 꺼진다(S4, X03).
      recentHides.delete(channelId);
      listeners.forEach((listener) => notifyListener(logger, listener, channelId, enabled, reason));
    },
    tryConsume: (channelId) => consumeOrTrip(deps, autoHide, recentHides, channelId),
    onChange: (listener) => void listeners.push(listener),
  };
  return autoHide;
}

/**
 * 켜기: 설정 변경과 감사 기록을 한 DB 트랜잭션으로 쓴다. 둘 중 하나라도 실패하면 모두 되돌려 꺼진 채로 두고 예외를 그대로 던진다(K3).
 * 왜: 설정만 저장되고 기록이 실패하면 요청은 실패로 보이는데 자동 숨김이 실제로 돌아, 매니저가 모르는 숨김이 나간다.
 * @param deps DB·설정·감사 기록
 * @param record 남길 감사 기록(채널 ID가 들어 있다)
 */
function enableWithAudit(deps: AutoHideSwitchDeps, record: AuditRecord): void {
  deps.database.transaction(() => {
    deps.settings.setAutoHide(record.channelId, true);
    deps.auditLog.record(record);
  })();
}

/**
 * 끄기: 설정을 먼저 바꾸고, 감사 기록이 실패해도 되돌리지 않고 오류 로그만 남긴다(K3).
 * 왜: 끄기는 비상 정지 스위치라 언제나 먹혀야 한다. 기록 실패 때문에 자동 숨김이 계속 돌면 안 된다.
 * 설정 변경 자체가 실패하면(설정 행 없음 등) 꺼지지 않은 것이므로 예외를 그대로 던진다.
 * @param deps 설정·감사 기록
 * @param logger 기록 실패를 남길 기록기
 * @param record 남길 감사 기록(채널 ID와 끈 이유가 들어 있다)
 */
function disableThenAudit(deps: AutoHideSwitchDeps, logger: Logger, record: AuditRecord): void {
  deps.settings.setAutoHide(record.channelId, false);
  try {
    deps.auditLog.record(record);
  } catch (error) {
    logger.error("자동 숨김은 껐지만 감사 기록을 남기지 못했습니다. 디스크 공간과 DB 상태를 확인하세요", { action: record.action, error: describeError(error) });
  }
}

/**
 * 스위치 변경 감사 기록 한 줄을 만든다. 켜기·끄기가 같은 형식(auto_hide_on|off:이유)을 쓰게 한 곳에 둔다.
 * @param channelId 채널 ID
 * @param actor 바꾼 주체
 * @param enabled 켰으면 true
 * @param reason 바꾼 이유(manual·breaker·failure_rate)
 */
function switchAuditRecord(channelId: string, actor: Actor, enabled: boolean, reason: AutoHideOffReason): AuditRecord {
  return {
    channelId, actorType: actor.type, actorChannelId: actor.channelId, action: `auto_hide_${enabled ? "on" : "off"}:${reason}`,
    targetSenderChannelId: null, verdictId: null, result: "ok", error: null,
  };
}

/**
 * 알림 수신자 하나를 호출한다. 한 수신자의 예외가 다른 수신자나 setEnabled 호출자에게 번지지 않게 격리한다.
 * 상태 변경과 감사 기록은 이미 끝난 뒤이므로, 알림 실패로 되돌리면 안 된다.
 */
function notifyListener(
  logger: Logger,
  listener: (channelId: string, enabled: boolean, reason: AutoHideOffReason) => void,
  channelId: string,
  enabled: boolean,
  reason: AutoHideOffReason,
): void {
  try {
    listener(channelId, enabled, reason);
  } catch (error) {
    logger.error("자동 숨김 스위치 알림 처리 실패", { error: describeError(error) });
  }
}

/**
 * 자동 숨김 1건을 허락할지 정한다. 1분 동안 한도만큼 이미 숨겼다면 스위치를 끄고 거절한다.
 * 실수로 "ㅋ"를 금칙어에 넣는 사고가 채팅 전체 숨김으로 번지지 않게 하려는 것이다(스펙 5.5).
 */
function consumeOrTrip(deps: AutoHideSwitchDeps, autoHide: AutoHideSwitch, recentHides: Map<string, number[]>, channelId: string): boolean {
  const now = deps.clock();
  const times = (recentHides.get(channelId) ?? []).filter((time) => time > now - BREAKER_WINDOW_MS);
  recentHides.set(channelId, times);
  if (times.length >= deps.settings.get(channelId).breakerPerMinute) {
    autoHide.setEnabled(channelId, false, SYSTEM_ACTOR, "breaker");
    return false;
  }
  times.push(now);
  return true;
}
