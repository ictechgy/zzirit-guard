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

/** 자동 숨김을 켜고 끈 이유. manual: 매니저가 직접, breaker: 1분 한도 초과, failure_rate: 치지직 호출 실패 증가. */
export type AutoHideOffReason = "manual" | "breaker" | "failure_rate";

/** 상태 배너·상태 점검 화면에 쓰는 서버 상태. */
export interface ServerStatus {
  channelConnected: boolean;
  channelName: string | null;
  chatConnected: boolean;
  writeLocked: boolean;
  accessExpiresAt: number | null;
  autoHideEnabled: boolean;
  /**
   * 자동 숨김이 마지막으로 꺼진 이유(B19-3). 켜져 있거나, 이 서버가 시작된 뒤 꺼진 적이 없으면 null.
   * 화면은 manual이 아니면(시스템이 껐으면) 이유를 밝힌 안내를 띄운다. 서버 메모리에만 두어 재시작하면 null이 된다.
   */
  autoHideOffReason: AutoHideOffReason | null;
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

/** 분당 통계 한 행(GET /api/stats). 서버 minute_stat 열 이름(snake_case)을 그대로 쓴다. */
export interface MinuteStatDto {
  /** 그 분이 시작한 시각(ms). */
  minute: number;
  /** 받은 채팅 수. */
  received: number;
  /** 가벼운 반응(ㅋㅋ 등)이라 AI 단계를 건너뛴 수. */
  skipped: number;
  /** 10분 안에 같은 정규화 문장이 이미 있었던 수. */
  deduplicated: number;
  /** 1차 분류기로 보낸 수(2단계). */
  stage1_forwarded: number;
  /** 2차 분류기가 판정한 수(2단계). */
  stage2_done: number;
  /** 2차 대기열에서 버린 수(2단계). */
  stage2_dropped: number;
  /** 후보로 올린 수. */
  candidates: number;
  /** 자동 숨김에 성공한 수. 취소(스위치 꺼짐)·실패는 세지 않는다(S5). */
  auto_hidden: number;
  /** 스위치가 꺼져 섀도로 기록한 수. */
  shadow: number;
  /** 형식이 틀려 버린 채팅 이벤트 수. */
  invalid_events: number;
}

/** 오판 검토 목록의 이유별 건수 한 줄. */
export interface FalsePositiveReasonCountDto {
  /** 판정 이유(예: rule:strong:12). 규칙 번호가 들어 있어 어떤 규칙을 고칠지 알 수 있다. */
  reason: string;
  /** 보관 기간 안에서 이 이유로 오판 신고된 판정 수. */
  count: number;
}

/** 오판 검토 목록(GET /api/false-positives, 스펙 5.5 "오판을 누르면 그 규칙이 검토 목록에 올라간다"). */
export interface FalsePositiveReviewDto {
  /** 최근 오판 신고 판정(판정이 만들어진 순서로 최신부터, limit개까지). */
  recent: VerdictDto[];
  /** 이유별 오판 건수(많은 순, 같으면 이유 순). */
  byReason: FalsePositiveReasonCountDto[];
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

/**
 * 로그인 실패 이유 코드. 서버는 /auth/* 실패를 "/?loginError=<코드>"로 첫 화면에 보내고, 화면이 코드를 정해진 한국어 문구로 바꾼다.
 * 왜 문구가 아니라 코드인가: 주소의 문구를 그대로 보여 주면 누구나 공식 주소에 임의의 글(피싱 안내 등)을 띄울 수 있다(F10).
 * state_mismatch: 로그인 요청이 만료·위조됨, rate_limited: 요청 한도 초과, not_manager: 매니저가 아님,
 * not_allowed_channel: 설정한 스트리머 채널이 아님, no_channel: 아직 연결된 채널이 없음, failed: 그 밖의 실패(모르는 코드도 이것으로 본다).
 */
export type LoginErrorCode = "state_mismatch" | "rate_limited" | "not_manager" | "not_allowed_channel" | "no_channel" | "failed";
