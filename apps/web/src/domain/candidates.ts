import type { VerdictDto, VerdictStatus } from "@zzirit-guard/shared";

/**
 * 후보 화면에 보여 줄 기간(최근 10분, 스펙 6장).
 * 서버 CANDIDATE_WINDOW_MS(apps/server/src/http/constants.ts)와 같아야 한다. shared는 타입만 내보내 런타임 값을 옮길 수 없어 복사했다(R-20).
 */
export const CANDIDATE_WINDOW_MS = 10 * 60 * 1000;
/**
 * 판정을 화면 메모리에 남기는 기간: 후보 창 + 1분 여유.
 * 왜: 창을 넘긴 판정은 어차피 보이지 않는데 남겨 두면 섀도 떼도배 몇 번에 수천 건이 쌓여 휴대폰이 느려진다(R-11). 여유는 시계 차이를 흡수한다.
 */
export const VERDICT_KEEP_MS = CANDIDATE_WINDOW_MS + 60_000;

/** 한 사람의 판정 묶음. 매니저는 사람 단위로 제재한다. */
export interface SenderGroup {
  /** 보낸 사람 채널 ID(묶음의 키, 임시 제한 대상). */
  senderChannelId: string;
  /** 보낸 사람 닉네임(가장 최근 판정의 값). */
  senderNickname: string;
  /** 임시 제한 API에 넘길 채팅 채널 ID. */
  chatChannelId: string;
  /** 이 사람의 판정(최신순). */
  verdicts: VerdictDto[];
  /** 가장 최근 판정 시각. 묶음 정렬에 쓴다. */
  latestAt: number;
}

/** 후보 화면의 구역. 도움 필요·섀도·후보는 처리 전(pending)만 사람 단위로 묶는다. */
export interface CandidateSections {
  /** 도움 필요(자해·자살 신호). 1단계에는 생기지 않는다(AI는 2단계). */
  care: SenderGroup[];
  /** 스위치가 켜져 있었으면 숨겼을 메시지(섀도). */
  shadow: SenderGroup[];
  /** 매니저 확인이 필요한 후보. */
  candidates: SenderGroup[];
  /**
   * 자동 숨김 판정인데 아직 숨겨지지 않은 것(최신순). 실행 대기 중이거나, 스위치가 꺼져 취소됐거나, 재시도를 다 써도 실패한 것이다.
   * 왜 따로 두나: "자동 숨김됨"에 섞으면 숨겨지지 않은 메시지가 숨겨진 것처럼 보이고 숨길 버튼도 없어 조용히 사라진다(R-4).
   */
  autoHidePending: VerdictDto[];
  /** 실제로 숨겨진 자동 숨김(status hidden, 최신순). 잘못 숨겼으면 오판으로 신고한다. */
  autoHidden: VerdictDto[];
  /**
   * 자동 숨김 판정인데 보낸 사람이 임시 제한된 것(status restricted, 최신순).
   * 왜 hidden과 가르나: 서버는 어떤 판정으로든 임시 제한하면 그 판정을 restricted로 바꾸고 hidden도 덮어쓴다.
   * 그래서 숨김에 실패한 메시지도 restricted가 될 수 있어, "숨겨짐"으로 보여 주면 보이는 메시지를 숨겼다고 착각한다.
   * 서버는 restricted 판정의 숨기기를 409로 거절하므로 이 목록에는 숨기기 버튼을 두지 않는다.
   */
  restrictedAfterAutoHide: VerdictDto[];
}

/**
 * 처리를 기다리지 않는 정보 목록(자동 숨김됨·사용자 제한됨·섀도)에 그릴 최대 행 수(최근 50).
 * 왜: 떼도배 한 번에 수천 건이 쌓이면 이 목록들을 그리는 데만 휴대폰에서 수백 ms가 걸린다(F4). 나머지는 "외 N건"으로 줄인다.
 */
export const MAX_LISTED_ROWS = 50;

/** 판정 목록을 화면 구역으로 나눈다. now보다 CANDIDATE_WINDOW_MS 넘게 지난 판정은 뺀다. */
export function buildSections(verdicts: readonly VerdictDto[], now: number): CandidateSections {
  const recent = verdicts.filter((verdict) => verdict.createdAt >= now - CANDIDATE_WINDOW_MS);
  const pick = (decision: VerdictDto["decision"], status: VerdictStatus) => recent.filter((verdict) => verdict.decision === decision && verdict.status === status);
  return {
    care: groupBySender(pick("needs_care", "pending")),
    shadow: groupBySender(pick("shadow", "pending")),
    candidates: groupBySender(pick("candidate", "pending")),
    autoHidePending: pick("auto_hide", "pending").sort(newestFirst),
    autoHidden: pick("auto_hide", "hidden").sort(newestFirst),
    restrictedAfterAutoHide: pick("auto_hide", "restricted").sort(newestFirst),
  };
}

