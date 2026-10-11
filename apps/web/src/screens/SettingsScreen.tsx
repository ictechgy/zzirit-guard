import type { MeDto } from "@zzirit-guard/shared";
import { AccountSection } from "../settings/AccountSection";
import { AuditSection } from "../settings/AuditSection";
import { ChatSettingsSection } from "../settings/ChatSettingsSection";
import { FalsePositiveSection } from "../settings/FalsePositiveSection";
import { LimitsSection } from "../settings/LimitsSection";
import { RulesSection } from "../settings/RulesSection";
import { StatsSection } from "../settings/StatsSection";
import { StatusSection } from "../settings/StatusSection";

/** 기록·설정 화면 속성. */
export interface SettingsScreenProps {
  /** 로그인한 매니저. */
  me: MeDto;
  /** 로그아웃·연결 해제 뒤 로그인 화면으로 돌아갈 때 부른다(message는 로그인 화면 안내). */
  onSignedOut(message: string | null): void;
}

/** 기록·설정 화면(스펙 6장 ③). 영구 제한·해제는 이 앱에 없다: 치지직 기본 도구로 한다(B4, 운영 안내서). */
export function SettingsScreen({ me, onSignedOut }: SettingsScreenProps) {
  return (
    <section className="screen settings">
      <StatusSection />
      <StatsSection />
      <FalsePositiveSection />
      <RulesSection me={me} />
      <LimitsSection me={me} />
      <ChatSettingsSection me={me} />
      <AuditSection me={me} />
      <AccountSection me={me} onSignedOut={onSignedOut} />
    </section>
  );
}
