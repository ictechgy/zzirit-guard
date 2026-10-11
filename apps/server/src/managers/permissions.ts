import type { ManagerRole, Permission } from "@zzirit-guard/shared";

/** 모든 권한. */
const ALL_PERMISSIONS: readonly Permission[] = [
  "connect_channel", "disable_auto_hide", "enable_auto_hide", "edit_rules", "hide_message",
  "temporary_restrict", "restrict", "edit_chat_settings", "view_audit",
];

/**
 * 역할별 권한(스펙 7장). 끄기는 안전한 방향이라 채팅 운영자에게도 준다.
 * 채널 연결·해제는 스트리머만 한다.
 */
const ROLE_PERMISSIONS: Readonly<Record<ManagerRole, readonly Permission[]>> = {
  STREAMING_CHANNEL_OWNER: ALL_PERMISSIONS,
  STREAMING_CHANNEL_MANAGER: ALL_PERMISSIONS.filter((permission) => permission !== "connect_channel"),
  STREAMING_CHAT_MANAGER: ["disable_auto_hide", "hide_message", "temporary_restrict"],
};

/** 역할의 권한 목록. */
export function permissionsFor(role: ManagerRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/** 역할이 권한을 가졌는지 본다. */
export function hasPermission(role: ManagerRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** 치지직 userRole 문자열을 앱 역할로 바꾼다. 정산 관리자·모르는 역할은 null(접근 불가). */
export function toManagerRole(userRole: string): ManagerRole | null {
  return userRole in ROLE_PERMISSIONS ? (userRole as ManagerRole) : null;
}
