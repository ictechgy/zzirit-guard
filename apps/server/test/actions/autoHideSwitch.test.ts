import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoHideSwitch, type AutoHideSwitch } from "../../src/actions/autoHideSwitch.js";
import { openDatabase, type Database } from "../../src/db/database.js";
import type { Logger } from "../../src/logger.js";
import { createAuditLog, type AuditLog, type AuditRecord } from "../../src/records/auditLog.js";
import { createSettingsRepository, type SettingsRepository } from "../../src/records/settingsRepository.js";

let database: Database;
let settings: SettingsRepository;
let auditLog: AuditLog;
let autoHide: AutoHideSwitch;
let now = 0;

beforeEach(() => {
  database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
  database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
  settings = createSettingsRepository(database);
  auditLog = createAuditLog(database, () => now);
  autoHide = createAutoHideSwitch({ database, settings, auditLog, clock: () => now });
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

  it("한도로 꺼진 뒤 1분 안에 다시 켜도 바로 다시 꺼지지 않는다: 트립과 다시 켜기 때 창을 비운다(S4, X03)", () => {
    now = 1_000_000;
    settings.update("c1", { breakerPerMinute: 2 });
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    expect([autoHide.tryConsume("c1"), autoHide.tryConsume("c1"), autoHide.tryConsume("c1")]).toEqual([true, true, false]);
    expect(autoHide.isEnabled("c1")).toBe(false);
    now += 5_000;
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    expect([autoHide.tryConsume("c1"), autoHide.tryConsume("c1")]).toEqual([true, true]);
    expect(autoHide.isEnabled("c1")).toBe(true);
  });

  it("손으로 껐다 1분 안에 다시 켜도 꺼지기 전 숨김은 새 창에 세지 않는다(S4)", () => {
    now = 2_000_000;
    settings.update("c1", { breakerPerMinute: 2 });
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    expect([autoHide.tryConsume("c1"), autoHide.tryConsume("c1")]).toEqual([true, true]);
    autoHide.setEnabled("c1", false, { type: "manager", channelId: "m1" }, "manual");
    now += 1_000;
    autoHide.setEnabled("c1", true, { type: "manager", channelId: "m1" }, "manual");
    expect(autoHide.tryConsume("c1")).toBe(true);
    expect(autoHide.isEnabled("c1")).toBe(true);
  });

  it("잘못된 설정값을 거부한다", () => {
    expect(() => settings.update("c1", { breakerPerMinute: 0 })).toThrow(/1~1000/);
    expect(() => settings.update("c1", { retentionDaysContent: 400 })).toThrow(/1~365/);
  });

  it("한 알림 수신자가 던져도 나머지 수신자는 호출되고 설정 변경은 유지된다", () => {
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const isolated = createAutoHideSwitch({ database, settings, auditLog, clock: () => now, logger });
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

describe("AutoHideSwitch 감사 기록 실패(K3)", () => {
  /** 매니저 행위자. */
  const MANAGER = { type: "manager" as const, channelId: "m1" };

  /**
   * 감사 기록 저장만 실패시킬 수 있는 기록기로 스위치를 만든다. 나머지는 실제 저장소를 쓴다.
   * @returns 스위치, 실패 스위치(shouldFail), 오류 기록기, 변경 알림 수신자
   */
  function switchWithFlakyAudit() {
    const failure = { shouldFail: false };
    const record = (entry: AuditRecord) => {
      if (failure.shouldFail) throw new Error("disk I/O error");
      auditLog.record(entry);
    };
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const flaky = createAutoHideSwitch({ database, settings, auditLog: { ...auditLog, record }, clock: () => now, logger });
    const listener = vi.fn();
    flaky.onChange(listener);
    return { flaky, failure, logger, listener };
  }

  it("켜기의 감사 기록이 실패하면 켜기도 실패하고 꺼진 채로 남으며, 켜졌다고 알리지 않는다", () => {
    const { flaky, failure, listener } = switchWithFlakyAudit();
    failure.shouldFail = true;
    expect(() => flaky.setEnabled("c1", true, MANAGER, "manual")).toThrow(/disk I\/O error/);
    expect(flaky.isEnabled("c1")).toBe(false);
    expect(settings.get("c1").autoHideEnabled).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it.each(["manual", "breaker"] as const)("끄기(%s)의 감사 기록이 실패해도 꺼진 채로 두고, 이유를 오류 로그로 남기고 꺼졌다고 알린다", (reason) => {
    const { flaky, failure, logger, listener } = switchWithFlakyAudit();
    flaky.setEnabled("c1", true, MANAGER, "manual");
    failure.shouldFail = true;
    expect(() => flaky.setEnabled("c1", false, MANAGER, reason)).not.toThrow();
    expect(flaky.isEnabled("c1")).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("감사 기록"), expect.objectContaining({ action: `auto_hide_off:${reason}`, error: "Error: disk I/O error" }));
    expect(listener).toHaveBeenLastCalledWith("c1", false, reason);
  });
});
