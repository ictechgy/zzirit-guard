import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createSessionStore, SESSION_TTL_MS } from "../../src/managers/sessionStore.js";

/** 예시 매니저. */
const manager = { channelId: "m1", channelName: "매니저1", role: "STREAMING_CHAT_MANAGER" as const };

describe("SessionStore", () => {
  it("원래 세션 ID는 저장하지 않고 해시로만 찾는다", () => {
    const database = openDatabase(":memory:");
    const store = createSessionStore(database, () => 0);
    const { session, rawId } = store.create(manager);
    expect(session.id).not.toBe(rawId);
    expect(JSON.stringify(database.prepare("SELECT * FROM manager_session").all())).not.toContain(rawId);
    expect(store.get(rawId)?.managerChannelId).toBe("m1");
    expect(store.get("wrong")).toBeNull();
  });

  it("12시간이 지나면 만료된다", () => {
    let now = 0;
    const store = createSessionStore(openDatabase(":memory:"), () => now);
    const { rawId } = store.create(manager);
    now = SESSION_TTL_MS + 1;
    expect(store.get(rawId)).toBeNull();
  });

  it("WebSocket 티켓은 한 번만, 30초 안에만 쓸 수 있다", () => {
    let now = 0;
    const store = createSessionStore(openDatabase(":memory:"), () => now);
    const { session } = store.create(manager);
    const ticket = store.issueTicket(session.id);
    expect(store.redeemTicket(ticket)?.id).toBe(session.id);
    expect(store.redeemTicket(ticket)).toBeNull();
    const late = store.issueTicket(session.id);
    now = 30_001;
    expect(store.redeemTicket(late)).toBeNull();
  });
});
