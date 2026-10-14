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
  /**
   * 바뀌면 통계·오판 검토·규칙·한도·감사 기록을 다시 읽는다. MainScreen이 설정 탭을 열 때마다 올린다(F6).
   * 채팅 설정은 넣지 않는다: 서버가 치지직 API를 직접 부르므로 탭을 열 때마다 부르면 호출이 늘어난다(저속 모드를 바꿀 때 다시 읽는다, F5).
   * 상태 점검은 스스로 15초마다 다시 읽는다.
   */
  refreshKey: number;
  /** 머리의 '새로 고침'을 누르면 부른다(refreshKey를 올린다). iOS 홈 화면 앱에는 새로고침이 없다. */
  onRefresh(): void;
  /** 서버가 AI 단계를 켰는지(실시간 상태). 켜져 있을 때만 AI 임계값을 보인다. 생략하면 꺼짐으로 본다. */
  aiEnabled?: boolean;
}

/** 기록·설정 화면(스펙 6장 ③). 영구 제한·해제는 이 앱에 없다: 치지직 기본 도구로 한다(B4, 운영 안내서). */
export function SettingsScreen({ me, onSignedOut, refreshKey, onRefresh, aiEnabled = false }: SettingsScreenProps) {
  return (
    <section className="screen settings">
      <div className="toolbar">
        <button type="button" onClick={onRefresh}>새로 고침</button>
      </div>
      <StatusSection />
      <StatsSection refreshKey={refreshKey} aiEnabled={aiEnabled} />
      <FalsePositiveSection refreshKey={refreshKey} />
      <RulesSection me={me} refreshKey={refreshKey} />
      <p className="hint">영구 제한·해제는 치지직 기본 도구에서 합니다.</p>
      <LimitsSection me={me} refreshKey={refreshKey} aiEnabled={aiEnabled} />
      <ChatSettingsSection me={me} />
      <AuditSection me={me} refreshKey={refreshKey} />
      <AccountSection me={me} onSignedOut={onSignedOut} />
    </section>
  );
}
