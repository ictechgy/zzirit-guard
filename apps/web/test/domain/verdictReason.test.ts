import { describe, expect, it } from "vitest";
import { describeReason, ruleIdOf } from "../../src/domain/verdictReason";

describe("describeReason", () => {
  it.each([
    ["rule:strong:12", "금칙어 강 #12"],
    ["rule:strong_spanning:3", "금칙어 강(띄어 쓰거나 단어를 걸침) #3"],
    ["rule:weak:7:privileged", "금칙어 약 #7 · 스트리머·매니저 메시지라 후보로 낮춤"],
    ["rule:group_flood", "떼도배"],
    ["rule:group_flood:privileged", "떼도배 · 스트리머·매니저 메시지라 후보로 낮춤"],
    ["rule:watch_user", "요주의 사용자(최근 180일 조치 이력)"],
    ["rule:link_glued", "광고 링크 의심(허용 주소 앞에 한글이 붙어 다른 주소일 수 있음)"],
    ["rule:link_idn", "한글 주소(후보)"],
    ["rule:link_port", "포트가 붙은 주소(후보)"],
    ["rule:spam:41", "광고 낱말 #41"],
    ["rule:critical:42", "바로 후보 #42"],
    ["rule:strong:12:unknown_role", "금칙어 강 #12 · 보낸 사람의 역할을 알 수 없어 후보로 낮춤"],
    ["rule:link:unknown_role", "광고 링크 · 보낸 사람의 역할을 알 수 없어 후보로 낮춤"],
    ["model:kanana", "model:kanana"],
    ["rule:toString", "rule:toString"],
  ])("%s → %s", (reason, expected) => {
    expect(describeReason(reason)).toBe(expected);
  });

  it("규칙 번호를 꺼낸다", () => {
    expect([ruleIdOf("rule:strong:12"), ruleIdOf("rule:weak:7:privileged"), ruleIdOf("rule:link"), ruleIdOf("model:x"), ruleIdOf("rule:strong:3:unknown_role")]).toEqual([12, 7, null, null, 3]);
  });
});

describe("describeReason AI 판정(로드맵 2단계)", () => {
  it.each([
    ["ai:S1", "AI · 증오(S1)"],
    ["ai:S2", "AI · 괴롭힘(S2)"],
    ["ai:S6", "AI · 자살·자해(S6)"],
    ["ai:S7", "AI · 잘못된 정보(S7)"],
  ])("%s → %s", (reason, expected) => {
    expect(describeReason(reason)).toBe(expected);
  });

  it("모르는 AI 범주와 프로토타입 이름은 원문 그대로 보여 준다", () => {
    expect(describeReason("ai:S9")).toBe("ai:S9");
    expect(describeReason("ai:toString")).toBe("ai:toString");
    expect(ruleIdOf("ai:S2")).toBeNull();
  });
});
