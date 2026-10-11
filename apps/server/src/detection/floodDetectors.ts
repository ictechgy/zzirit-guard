/** 숨기기에 필요한 메시지 식별값과 화면 표시용 정보. privileged는 스트리머·매니저 여부다. */
export interface MessageRef {
  chatChannelId: string;
  messageTime: number;
  senderChannelId: string;
  nickname: string;
  content: string;
  privileged: boolean;
}

/** 떼도배 관측 결과. earlierRefs는 이번에 처음 조건을 넘었을 때 함께 숨길 앞선 메시지들이다. */
export interface GroupFloodObservation {
  triggered: boolean;
  earlierRefs: MessageRef[];
}

/** 떼도배(여러 사람이 같은 문장 반복) 감지기. */
export interface GroupFloodDetector {
  observe(normalized: string, ref: MessageRef, receivedAt: number): GroupFloodObservation;
  /**
   * observe에 넘긴 메시지를 이미 숨김 대상으로 넘긴 것으로 표시한다. 나중에 떼도배가 발동해도 earlierRefs에 다시 넣지 않는다.
   * 왜: 자체 판정이 이미 auto_hide(링크·금칙어 강 등)인 메시지를 발동 때 또 넘기면 숨김 요청·판정 기록·폭주 한도가 두 번 쓰인다(F1).
   * @param ref observe에 넘긴 바로 그 참조 객체. 관측하지 않았거나 창에서 빠진 참조면 아무것도 하지 않는다.
   */
  markReported(ref: MessageRef): void;
}

/** 개인 도배(한 사람이 짧은 시간에 여러 번) 감지기. */
export interface PersonalFloodDetector {
  observe(senderChannelId: string, receivedAt: number): boolean;
}

/** 떼도배 기본값: 10초, 5명, 10자(스펙 5.2). */
const GROUP_DEFAULTS = { windowMs: 10_000, minDistinctUsers: 5, minLength: 10 };
/** 개인 도배 기본값: 10초 안 5건. */
const PERSONAL_DEFAULTS = { windowMs: 10_000, maxMessages: 5 };
/** 이만큼 관측할 때마다 오래된 키를 정리해 메모리가 늘지 않게 한다. */
const SWEEP_EVERY_OBSERVATIONS = 1_000;

/** 창 안의 관측 1건. reported는 이미 숨김 대상으로 넘긴 것인지다. */
interface GroupEntry {
  ref: MessageRef;
  receivedAt: number;
  reported: boolean;
}

/**
 * 떼도배 감지기를 만든다. 창은 서버 수신 시각으로 계산한다(치지직 시각은 어긋날 수 있다).
 * @param options 창 길이·최소 사용자 수·최소 길이. 생략하면 스펙 기본값을 쓴다.
 * @returns observe로 관측을 넣는 감지기
 */
export function createGroupFloodDetector(options: Partial<typeof GROUP_DEFAULTS> = {}): GroupFloodDetector {
  const settings = { ...GROUP_DEFAULTS, ...options };
  const entriesByText = new Map<string, GroupEntry[]>();
  // 참조 → 관측 항목. WeakMap이라 창에서 빠져 버려진 항목은 따로 지우지 않아도 메모리에서 사라진다.
  const entryByRef = new WeakMap<MessageRef, GroupEntry>();
  let observations = 0;
  return {
    observe(normalized, ref, receivedAt) {
      if (normalized.length < settings.minLength) return { triggered: false, earlierRefs: [] };
      observations += 1;
      if (observations % SWEEP_EVERY_OBSERVATIONS === 0) sweep(entriesByText, receivedAt - settings.windowMs);
      const entries = withinWindow(entriesByText.get(normalized), receivedAt - settings.windowMs);
      const entry: GroupEntry = { ref, receivedAt, reported: false };
      entries.push(entry);
      entryByRef.set(ref, entry);
      entriesByText.set(normalized, entries);
      return evaluateGroup(entries, settings.minDistinctUsers);
    },
    markReported(ref) {
      const entry = entryByRef.get(ref);
      if (entry) entry.reported = true;
    },
  };
}

