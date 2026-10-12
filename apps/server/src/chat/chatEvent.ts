import { z } from "zod";

/** 서버가 다루는 채팅 1건. receivedAt은 서버 수신 시각(도배 창 계산에 쓴다). */
export interface ChatEvent {
  channelId: string;
  senderChannelId: string;
  chatChannelId: string;
  nickname: string;
  userRoleCode: string;
  content: string;
  messageTime: number;
  receivedAt: number;
}

/** 시스템 메시지. connected만 sessionKey를 갖는다. */
export type SystemMessage =
  | { type: "connected"; sessionKey: string }
  | { type: "subscribed" | "unsubscribed" | "revoked"; eventType: string; channelId: string };

/**
 * userRoleCode가 빠진 채팅에 채우는 값(빈 문자열 = 모르는 역할).
 * 왜 common_user로 채우지 않나: 역할 코드가 빠진 매니저 메시지가 일반 시청자로 보여 되돌릴 수 없는 자동 숨김 대상이 된다(S18, X08).
 * 파이프라인은 모르는 역할의 auto_hide를 후보(:unknown_role)로 낮춘다.
 */
const MISSING_ROLE_CODE = "";

/** CHAT 이벤트 검증 규칙(문서 필드표). profile·userRoleCode가 빠져도 받아 준다. */
const chatPayloadSchema = z.object({
  channelId: z.string(),
  senderChannelId: z.string(),
  chatChannelId: z.string(),
  profile: z.object({ nickname: z.string() }).nullish(),
  userRoleCode: z.string().default(MISSING_ROLE_CODE),
  content: z.string(),
  messageTime: z.coerce.number(),
});

/** SYSTEM 이벤트 검증 규칙. */
const systemPayloadSchema = z.union([
  z.object({ type: z.literal("connected"), data: z.object({ sessionKey: z.string() }) }),
  z.object({ type: z.enum(["subscribed", "unsubscribed", "revoked"]), data: z.object({ eventType: z.string(), channelId: z.string() }) }),
]);

/** 자동 숨김에서 빼는 역할(스펙 5.2 ①). */
const PRIVILEGED_ROLES: ReadonlySet<string> = new Set(["streamer", "streaming_channel_manager", "streaming_chat_manager"]);
/** 치지직 문서에 있는 역할 코드 전체. 여기 없는 값(빠짐·새 코드·오타)은 모르는 역할로 보고 자동 숨김하지 않는다(S18). */
const KNOWN_ROLES: ReadonlySet<string> = new Set(["common_user", ...PRIVILEGED_ROLES]);

/**
 * CHAT 페이로드를 ChatEvent로 바꾼다. 문자열로 오면 JSON으로 읽는다.
 * @returns 형식이 맞지 않으면 null(호출자가 개수를 센다)
 */
export function parseChatPayload(payload: unknown, receivedAt: number): ChatEvent | null {
  const parsed = chatPayloadSchema.safeParse(decodePayload(payload));
  if (!parsed.success) return null;
  const { profile, ...rest } = parsed.data;
  return { ...rest, nickname: profile?.nickname ?? "(알 수 없음)", receivedAt };
}

/** SYSTEM 페이로드를 SystemMessage로 바꾼다(모르는 형식이면 null). */
export function parseSystemPayload(payload: unknown): SystemMessage | null {
  const parsed = systemPayloadSchema.safeParse(decodePayload(payload));
  if (!parsed.success) return null;
  const message = parsed.data;
  return message.type === "connected" ? { type: "connected", sessionKey: message.data.sessionKey } : { type: message.type, ...message.data };
}

/** 스트리머·매니저 역할인지 확인한다. */
export function isPrivilegedRole(userRoleCode: string): boolean {
  return PRIVILEGED_ROLES.has(userRoleCode);
}

/**
 * 치지직 문서에 있는 역할 코드인지 확인한다(S18). 빠졌거나(빈 문자열) 처음 보는 코드면 false.
 * @param userRoleCode 채팅 이벤트의 역할 코드
 */
export function isKnownRole(userRoleCode: string): boolean {
  return KNOWN_ROLES.has(userRoleCode);
}

/** 문자열이면 JSON으로 풀고, 깨진 JSON은 검증에서 걸리도록 undefined로 바꾼다. */
function decodePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}