/** 처리를 기다리는 항목 수: 사람 묶음(도움 필요·섀도·후보) 수 + 숨기지 못한 자동 숨김 건수. 탭 배지와 "후보 없음" 판단에 쓴다. */
export function countActionable(sections: CandidateSections): number {
  return sections.care.length + sections.shadow.length + sections.candidates.length + sections.autoHidePending.length;
}

/**
 * 실시간 verdict 이벤트(새 판정)를 더한다. 이미 있는 id면 그대로 둔다.
 * 왜: verdict 이벤트는 판정이 만들어질 때 한 번만 온다. 이미 있는 것은 같은 판정이거나 그 뒤 상태가 바뀐 것이라 더 새롭다.
 */
export function addVerdictIfAbsent(verdicts: readonly VerdictDto[], verdict: VerdictDto): VerdictDto[] {
  return verdicts.some((item) => item.id === verdict.id) ? [...verdicts] : [...verdicts, verdict];
}

/**
 * REST로 다시 읽은 판정을 id로 합친다. 같은 id는 읽은 값으로 바꾸고(끊긴 동안 바뀐 상태를 반영), 없던 것은 더하고, 목록에 없는 기존 판정은 남긴다.
 * 결과는 id 순서(저장 순서)로 정렬한다.
 * 왜 통째로 바꾸지 않나: 조회와 실시간 연결이 함께 시작돼, 먼저 온 실시간 판정을 덮어쓰면 사라지기 때문이다(X1, R-3).
 */
export function mergeVerdicts(current: readonly VerdictDto[], loaded: readonly VerdictDto[]): VerdictDto[] {
  const byId = new Map(current.map((verdict) => [verdict.id, verdict]));
  for (const verdict of loaded) byId.set(verdict.id, verdict);
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

/** 상태만 바꾼다. 없는 id면 그대로 둔다. */
export function applyVerdictStatus(verdicts: readonly VerdictDto[], verdictId: number, status: VerdictStatus): VerdictDto[] {
  return verdicts.map((item) => (item.id === verdictId ? { ...item, status } : item));
}

/**
 * 가장 새 판정의 시각에서 VERDICT_KEEP_MS보다 오래된 판정을 지운다(R-11).
 * 왜 휴대폰 시계가 아니라 판정 시각(서버 시계)을 기준으로 하나: 휴대폰 시계가 틀려도 보여야 할 판정을 지우지 않게 하려는 것이다.
 */
export function pruneVerdicts(verdicts: readonly VerdictDto[]): VerdictDto[] {
  if (verdicts.length === 0) return [];
  // 왜 reduce인가: Math.max(...배열)은 원소마다 인자를 하나씩 넘겨, 판정이 많으면 인자 개수 한도(iOS JavaScriptCore는 특히 작다)로 실패한다(F4).
  const newestAt = verdicts.reduce((newest, verdict) => Math.max(newest, verdict.createdAt), Number.NEGATIVE_INFINITY);
  const cutoff = newestAt - VERDICT_KEEP_MS;
  return verdicts.filter((verdict) => verdict.createdAt >= cutoff);
}

/** 보낸 사람별로 묶고, 묶음과 묶음 안의 판정을 모두 최신순으로 정렬한다. */
function groupBySender(verdicts: readonly VerdictDto[]): SenderGroup[] {
  const groups = new Map<string, SenderGroup>();
  for (const verdict of [...verdicts].sort(newestFirst)) {
    const group = groups.get(verdict.senderChannelId) ?? {
      senderChannelId: verdict.senderChannelId, senderNickname: verdict.senderNickname, chatChannelId: verdict.chatChannelId, verdicts: [], latestAt: verdict.createdAt,
    };
    group.verdicts.push(verdict);
    groups.set(verdict.senderChannelId, group);
  }
  return [...groups.values()].sort((left, right) => right.latestAt - left.latestAt);
}

/** 최신순 비교. 같은 시각이면 id가 큰 것(나중에 저장된 것)이 앞. */
function newestFirst(left: VerdictDto, right: VerdictDto): number {
  return right.createdAt - left.createdAt || right.id - left.id;
}
