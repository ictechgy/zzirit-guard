import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoHideSwitch, type AutoHideSwitch } from "../../src/actions/autoHideSwitch.js";
import { openDatabase } from "../../src/db/database.js";
import type { Logger } from "../../src/logger.js";
import { createAuditLog, type AuditLog } from "../../src/records/auditLog.js";
import { createSettingsRepository, type SettingsRepository } from "../../src/records/settingsRepository.js";

let settings: SettingsRepository;
let auditLog: AuditLog;
let autoHide: AutoHideSwitch;
let now = 0;

beforeEach(() => {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
  database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
  settings = createSettingsRepository(database);
  auditLog = createAuditLog(database, () => now);
  autoHide = createAutoHideSwitch({ settings, auditLog, clock: () => now });
});

describe("AutoHideSwitch", () => {
  it("기본값은 꺼짐이고, 켜고 끈 기록을 남긴다", () => {
    const listener = vi.fn();
    autoHide.onChange(listener);
    expect(autoHide.isEnabled("c1")).toBe(false);
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    expect(autoHide.isEnabled("c1")).toBe(true);
    expect(settings.get("c1").autoHideEnabled).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(auditLog.list("c1", 10, null).map((entry) => entry.action)).toEqual(["auto_hide_on:manual"]);
  });

  it("1분 한도를 넘는 순간 스스로 꺼지고 그 건은 막는다", () => {
    settings.update("c1", { breakerPerMinute: 2 });
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    expect([autoHide.tryConsume("c1"), autoHide.tryConsume("c1"), autoHide.tryConsume("c1")]).toEqual([true, true, false]);
    expect(autoHide.isEnabled("c1")).toBe(false);
    expect(auditLog.list("c1", 1, null)[0]).toMatchObject({ action: "auto_hide_off:breaker", actorType: "system" });
  });

  it("1분이 지나면 다시 센다", () => {
    settings.update("c1", { breakerPerMinute: 1 });
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    expect(autoHide.tryConsume("c1")).toBe(true);
    now = 60_001;
    expect(autoHide.tryConsume("c1")).toBe(true);
  });

  it("잘못된 설정값을 거부한다", () => {
    expect(() => settings.update("c1", { breakerPerMinute: 0 })).toThrow(/1~1000/);
    expect(() => settings.update("c1", { retentionDaysContent: 400 })).toThrow(/1~365/);
  });

  it("한 알림 수신자가 던져도 나머지 수신자는 호출되고 설정 변경은 유지된다", () => {
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const isolated = createAutoHideSwitch({ settings, auditLog, clock: () => now, logger });
    const throwing = vi.fn(() => {
      throw new Error("리스너 실패");
    });
    const survivor = vi.fn();
    isolated.onChange(throwing);
    isolated.onChange(survivor);
    expect(() => isolated.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual")).not.toThrow();
    expect(throwing).toHaveBeenCalledWith("c1", true, "manual");
    expect(survivor).toHaveBeenCalledWith("c1", true, "manual");
    expect(isolated.isEnabled("c1")).toBe(true);
    expect(logger.error).toHaveBeenCalledWith("자동 숨김 스위치 알림 처리 실패", { error: "Error: 리스너 실패" });
  });
});
