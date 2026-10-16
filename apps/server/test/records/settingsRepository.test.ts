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

describe("SettingsRepository 자동 숨김 스위치(S6, C03)", () => {
  it("설정 행이 없으면 성공으로 넘기지 않고 원인과 해결 방향을 담아 던진다", () => {
    expect(() => settings.setAutoHide("missing-channel", false)).toThrow(SettingsValidationError);
    expect(() => settings.setAutoHide("missing-channel", false)).toThrow(/채널 설정이 없어.*다시 연결/);
  });

  it("설정 행이 있으면 값을 바꾼다", () => {
    settings.setAutoHide("c1", true);
    expect(settings.get("c1").autoHideEnabled).toBe(true);
  });
});

describe("SettingsRepository AI 임계값(로드맵 2단계 계획 R10)", () => {
  it("기본값은 스펙 11장 값이다", () => {
    expect(settings.get("c1")).toMatchObject({
      stage1Threshold: 0.05, candidateThreshold: 0.5, sureThreshold: 0.99,
      stage2Policy: "category", relaxedCandidateThreshold: 0.2,
    });
  });

  it("2차 정책과 완화 기준을 저장하고 다시 읽는다", () => {
    expect(settings.update("c1", { stage2Policy: "keyword_route", relaxedCandidateThreshold: 0.3 })).toMatchObject({
      stage2Policy: "keyword_route", relaxedCandidateThreshold: 0.3,
    });
    expect(settings.get("c1")).toMatchObject({ stage2Policy: "keyword_route", relaxedCandidateThreshold: 0.3 });
  });

  it("알 수 없는 2차 정책과 범위 밖 완화 기준을 거부한다", () => {
    expectValidationError({ stage2Policy: "unknown" }, /stage2Policy/);
    expectValidationError({ relaxedCandidateThreshold: 1 }, /relaxedCandidateThreshold/);
  });

  it("비율은 소수를 받는다(정수 설정의 정수 검사는 그대로다)", () => {
    expect(settings.update("c1", { stage1Threshold: 0.012, candidateThreshold: 0.6, sureThreshold: 1 })).toMatchObject({ stage1Threshold: 0.012, sureThreshold: 1 });
    expectValidationError({ breakerPerMinute: 1.5 }, /정수/);
  });

  it.each([
    [{ stage1Threshold: 0 }, /stage1Threshold/],
    [{ stage1Threshold: 1 }, /stage1Threshold/],
    [{ candidateThreshold: -0.1 }, /candidateThreshold/],
    [{ sureThreshold: 1.01 }, /sureThreshold/],
    [{ stage1Threshold: Number.NaN }, /stage1Threshold/],
    [{ stage1Threshold: "0.1" }, /stage1Threshold/],
  ])("범위 밖·숫자 아님은 거부한다: %o", (patch, pattern) => {
    expectValidationError(patch, pattern);
  });

  it("후보 임계값이 확실 임계값보다 크면 거부하고, 함께 보낸 다른 값도 바꾸지 않는다", () => {
    expectValidationError({ stage1Threshold: 0.2, candidateThreshold: 0.995 }, /확실 임계값/);
    expect(settings.get("c1")).toMatchObject({ stage1Threshold: 0.05, candidateThreshold: 0.5 });
  });
});

describe("SettingsRepository 깨진 임계값 읽기", () => {
  it("DB 값이 범위 밖이면 기본값으로 읽고 경고를 남긴다", () => {
    const database = openDatabase(":memory:");
    database.prepare("INSERT INTO setting (channel_id, stage1_threshold, candidate_threshold, sure_threshold) VALUES ('c1', 7, 0.9, 0.5)").run();
    const warnings: string[] = [];
    const repository = createSettingsRepository(database, { info: () => undefined, warn: (message) => warnings.push(message), error: () => undefined });
    expect(repository.get("c1")).toMatchObject({ stage1Threshold: 0.05, candidateThreshold: 0.5, sureThreshold: 0.99 });
    expect(warnings).toHaveLength(2);
  });
});
