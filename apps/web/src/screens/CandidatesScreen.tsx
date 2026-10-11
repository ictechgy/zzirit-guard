import type { MeDto, ServerStatus, VerdictDto } from "@zzirit-guard/shared";
import { useState } from "react";
import { ApiError, describeApiError } from "../api/client";
import { AutoHiddenList, AutoHidePendingList } from "../components/AutoHideLists";
import { AutoHideToggle } from "../components/AutoHideToggle";
import { CandidateGroupCard, type GroupKind } from "../components/CandidateGroupCard";
import { StatusBanner } from "../components/StatusBanner";
import { countActionable, type CandidateSections, type SenderGroup } from "../domain/candidates";

/** 후보 화면이 부르는 동작. 성공하면 화면에 보여 줄 안내(없으면 null)를 돌려준다. MainScreen이 API로 채우고, 테스트는 가짜를 넘긴다. */
export interface CandidateActions {
  /** 메시지 하나를 숨긴다. */
  hide(verdict: VerdictDto): Promise<string | null>;
  /** 사람 단위 임시 제한. */
  temporaryRestrict(group: SenderGroup): Promise<string | null>;
  /** 후보를 무시로 표시한다(대기 중인 것만). */
  ignore(verdict: VerdictDto): Promise<string | null>;
  /** 오판으로 신고한다(오판 검토 목록에 오른다). */
  reportFalsePositive(verdict: VerdictDto): Promise<string | null>;
  /** 자동 숨김 스위치를 켜거나 끈다. */
  setAutoHide(enabled: boolean): Promise<string | null>;
}

/** 동작 하나를 실행하고 결과(안내 또는 오류)를 화면에 남기는 함수. */
export type ActionRunner = (task: () => Promise<string | null>) => void;

/** 후보 화면 속성. */
export interface CandidatesScreenProps {
  /** 로그인한 매니저(권한으로 버튼을 켠다). */
  me: MeDto;
  /** 서버 상태. 아직 모르면 null. */
  status: ServerStatus | null;
  /** MainScreen이 한 번 계산한 구역(탭 배지와 같은 값을 쓰려고 위에서 받는다). */
  sections: CandidateSections;
  /** 실시간 연결이 살아 있는지. */
  realtimeConnected: boolean;
  /** 후보 화면 동작. */
  actions: CandidateActions;
  /** 서버에서 상태·후보를 다시 읽는다(iOS 홈 화면 앱에는 새로고침이 없다). */
  onReload(): void;
}

/** 화면에 남기는 동작 결과. */
type Feedback = { kind: "ok" | "error"; message: string } | null;

/** 사람 단위 구역의 제목과 종류. 순서가 화면 순서다(스펙 5.1: 섀도는 후보 목록 위). */
const GROUP_SECTIONS: ReadonlyArray<{ key: "care" | "shadow" | "candidates"; kind: GroupKind; title: string }> = [
  { key: "care", kind: "care", title: "도움 필요(자해·자살 신호)" },
  { key: "shadow", kind: "shadow", title: "켜져 있었으면 숨겼을 메시지" },
  { key: "candidates", kind: "candidate", title: "후보" },
];

/**
 * 동작 실행기를 만든다. 성공하면 안내를, 실패하면 서버 문구를 남긴다.
 * 이미 처리된 판정(409 already_handled)이면 화면이 낡은 것이므로 목록을 다시 읽는다(R-13).
 */
function createRunner(setFeedback: (feedback: Feedback) => void, onReload: () => void): ActionRunner {
  return (task) => {
    setFeedback(null);
    task().then(
      (message) => setFeedback(message ? { kind: "ok", message } : null),
      (error: unknown) => {
        setFeedback({ kind: "error", message: describeApiError(error) });
        if (error instanceof ApiError && error.code === "already_handled") onReload();
      },
    );
  };
}

/** 후보 화면(스펙 6장 ①): 상태 배너·스위치·구역별 사람 단위 묶음·자동 숨김 목록. */
export function CandidatesScreen({ me, status, sections, realtimeConnected, actions, onReload }: CandidatesScreenProps) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const run = createRunner(setFeedback, onReload);
  const canHide = me.permissions.includes("hide_message");
  return (
    <section className="screen">
      <StatusBanner status={status} realtimeConnected={realtimeConnected} />
      <div className="toolbar">
        <AutoHideToggle enabled={status?.autoHideEnabled ?? null} canEnable={me.permissions.includes("enable_auto_hide")}
          canDisable={me.permissions.includes("disable_auto_hide")} onChange={(enabled) => run(() => actions.setAutoHide(enabled))} />
        <button type="button" onClick={onReload}>다시 불러오기</button>
      </div>
      <FeedbackLine feedback={feedback} />
      {GROUP_SECTIONS.map(({ key, kind, title }) => (
        <GroupSection key={key} title={title} groups={sections[key]} kind={kind} me={me} run={run} actions={actions} />
      ))}
      {countActionable(sections) === 0 && <p className="empty">지금 확인할 후보가 없습니다.</p>}
      <AutoHidePendingList verdicts={sections.autoHidePending} canHide={canHide} run={run} actions={actions} />
      <AutoHiddenList verdicts={sections.autoHidden} canHide={canHide} run={run} actions={actions} />
    </section>
  );
}

/** 동작 결과 한 줄. 오류는 alert, 안내는 status로 읽어 준다. */
function FeedbackLine({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return feedback.kind === "error" ? <p className="error" role="alert">{feedback.message}</p> : <p className="feedback" role="status">{feedback.message}</p>;
}

/** 사람 단위 구역 하나의 속성. */
interface GroupSectionProps {
  /** 구역 제목. */
  title: string;
  /** 이 구역의 사람 묶음. */
  groups: readonly SenderGroup[];
  /** 카드 종류. */
  kind: GroupKind;
  /** 로그인한 매니저. */
  me: MeDto;
  /** 동작 실행기. */
  run: ActionRunner;
  /** 후보 화면 동작. */
  actions: CandidateActions;
}

/** 구역 하나. 비어 있으면 그리지 않는다. */
function GroupSection({ title, groups, kind, me, run, actions }: GroupSectionProps) {
  if (groups.length === 0) return null;
  return (
    <section className={`section section-${kind}`}>
      <h2>{title}</h2>
      {groups.map((group) => (
        <CandidateGroupCard key={group.senderChannelId} group={group} kind={kind} permissions={me.permissions} run={run} actions={actions} />
      ))}
    </section>
  );
}
