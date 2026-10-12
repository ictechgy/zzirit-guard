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
    ["model:kanana", "model:kanana"],
    ["rule:toString", "rule:toString"],
  ])("%s → %s", (reason, expected) => {
    expect(describeReason(reason)).toBe(expected);
  });

  it("규칙 번호를 꺼낸다", () => {
    expect([ruleIdOf("rule:strong:12"), ruleIdOf("rule:weak:7:privileged"), ruleIdOf("rule:link"), ruleIdOf("model:x")]).toEqual([12, 7, null, null]);
  });
});
