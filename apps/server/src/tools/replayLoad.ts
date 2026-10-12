// 부하 재생 도구: 합성 채팅을 초당 N건으로 판정 파이프라인에 흘려 처리 시간과 밀린 시간을 잰다(스펙 13장).
// 사용법: npm run build -w @zzirit-guard/server && npm run replay -w @zzirit-guard/server -- --rate 50 --seconds 600
// 치지직에 연결하지 않는다. 메모리 DB와 아무것도 하지 않는 실행기를 써서 네트워크를 전혀 타지 않는다.
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createAutoHideSwitch } from "../actions/autoHideSwitch.js";
import { createDecisionHandler } from "../actions/decisionHandler.js";
import type { Executor } from "../actions/executor.js";
import { createVerdictClaims } from "../actions/verdictClaims.js";
import type { ChatEvent } from "../chat/chatEvent.js";
import { openDatabase } from "../db/database.js";
import { createGroupFloodDetector, createPersonalFloodDetector } from "../detection/floodDetectors.js";
import { createDuplicateTracker } from "../detection/messageTraits.js";
import { createDetectionPipeline } from "../detection/pipeline.js";
import { createRuleRepository } from "../detection/ruleRepository.js";
import { silentLogger } from "../logger.js";
import { createAuditLog } from "../records/auditLog.js";
import { createMinuteStats } from "../records/minuteStats.js";
import { createSettingsRepository } from "../records/settingsRepository.js";
import { createVerdictRepository } from "../records/verdictRepository.js";

/**
 * 명령행 출력 맨 앞에 붙는 측정 범위 표기. 스펙 13장 근거로 옮길 때 이 범위를 함께 적어야 오해가 없다.
 * CLI 출력에만 붙이고 ReplayReport에는 넣지 않는다. 라이브러리 호출자는 범위를 이미 알고 있기 때문이다.
 */
const SCOPE_NOTE = "규칙 판정+판정 처리+메모리 SQLite 쓰기만 측정. 실행기·치지직 네트워크 제외, 자동 숨김 스위치 꺼짐(섀도 기록). 지연(lateness) 1~2ms는 타이머 해상도 때문이며 정상, 10ms 이상이면 처리 지연";

/** 재생 설정. */
export interface ReplayOptions {
  ratePerSecond: number;
  seconds: number;
}

/**
 * 재생 결과. achievedPerSecond가 목표보다 낮으면 처리가 밀린 것이다.
 * 지연 필드(p95LatenessMs·maxLatenessMs)는 처리 시간만 재면 보이지 않는 멈춤의 영향을 드러내려고 따로 둔다(누락 보정).
 */
export interface ReplayReport {
  messages: number;
  elapsedMs: number;
  achievedPerSecond: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /**
   * 예정 시각부터 실제 처리 시작까지 밀린 시간의 95분위. 타이머(setTimeout)는 정수 ms로 깨어나 예정 시각 이후에 실행되므로
   * 정상 상태에서도 1~2ms의 바닥값이 깔린다. 이 값은 타이머 해상도 때문이며 정상이다. 10ms 이상이어야 처리 지연(멈춤)으로 본다.
   * 처리 시간(p95Ms)만 재면 멈춤 뒤에 줄 선 메시지가 빠르게 찍혀 이 값이 0에 가깝게 보인다.
   */
  p95LatenessMs: number;
  /**
   * 밀린 시간의 최댓값. 0보다 크다고 밀린 것은 아니다. 타이머 해상도 때문에 정상 실행에서도 1~2ms가 나온다.
   * 10ms 이상일 때만 목표 속도를 따라가지 못한 멈춤으로 본다. 값의 크기는 가장 길게 멈춘 구간이 뒤 메시지에 전가된 정도다.
   */
  maxLatenessMs: number;
  decisions: Record<string, number>;
  /** 판정 이유(reason) 전체 문자열별 건수. 개인 도배 같은 규칙 경로가 실제로 지나갔는지 확인하는 용도다. */
  reasons: Record<string, number>;
}

/** runPaced가 돌려주는 원자료. 건마다 처리 시간과 밀린 시간을 담는다. */
export interface PacedRun {
  elapsedMs: number;
  serviceMs: number[];
  latenessMs: number[];
}

