/** 본 화면의 탭. */
export type Tab = "candidates" | "chat" | "settings";

/** 탭 이름. */
const TAB_LABELS: Record<Tab, string> = { candidates: "후보", chat: "실시간 채팅", settings: "기록·설정" };

/** TabBar 속성. */
export interface TabBarProps {
  /** 지금 보이는 탭. */
  active: Tab;
  /** 탭을 누르면 부른다. */
  onChange(tab: Tab): void;
  /** 후보 탭 배지: 처리를 기다리는 항목 수(사람 묶음 + 숨기지 못한 자동 숨김 건, countActionable). 메시지 건수가 아니다. */
  pendingCount: number;
}

/** 아래쪽 탭 막대. 후보 탭에는 처리를 기다리는 항목 수를 붙인다. */
export function TabBar({ active, onChange, pendingCount }: TabBarProps) {
  return (
    <nav className="tab-bar">
      {(Object.keys(TAB_LABELS) as Tab[]).map((tab) => (
        <button key={tab} type="button" aria-pressed={tab === active} onClick={() => onChange(tab)}>
          {TAB_LABELS[tab]}
          {tab === "candidates" && pendingCount > 0 && <span className="badge">{pendingCount}</span>}
        </button>
      ))}
    </nav>
  );
}
