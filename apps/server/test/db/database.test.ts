import BetterSqlite3 from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RuleKind } from "@zzirit-guard/shared";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createRuleRepository } from "../../src/detection/ruleRepository.js";
import { MIGRATIONS, runMigrations } from "../../src/db/migrations.js";

const RULE_KINDS: readonly RuleKind[] = ["strong", "weak", "exception", "allow", "allow_domain", "threat", "keyword_route", "spam", "critical"];

/** 규칙 번호와 종류 간 삽입 위치는 빼고, 같은 종류 안의 상대 순서와 집합만 비교한다. */
function rulesByKind(rules: ReadonlyArray<{ kind: RuleKind; pattern: string }>) {
  return Object.fromEntries(RULE_KINDS.map((kind) => [kind, rules.filter((rule) => rule.kind === kind).map((rule) => [rule.kind, rule.pattern])]));
}

/** v4 출시 시점의 기본 규칙. 현재 DEFAULT_RULES와 독립적으로 이전 DB를 재현한다. */
const V4_DEFAULT_RULES: ReadonlyArray<{ kind: RuleKind; pattern: string }> = [
  ...["니애미", "느금마", "한남충", "김치녀", "틀딱", "짱깨"].map((pattern) => ({ kind: "strong" as const, pattern })),
  ...["씨발", "시발", "ㅅㅂ", "병신", "ㅂㅅ", "개새끼", "홍어"].map((pattern) => ({ kind: "weak" as const, pattern })),
  ...["시발점", "시발택시"].map((pattern) => ({ kind: "exception" as const, pattern })),
  ...["찾아간다", "찾아갈게", "칼들고", "집주소", "신상털"].map((pattern) => ({ kind: "threat" as const, pattern })),
  ...[
    "꽁머니", "첫충", "매충", "먹튀없는", "먹튀검증", "메이저놀이터", "토토사이트", "카지노사이트", "바카라", "파워볼", "리딩방", "급등주",
    "고수익", "부업하실", "부업정보", "부업문의", "재택알바", "고액알바", "당일지급", "무직자", "급전", "상위노출", "팔로워늘려", "시청자늘려",
    "구독자늘려", "맞팔", "맞구독", "계정판매", "대리육성", "현금매입", "가입코드", "가입머니", "0픈톡", "오카방", "텔방", "텔ㄹ", "선입금",
    "레플리카", "실시청자", "실계정", "팔로워패키지", "당일작업", "원금보장", "코인리딩", "저신용", "경험무관", "땡처리", "시세보다싸",
    "픽공유", "대리구매", "무료충전", "당첨되셨", "아이디비번", "비번입력", "기프티콘무료",
  ].map((pattern) => ({ kind: "spam" as const, pattern })),
  { kind: "exception", pattern: "토토로" },
  ...[
    "자살", "자해", "죽고싶", "뒤지고싶", "살기싫", "사라지고싶", "끝내고싶", "극단적선택", "유서", "손목긋", "손목그어", "수면제", "번개탄",
    "투신", "뛰어내리", "죽을생각", "죽는법", "죽어버릴까", "주글생각", "살이유", "그만살", "살생각없", "살자신", "세상그만", "인생그만",
    "생마감", "인생로그아웃", "삶로그아웃", "나없어지면", "사라지는게맞", "약모아", "한강다리", "옥상난간", "다치게했어", "팔에상처",
    "죽여버린", "죽일거", "가만안둬", "가만안둔", "각오해", "밤길조심", "뒤통수조심", "기다려라", "패버린", "때려죽", "묻어버", "테러",
    "폭파", "불질러", "잡으러간", "뒤따라간", "덮친", "뒤조심", "무사하지못", "몸으로배", "사는지알", "혼자다니지마", "편히잘생각",
    "집앞에찾아", "집앞까지", "집앞에서기다", "찾아가서기다", "따라갈거", "따라간다", "실명", "본명", "집주소", "사는곳", "다니는학교",
    "학교어디", "회사어디", "전화번호", "신상공개", "신상뿌", "얼굴공개", "학번", "졸앨", "차번호", "번호판", "본계", "뒷계", "민증",
    "주민번호", "생년월일", "폰번", "카톡아이디", "사원증", "집아는", "주소아는", "공일공", "가슴", "몸매", "엉덩이", "허벅지", "속옷", "팬티",
    "섹시", "섹스", "야한", "야동", "옷벗", "벗어봐", "벗어줘", "벗으면", "모텔", "자고싶", "꼴리", "꼴려", "따먹", "몸보여", "몸보는", "몸전체",
    "몸흔드", "몸한번", "핥", "야하", "뒤태", "안쪽보", "샤워방송", "씻는모습", "성인통화", "어디까지해", "첫날밤", "숙소잡", "단둘이", "만져보고",
    "몸만져", "허리만져", "다리라인",
  ].map((pattern) => ({ kind: "keyword_route" as const, pattern })),
  { kind: "exception", pattern: "가슴이웅장" },
];

