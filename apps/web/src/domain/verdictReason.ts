/**
 * 판정 이유의 규칙 종류별 이름. 키는 서버 판정 이유 "rule:<종류>[:<규칙 번호>]"의 <종류>다(apps/server/src/detection/pipeline.ts decide).
 * 왜 Map인가: 객체 표로 두면 "rule:toString" 같은 값이 프로토타입 함수를 꺼내 이름으로 보여 준다.
 */
const RULE_LABELS: ReadonlyMap<string, string> = new Map([
  ["strong", "금칙어 강"], ["strong_spanning", "금칙어 강(띄어 쓰거나 단어를 걸침)"], ["weak", "금칙어 약"], ["threat", "협박 표현"],
  ["group_flood", "떼도배"], ["personal_flood", "개인 도배"], ["link", "광고 링크"], ["phone", "전화번호"], ["address", "주소"],
  ["watch_user", "요주의 사용자(최근 180일 조치 이력)"], ["allow", "허용어"],
  ["link_glued", "광고 링크 의심(허용 주소 앞에 한글이 붙어 다른 주소일 수 있음)"], ["link_idn", "한글 주소(후보)"],
]);
/**
 * 자동 숨김 대신 후보로 낮췄다는 꼬리표와 화면 문구(pipeline.ts applyPrivilege).
 * privileged는 스트리머·매니저 본인 메시지, unknown_role은 역할 코드가 빠졌거나 처음 보는 값이라 권한자인지 모르는 메시지다(S18).
 */
const DOWNGRADE_SUFFIXES: ReadonlyArray<{ suffix: string; note: string }> = [
  { suffix: ":privileged", note: " · 스트리머·매니저 메시지라 후보로 낮춤" },
  { suffix: ":unknown_role", note: " · 보낸 사람의 역할을 알 수 없어 후보로 낮춤" },
];
/** 규칙 번호가 든 이유의 모양: rule:<종류>:<번호>[:privileged|:unknown_role]. */
const RULE_ID_PATTERN = /^rule:[a-z_]+:(\d+)(?::privileged|:unknown_role)?$/;

/**
 * 판정 이유를 매니저가 읽을 수 있는 문구로 바꾼다(스펙 5.5 "자동 숨김마다 이유(규칙 번호)를 표시").
 * 모르는 이유(2단계 AI 판정 등)는 원문 그대로 보여 준다.
 * @param reason 서버 판정 이유(예: rule:strong:12, rule:group_flood:privileged)
 * @returns 예: "금칙어 강 #12", "떼도배 · 스트리머·매니저 메시지라 후보로 낮춤"
 */
export function describeReason(reason: string): string {
  const downgrade = DOWNGRADE_SUFFIXES.find(({ suffix }) => reason.endsWith(suffix));
  const [prefix, kind, ruleId] = (downgrade ? reason.slice(0, -downgrade.suffix.length) : reason).split(":");
  const label = prefix === "rule" && kind ? RULE_LABELS.get(kind) : undefined;
  if (!label) return reason;
  return `${label}${ruleId ? ` #${ruleId}` : ""}${downgrade?.note ?? ""}`;
}

/** 이유에서 규칙 번호를 꺼낸다. 규칙 번호가 없는 이유(떼도배·링크 등)면 null. 오판 검토 목록이 규칙 내용을 찾을 때 쓴다. */
export function ruleIdOf(reason: string): number | null {
  const match = RULE_ID_PATTERN.exec(reason);
  return match ? Number(match[1]) : null;
}