/**
 * 명령행 인자가 잘못됐을 때 던진다. 사용자에게 원인과 올바른 값을 그대로 보여 주려고 별도 타입으로 나눈다.
 * 잘못된 값을 그대로 넘기면 Number 변환이 NaN을 만들어 결과 지표가 조용히 망가지므로 여기서 먼저 막는다.
 */
export class ReplayArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayArgumentError";
  }
}

/** 일반 송신자가 쓰는 문장. 약한 금칙어·떼도배·통과 경로를 지나가도록 고른 것이다. 강한 금칙어는 이 목록으로 맞지 않는다(smoke의 reasons로 확인). */
const SAMPLE_TEXTS = [
  "ㅋㅋㅋㅋㅋ", "와 방금 컨트롤 미쳤다 ㄷㄷ", "오늘 몇 시까지 방송해요?", "GG", "저 보스 존나 세네",
  "씨발 방송 꺼라", "구독하면 선물 드려요 진짜로 지금", "다음 판은 원딜 해주세요", "ㅠㅠ", "헤드샷 개쩐다",
];

/**
 * 도배 송신자가 쓰는 문장. 금칙어에 걸리지 않는 평범한 문장만 골라서, 개인 도배 판정이 이유(rule:personal_flood)로 드러나게 한다.
 * 욕설을 넣으면 금칙어가 먼저 걸려 개인 도배 경로가 가려진다.
 */
const SPAMMER_TEXTS = ["오늘 몇 시까지 방송해요?", "다음 판은 원딜 해주세요", "헤드샷 개쩐다", "GG", "ㅠㅠ"];

/** 이 간격마다 한 번씩 도배 송신자가 끼어든다. 100/s에서 약 6.7건/초라 10초 창 안에 5건 기준을 넘는다. */
const SPAMMER_INTERVAL = 15;

/** 도배 송신자의 채널 식별자. */
const SPAMMER_ID = "spammer-1";

/**
 * 합성 채팅 1건을 만든다. 경로 구성: 일반 송신자 300명이 SAMPLE_TEXTS를 돌아가며 쓰고,
 * 15건마다 SPAMMER_ID가 SPAMMER_TEXTS를 보낸다. 이 구성에서 나오는 판정 이유는 약한 금칙어(rule:weak)·떼도배(rule:group_flood)·
 * 개인 도배(rule:personal_flood)·통과(none)다. 강한 금칙어(rule:strong)와 링크·전화번호 경로는 나오지 않는다.
 * 실제 채팅 분포를 흉내 낸 것은 아니다. 어떤 경로가 실제로 몇 건 나왔는지는 ReplayReport.reasons로 확인한다.
 */
function syntheticChat(index: number, receivedAt: number): ChatEvent {
  const isSpammer = index % SPAMMER_INTERVAL === 0;
  const senderChannelId = isSpammer ? SPAMMER_ID : `viewer-${index % 300}`;
  const content = isSpammer
    ? (SPAMMER_TEXTS[Math.floor(index / SPAMMER_INTERVAL) % SPAMMER_TEXTS.length] as string)
    : (SAMPLE_TEXTS[index % SAMPLE_TEXTS.length] as string);
  return {
    channelId: "replay", senderChannelId, chatChannelId: "chat", nickname: senderChannelId,
    userRoleCode: "common_user", content, messageTime: receivedAt, receivedAt,
  };
}

/**
 * 메모리 DB 위에 파이프라인과 처리기를 만든다. 실행기는 호출만 세지 않는 no-op이라 치지직을 부르지 않는다.
 * 자동 숨김 스위치는 기본값(꺼짐)이라 auto_hide 판정은 shadow로 기록된다. 실행기 호출 비용은 이 도구로 재지 않는다.
 */
