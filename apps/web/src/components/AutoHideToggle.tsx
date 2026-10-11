/** AutoHideToggle 속성. */
export interface AutoHideToggleProps {
  /** 지금 켜져 있는지. 서버 상태를 아직 모르면 null이고, 그동안은 누를 수 없다(모르는 상태에서 켜지 않도록). */
  enabled: boolean | null;
  /** 켜기 권한(enable_auto_hide)이 있는지. */
  canEnable: boolean;
  /** 끄기 권한(disable_auto_hide)이 있는지. */
  canDisable: boolean;
  /** 바꾸려는 값으로 부른다. */
  onChange(enabled: boolean): void;
}

/** 켜기 확인 문구. 숨긴 메시지는 되돌릴 수 없어서 한 번 더 묻는다. */
const ENABLE_CONFIRMATION = "자동 숨김을 켜면 규칙에 걸린 채팅이 바로 숨겨지고, 숨긴 채팅은 되돌릴 수 없습니다. 켤까요?";

/** 자동 숨김 스위치. 끄기는 바로, 켜기는 확인 후. 권한이 없거나 상태를 모르면 비활성. */
export function AutoHideToggle({ enabled, canEnable, canDisable, onChange }: AutoHideToggleProps) {
  if (enabled === null) return <button type="button" className="toggle" disabled>자동 숨김: 확인 중</button>;
  const allowed = enabled ? canDisable : canEnable;
  const handleClick = () => {
    if (!enabled && !window.confirm(ENABLE_CONFIRMATION)) return;
    onChange(!enabled);
  };
  return (
    <button type="button" className={`toggle ${enabled ? "toggle-on" : "toggle-off"}`} disabled={!allowed} onClick={handleClick}
      title={allowed ? undefined : "이 기능을 쓸 권한이 없습니다"}>
      자동 숨김: {enabled ? "켜짐" : "꺼짐"}
    </button>
  );
}
