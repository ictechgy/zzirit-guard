import { describe, expect, it } from "vitest";
import { hasPermission, permissionsFor, toManagerRole } from "../../src/managers/permissions.js";

describe("permissions", () => {
  it("스펙 7장 권한 표를 따른다", () => {
    expect(permissionsFor("STREAMING_CHANNEL_OWNER")).toContain("connect_channel");
    expect(hasPermission("STREAMING_CHANNEL_MANAGER", "connect_channel")).toBe(false);
    expect(hasPermission("STREAMING_CHANNEL_MANAGER", "enable_auto_hide")).toBe(true);
    expect(permissionsFor("STREAMING_CHAT_MANAGER").sort()).toEqual(["disable_auto_hide", "hide_message", "temporary_restrict"]);
  });

  it("정산 관리자와 모르는 역할은 접근할 수 없다", () => {
    expect(toManagerRole("STREAMING_SETTLEMENT_MANAGER")).toBeNull();
    expect(toManagerRole("SOMETHING_NEW")).toBeNull();
    expect(toManagerRole("constructor")).toBeNull();
    expect(toManagerRole("toString")).toBeNull();
    expect(toManagerRole("__proto__")).toBeNull();
    expect(toManagerRole("STREAMING_CHAT_MANAGER")).toBe("STREAMING_CHAT_MANAGER");
  });
});
