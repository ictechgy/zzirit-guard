import { createHash, randomBytes } from "node:crypto";
import type { ManagerRole } from "@zzirit-guard/shared";
import type { Database } from "../db/database.js";
import type { Clock } from "../time.js";

/** 매니저 세션. id는 쿠키 값의 SHA-256이다(DB가 새도 세션을 훔칠 수 없게). */
export interface ManagerSession {
  id: string;
  managerChannelId: string;
  managerChannelName: string;
  role: ManagerRole;
  expiresAt: number;
  lastRoleCheckAt: number;
}

/** 세션·WebSocket 티켓 저장소. */
export interface SessionStore {
  create(manager: { channelId: string; channelName: string; role: ManagerRole }): { session: ManagerSession; rawId: string };
  get(rawId: string): ManagerSession | null;
  getById(id: string): ManagerSession | null;
  deleteByRawId(rawId: string): void;
  deleteById(id: string): void;
  updateRole(id: string, role: ManagerRole): void;
  listActive(): ManagerSession[];
  deleteExpired(): number;
  /**
   * WebSocket 일회용 티켓을 준다. 같은 세션이 아직 쓰지 않은 앞 티켓은 무효가 된다(세션당 하나, K8).
   * @param sessionId 세션 ID
   * @returns 티켓. 이 세션이 1분에 WS_TICKETS_PER_MINUTE개를 이미 받았으면 null(앞 티켓도 그대로 둔다)
   */
  issueTicket(sessionId: string): string | null;
  redeemTicket(ticket: string): ManagerSession | null;
}

/** 세션 유효 기간(12시간, 스펙 8장). */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** WebSocket 티켓 유효 기간(30초). */
const TICKET_TTL_MS = 30_000;
/**
 * 세션 하나가 1분에 받을 수 있는 WebSocket 티켓 수(10, K8).
 * 왜: 티켓마다 소켓을 하나 열 수 있어, 한도가 없으면 세션 하나가 티켓을 쏟아 내 연결·메모리를 바닥낼 수 있다.
 * 화면은 끊기면 1초부터 두 배씩 늘려 다시 연결하므로(30초 상한) 정상 사용은 1분에 몇 번을 넘지 않는다.
 */
export const WS_TICKETS_PER_MINUTE = 10;
/** 티켓 발급 한도를 세는 기간(1분). */
const TICKET_RATE_WINDOW_MS = 60_000;

/** 메모리에만 두는 티켓 상태: 티켓 → 세션·만료 시각, 세션 → 최근 1분의 발급 시각들. */
interface TicketState {
  tickets: Map<string, { sessionId: string; expiresAt: number }>;
  issuedAtBySession: Map<string, number[]>;
}

/** manager_session 행. */
interface SessionRow {
  id: string;
  manager_channel_id: string;
  manager_channel_name: string;
  role: ManagerRole;
  expires_at: number;
  last_role_check_at: number;
}

/** 쿠키 값 → 저장용 해시. */
function hashSessionId(rawId: string): string {
  return createHash("sha256").update(rawId).digest("hex");
}

/** 세션 저장소를 만든다. 티켓은 수명이 짧아 메모리에만 둔다. */
export function createSessionStore(database: Database, clock: Clock): SessionStore {
  const ticketState: TicketState = { tickets: new Map(), issuedAtBySession: new Map() };
  const { tickets } = ticketState;
  const getById = (id: string) => readSession(database, id, clock());
  return {
    create: (manager) => insertSession(database, manager, clock()),
    get: (rawId) => getById(hashSessionId(rawId)),
    getById,
    deleteByRawId: (rawId) => void database.prepare("DELETE FROM manager_session WHERE id = ?").run(hashSessionId(rawId)),
    deleteById: (id) => void database.prepare("DELETE FROM manager_session WHERE id = ?").run(id),
    updateRole: (id, role) => void database.prepare("UPDATE manager_session SET role = ?, last_role_check_at = ? WHERE id = ?").run(role, clock(), id),
    listActive: () => (database.prepare("SELECT * FROM manager_session WHERE expires_at > ?").all(clock()) as SessionRow[]).map(toSession),
    deleteExpired: () => database.prepare("DELETE FROM manager_session WHERE expires_at <= ?").run(clock()).changes,
    issueTicket: (sessionId) => issueTicket(ticketState, sessionId, clock()),
    redeemTicket: (ticket) => {
      const entry = tickets.get(ticket);
      tickets.delete(ticket);
      return entry && entry.expiresAt > clock() ? getById(entry.sessionId) : null;
    },
  };
}

