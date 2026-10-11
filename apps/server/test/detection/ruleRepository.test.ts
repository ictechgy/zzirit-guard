import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { DEFAULT_RULES } from "../../src/detection/defaultRules.js";
import { createRuleRepository, RuleValidationError } from "../../src/detection/ruleRepository.js";

/** 채널 1개가 있는 저장소. */
function createRepository() {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
  return createRuleRepository(database, () => 42);
}

describe("RuleRepository", () => {
  it("추가·조회·삭제한다", () => {
    const repository = createRepository();
    const added = repository.add("c1", "weak", " 씨 발 ", "manager-1");
    expect(added).toMatchObject({ kind: "weak", pattern: "씨 발", createdBy: "manager-1", createdAt: 42 });
    expect(repository.list("c1")).toHaveLength(1);
    expect(repository.remove("c1", added.id)).toBe(true);
    expect(repository.remove("c1", added.id)).toBe(false);
  });

  it("비교용으로 정규화한 패턴을 스냅숏에 담고, 바뀌면 다시 만든다", () => {
    const repository = createRepository();
    repository.add("c1", "weak", "씨 발", "m");
    expect(repository.snapshot("c1").weak.map((rule) => rule.normalizedPattern)).toEqual(["씨발"]);
    repository.add("c1", "allow", "적팀 죽여버려!!", "m");
    repository.add("c1", "allow_domain", "https://www.YouTube.com/", "m");
    const snapshot = repository.snapshot("c1");
    expect(snapshot.allow.has("적팀죽여버려")).toBe(true);
    expect(snapshot.allowDomains).toEqual(["youtube.com"]);
  });

  it("빈 패턴·너무 긴 패턴·중복을 거부한다", () => {
    const repository = createRepository();
    expect(() => repository.add("c1", "weak", "!!!", "m")).toThrow(RuleValidationError);
    expect(() => repository.add("c1", "weak", "가".repeat(51), "m")).toThrow(/50자/);
    repository.add("c1", "weak", "바보", "m");
    expect(() => repository.add("c1", "weak", "바보", "m")).toThrow(/이미 있는/);
  });

  it("기본 규칙을 한 번만 넣는다", () => {
    const repository = createRepository();
    repository.seedDefaults("c1");
    repository.seedDefaults("c1");
    expect(repository.list("c1")).toHaveLength(DEFAULT_RULES.length);
  });
});