/**
 * 창 밖(cutoff 이전) 항목을 버린다.
 * @param entries 같은 문장의 관측 목록. 없으면 빈 목록으로 본다.
 * @param cutoff 이 시각 이하의 수신 기록은 창 밖이다.
 * @returns 창 안에 남은 관측 목록(새 배열)
 */
function withinWindow(entries: GroupEntry[] | undefined, cutoff: number): GroupEntry[] {
  return (entries ?? []).filter((entry) => entry.receivedAt > cutoff);
}

/**
 * 서로 다른 사용자 수가 기준 이상이면, 아직 넘기지 않은 앞선 메시지를 모아 돌려준다.
 * 이미 넘긴 메시지는 다시 넘기지 않아 숨김 요청이 중복되지 않게 한다.
 * @param entries 창 안의 같은 문장 관측 목록(마지막 항목이 이번 관측)
 * @param minDistinctUsers 떼도배로 볼 최소 서로 다른 사용자 수
 * @returns 발동 여부와 이번에 새로 넘길 앞선 메시지
 */
function evaluateGroup(entries: GroupEntry[], minDistinctUsers: number): GroupFloodObservation {
  const distinctUsers = new Set(entries.map((entry) => entry.ref.senderChannelId)).size;
  if (distinctUsers < minDistinctUsers) return { triggered: false, earlierRefs: [] };
  const current = entries[entries.length - 1] as GroupEntry;
  const earlierRefs = entries.filter((entry) => entry !== current && !entry.reported).map((entry) => entry.ref);
  for (const entry of entries) entry.reported = true;
  return { triggered: true, earlierRefs };
}

/**
 * 창이 지난 문장 키를 지워 메모리가 무한히 늘지 않게 한다.
 * @param entriesByText 문장별 관측 목록 맵(직접 수정한다)
 * @param cutoff 이 시각 이하만 남은 문장 키는 삭제한다
 */
function sweep(entriesByText: Map<string, GroupEntry[]>, cutoff: number): void {
  for (const [text, entries] of entriesByText) {
    const remaining = withinWindow(entries, cutoff);
    if (remaining.length === 0) entriesByText.delete(text);
    else entriesByText.set(text, remaining);
  }
}

/**
 * 개인 도배 감지기를 만든다. 창은 서버 수신 시각으로 계산한다.
 * @param options 창 길이·도배로 볼 최소 건수. 생략하면 스펙 기본값을 쓴다.
 * @returns observe로 관측을 넣는 감지기
 */
export function createPersonalFloodDetector(options: Partial<typeof PERSONAL_DEFAULTS> = {}): PersonalFloodDetector {
  const settings = { ...PERSONAL_DEFAULTS, ...options };
  const timesBySender = new Map<string, number[]>();
  let observations = 0;
  return {
    observe(senderChannelId, receivedAt) {
      observations += 1;
      if (observations % SWEEP_EVERY_OBSERVATIONS === 0) sweepTimes(timesBySender, receivedAt - settings.windowMs);
      const times = (timesBySender.get(senderChannelId) ?? []).filter((time) => time > receivedAt - settings.windowMs);
      times.push(receivedAt);
      timesBySender.set(senderChannelId, times);
      return times.length >= settings.maxMessages;
    },
  };
}

/**
 * 창 밖 시각만 남은 사용자를 지운다.
 * @param timesBySender 사용자별 수신 시각 목록 맵(직접 수정한다)
 * @param cutoff 이 시각 이하만 남은 사용자는 삭제한다
 */
function sweepTimes(timesBySender: Map<string, number[]>, cutoff: number): void {
  for (const [sender, times] of timesBySender) {
    if (times.every((time) => time <= cutoff)) timesBySender.delete(sender);
  }
}
