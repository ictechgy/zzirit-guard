/**
 * 첫 채팅 사용자: 논리 세션(앱이 채팅 수신기를 시작한 때부터 멈출 때까지) 동안 처음 본 보낸 사람(스펙 5.4 우선순위, 계획 R6).
 * 소켓이 잠깐 끊겼다 이어지는 것은 세션을 바꾸지 않는다(그때마다 비우면 돌아온 시청자가 모두 '처음'이 되어 진짜 새 사용자를 밀어낸다).
 * 상한을 넘으면 가장 오래 안 본 사람부터 뺀다(한꺼번에 비우지 않는다).
 */
export interface FirstChatters {
  /**
   * 보낸 사람을 기록하고, 이번 세션에서 처음이면 true를 준다.
   * @param senderChannelId 보낸 사람 채널 ID
   */
  observe(senderChannelId: string): boolean;
  /** 비운다(세션 초기화). */
  clear(): void;
}

/** 기억하는 사람 수 상한 기본값. */
export const FIRST_CHATTER_CAPACITY = 200_000;

/**
 * 첫 채팅 사용자 집합을 만든다.
 * @param capacity 기억하는 사람 수 상한
 */
export function createFirstChatters(capacity = FIRST_CHATTER_CAPACITY): FirstChatters {
  let seen = new Set<string>();
  return {
    observe(senderChannelId) {
      const isFirst = !seen.delete(senderChannelId);
      seen.add(senderChannelId);
      if (seen.size > capacity) seen.delete(seen.values().next().value as string);
      return isFirst;
    },
    clear: () => void (seen = new Set()),
  };
}
