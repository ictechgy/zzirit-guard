import type { ChatLine, ServerStatus, VerdictDto } from "@zzirit-guard/shared";
import { describe, expect, it } from "vitest";
import { VERDICT_KEEP_MS } from "../../src/domain/candidates";
import { initialServerState, MAX_CHAT_LINES, serverReducer, type ServerAction, type ServerState } from "../../src/state/serverReducer";

/** 상태 예시. */
const status: ServerStatus = { channelConnected: true, channelName: "채널", chatConnected: true, writeLocked: false, accessExpiresAt: null, autoHideEnabled: false, lastChatAt: null, pendingActions: 0 };

/** 채팅 줄 예시. */
function line(index: number): ChatLine {
  return { senderNickname: "n", content: `c${index}`, messageTime: index, decision: "pass" };
}

/** 판정 예시. */
function verdict(id: number, overrides: Partial<VerdictDto> = {}): VerdictDto {
  return { id, chatChannelId: "c", senderChannelId: "s", senderNickname: "n", content: "x", messageTime: id, decision: "candidate", reason: "rule:weak:1", status: "pending", createdAt: id, ...overrides };
}

/** 동작을 차례로 적용한다. */
function reduce(actions: ServerAction[], from: ServerState = initialServerState): ServerState {
  return actions.reduce(serverReducer, from);
}

describe("serverReducer", () => {
  it("조회 결과를 넣는다", () => {
    const state = reduce([{ type: "snapshot_started" }, { type: "snapshot_loaded", status, verdicts: [verdict(1)] }]);
    expect(state).toMatchObject({ status, verdicts: [verdict(1)], loadError: null, replayLog: null });
  });

  it("채팅 줄은 최근 300개만 남긴다", () => {
    let state = initialServerState;
    for (let batch = 0; batch < 4; batch += 1) {
      const lines = Array.from({ length: 100 }, (_unused, index) => line(batch * 100 + index));
      state = serverReducer(state, { type: "event", event: { type: "chat_batch", lines } });
    }
    expect(state.chatLines).toHaveLength(MAX_CHAT_LINES);
    expect(state.chatLines[0]?.content).toBe("c100");
  });

  it("채팅 줄 순번은 배치가 달라도 증가하며 겹치지 않는다", () => {
    const state = reduce([
      { type: "event", event: { type: "chat_batch", lines: [line(1), line(2)] } },
      { type: "event", event: { type: "chat_batch", lines: [line(3)] } },
    ]);
    expect(state.chatLines.map((entry) => entry.seq)).toEqual([0, 1, 2]);
    expect(state.nextChatSeq).toBe(3);
  });

  it("300개 상한으로 앞이 잘려도 남은 순번은 겹치지 않고 이어진다", () => {
    let state = initialServerState;
    for (let batch = 0; batch < 4; batch += 1) {
      const lines = Array.from({ length: 100 }, (_unused, index) => line(batch * 100 + index));
      state = serverReducer(state, { type: "event", event: { type: "chat_batch", lines } });
    }
    const seqs = state.chatLines.map((entry) => entry.seq);
    expect(new Set(seqs).size).toBe(MAX_CHAT_LINES);
    expect(seqs[0]).toBe(100);
    expect(seqs.every((seq, index) => index === 0 || seq === seqs[index - 1]! + 1)).toBe(true);
  });

  it("세션 종료·연결 상태·불러오기 실패를 기록한다", () => {
    expect(reduce([{ type: "event", event: { type: "session_ended", reason: "권한 해제" } }]).sessionEndedReason).toBe("권한 해제");
    expect(reduce([{ type: "connection", connected: true }]).realtimeConnected).toBe(true);
    expect(reduce([{ type: "snapshot_started" }, { type: "snapshot_failed", message: "서버 오류" }])).toMatchObject({ loadError: "서버 오류", replayLog: null });
  });

  it("판정 이벤트와 상태 이벤트를 반영한다", () => {
    const state = reduce([
      { type: "event", event: { type: "verdict", verdict: verdict(1) } },
      { type: "event", event: { type: "verdict_status", verdictId: 1, status: "hidden" } },
      { type: "event", event: { type: "status", status } },
    ]);
    expect(state.verdicts[0]?.status).toBe("hidden");
    expect(state.status).toEqual(status);
  });

  it("조회 중에 온 판정·상태 이벤트는 조회 결과 위에 다시 적용한다(X1)", () => {
    const newerStatus = { ...status, autoHideEnabled: true };
    const state = reduce([
      { type: "snapshot_started" },
      { type: "event", event: { type: "status", status: newerStatus } },
      { type: "event", event: { type: "verdict_status", verdictId: 1, status: "hidden" } },
      { type: "event", event: { type: "verdict", verdict: verdict(2) } },
      { type: "snapshot_loaded", status, verdicts: [verdict(1)] },
    ]);
    expect(state.status).toEqual(newerStatus);
    expect(state.verdicts.map((item) => [item.id, item.status])).toEqual([[1, "hidden"], [2, "pending"]]);
    expect(state.replayLog).toBeNull();
  });

  it("다시 조회하면 기존 판정과 id로 합친다(재연결, R-3)", () => {
    const before = reduce([{ type: "snapshot_started" }, { type: "snapshot_loaded", status, verdicts: [verdict(1), verdict(2)] }]);
    const after = reduce([{ type: "snapshot_started" }, { type: "snapshot_loaded", status, verdicts: [verdict(1, { status: "ignored" }), verdict(3)] }], before);
    expect(after.verdicts.map((item) => [item.id, item.status])).toEqual([[1, "ignored"], [2, "pending"], [3, "pending"]]);
  });

  it("새 판정이 오면 창과 여유를 넘긴 판정을 지운다(R-11)", () => {
    const state = reduce([
      { type: "event", event: { type: "verdict", verdict: verdict(1, { createdAt: 0 }) } },
      { type: "event", event: { type: "verdict", verdict: verdict(2, { createdAt: VERDICT_KEEP_MS + 1 }) } },
    ]);
    expect(state.verdicts.map((item) => item.id)).toEqual([2]);
  });

  it("실시간 연결이 거듭 거절되면 표시하고, 다시 연결되면 지운다(R-6)", () => {
    const rejected = reduce([{ type: "connection", connected: true }, { type: "realtime_rejected" }]);
    expect(rejected).toMatchObject({ realtimeRejected: true, realtimeConnected: false });
    expect(serverReducer(rejected, { type: "connection", connected: true }).realtimeRejected).toBe(false);
  });
});
