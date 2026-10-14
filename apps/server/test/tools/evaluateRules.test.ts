import { describe, expect, it } from "vitest";
import { EvaluateRulesArgumentError, evaluateRuleRoutes, parseEvaluationItems, parseKeywordPatterns } from "../../src/tools/evaluateRules.js";

describe("evaluateRuleRoutes", () => {
  it("기본 규칙으로 전화번호는 자동 숨김, 협박은 후보, 일반 문장은 통과로 판정한다", () => {
    const routes = evaluateRuleRoutes([
      { id: "phone", text: "연락 주세요 010-1234-5678" },
      { id: "threat", text: "너 집 앞으로 찾아간다" },
      { id: "normal", text: "오늘 방송 몇 시까지 해요" },
    ]);
    expect(routes.map((route) => [route.id, route.decision])).toEqual([["phone", "auto_hide"], ["threat", "candidate"], ["normal", "pass"]]);
    expect(routes[0]?.reason).toBe("rule:phone");
  });

  it("같은 문장이 반복돼도 서로 다른 사람·시각이라 도배·중복 규칙이 걸리지 않는다", () => {
    const routes = evaluateRuleRoutes(Array.from({ length: 8 }, (_, index) => ({ id: `same-${index}`, text: "오늘 방송 진짜 재밌어요 다들 화이팅" })));
    expect(new Set(routes.map((route) => route.reason))).toEqual(new Set(["none"]));
  });

  it("키워드 경로 패턴은 규칙 판정과 따로 일치 여부를 알려 준다(예외 단어는 지우고 본다)", () => {
    const routes = evaluateRuleRoutes([{ id: "hit", text: "요즘 너무 우울 해서" }, { id: "miss", text: "날씨 좋네요" }], ["우울"]);
    expect(routes[0]?.keyword).not.toBeNull();
    expect(routes[0]?.decision).toBe("pass");
    expect(routes[1]?.keyword).toBeNull();
  });
});

describe("입력 읽기", () => {
  it("평가셋 JSONL에서 id·text만 읽고, 빠지면 줄 번호로 알려 준다", () => {
    expect(parseEvaluationItems('{"id":"a","text":"가","label":"allow"}\n\n{"id":"b","text":"나"}\n')).toEqual([{ id: "a", text: "가" }, { id: "b", text: "나" }]);
    expect(() => parseEvaluationItems('{"id":"a"}\n')).toThrow(EvaluateRulesArgumentError);
    expect(() => parseEvaluationItems('{"id":"a"}\n')).toThrow("1번째 줄");
  });

  it("키워드 목록은 빈 줄과 # 주석을 건너뛴다", () => {
    expect(parseKeywordPatterns("# 자해\n우울\n\n  죽고싶  \n")).toEqual(["우울", "죽고싶"]);
  });
});
