import { beforeEach, describe, expect, it } from "vitest";
import type { SettingsDto } from "@zzirit-guard/shared";
import { openDatabase } from "../../src/db/database.js";
import { createSettingsRepository, SettingsValidationError, type SettingsRepository } from "../../src/records/settingsRepository.js";

let settings: SettingsRepository;

beforeEach(() => {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
  database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
  settings = createSettingsRepository(database);
});

/** 검증 실패를 기대하며 설정 변경을 실행한다. 다른 오류(예: SQLite 원시 오류)는 테스트를 실패시킨다. */
function expectValidationError(patch: Record<string, unknown>, messagePattern: RegExp): void {
  let caught: unknown = null;
  try {
    settings.update("c1", patch as Partial<SettingsDto>);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SettingsValidationError);
  expect((caught as Error).message).toMatch(messagePattern);
}

describe("SettingsRepository 값 검증", () => {
  it("알 수 없는 키는 검증 오류로 거부한다", () => {
    expectValidationError({ foo: 5 }, /알 수 없는 설정입니다: foo/);
  });

  it.each(["constructor", "toString", "__proto__"])("Object.prototype 키 %s도 검증 오류로 거부한다", (key) => {
    expectValidationError({ [key]: 5 }, /알 수 없는 설정입니다/);
  });

  it("정수가 아닌 값은 거부한다", () => {
    expectValidationError({ breakerPerMinute: 1.5 }, /1~1000 사이 정수/);
  });

  it("undefined 값은 거부한다", () => {
    expectValidationError({ breakerPerMinute: undefined }, /1~1000 사이 정수/);
  });

  it("범위를 벗어난 값은 거부한다", () => {
    expectValidationError({ breakerPerMinute: 0 }, /1~1000/);
    expectValidationError({ retentionDaysContent: 400 }, /1~365/);
  });

  it("여러 항목 중 하나가 틀리면 전부 롤백해 이전 값을 유지한다", () => {
    expect(() => settings.update("c1", { breakerPerMinute: 10, retentionDaysContent: 400 })).toThrow(SettingsValidationError);
    expect(settings.get("c1").breakerPerMinute).toBe(60);
  });
});
