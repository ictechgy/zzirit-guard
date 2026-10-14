import { describe, expect, it } from "vitest";
import {
  EvaluateRulesArgumentError, ensureHoldoutUsesDefaults, evaluateRuleRoutes, parseEvaluationItems, parseKeywordPatterns, type EvaluationItem,
} from "../../src/tools/evaluateRules.js";

/** 개발셋 문장 하나. */
function devItem(id: string, text: string): EvaluationItem {
  return { id, text, split: "dev" };
}

describe("evaluateRuleRoutes", () => {
  it("기본 규칙으로 전화번호는 자동 숨김, 협박은 후보, 일반 문장은 통과로 판정한다", () => {
    const routes = evaluateRuleRoutes([devItem("phone", "연락 주세요 010-1234-5678"), devItem("threat", "너 집 앞으로 찾아간다"), devItem("normal", "오늘 방송 몇 시까지 해요")]);
    expect(routes.map((route) => [route.id, route.decision])).toEqual([["phone", "auto_hide"], ["threat", "candidate"], ["normal", "pass"]]);
    expect(routes[0]?.reason).toBe("rule:phone");
  });

  it("같은 문장이 반복돼도 서로 다른 사람·시각(중복 보관 시간보다 멀리)이라 도배·중복 규칙이 걸리지 않는다", () => {
    const routes = evaluateRuleRoutes(Array.from({ length: 8 }, (_, index) => devItem(`same-${index}`, "오늘 방송 진짜 재밌어요 다들 화이팅")));
    expect(new Set(routes.map((route) => route.reason))).toEqual(new Set(["none"]));
  });

  it("키워드 경로 패턴은 규칙 판정과 따로 일치 여부를 알려 준다", () => {
    const routes = evaluateRuleRoutes([devItem("hit", "요즘 너무 우울 해서"), devItem("miss", "날씨 좋네요")], ["우울"]);
    expect(routes[0]?.keyword).not.toBeNull();
    expect(routes[0]?.decision).toBe("pass");
    expect(routes[1]?.keyword).toBeNull();
  });

  it("가벼운 반응(ㅋㅋ 등)은 AI 단계를 건너뛴다고 표시한다", () => {
    const routes = evaluateRuleRoutes([devItem("laugh", "ㅋㅋㅋㅋㅋ"), devItem("text", "ㅋㅋ 웃기다")]);
    expect(routes.map((route) => route.skipAi)).toEqual([true, false]);
  });

  it("평가셋 해시를 그대로 적고, 규칙 목록 지문은 목록이 같으면 같고 다르면 다르다", () => {
    const base = evaluateRuleRoutes([devItem("a", "가")], [], "abc");
    const same = evaluateRuleRoutes([devItem("b", "나")], [], "def");
    const extra = evaluateRuleRoutes([devItem("a", "가")], ["우울"], "abc");
    expect(base[0]?.evalSha256).toBe("abc");
    expect(base[0]?.policySha256).toBe(same[0]?.policySha256);
    expect(extra[0]?.policySha256).not.toBe(base[0]?.policySha256);
  });
});

describe("기본 목록이 흔한 방송 채팅을 건드리지 않는다", () => {
  it.each([
    "방송 잘 보고 있다", "특정 캐릭터만 가능?", "이 게임 다 끝낼 수 있나", "오늘 이거 끝내려고 함", "버프 없어지면 바로 빼",
    "집 앞 편의점 다녀옴", "동선 좋네", "옥상 파밍 가자", "볼륨 늘려드릴까요?", "본인 인증이 왜 안 돼?", "카지노 하이스트 하자",
    "홀덤 방송 언제 해요", "후원 먹튀 ㅋㅋ", "가슴이 웅장해진다", "여기서 벗어나야 해", "샤워하고 올게요", "오픈채팅방 있어요?",
    "부업으로 유튜브 하세요?", "몇 학년이에요?", "호텔 뷔페 맛있음",
  ])("%s", (text) => {
    const [route] = evaluateRuleRoutes([devItem("normal", text)]);
    expect(route?.keyword).toBeNull();
    expect(route?.reason).not.toMatch(/^rule:spam/);
  });

  it.each(["너네 집 앞에 찾아가서 기다릴게", "집 앞까지 따라갈거임", "퇴근길 따라간다 조심해"])("집 앞·따라가기 협박은 키워드 경로로 간다: %s", (text) => {
    const [route] = evaluateRuleRoutes([devItem("threat", text)]);
    expect(route?.keyword).not.toBeNull();
  });

  it("벗어나 예외가 옷 벗어 요구를 가리지 않는다", () => {
    const [route] = evaluateRuleRoutes([devItem("sexual", "옷 벗어봐 나한테 보여줘")]);
    expect(route?.keyword).not.toBeNull();
  });
});

describe("입력 읽기와 보류셋 보호", () => {
  it("평가셋 JSONL에서 id·text·split을 읽고, 빠지면 줄 번호로 알려 준다", () => {
    expect(parseEvaluationItems('{"id":"a","text":"가","split":"dev"}\n\n{"id":"b","text":"나"}\n')).toEqual([
      { id: "a", text: "가", split: "dev" }, { id: "b", text: "나", split: null },
    ]);
    expect(() => parseEvaluationItems('{"id":"a"}\n')).toThrow(EvaluateRulesArgumentError);
    expect(() => parseEvaluationItems('{"id":"a"}\n')).toThrow("1번째 줄");
  });

  it("키워드 목록은 빈 줄과 # 주석을 건너뛴다", () => {
    expect(parseKeywordPatterns("# 자해\n우울\n\n  죽고싶  \n")).toEqual(["우울", "죽고싶"]);
  });

  it("보류셋에는 추가 키워드를 쓸 수 없고, 개발셋에는 쓸 수 있다", () => {
    expect(() => ensureHoldoutUsesDefaults([{ id: "h", text: "가", split: "holdout" }], ["우울"])).toThrow(EvaluateRulesArgumentError);
    expect(() => ensureHoldoutUsesDefaults([{ id: "h", text: "가", split: "holdout" }], [])).not.toThrow();
    expect(() => ensureHoldoutUsesDefaults([devItem("d", "가")], ["우울"])).not.toThrow();
  });
});
