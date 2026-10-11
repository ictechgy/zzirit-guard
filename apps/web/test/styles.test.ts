/// <reference types="node" />
// 왜 node:fs인가: Vitest는 CSS 가져오기(?raw 포함)를 빈 문자열로 바꿔, 파일을 직접 읽어야 규칙을 검사할 수 있다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 검사할 스타일 원문. */
const styles = readFileSync(join(import.meta.dirname, "../src/styles.css"), "utf8");

/** CSS 규칙(선택자 목록, 선언) 목록. 이 파일은 중첩 규칙을 쓰지 않아 단순 분해로 충분하다. */
const RULES = [...styles.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selectors = "", body = ""]) => ({
  selectors: selectors.split(",").map((selector) => selector.trim()),
  body,
}));

describe("목록을 밀지 않는 떠 있는 층(B19-1·4)", () => {
  it.each([".overlay-top", ".overlay-bottom"])("%s는 position: fixed라 문서 흐름에 자리를 차지하지 않는다", (selector) => {
    const rule = RULES.find(({ selectors }) => selectors.includes(selector));
    expect(rule?.body).toMatch(/position:\s*fixed/);
  });

  it("'새 항목' 버튼에는 자리를 차지하는 sticky를 쓰지 않는다", () => {
    const rule = RULES.find(({ selectors }) => selectors.includes(".new-items"));
    expect(rule?.body).not.toMatch(/position:\s*sticky/);
  });
});

describe("입력 글자 크기(F10, iOS 확대 방지)", () => {
  it.each(["input", "select", "textarea"])("%s의 글자 크기는 16px 이상이다(작으면 iOS Safari가 누를 때 화면을 확대한다)", (tag) => {
    const rule = RULES.find(({ selectors }) => selectors.includes(tag));
    const size = rule ? /font-size:\s*(\d+)px/.exec(rule.body) : null;
    expect(Number(size?.[1])).toBeGreaterThanOrEqual(16);
  });
});
