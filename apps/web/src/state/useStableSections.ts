import type { VerdictStatus } from "@zzirit-guard/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { actionableVerdicts, allVerdicts, type CandidateSections } from "../domain/candidates";

/**
 * 손을 뗀 뒤에도 목록을 고정해 두는 시간(1.5초).
 * 왜: 누른 직후 목록이 바뀌면 다음 탭이 엉뚱한 줄에 떨어진다. 손가락이 화면을 떠난 직후에 이어 누르는 경우까지 덮는다.
 */
export const FREEZE_GRACE_MS = 1_500;
/** 목록을 이만큼(80px) 넘게 내려 본 동안에도 고정한다. 읽던 줄이 밀려 내려가지 않게 한다. */
export const FREEZE_SCROLL_THRESHOLD_PX = 80;
/** 누르기가 끝났다고 보는 이벤트. 손가락이 목록 밖에서 떨어질 수 있어 문서 전체에서 듣는다. */
const RELEASE_EVENTS = ["pointerup", "pointercancel", "touchend", "touchcancel"] as const;

/** useStableSections 결과. */
export interface StableSections {
  /** 화면에 그릴 구역. 고정 중이면 고정한 순간의 구역이다. */
  sections: CandidateSections;
  /** 고정한 화면에서 이미 처리된(상태가 바뀌었거나 사라진) 판정 번호. 고정 중이 아니면 비어 있다. */
  handledIds: ReadonlySet<number>;
  /** 고정한 뒤 새로 들어온, 처리를 기다리는 판정 수("새 항목 N개"). */
  newCount: number;
  /** 최신 구역을 바로 보여 주고 맨 위로 올린다("보기" 버튼). */
  showLatest(): void;
}

/** 빈 번호 집합. 고정 중이 아닐 때 렌더마다 새 집합을 만들지 않으려고 하나를 같이 쓴다. */
const NO_IDS: ReadonlySet<number> = new Set();

/**
 * 매니저가 목록을 만지는 동안 후보 구역을 고정한다(F4, 스모크 S1).
 * 왜: 초당 몇 건만 와도 사람 묶음이 계속 자리를 바꿔, 누르려던 줄 대신 다른 사람의 메시지를 숨길 수 있다. 숨김은 되돌릴 수 없다.
 * 고정 조건: 목록 안을 누르고 있는 동안, 손을 뗀 뒤 FREEZE_GRACE_MS 동안, 창을 FREEZE_SCROLL_THRESHOLD_PX 넘게 내려 본 동안.
 * 고정 중에는 고정한 순간의 구역을 그대로 보여 주고, 그사이 처리된 줄은 지우지 않고 handledIds로 알려 흐리게 남긴다(줄이 빠져도 자리가 밀린다).
 * 새로 들어온 항목 수는 newCount로 알려 "보기"를 누르게 한다. 고정이 풀리면(맨 위에서 손을 놓고 잠시 지나면) 최신 구역을 보여 준다.
 * @param latest 최신 구역(MainScreen이 계산한 값)
 * @param containerRef 목록 영역. 이 안에서 누를 때만 고정한다(스위치·다시 불러오기 버튼은 제외).
 */
export function useStableSections(latest: CandidateSections, containerRef: RefObject<HTMLElement | null>): StableSections {
  const isFrozen = useInteractionFreeze(containerRef);
  const [snapshot, setSnapshot] = useState<CandidateSections | null>(null);
  // 렌더 중 상태 맞추기(React 문서 "이전 렌더의 정보 저장"): 고정이 시작되면 그 순간의 구역을 잡고, 풀리면 놓는다.
  if (isFrozen && snapshot === null) setSnapshot(latest);
  if (!isFrozen && snapshot !== null) setSnapshot(null);
  const latestRef = useRef(latest);
  useEffect(() => {
    latestRef.current = latest;
  }, [latest]);
  const showLatest = useCallback(() => {
    setSnapshot((current) => (current === null ? null : latestRef.current));
    window.scrollTo({ top: 0 });
  }, []);
  const comparison = useMemo(() => (snapshot === null ? null : compareSnapshot(snapshot, latest)), [snapshot, latest]);
  return { sections: snapshot ?? latest, handledIds: comparison?.handledIds ?? NO_IDS, newCount: comparison?.newCount ?? 0, showLatest };
}