function buildPipeline() {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO channel (channel_id, channel_name, connected_at) VALUES ('replay', '재생', 0)").run();
  database.prepare("INSERT INTO setting (channel_id) VALUES ('replay')").run();
  const clock = () => Date.now();
  const rules = createRuleRepository(database, clock);
  rules.seedDefaults("replay");
  const auditLog = createAuditLog(database, clock);
  const executor: Executor = { submit: async () => ({ ok: true, note: null }), pendingCount: () => 0, onFailureRateExceeded: () => undefined };
  const pipeline = createDetectionPipeline({ rules, auditLog, groupFlood: createGroupFloodDetector(), personalFlood: createPersonalFloodDetector(), duplicates: createDuplicateTracker() });
  const handler = createDecisionHandler({
    verdicts: createVerdictRepository(database, clock), executor, claims: createVerdictClaims(), stats: createMinuteStats(database, clock), logger: silentLogger,
    autoHide: createAutoHideSwitch({ settings: createSettingsRepository(database), auditLog, clock, logger: silentLogger }),
    broadcaster: { broadcast: () => undefined, pushChatLine: () => undefined },
  });
  return { pipeline, handler };
}

/**
 * 정해진 간격으로 work를 호출하고, 건마다 처리 시간과 예정 시각 대비 밀린 시간을 잰다.
 * 왜 밀린 시간을 따로 재는가(누락 보정): 한 건이 오래 멈추면 뒤 건들의 예정 시각이 이미 지나 바로 처리되는데,
 * 처리 시간만 재면 그 건들이 빠르게 찍혀 멈춤이 가려진다. 예정 시각 기준 지연을 같이 재야 멈춤이 드러난다.
 * @param total 보낼 건수
 * @param intervalMs 건 사이 간격(ms). 건 i의 예정 시각은 시작 + i × intervalMs
 * @param work 건 하나를 처리하는 함수. 인덱스를 받는다
 * @returns 전체 경과 시간과 건마다의 처리 시간·밀린 시간
 */
export async function runPaced(total: number, intervalMs: number, work: (index: number) => void): Promise<PacedRun> {
  const serviceMs: number[] = [];
  const latenessMs: number[] = [];
  const startedAt = performance.now();
  for (let index = 0; index < total; index += 1) {
    const scheduledAt = startedAt + index * intervalMs;
    await waitUntil(scheduledAt);
    const begin = performance.now();
    // 예정보다 일찍 시작하는 경우는 없어야 하지만, 혹시 있어도 밀린 시간이 음수로 섞이지 않게 0으로 바닥을 깐다.
    latenessMs.push(Math.max(0, begin - scheduledAt));
    work(index);
    serviceMs.push(performance.now() - begin);
  }
  return { elapsedMs: performance.now() - startedAt, serviceMs, latenessMs };
}

/** 정한 속도로 합성 채팅을 흘리며 판정·처리를 하고, 시간과 판정 집계를 돌려준다. */
export async function runReplay(options: ReplayOptions): Promise<ReplayReport> {
  const { pipeline, handler } = buildPipeline();
  const total = Math.round(options.ratePerSecond * options.seconds);
  const decisions: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const run = await runPaced(total, 1000 / options.ratePerSecond, (index) => {
    const event = syntheticChat(index, Date.now());
    const result = pipeline.evaluate(event);
    handler.handle(event, result);
    decisions[result.decision] = (decisions[result.decision] ?? 0) + 1;
    reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
  });
  return summarize(run, decisions, reasons);
}

/** 목표 시각까지 기다린다(이미 지났으면 바로 진행해 밀림이 결과에 드러나게 한다). */
async function waitUntil(targetMs: number): Promise<void> {
  const delay = targetMs - performance.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * 원자료를 보고서로 바꾼다. 분위수는 정렬된 배열에서 floor(건수 × 비율) 번째 값을 고른다.
 * floor 인덱스는 0부터 세므로 nearest-rank보다 한 칸 위의 값이 나온다. 지연 지표에서 이쪽이 보수적이다(낮게 보이지 않는다).
 * @param run 원자료
 * @param decisions 판정별 건수
 * @param reasons 판정 이유별 건수
 */
export function summarize(run: PacedRun, decisions: Record<string, number>, reasons: Record<string, number>): ReplayReport {
  const service = [...run.serviceMs].sort((left, right) => left - right);
  const lateness = [...run.latenessMs].sort((left, right) => left - right);
  const messages = service.length;
  return {
    messages,
    elapsedMs: round(run.elapsedMs),
    // 분모는 목표 시간(seconds)이 아니라 실제 경과 시간이다. 밀렸다면 목표보다 낮게 나와야 하기 때문이다.
    achievedPerSecond: round((messages / run.elapsedMs) * 1000),
    p50Ms: percentileOf(service, 0.5),
    p95Ms: percentileOf(service, 0.95),
    maxMs: round(service.at(-1) ?? 0),
    p95LatenessMs: percentileOf(lateness, 0.95),
    maxLatenessMs: round(lateness.at(-1) ?? 0),
    decisions,
    reasons,
  };
}

/**
 * 정렬된 값에서 분위수 하나를 고른다. 빈 배열이면 0을 돌려준다.
 * @param sorted 오름차순으로 정렬된 값
 * @param ratio 0~1 사이 비율
 */
function percentileOf(sorted: number[], ratio: number): number {
  return round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0);
}

