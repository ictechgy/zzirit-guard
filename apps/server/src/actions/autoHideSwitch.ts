import type { AutoHideOffReason } from "@zzirit-guard/shared";
import { describeError, type Logger } from "../logger.js";
import type { AuditLog } from "../records/auditLog.js";
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
      deps.settings.setAutoHide(channelId, enabled);
      // 켜고 끌 때마다(한도 트립 포함) 폭주 창을 비운다. 왜: 남겨 두면 1분 안에 다시 켰을 때 꺼지기 전 숨김이 그대로 세져 첫 건에서 바로 다시 꺼진다(S4, X03).
      recentHides.delete(channelId);
      deps.auditLog.record({
        channelId, actorType: actor.type, actorChannelId: actor.channelId, action: `auto_hide_${enabled ? "on" : "off"}:${reason}`,
        targetSenderChannelId: null, verdictId: null, result: "ok", error: null,
      });
      listeners.forEach((listener) => notifyListener(logger, listener, channelId, enabled, reason));
    },
    tryConsume: (channelId) => consumeOrTrip(deps, autoHide, recentHides, channelId),
    onChange: (listener) => void listeners.push(listener),
  };
  return autoHide;
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