/**
 * 고정한 구역과 최신 구역을 비교한다.
 * @returns 고정 화면에서 처리된 판정 번호와, 고정 뒤 새로 들어온 처리 대기 판정 수
 */
function compareSnapshot(snapshot: CandidateSections, latest: CandidateSections): { handledIds: ReadonlySet<number>; newCount: number } {
  const latestStatus = new Map<number, VerdictStatus>(allVerdicts(latest).map((verdict) => [verdict.id, verdict.status]));
  const shown = allVerdicts(snapshot);
  const handledIds = new Set(shown.filter((verdict) => latestStatus.get(verdict.id) !== verdict.status).map((verdict) => verdict.id));
  const shownIds = new Set(shown.map((verdict) => verdict.id));
  const newCount = actionableVerdicts(latest).filter((verdict) => !shownIds.has(verdict.id)).length;
  return { handledIds, newCount };
}

/**
 * 목록을 만지는 중인지(누르는 중·손을 뗀 직후·아래로 내려 본 중) 알려 준다.
 * @param containerRef 누르기를 감지할 목록 영역
 */
function useInteractionFreeze(containerRef: RefObject<HTMLElement | null>): boolean {
  const [isPressing, setPressing] = useState(false);
  const [isSettling, setSettling] = useState(false);
  const isScrolledAway = useScrolledAway();
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return listenForPress(container, {
      onPress: () => {
        setSettling(false);
        setPressing(true);
      },
      onRelease: () => {
        setPressing(false);
        setSettling(true);
      },
      onSettled: () => setSettling(false),
    });
  }, [containerRef]);
  return isPressing || isSettling || isScrolledAway;
}

/** 누르기 감지 콜백. */
interface PressHandlers {
  /** 목록 안을 누르기 시작했다. */
  onPress(): void;
  /** 손을 뗐다(FREEZE_GRACE_MS 뒤 onSettled가 온다). */
  onRelease(): void;
  /** 손을 뗀 뒤 FREEZE_GRACE_MS가 지났다(그사이 다시 누르면 오지 않는다). */
  onSettled(): void;
}

/**
 * 목록 안의 누르기와 문서 어디서든의 손 떼기를 듣는다. pointer와 touch를 둘 다 듣는 이유: 일부 모바일 브라우저는 스크롤을 시작하면 pointercancel만 보낸다.
 * 화면이 숨겨지는 것(visibilitychange → hidden)도 손 떼기로 본다(B19-8): 누른 채 다른 앱으로 넘어가면 손 떼기 이벤트가 오지 않아 고정이 영영 풀리지 않는다.
 * @param container 목록 영역
 * @param handlers 누르기·손 떼기·안정 콜백
 * @returns 듣기를 멈추고 남은 타이머를 지우는 함수
 */
function listenForPress(container: HTMLElement, handlers: PressHandlers): () => void {
  let isHeld = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const press = () => {
    isHeld = true;
    clearTimeout(timer);
    handlers.onPress();
  };
  const release = () => {
    if (!isHeld) return;
    isHeld = false;
    handlers.onRelease();
    clearTimeout(timer);
    timer = setTimeout(handlers.onSettled, FREEZE_GRACE_MS);
  };
  const releaseWhenHidden = () => {
    if (document.visibilityState === "hidden") release();
  };
  container.addEventListener("pointerdown", press);
  container.addEventListener("touchstart", press, { passive: true });
  RELEASE_EVENTS.forEach((type) => document.addEventListener(type, release));
  document.addEventListener("visibilitychange", releaseWhenHidden);
  return () => {
    container.removeEventListener("pointerdown", press);
    container.removeEventListener("touchstart", press);
    RELEASE_EVENTS.forEach((type) => document.removeEventListener(type, release));
    document.removeEventListener("visibilitychange", releaseWhenHidden);
    clearTimeout(timer);
  };
}

/** 창을 FREEZE_SCROLL_THRESHOLD_PX 넘게 내려 본 상태인지. 값이 바뀔 때만 다시 그린다(같은 값 setState는 React가 건너뛴다). */
function useScrolledAway(): boolean {
  const [isAway, setAway] = useState(() => window.scrollY > FREEZE_SCROLL_THRESHOLD_PX);
  useEffect(() => {
    const update = () => setAway(window.scrollY > FREEZE_SCROLL_THRESHOLD_PX);
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return isAway;
}