describe("openDatabase", () => {
  it("지운 행이 파일에 남지 않게 secure_delete를 켠다(F5)", () => {
    const database = openDatabase(":memory:");
    expect(database.pragma("secure_delete", { simple: true })).toBe(1);
  });

  it("스펙 11장의 테이블을 모두 만든다", () => {
    const database = openDatabase(":memory:");
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual([
      "audit_log", "channel", "credential", "manager_session", "message_hide", "minute_stat", "push_subscription", "rule_entry", "setting", "verdict",
    ]);
  });

  it("마이그레이션을 두 번 실행해도 안전하다", () => {
    const database = openDatabase(":memory:");
    expect(() => runMigrations(database)).not.toThrow();
    expect(database.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
  });

  it("v1 DB를 v2로 올리면 규칙 번호를 그대로 두고 광고 낱말(spam)을 받는다", () => {
    const database = new BetterSqlite3(":memory:");
    database.exec(MIGRATIONS[0] as string);
    database.pragma("user_version = 1");
    const insert = database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', ?, ?, 'test', 0)");
    insert.run("strong", "가");
    insert.run("threat", "나");
    database.prepare("DELETE FROM rule_entry WHERE pattern = '가'").run();
    runMigrations(database);
    expect(database.prepare("SELECT id, kind, pattern FROM rule_entry").all()).toEqual([{ id: 2, kind: "threat", pattern: "나" }]);
    insert.run("spam", "꽁머니");
    expect(database.prepare("SELECT id FROM rule_entry WHERE kind = 'spam'").get()).toEqual({ id: 3 });
    expect(() => insert.run("unknown", "x")).toThrow(/CHECK/);
  });

  it.each([
    ["가장 큰 번호를 지운 뒤", ["가", "나", "다"], ["다"], 4],
    ["모든 규칙을 지운 뒤", ["가", "나"], ["가", "나"], 3],
    ["규칙을 한 번도 넣지 않은 채", [], [], 1],
  ])("v1→v2 마이그레이션은 %s에도 지워진 규칙 번호를 다시 쓰지 않는다", (_label, added, removed, expectedNextId) => {
    const database = new BetterSqlite3(":memory:");
    database.exec(MIGRATIONS[0] as string);
    database.pragma("user_version = 1");
    const insert = database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', ?, ?, 'test', 0)");
    added.forEach((pattern) => insert.run("weak", pattern));
    removed.forEach((pattern) => database.prepare("DELETE FROM rule_entry WHERE pattern = ?").run(pattern));
    runMigrations(database);
    expect(Number(insert.run("spam", "새규칙").lastInsertRowid)).toBe(expectedNextId);
  });

  it("v2 DB를 v3로 올리면 이미 숨긴 메시지(지금 숨김 상태이거나 숨김 성공 감사 기록이 있는 판정)를 숨김 장부로 옮긴다", () => {
    const database = new BetterSqlite3(":memory:");
    MIGRATIONS.slice(0, 2).forEach((statement) => database.exec(statement as string));
    database.pragma("user_version = 2");
    const insertVerdict = database.prepare(
      `INSERT INTO verdict (channel_id, chat_channel_id, message_time, sender_channel_id, sender_nickname, content, decision, reason, status, created_at)
       VALUES ('c1', 'chat', ?, ?, 'n', '원문', 'auto_hide', 'rule', ?, ?)`,
    );
    insertVerdict.run(1, "a", "hidden", 100);
    insertVerdict.run(1, "a", "hidden", 200);
    const restricted = Number(insertVerdict.run(2, "b", "restricted", 300).lastInsertRowid);
    const failed = Number(insertVerdict.run(3, "c", "pending", 400).lastInsertRowid);
    insertVerdict.run(4, "d", "false_positive", 500);
    const insertAudit = database.prepare(
      "INSERT INTO audit_log (channel_id, actor_type, action, verdict_id, result, created_at) VALUES ('c1', 'manager', 'hide', ?, ?, ?)",
    );
    insertAudit.run(restricted, "ok", 900);
    insertAudit.run(failed, "error", 950);
    runMigrations(database);
    expect(database.prepare("SELECT sender_channel_id, message_time, state, updated_at FROM message_hide ORDER BY sender_channel_id").all()).toEqual([
      { sender_channel_id: "a", message_time: 1, state: "hidden", updated_at: 200 },
      { sender_channel_id: "b", message_time: 2, state: "hidden", updated_at: 900 },
    ]);
  });

  it.each([
    [1, ["strong", "threat", "keyword_route", "weak"], ["strong", "keyword_route"], 4, 5],
    [2, ["strong", "threat", "keyword_route", "spam", "weak"], ["strong", "keyword_route", "spam"], 5, 6],
    [3, ["strong", "threat", "keyword_route", "spam", "weak"], ["strong", "keyword_route", "spam"], 5, 6],
  ] as const)("v%d 규칙 표를 v4로 올릴 때 실제 규칙·삭제된 번호·sqlite_sequence를 보존한다", (version, kinds, remainingKinds, expectedSequence, expectedNextId) => {
    const database = new BetterSqlite3(":memory:");
    MIGRATIONS.slice(0, version).forEach((statement) => database.exec(statement as string));
    database.pragma(`user_version = ${version}`);
    const insert = database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', ?, ?, 'test', 0)");
    kinds.forEach((kind, index) => insert.run(kind, `이전규칙${index + 1}`));
    database.prepare("DELETE FROM rule_entry WHERE id = 2").run();
    database.prepare("DELETE FROM rule_entry WHERE id = ?").run(kinds.length);
    expect(database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'rule_entry'").get()).toEqual({ seq: expectedSequence });
    expect(database.prepare("SELECT MAX(id) AS maxId FROM rule_entry").get()).toEqual({ maxId: expectedSequence - 1 });
    runMigrations(database);
    expect(database.prepare("SELECT id, kind FROM rule_entry ORDER BY id").all()).toEqual(remainingKinds.map((kind, index) => ({ id: index === 0 ? 1 : index + 2, kind })));
    expect(database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'rule_entry'").get()).toEqual({ seq: expectedSequence });
    const currentInsert = database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', ?, ?, 'test', 0)");
    expect(Number(currentInsert.run("critical", "핵심낱말").lastInsertRowid)).toBe(expectedNextId);
    expect(() => currentInsert.run("unknown", "x")).toThrow(/CHECK/);
  });

  it.each([1, 2, 3])("v%d 규칙 표가 비었어도 v4 이전은 sqlite_sequence의 지운 번호를 보존한다", (version) => {
    const database = new BetterSqlite3(":memory:");
    MIGRATIONS.slice(0, version).forEach((statement) => database.exec(statement as string));
    database.pragma(`user_version = ${version}`);
    database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', 'strong', '이전규칙', 'test', 0)").run();
    database.prepare("DELETE FROM rule_entry").run();
    expect(database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'rule_entry'").get()).toEqual({ seq: 1 });

    runMigrations(database);

    expect(database.prepare("SELECT COUNT(*) AS count FROM rule_entry").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'rule_entry'").get()).toEqual({ seq: 1 });
    const inserted = database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', 'critical', '새규칙', 'test', 0)").run();
    expect(Number(inserted.lastInsertRowid)).toBe(2);
  });

  it.each([1, 2, 3])("v%d 규칙 표에 삽입 이력이 없어도 v4 이전과 첫 critical 삽입이 안전하다", (version) => {
    const database = new BetterSqlite3(":memory:");
    MIGRATIONS.slice(0, version).forEach((statement) => database.exec(statement as string));
    database.pragma(`user_version = ${version}`);
    expect(database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'rule_entry'").get()).toBeUndefined();

    runMigrations(database);

    expect(database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'rule_entry'").get()).toBeUndefined();
    const inserted = database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', 'critical', '첫규칙', 'test', 0)").run();
    expect(Number(inserted.lastInsertRowid)).toBe(1);
  });

  it.each([0, 1, 2, 3, 4])("버전 %d DB를 현재 스키마로 올린 후 seedDefaults하면 새 DB와 규칙 스냅숏이 같다", (version) => {
    const migrated = new BetterSqlite3(":memory:");
    if (version > 0) MIGRATIONS.slice(0, version).forEach((statement) => migrated.exec(statement as string));
    migrated.pragma(`user_version = ${version}`);
    runMigrations(migrated);
    migrated.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    const fresh = openDatabase(":memory:");
    fresh.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    const migratedRepository = createRuleRepository(migrated, () => 0);
    const freshRepository = createRuleRepository(fresh, () => 0);
    migratedRepository.seedDefaults("c1");
    freshRepository.seedDefaults("c1");
    expect(rulesByKind(migratedRepository.list("c1"))).toEqual(rulesByKind(freshRepository.list("c1")));
    expect(migrated.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(fresh.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
  });

  it("v4 기본 키워드 경로를 번호 그대로 critical로 옮기고 운영자 규칙은 건드리지 않는다", () => {
    const database = new BetterSqlite3(":memory:");
    MIGRATIONS.slice(0, 4).forEach((statement) => database.exec(statement as string));
    database.pragma("user_version = 4");
    const path = fileURLToPath(new URL("../../../../docs/ml/m2-round4-decisions/r1-public.tsv", import.meta.url));
    const patterns = readFileSync(path, "utf8").trim().split("\n").map((line) => line.split("\t")[1] as string);
    const insert = database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES (?, ?, ?, ?, 0)");
    insert.run("c1", "keyword_route", patterns[0], "default");
    insert.run("c1", "keyword_route", patterns[1], "manager");
    insert.run("c2", "critical", patterns[2], "manager");
    insert.run("c2", "keyword_route", patterns[2], "default");
    const ids = database.prepare("SELECT id, channel_id, pattern FROM rule_entry ORDER BY id").all() as Array<{ id: number; channel_id: string; pattern: string }>;

    runMigrations(database);

    expect(database.prepare("SELECT id, channel_id, kind, pattern, created_by FROM rule_entry ORDER BY id").all()).toEqual([
      { ...ids[0], kind: "critical", created_by: "default" },
      { ...ids[1], kind: "keyword_route", created_by: "manager" },
      { ...ids[2], kind: "critical", created_by: "manager" },
    ]);
  });

  it("v4 기본값을 이전한 뒤 seedDefaults를 반복해도 새 DB와 같은 규칙 집합이다", () => {
    const migrated = new BetterSqlite3(":memory:");
    MIGRATIONS.slice(0, 4).forEach((statement) => migrated.exec(statement as string));
    migrated.pragma("user_version = 4");
    migrated.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    const insert = migrated.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', ?, ?, 'default', 0)");
    V4_DEFAULT_RULES.forEach(({ kind, pattern }) => insert.run(kind, pattern));
    runMigrations(migrated);

    const fresh = openDatabase(":memory:");
    fresh.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    const migratedRepository = createRuleRepository(migrated, () => 0);
    const freshRepository = createRuleRepository(fresh, () => 0);
    migratedRepository.seedDefaults("c1");
    migratedRepository.seedDefaults("c1");
    freshRepository.seedDefaults("c1");

    expect(rulesByKind(migratedRepository.list("c1"))).toEqual(rulesByKind(freshRepository.list("c1")));
  });

  it("알 수 없는 규칙 종류를 거부한다", () => {
    const database = openDatabase(":memory:");
    database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    const insertRule = database.prepare(
      "INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', ?, 'x', 'test', 0)",
    );
    expect(() => insertRule.run("unknown")).toThrow(/CHECK/);
    expect(() => insertRule.run("exception")).not.toThrow();
  });

  it("채널을 지우면 토큰(credential)은 함께 지워진다(F3)", () => {
    const database = openDatabase(":memory:");
    database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    database.prepare("INSERT INTO credential (channel_id, access_token_enc, refresh_token_enc, access_expires_at, refreshed_at) VALUES ('c1', 'a', 'r', 0, 0)").run();
    database.prepare("DELETE FROM channel").run();
    expect(database.prepare("SELECT COUNT(*) AS count FROM credential").get()).toEqual({ count: 0 });
  });

  it("채널을 지워도 설정과 규칙은 상시 보관이라 남는다(스펙 11장, F3)", () => {
    const database = openDatabase(":memory:");
    database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('c1', '채널', 0)").run();
    database.prepare("INSERT INTO setting (channel_id) VALUES ('c1')").run();
    database.prepare("INSERT INTO rule_entry (channel_id, kind, pattern, created_by, created_at) VALUES ('c1', 'strong', 'x', 'test', 0)").run();
    database.prepare("DELETE FROM channel").run();
    expect(database.prepare("SELECT COUNT(*) AS count FROM setting").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM rule_entry").get()).toEqual({ count: 1 });
  });
});
