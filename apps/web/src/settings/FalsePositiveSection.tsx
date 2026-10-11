import type { FalsePositiveReviewDto, RuleEntryDto } from "@zzirit-guard/shared";
import { useApiResource } from "../api/useApiResource";
import { describeReason, ruleIdOf } from "../domain/verdictReason";

/** 최근 오판을 몇 건까지 읽을지. 서버 상한(200) 안에서 휴대폰 화면에 맞게 줄였다. */
const RECENT_LIMIT = 20;

/** 이유를 규칙 내용까지 붙여 보여 준다. 예: "금칙어 강 #3 '내용'". 규칙이 지워졌거나 아직 못 읽었으면 이유만. */
function describeWithPattern(reason: string, patterns: ReadonlyMap<number, string>): string {
  const ruleId = ruleIdOf(reason);
  const pattern = ruleId === null ? undefined : patterns.get(ruleId);
  return pattern ? `${describeReason(reason)} '${pattern}'` : describeReason(reason);
}

/**
 * 오판 검토 목록(스펙 5.5 "오판을 누르면 그 규칙이 검토 목록에 올라간다", R-16).
 * 오판이 많이 나온 규칙부터 보여 줘 예외 단어·허용어를 먼저 손보게 한다. 읽기 전용이라 로그인한 매니저면 누구나 본다.
 */
export function FalsePositiveSection() {
  const review = useApiResource<FalsePositiveReviewDto>(`/api/false-positives?limit=${RECENT_LIMIT}`);
  const rules = useApiResource<RuleEntryDto[]>("/api/rules");
  const patterns = new Map((rules.data ?? []).map((rule) => [rule.id, rule.pattern]));
  const data = review.data ?? { recent: [], byReason: [] };
  return (
    <section>
      <h2>오판 검토</h2>
      {review.error && <p className="error" role="alert">{review.error}</p>}
      {data.byReason.length === 0 ? <p className="hint">오판 신고가 없습니다.</p> : (
        <ul className="false-positive-counts">
          {data.byReason.map(({ reason, count }) => <li key={reason}>{`${describeWithPattern(reason, patterns)} — ${count}건`}</li>)}
        </ul>
      )}
      {data.recent.length > 0 && (
        <details>
          <summary>최근 오판 {data.recent.length}건</summary>
          <ul className="messages">
            {data.recent.map((verdict) => (
              <li key={verdict.id} className="message">
                <span className="content">{`${verdict.senderNickname}: ${verdict.content}`}</span>
                <span className="reason">{describeReason(verdict.reason)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
