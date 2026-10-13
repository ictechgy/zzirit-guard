import { useCallback, useState } from "react";

/** useUnknownOutcomeAlerts 결과. */
export interface UnknownOutcomeAlerts {
  /** 남겨 둔 알림 문구(같은 문구는 하나만, 먼저 온 순서). */
  messages: readonly string[];
  /**
   * 알림을 남긴다. 같은 문구가 이미 있으면 더하지 않는다. 렌더마다 같은 함수다.
   * @param message 보여 줄 문구
   */
  keep(message: string): void;
  /**
   * 알림 하나를 닫는다. 매니저가 '닫기'를 눌렀을 때만 부른다. 렌더마다 같은 함수다.
   * @param message 닫을 문구
   */
  dismiss(message: string): void;
}

/**
 * 결과를 알 수 없는 조치(시간 초과·result_unknown)의 알림을 매니저가 닫을 때까지 남긴다(K20).
 * 왜: 작업 결과 알림 하나를 같이 쓰면, 다른 조치를 시작하거나 성공할 때 "다시 누르지 마세요"가 지워지거나 덮여
 * 매니저가 같은 조치를 다시 보낼 수 있다.
 * 왜 같은 문구를 합치나: 문구는 몇 가지뿐이라(시간 초과·서버의 결과 모름·네트워크) 합쳐도 알릴 내용이 같고, 실패가 몰려도 알림이 화면을 덮지 않는다.
 */
export function useUnknownOutcomeAlerts(): UnknownOutcomeAlerts {
  const [messages, setMessages] = useState<readonly string[]>([]);
  const keep = useCallback((message: string) => setMessages((current) => (current.includes(message) ? current : [...current, message])), []);
  const dismiss = useCallback((message: string) => setMessages((current) => current.filter((item) => item !== message)), []);
  return { messages, keep, dismiss };
}
