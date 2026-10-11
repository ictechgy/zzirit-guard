// 부하 재생 도구: 합성 채팅을 초당 N건으로 판정 파이프라인에 흘려 처리 시간을 잰다(스펙 13장).
// 사용법: npm run build -w @zzirit-guard/server && npm run replay -w @zzirit-guard/server -- --rate 50 --seconds 600
// 치지직에 연결하지 않는다. 메모리 DB와 아무것도 하지 않는 실행기를 써서 네트워크를 전혀 타지 않는다.
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createAutoHideSwitch } from "../actions/autoHideSwitch.js";
import { createDecisionHandler } from "../actions/decisionHandler.js";
import type { Executor } from "../actions/executor.js";
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

/** 재생 설정. */
export interface ReplayOptions {
  ratePerSecond: number;
  seconds: number;
}

/** 재생 결과. achievedPerSecond가 목표보다 낮으면 처리가 밀린 것이다. */
export interface ReplayReport {
  messages: number;
  elapsedMs: number;
  achievedPerSecond: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  decisions: Record<string, number>;
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

/** 합성 채팅 문장. 실채팅 분포를 흉내 낸 것이 아니라 각 규칙 경로를 고루 지나가게 고른 것이다. */
const SAMPLE_TEXTS = [
  "ㅋㅋㅋㅋㅋ", "와 방금 컨트롤 미쳤다 ㄷㄷ", "오늘 몇 시까지 방송해요?", "GG", "저 보스 존나 세네",
  "씨발 방송 꺼라", "구독하면 선물 드려요 진짜로 지금", "다음 판은 원딜 해주세요", "ㅠㅠ", "헤드샷 개쩐다",
];

/** 메시지 1건을 만든다. 보낸 사람을 돌려 써서 도배 감지도 함께 돈다. */
function syntheticChat(index: number, receivedAt: number): ChatEvent {
  return {
    channelId: "replay", senderChannelId: `viewer-${index % 300}`, chatChannelId: "chat", nickname: `viewer-${index % 300}`,
    userRoleCode: "common_user", content: SAMPLE_TEXTS[index % SAMPLE_TEXTS.length] as string, messageTime: receivedAt, receivedAt,
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
    verdicts: createVerdictRepository(database, clock), executor, stats: createMinuteStats(database, clock), logger: silentLogger,
    autoHide: createAutoHideSwitch({ settings: createSettingsRepository(database), auditLog, clock, logger: silentLogger }),
    broadcaster: { broadcast: () => undefined, pushChatLine: () => undefined },
  });
  return { pipeline, handler };
}

/** 정한 속도로 메시지를 흘리며 한 건당 처리 시간(판정 + 처리)을 잰다. */
export async function runReplay(options: ReplayOptions): Promise<ReplayReport> {
  const { pipeline, handler } = buildPipeline();
  const total = Math.round(options.ratePerSecond * options.seconds);
  const intervalMs = 1000 / options.ratePerSecond;
  const durations: number[] = [];
  const decisions: Record<string, number> = {};
  const startedAt = performance.now();
  for (let index = 0; index < total; index += 1) {
    await waitUntil(startedAt + index * intervalMs);
    const event = syntheticChat(index, Date.now());
    const begin = performance.now();
    const result = pipeline.evaluate(event);
    handler.handle(event, result);
    durations.push(performance.now() - begin);
    decisions[result.decision] = (decisions[result.decision] ?? 0) + 1;
  }
  return summarize(durations, performance.now() - startedAt, decisions);
}

/** 목표 시각까지 기다린다(이미 지났으면 바로 진행해 밀림이 결과에 드러나게 한다). */
async function waitUntil(targetMs: number): Promise<void> {
  const delay = targetMs - performance.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

/** 분위수와 처리율을 계산한다. */
function summarize(durations: number[], elapsedMs: number, decisions: Record<string, number>): ReplayReport {
  const sorted = [...durations].sort((left, right) => left - right);
  const at = (ratio: number) => round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0);
  return { messages: durations.length, elapsedMs: round(elapsedMs), achievedPerSecond: round((durations.length / elapsedMs) * 1000), p50Ms: at(0.5), p95Ms: at(0.95), maxMs: round(sorted.at(-1) ?? 0), decisions };
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
 * 명령행 실행: --rate(초당 건수, 기본 50) --seconds(기본 60). 결과를 JSON으로 출력한다.
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
  console.log(JSON.stringify(await runReplay(options), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromCommandLine().catch((error: unknown) => {
    console.error("부하 재생 실패:", error);
    process.exit(1);
  });
}
