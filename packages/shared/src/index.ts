// 서버와 PWA가 함께 쓰는 REST·WebSocket 메시지 타입. 타입만 두어 런타임 의존이 생기지 않게 한다.

/** 이 앱에 접근할 수 있는 치지직 역할. 정산 관리자(STREAMING_SETTLEMENT_MANAGER)는 제외한다. */
export type ManagerRole = "STREAMING_CHANNEL_OWNER" | "STREAMING_CHANNEL_MANAGER" | "STREAMING_CHAT_MANAGER";

/** 판정 종류. shadow는 스위치가 꺼져 있어 숨기지 않은 auto_hide 대상이다. */
export type Decision = "auto_hide" | "shadow" | "candidate" | "needs_care" | "pass";

/** 저장된 판정의 처리 상태. */
export type VerdictStatus = "pending" | "hidden" | "ignored" | "restricted" | "false_positive";

/** 채널 규칙 종류. exception은 금칙어 비교 전에 지우는 예외 단어(예: 시발점)다. */
export type RuleKind = "strong" | "weak" | "exception" | "allow" | "allow_domain" | "threat" | "keyword_route";

/** 역할별로 허용되는 기능. 스펙 7장 권한 표와 일치해야 한다. */
export type Permission =
  | "connect_channel"
  | "disable_auto_hide"
  | "enable_auto_hide"
  | "edit_rules"
  | "hide_message"
  | "temporary_restrict"
  | "restrict"
  | "edit_chat_settings"
  | "view_audit";

/** 저장된 판정 1건(후보·섀도·자동 숨김 등). */
export interface VerdictDto {
  id: number;
  chatChannelId: string;
  senderChannelId: string;
  senderNickname: string;
  content: string;
  messageTime: number;
  decision: Decision;
  reason: string;
  status: VerdictStatus;
  createdAt: number;
}

/** 실시간 채팅 화면에 보내는 한 줄. */
export interface ChatLine {
  senderNickname: string;
  content: string;
  messageTime: number;
  decision: Decision;
}

/** 상태 배너·상태 점검 화면에 쓰는 서버 상태. */
export interface ServerStatus {
  channelConnected: boolean;
  channelName: string | null;
  chatConnected: boolean;
  writeLocked: boolean;
  accessExpiresAt: number | null;
  autoHideEnabled: boolean;
  lastChatAt: number | null;
  pendingActions: number;
}

/** 로그인한 매니저 정보와 권한. */
export interface MeDto {
  channelId: string;
  channelName: string;
  role: ManagerRole;
  permissions: Permission[];
}

/** 채널 규칙 1건. */
export interface RuleEntryDto {
  id: number;
  kind: RuleKind;
  pattern: string;
  createdBy: string;
  createdAt: number;
}

/** 1단계에서 설정 화면이 바꿀 수 있는 값. */
export interface SettingsDto {
  breakerPerMinute: number;
  retentionDaysContent: number;
  retentionDaysAudit: number;
}

/** 감사 기록 1건(원문 없음). */
export interface AuditEntryDto {
  id: number;
  actorType: "manager" | "rule" | "system";
  actorChannelId: string | null;
  action: string;
  targetSenderChannelId: string | null;
  verdictId: number | null;
  result: "ok" | "error";
  error: string | null;
  createdAt: number;
}

/** 치지직 채팅 설정(GET/PUT /open/v1/chats/settings와 같은 필드). */
export interface ChatSettingsDto {
  chatAvailableCondition: "NONE" | "REAL_NAME";
  chatAvailableGroup: "ALL" | "FOLLOWER" | "MANAGER" | "SUBSCRIBER";
  minFollowerMinute: number;
  allowSubscriberInFollowerMode: boolean;
  chatSlowModeSec: number;
  chatEmojiMode: boolean;
}

/** WebSocket으로 서버가 보내는 메시지. */
export type RealtimeEvent =
  | { type: "verdict"; verdict: VerdictDto }
  | { type: "verdict_status"; verdictId: number; status: VerdictStatus }
  | { type: "chat_batch"; lines: ChatLine[] }
  | { type: "status"; status: ServerStatus }
  | { type: "session_ended"; reason: string };

/** REST 오류 응답 본문. message는 사용자에게 보여 줄 문구다. */
export interface ApiErrorBody {
  error: string;
  message: string;
}