/** 소수 둘째 자리 반올림. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 문자열 옵션 하나를 양의 유한 숫자로 바꾼다.
 * 이유: Number("abc")는 NaN, Number("")는 0이라 그대로 쓰면 재생이 조용히 엉뚱하게 돈다.
 * @param name 옵션 이름(오류 메시지용)
 * @param raw 명령행에서 받은 값
 */
function parsePositiveNumber(name: string, raw: string | undefined): number {
  if (raw === undefined) throw new ReplayArgumentError(`--${name} 값이 없습니다. 예: --${name} ${name === "rate" ? "100" : "10"}`);
  const value = Number(raw);
  if (Number.isNaN(value)) throw new ReplayArgumentError(`--${name}는 숫자여야 합니다(받은 값: "${raw}")`);
  if (!Number.isFinite(value)) throw new ReplayArgumentError(`--${name}는 유한한 값이어야 합니다(받은 값: "${raw}")`);
  if (value <= 0) throw new ReplayArgumentError(`--${name}는 0보다 커야 합니다(받은 값: ${raw})`);
  return value;
}

/**
 * 명령행 값을 재생 설정으로 검사해 바꾼다. 반올림 결과 메시지가 0건이면 측정할 것이 없으므로 거절한다.
 * @param raw 명령행에서 읽은 문자열 옵션 {rate, seconds}
 * @returns 검사를 통과한 재생 설정
 * @throws ReplayArgumentError 값이 없거나 숫자가 아니거나 0 이하이거나 메시지가 0건일 때
 */
export function parseReplayOptions(raw: { rate: string | undefined; seconds: string | undefined }): ReplayOptions {
  const options = { ratePerSecond: parsePositiveNumber("rate", raw.rate), seconds: parsePositiveNumber("seconds", raw.seconds) };
  if (Math.round(options.ratePerSecond * options.seconds) < 1) throw new ReplayArgumentError("재생 메시지가 0건입니다. --rate와 --seconds를 늘려 주세요");
  return options;
}

/**
 * 명령행 인자를 읽는다. 알 수 없는 옵션이나 값 누락은 node:util이 던지므로 그대로 사용자 오류로 바꾼다.
 * @returns 검사를 통과한 재생 설정
 */
function readOptionsFromArgv(): ReplayOptions {
  let values: { rate?: string; seconds?: string };
  try {
    ({ values } = parseArgs({ options: { rate: { type: "string" }, seconds: { type: "string" } } }));
  } catch (error) {
    throw new ReplayArgumentError(`인자를 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseReplayOptions({ rate: values.rate ?? "50", seconds: values.seconds ?? "60" });
}

/**
 * 명령행 실행: --rate(초당 건수, 기본 50) --seconds(기본 60). 범위 표기와 결과를 JSON으로 출력한다.
 * 인자 오류는 원인을 stderr에 적고 종료 코드 2로 끝낸다. 재생 중 예외는 1로 끝낸다.
 */
async function runFromCommandLine(): Promise<void> {
  let options: ReplayOptions;
  try {
    options = readOptionsFromArgv();
  } catch (error) {
    if (!(error instanceof ReplayArgumentError)) throw error;
    console.error(`인자 오류: ${error.message}`);
    console.error("사용법: npm run replay -w @zzirit-guard/server -- --rate 100 --seconds 10");
    process.exit(2);
  }
  console.log(JSON.stringify({ scope: SCOPE_NOTE, ...(await runReplay(options)) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromCommandLine().catch((error: unknown) => {
    console.error("부하 재생 실패:", error);
    process.exit(1);
  });
}
