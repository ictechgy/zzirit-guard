import type { ChatEvent } from "./chatEvent.js";

/**
 * 같은 채팅이 다시 전달됐는지 가려낸다(K4).
 * 왜 필요한가: 치지직 숨김 API는 메시지를 (채팅 채널, 보낸 사람, 보낸 시각)으로 가리킨다. 같은 CHAT이 두 번 오면(재연결·중복 전달)
 * 파이프라인은 둘 다 따로 판정해 판정 행이 둘 생기고 되돌릴 수 없는 숨김 요청이 두 번 나간다.
 * 판정 전에 버려서 도배 집계·판정·실행기 어디에도 닿지 않게 한다.
 */
export interface RepeatedChatFilter {
  /**
   * 처음 보는 메시지면 기억하고 false, 10분 안에 본 메시지면 true를 돌려준다.
   * @param event 받은 채팅. 보낸 사람·보낸 시각으로 같은 메시지인지 보고, 받은 시각(receivedAt)으로 기한을 잰다
   */
  isRepeat(event: ChatEvent): boolean;
  /**
   * 기억한 메시지를 잊는다. 판정이 부작용 없이 실패했을 때 불러, 치지직이 같은 채팅을 다시 보내면 그때 판정하게 한다.
   * 왜: 기억만 남기고 판정이 실패하면 다시 온 같은 채팅이 중복으로 버려져 그 메시지는 끝내 판정되지 않는다.
   * @param event 판정에 실패한 채팅
   */
  forget(event: ChatEvent): void;
}

/**
 * 같은 메시지로 보는 기간(10분, 후보 목록 기간과 같다).
 * 왜 10분인가: 재연결 뒤 다시 전달되는 일은 길어야 몇 분 안이고, 그보다 오래 기억하면 메모리만 늘어난다.
 */
export const REPEATED_CHAT_WINDOW_MS = 10 * 60 * 1000;

/**
 * 기억하는 메시지 수의 상한(2만 건). 넘으면 가장 먼저 본 것부터 잊는다.
 * 왜: 떼도배로 10분 안에 채팅이 몰려도 메모리가 끝없이 늘지 않게 한다. 채팅 원문은 기억하지 않는다(보낸 사람·시각만).
 */
export const MAX_REMEMBERED_CHATS = 20_000;

/** 빈 중복 걸러내기를 만든다. 앱 하나에 하나만 만들어 채팅 수신 콜백에서 판정 전에 쓴다. */
export function createRepeatedChatFilter(): RepeatedChatFilter {
  /** 메시지 열쇠 → 처음 본 시각. Map의 삽입 순서가 곧 처음 본 순서라 앞에서부터 지우면 된다. */
  const firstSeenAt = new Map<string, number>();
  return {
    isRepeat(event) {
      forgetExpired(firstSeenAt, event.receivedAt);
      const key = messageKey(event);
      if (firstSeenAt.has(key)) return true;
      firstSeenAt.set(key, event.receivedAt);
      if (firstSeenAt.size > MAX_REMEMBERED_CHATS) firstSeenAt.delete(firstSeenAt.keys().next().value as string);
      return false;
    },
    forget: (event) => void firstSeenAt.delete(messageKey(event)),
  };
}

/**
 * 처음 본 지 10분이 지난 메시지를 앞에서부터 잊는다. 첫 번째로 기한 안인 항목에서 멈춰 한 번에 드는 비용이 작다.
 * @param firstSeenAt 메시지 열쇠 → 처음 본 시각
 * @param now 지금 받은 채팅의 수신 시각(ms)
 */
function forgetExpired(firstSeenAt: Map<string, number>, now: number): void {
  for (const [key, seenAt] of firstSeenAt) {
    if (now - seenAt < REPEATED_CHAT_WINDOW_MS) return;
    firstSeenAt.delete(key);
  }
}

/**
 * 메시지 열쇠: 보낸 시각과 보낸 사람. 보낸 시각은 숫자라 ':'가 없어 앞에 두면 열쇠가 겹치지 않는다.
 * @param event 받은 채팅
 */
function messageKey(event: ChatEvent): string {
  return `${event.messageTime}:${event.senderChannelId}`;
}
