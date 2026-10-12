import type { VerdictDto } from "@zzirit-guard/shared";
import { describe, expect, it } from "vitest";
import { addVerdictIfAbsent, applyVerdictStatus, buildSections, countActionable, mergeVerdicts, pruneVerdicts, VERDICT_KEEP_MS } from "../../src/domain/candidates";

/** 판정 예시. */
function verdict(id: number, overrides: Partial<VerdictDto> = {}): VerdictDto {
  return {
    id, chatChannelId: "chat-1", senderChannelId: "viewer-1", senderNickname: "시청자1", content: `메시지${id}`,
    messageTime: id, decision: "candidate", reason: "rule:weak:1", status: "pending", createdAt: id * 1000, ...overrides,
  };
}

/** 기준 시각(10분 창 안에 모두 들어오게). */
const NOW = 100_000;

describe("buildSections", () => {
  it("결정별로 나누고, 같은 사람은 한 묶음으로 최신순이며, 자동 숨김은 숨겨진 것과 아직 안 숨겨진 것을 가른다", () => {
    const sections = buildSections(
      [
        verdict(1), verdict(2), verdict(3, { senderChannelId: "viewer-2", senderNickname: "시청자2" }), verdict(4, { decision: "shadow" }),
        verdict(5, { decision: "needs_care" }), verdict(6, { decision: "auto_hide", status: "hidden" }), verdict(7, { decision: "auto_hide" }),
      ],
      NOW,
    );
    expect(sections.candidates.map((group) => [group.senderChannelId, group.verdicts.map((item) => item.id)])).toEqual([["viewer-2", [3]], ["viewer-1", [2, 1]]]);
    expect(sections.shadow.map((group) => group.verdicts.map((item) => item.id))).toEqual([[4]]);
    expect(sections.care).toHaveLength(1);
    expect(sections.autoHidden.map((item) => item.id)).toEqual([6]);
    expect(sections.autoHidePending.map((item) => item.id)).toEqual([7]);
    expect(countActionable(sections)).toBe(5);
  });

  it("처리된 것과 10분이 지난 것은 빼고, 자동 숨김도 10분 안의 것만 둔다(R-19)", () => {
    const old = NOW - 11 * 60 * 1000;
    const sections = buildSections(
      [
        verdict(1, { status: "hidden" }), verdict(2, { createdAt: old }), verdict(3, { decision: "auto_hide", status: "hidden", createdAt: old }),
        verdict(4, { decision: "auto_hide", status: "false_positive" }), verdict(5, { decision: "auto_hide", status: "hidden" }),
      ],
      NOW,
    );
    expect(sections.candidates).toEqual([]);
    expect(sections.autoHidden.map((item) => item.id)).toEqual([5]);
    expect(sections.autoHidePending).toEqual([]);
  });
});

describe("buildSections: 제한된 자동 숨김", () => {
  it("restricted는 숨겨진 쪽이 아니라 별도 구역에 두고, ignored는 어느 구역에도 두지 않는다", () => {
    const sections = buildSections([verdict(1, { decision: "auto_hide", status: "restricted" }), verdict(2, { decision: "auto_hide", status: "ignored" })], NOW);
    expect(sections.restrictedAfterAutoHide.map((item) => item.id)).toEqual([1]);
    expect(sections.autoHidden).toEqual([]);
    expect(sections.autoHidePending).toEqual([]);
  });
});

describe("판정 목록 갱신", () => {
  it("새 판정 이벤트는 없던 id만 더한다(이미 있으면 같거나 더 새 상태다)", () => {
    const list = addVerdictIfAbsent([verdict(1, { status: "hidden" })], verdict(2));
    expect(addVerdictIfAbsent(list, verdict(1)).map((item) => [item.id, item.status])).toEqual([[1, "hidden"], [2, "pending"]]);
  });

  it("다시 읽은 목록은 id로 합친다: 같은 id는 읽은 값, 없던 것은 더하고, 기존 것은 남긴다(R-3)", () => {
    const merged = mergeVerdicts([verdict(1), verdict(2)], [verdict(1, { status: "hidden" }), verdict(3)]);
    expect(merged.map((item) => [item.id, item.status])).toEqual([[1, "hidden"], [2, "pending"], [3, "pending"]]);
  });

  it("REST 스냅숏이 더 새로 받은 처리 상태(hidden 등)를 pending으로 되돌리지 않는다(W3, X36)", () => {
    const current = [verdict(1, { status: "hidden" }), verdict(2, { status: "restricted" }), verdict(3)];
    const loaded = [verdict(1), verdict(2), verdict(3)];
    expect(mergeVerdicts(current, loaded).map((item) => [item.id, item.status])).toEqual([[1, "hidden"], [2, "restricted"], [3, "pending"]]);
  });

  it("처리 상태끼리는 REST 스냅숏 값을 따른다(서버가 정한 최신 상태)", () => {
    const merged = mergeVerdicts([verdict(1, { status: "hidden" })], [verdict(1, { status: "false_positive" })]);
    expect(merged[0]?.status).toBe("false_positive");
  });

  it("상태만 바꾼다", () => {
    expect(applyVerdictStatus([verdict(1)], 1, "ignored")[0]?.status).toBe("ignored");
    expect(applyVerdictStatus([verdict(1)], 9, "ignored")[0]?.status).toBe("pending");
  });

  it("가장 새 판정 기준으로 창과 여유를 넘긴 판정을 지운다(R-11)", () => {
    const newest = verdict(2, { createdAt: VERDICT_KEEP_MS + 5_000 });
    expect(pruneVerdicts([verdict(1, { createdAt: 4_000 }), verdict(3, { createdAt: 5_000 }), newest]).map((item) => item.id)).toEqual([3, 2]);
    expect(pruneVerdicts([])).toEqual([]);
  });

  it("판정이 아주 많아도(20만 건) 인자 개수 한도로 실패하지 않는다(F4, Math.max 펼치기 금지)", () => {
    // 10ms 간격 20만 건: 가장 새 판정(1,999,990ms)에서 VERDICT_KEEP_MS(660,000ms) 안의 66,001건만 남는다.
    const many = Array.from({ length: 200_000 }, (_unused, index) => verdict(index, { createdAt: index * 10 }));
    expect(pruneVerdicts(many)).toHaveLength(66_001);
  });
});
