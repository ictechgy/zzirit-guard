import { useEffect } from "react";

/**
 * 화면에 남기는 동작 결과. 없으면 null.
 * ok는 성공, info는 실패가 아닌 알림(예: 이미 처리된 항목이라 목록을 다시 읽음), error는 실패다. ok·info는 잠깐 보이고 error는 닫을 때까지 남는다.
 */
export type ActionFeedback = { kind: "ok" | "info" | "error"; message: string } | null;

/**
 * 성공 안내를 보여 주는 시간(4초).
 * 왜: 결과는 목록 변화로도 보이므로 안내는 잠깐이면 된다. 오류는 놓치면 안 돼 닫을 때까지 남긴다.
 */
export const SUCCESS_TOAST_MS = 4_000;

/** ActionToast 속성. */
export interface ActionToastProps {
  /** 보여 줄 결과. null이면 그리지 않는다. */
  feedback: ActionFeedback;
  /** 알림을 닫는다. 성공 안내는 SUCCESS_TOAST_MS 뒤 스스로 부른다. 렌더마다 같은 함수여야 시간이 다시 시작되지 않는다. */
  onDismiss(): void;
}

/**
 * 동작 결과 알림: 탭 막대 바로 위에 떠 있는 토스트(F9, 스모크 S3).
 * 왜 아래쪽인가: 결과를 맨 위에만 보이면, 목록 아래에서 누른 매니저는 성공·실패를 못 본다(성공한 숨기기는 아무것도 안 보였다).
 * 성공·안내는 status로 읽어 주고 4초 뒤 사라진다. 오류는 alert로 읽어 주고 닫을 때까지 남는다.
 * 알림 자체에는 이름(aria-label)을 붙이지 않는다(W4, X33). 왜: 이름이 있으면 스크린리더가 결과 문구 대신 "작업 결과"만 읽는다.
 */
export function ActionToast({ feedback, onDismiss }: ActionToastProps) {
  useEffect(() => {
    if (!feedback || feedback.kind === "error") return;
    const timer = setTimeout(onDismiss, SUCCESS_TOAST_MS);
    return () => clearTimeout(timer);
  }, [feedback, onDismiss]);
  if (!feedback) return null;
  if (feedback.kind !== "error") return <p className={feedback.kind === "ok" ? "toast feedback" : "toast info"} role="status">{feedback.message}</p>;
  return (
    <div className="toast error" role="alert">
      <p>{feedback.message}</p>
      <button type="button" aria-label="작업 결과 닫기" onClick={onDismiss}>닫기</button>
    </div>
  );
}

/** UnknownOutcomeToasts 속성. */
export interface UnknownOutcomeToastsProps {
  /** 남겨 둔 알림 문구들(useUnknownOutcomeAlerts). */
  messages: readonly string[];
  /** 문구 하나를 닫는다. */
  onDismiss(message: string): void;
}

/**
 * 결과를 알 수 없는 조치의 알림들(K20). 오류 알림과 같은 모양이고, 매니저가 닫기 전에는 사라지지 않는다.
 * 작업 결과 알림(ActionToast 하나)과 따로 그려, 다른 조치의 결과가 이 알림을 지우거나 덮지 못한다.
 */
export function UnknownOutcomeToasts({ messages, onDismiss }: UnknownOutcomeToastsProps) {
  return <>{messages.map((message) => <ActionToast key={message} feedback={{ kind: "error", message }} onDismiss={() => onDismiss(message)} />)}</>;
}
