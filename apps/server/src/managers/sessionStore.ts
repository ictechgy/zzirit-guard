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
  issueTicket(sessionId: string): string;
  redeemTicket(ticket: string): ManagerSession | null;
}

/** 세션 유효 기간(12시간, 스펙 8장). */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** WebSocket 티켓 유효 기간(30초). */
const TICKET_TTL_MS = 30_000;

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
  const tickets = new Map<string, { sessionId: string; expiresAt: number }>();
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
    issueTicket: (sessionId) => issueTicket(tickets, sessionId, clock()),
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

/** 일회용 티켓을 발급한다. 오래된 티켓도 함께 치운다. */
function issueTicket(tickets: Map<string, { sessionId: string; expiresAt: number }>, sessionId: string, now: number): string {
  for (const [key, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(key);
  const ticket = randomBytes(24).toString("base64url");
  tickets.set(ticket, { sessionId, expiresAt: now + TICKET_TTL_MS });
  return ticket;
}

/** 행을 세션으로 바꾼다. */
function toSession(row: SessionRow): ManagerSession {
  return {
    id: row.id, managerChannelId: row.manager_channel_id, managerChannelName: row.manager_channel_name,
    role: row.role, expiresAt: row.expires_at, lastRoleCheckAt: row.last_role_check_at,
  };
}
