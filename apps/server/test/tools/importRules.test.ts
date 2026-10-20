import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { ImportRulesError, runImportRulesCommand } from "../../src/tools/importRules.js";

const temporaryDirectories: string[] = [];
const secretPatterns = ["비공개예시가", "비공개예시나"];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "zzirit-guard-import-rules-"));
  temporaryDirectories.push(directory);
  const dbPath = join(directory, "rules.sqlite");
  const rulesPath = join(directory, "rules.tsv");
  const content = secretPatterns.map((pattern) => `critical\t${pattern}`).join("\n") + "\n";
  writeFileSync(rulesPath, content);
  const database = openDatabase(dbPath);
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
  database.close();
  return { dbPath, rulesPath, hash: createHash("sha256").update(readFileSync(rulesPath)).digest("hex") };
}

function rows(dbPath: string) {
  const database = openDatabase(dbPath);
  const result = database.prepare("SELECT id, kind, pattern, created_by FROM rule_entry ORDER BY id").all();
  database.close();
  return result;
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("importRules", () => {
  it("해시가 다르면 DB를 열거나 바꾸지 않는다", () => {
    const { dbPath, rulesPath } = fixture();
    const before = readFileSync(dbPath);
    expect(() => runImportRulesCommand(["--db", dbPath, "--channel", "c1", "--rules", rulesPath, "--expected-sha256", "0".repeat(64)], () => undefined)).toThrow(ImportRulesError);
    expect(readFileSync(dbPath)).toEqual(before);
  });

  it("해시가 다르면 지정한 DB 파일이 없어도 새로 만들지 않는다", () => {
    const { rulesPath } = fixture();
    const missingDb = join(temporaryDirectories.at(-1) as string, "missing.sqlite");
    expect(() => runImportRulesCommand(["--db", missingDb, "--channel", "c1", "--rules", rulesPath, "--expected-sha256", "0".repeat(64)], () => undefined)).toThrow(ImportRulesError);
    expect(existsSync(missingDb)).toBe(false);
  });

  it("새 규칙을 넣고 두 번 실행해도 번호와 결과가 같다", () => {
    const { dbPath, rulesPath, hash } = fixture();
    const output: string[] = [];
    runImportRulesCommand(["--db", dbPath, "--channel", "c1", "--rules", rulesPath, "--expected-sha256", hash], (line) => output.push(line));
    const first = rows(dbPath);
    runImportRulesCommand(["--db", dbPath, "--channel", "c1", "--rules", rulesPath, "--expected-sha256", hash], (line) => output.push(line));
    expect(rows(dbPath)).toEqual(first);
    expect(first).toEqual([
      { id: 1, kind: "critical", pattern: secretPatterns[0], created_by: "import" },
      { id: 2, kind: "critical", pattern: secretPatterns[1], created_by: "import" },
    ]);
    expect(output).toEqual(["새로 넣음 2, 바꿈 0, 이미 있음 0", "새로 넣음 0, 바꿈 0, 이미 있음 2"]);
  });

  it("같은 키워드 경로는 번호를 유지해 critical로 바꾼다", () => {
    const { dbPath, rulesPath, hash } = fixture();
    const database = openDatabase(dbPath);
    database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', 'keyword_route', ?, 'manager', 0)").run(secretPatterns[0]);
    database.close();
    runImportRulesCommand(["--db", dbPath, "--channel", "c1", "--rules", rulesPath, "--expected-sha256", hash], () => undefined);
    expect(rows(dbPath)).toEqual([
      { id: 1, kind: "critical", pattern: secretPatterns[0], created_by: "import" },
      { id: 2, kind: "critical", pattern: secretPatterns[1], created_by: "import" },
    ]);
  });

  it("없는 채널은 오류이고 어떤 규칙도 넣지 않는다", () => {
    const { dbPath, rulesPath, hash } = fixture();
    expect(() => runImportRulesCommand(["--db", dbPath, "--channel", "missing", "--rules", rulesPath, "--expected-sha256", hash], () => undefined)).toThrow(/채널/);
    expect(rows(dbPath)).toEqual([]);
  });

  it("중간 DB 오류가 나면 앞서 넣은 규칙도 롤백한다", () => {
    const { dbPath, rulesPath, hash } = fixture();
    const database = openDatabase(dbPath);
    database.exec("CREATE TRIGGER fail_second_import BEFORE INSERT ON rule_entry WHEN (SELECT COUNT(*) FROM rule_entry) = 1 BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    database.close();
    expect(() => runImportRulesCommand(["--db", dbPath, "--channel", "c1", "--rules", rulesPath, "--expected-sha256", hash], () => undefined)).toThrow(ImportRulesError);
    expect(rows(dbPath)).toEqual([]);
  });

  it("출력과 모든 검증·DB 오류에 규칙 문구를 쓰지 않는다", () => {
    const { dbPath, rulesPath, hash } = fixture();
    const outputs: string[] = [];
    runImportRulesCommand(["--db", dbPath, "--channel", "c1", "--rules", rulesPath, "--expected-sha256", hash], (line) => outputs.push(line));
    expect(outputs.join("\n")).not.toContain(secretPatterns[0]);

    writeFileSync(rulesPath, `critical\t${secretPatterns[0]}\ncritical\t${secretPatterns[0]}!\n`);
    const duplicateHash = createHash("sha256").update(readFileSync(rulesPath)).digest("hex");
    let message = "";
    try {
      runImportRulesCommand(["--db", dbPath, "--channel", "c1", "--rules", rulesPath, "--expected-sha256", duplicateHash], () => undefined);
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(secretPatterns[0]);
  });

  it.each([
    ["critical\t문구\t추가\n", /탭/],
    ["keyword_route\t문구\n", /critical만/],
    ["critical\t!!!\n", /빈 문구/],
    [`critical\t${"가".repeat(51)}\n`, /50자/],
    ["# 설명\n\ncritical\t문 구\ncritical\t문구!\n", /정규화 중복/],
  ])("TSV 형식 오류를 원문 없이 거부한다", (content, expected) => {
    const { dbPath, rulesPath } = fixture();
    writeFileSync(rulesPath, content);
    const hash = createHash("sha256").update(readFileSync(rulesPath)).digest("hex");
    let message = "";
    try {
      runImportRulesCommand(["--db", dbPath, "--channel", "c1", "--rules", rulesPath, "--expected-sha256", hash], () => undefined);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(expected);
    expect(message).not.toContain("문구\t추가");
    expect(rows(dbPath)).toEqual([]);
  });
});