/** 무작위 세션 ID를 만들어 해시만 저장한다. */
function insertSession(database: Database, manager: { channelId: string; channelName: string; role: ManagerRole }, now: number) {
  const rawId = randomBytes(32).toString("base64url");
  const session: ManagerSession = {
    id: hashSessionId(rawId), managerChannelId: manager.channelId, managerChannelName: manager.channelName,
    role: manager.role, expiresAt: now + SESSION_TTL_MS, lastRoleCheckAt: now,
  };
  database
    .prepare("INSERT INTO manager_session (id, manager_channel_id, manager_channel_name, role, expires_at, last_role_check_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(session.id, session.managerChannelId, session.managerChannelName, session.role, session.expiresAt, session.lastRoleCheckAt);
  return { session, rawId };
}

/** 만료되지 않은 세션을 읽는다. 만료됐으면 지우고 null. */
function readSession(database: Database, id: string, now: number): ManagerSession | null {
  const row = database.prepare("SELECT * FROM manager_session WHERE id = ?").get(id) as SessionRow | undefined;
  if (!row) return null;
  if (row.expires_at <= now) {
    database.prepare("DELETE FROM manager_session WHERE id = ?").run(id);
    return null;
  }
  return toSession(row);
}

/**
 * 일회용 티켓을 발급한다. 1분 한도를 넘었으면 티켓은 건드리지 않고 null을 돌려준다.
 * 발급하면 만료된 티켓과 같은 세션의 쓰지 않은 앞 티켓을 함께 치운다(세션당 하나, K8).
 * 왜 앞 티켓을 지우나: 쓰지 않은 티켓을 모아 두었다가 한꺼번에 소켓을 여는 일을 막는다.
 */
function issueTicket(state: TicketState, sessionId: string, now: number): string | null {
  if (!recordIssuance(state.issuedAtBySession, sessionId, now)) return null;
  for (const [key, entry] of state.tickets) if (entry.expiresAt <= now || entry.sessionId === sessionId) state.tickets.delete(key);
  const ticket = randomBytes(24).toString("base64url");
  state.tickets.set(ticket, { sessionId, expiresAt: now + TICKET_TTL_MS });
  return ticket;
}

/**
 * 이 세션의 최근 1분 발급 횟수가 한도 안이면 이번 발급을 기록하고 true, 넘었으면 기록하지 않고 false.
 * 다른 세션의 기록 중 1분이 다 지난 것은 함께 지워, 오래전에 끝난 세션의 기록이 쌓이지 않게 한다.
 * @param issuedAtBySession 세션 → 최근 발급 시각들
 * @param sessionId 세션 ID
 * @param now 지금 시각(ms)
 */
function recordIssuance(issuedAtBySession: Map<string, number[]>, sessionId: string, now: number): boolean {
  for (const [key, times] of issuedAtBySession) if (times.every((time) => now - time >= TICKET_RATE_WINDOW_MS)) issuedAtBySession.delete(key);
  const recent = (issuedAtBySession.get(sessionId) ?? []).filter((time) => now - time < TICKET_RATE_WINDOW_MS);
  if (recent.length >= WS_TICKETS_PER_MINUTE) return false;
  issuedAtBySession.set(sessionId, [...recent, now]);
  return true;
}

/** 행을 세션으로 바꾼다. */
function toSession(row: SessionRow): ManagerSession {
  return {
    id: row.id, managerChannelId: row.manager_channel_id, managerChannelName: row.manager_channel_name,
    role: row.role, expiresAt: row.expires_at, lastRoleCheckAt: row.last_role_check_at,
  };
}
