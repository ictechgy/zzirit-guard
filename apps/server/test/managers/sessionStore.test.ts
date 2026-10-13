import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createSessionStore, SESSION_TTL_MS, WS_TICKETS_PER_MINUTE } from "../../src/managers/sessionStore.js";

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
    const ticket = store.issueTicket(session.id) as string;
    expect(store.redeemTicket(ticket)?.id).toBe(session.id);
    expect(store.redeemTicket(ticket)).toBeNull();
    const late = store.issueTicket(session.id) as string;
    now = 30_001;
    expect(store.redeemTicket(late)).toBeNull();
  });

  it("새 티켓을 주면 같은 세션의 쓰지 않은 앞 티켓은 무효가 되고, 다른 세션의 티켓은 그대로다(K8)", () => {
    const store = createSessionStore(openDatabase(":memory:"), () => 0);
    const first = store.create(manager).session;
    const second = store.create({ ...manager, channelId: "m2" }).session;
    const stale = store.issueTicket(first.id) as string;
    const otherSession = store.issueTicket(second.id) as string;
    const fresh = store.issueTicket(first.id) as string;
    expect(store.redeemTicket(stale)).toBeNull();
    expect(store.redeemTicket(fresh)?.id).toBe(first.id);
    expect(store.redeemTicket(otherSession)?.id).toBe(second.id);
  });

  it("세션 하나는 1분에 티켓을 10개까지만 받고, 넘으면 null이며 1분이 지나면 다시 받는다(K8)", () => {
    let now = 0;
    const store = createSessionStore(openDatabase(":memory:"), () => now);
    const { session } = store.create(manager);
    const other = store.create({ ...manager, channelId: "m2" }).session;
    expect(WS_TICKETS_PER_MINUTE).toBe(10);
    for (let index = 0; index < WS_TICKETS_PER_MINUTE; index += 1) expect(store.issueTicket(session.id)).toEqual(expect.any(String));
    const latest = store.issueTicket(session.id);
    expect(latest).toBeNull();
    expect(store.issueTicket(other.id)).toEqual(expect.any(String));
    now = 59_999;
    expect(store.issueTicket(session.id)).toBeNull();
    now = 60_000;
    expect(store.issueTicket(session.id)).toEqual(expect.any(String));
  });

  it("한도에 걸린 요청은 앞서 준 티켓을 무효로 만들지 않는다(K8)", () => {
    const store = createSessionStore(openDatabase(":memory:"), () => 0);
    const { session } = store.create(manager);
    let lastTicket: string | null = null;
    for (let index = 0; index < WS_TICKETS_PER_MINUTE; index += 1) lastTicket = store.issueTicket(session.id);
    expect(store.issueTicket(session.id)).toBeNull();
    expect(store.redeemTicket(lastTicket as string)?.id).toBe(session.id);
  });
});
