import type { ChatLine, Decision } from "@zzirit-guard/shared";
import { useState } from "react";

/** 판정 표시 이름. 통과는 표시하지 않는다. */
const DECISION_LABELS: Record<Decision, string | null> = {
  pass: null, candidate: "후보", shadow: "섀도", auto_hide: "자동 숨김", needs_care: "도움 필요",
};

/** 실시간 채팅 화면 속성. */
export interface LiveChatScreenProps {
  /** 최근 채팅 줄(오래된 것부터, 최대 MAX_CHAT_LINES개). */
  lines: readonly ChatLine[];
}

/** 실시간 채팅 화면(스펙 6장 ②): 위험 메시지 강조, 위험한 것만 보기. 최신 줄이 위로 온다. */
export function LiveChatScreen({ lines }: LiveChatScreenProps) {
  const [riskyOnly, setRiskyOnly] = useState(false);
  const visible = (riskyOnly ? lines.filter((line) => line.decision !== "pass") : lines).slice().reverse();
  return (
    <section className="screen">
      <label className="filter">
        <input type="checkbox" checked={riskyOnly} onChange={(event) => setRiskyOnly(event.target.checked)} />
        위험한 것만 보기
      </label>
      {visible.length === 0 && <p className="empty">표시할 채팅이 없습니다.</p>}
      <ol className="chat-lines">
        {visible.map((line, index) => (
          <li key={`${line.messageTime}-${index}`} className={`chat-line chat-${line.decision}`}>
            <span className="nickname">{line.senderNickname}</span>
            <span className="content">{line.content}</span>
            {DECISION_LABELS[line.decision] && <span className="tag">{DECISION_LABELS[line.decision]}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
