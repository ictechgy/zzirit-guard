import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiStage, type AiOutcome, type AiResult, type AiStage, type AiSubmission, type AiTiming } from "../../src/ai/aiStage.js";
import { WorkerCallError, type WorkerClient, type WorkerItem, type WorkerResult, type WorkerStage } from "../../src/ai/workerClient.js";
import type { Logger } from "../../src/logger.js";

/** 가짜 워커. 답은 respond로 정하고, 보낸 요청은 calls에 남긴다. */
interface FakeClient {
  client: WorkerClient;
  calls: WorkerItem[][];
  respond: (items: readonly WorkerItem[], signal?: AbortSignal) => Promise<WorkerResult>;
  healthResponse: () => Promise<string>;
}

/** 가짜 워커를 만든다. 기본은 1차 점수 0.5, 2차 S2 0.9다. */
function fakeClient(stage: WorkerStage): FakeClient {
  const fake: FakeClient = {
    client: {
      classify: (items, signal) => {
        fake.calls.push([...items]);
        return fake.respond(items, signal);
      },
      health: () => fake.healthResponse(),
    },
    calls: [],
    respond: async (items) => ({
      model: `${stage}@1`,
      verdicts: items.map(({ id }) => ({ id, unsafeProbability: stage === "stage1" ? 0.5 : 0.9, category: stage === "stage1" ? null : "S2" })),
    }),
    healthResponse: async () => `${stage}@1`,
  };
  return fake;
}

/** 중단 신호를 따르는 끝나지 않는 응답(처리 중 상태를 만들 때). */
function hanging(_items: readonly WorkerItem[], signal?: AbortSignal): Promise<WorkerResult> {
  return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new WorkerCallError("aborted", "aborted"))));
}

/** 채팅 한 건. */
function submission(content: string, options: { sender?: string; keyword?: number | null; time?: number } = {}): AiSubmission {
  const sender = options.sender ?? "viewer-1";
  return {
    channelId: "c1",
    keywordRouteId: options.keyword ?? null,
    ref: { chatChannelId: "chat-1", messageTime: options.time ?? 1, senderChannelId: sender, nickname: sender, content, privileged: false, isRoleUnknown: false },
  };
}

let stage1: FakeClient;
let stage2: FakeClient;
let outcomes: AiOutcome[];
let results: Array<{ content: string; result: AiResult }>;
let downs: WorkerStage[];
let threshold: number;
let logs: string[];
let ai: AiStage;

/** 기본 설정으로 AI 단계를 만든다. */
function build(timing: Partial<AiTiming> = {}): AiStage {
  const logger: Logger = {
    info: (message, details) => logs.push(`${message} ${JSON.stringify(details ?? {})}`),
    warn: (message, details) => logs.push(`${message} ${JSON.stringify(details ?? {})}`),
    error: (message, details) => logs.push(`${message} ${JSON.stringify(details ?? {})}`),
  };
  return createAiStage(
    {
      stage1: stage1.client, stage2: stage2.client, clock: () => Date.now(), logger,
      stage1Threshold: () => threshold,
      onResult: (item, result) => results.push({ content: item.ref.content, result }),
      onOutcome: (_channelId, outcome) => outcomes.push(outcome),
      onWorkerDown: (stage) => downs.push(stage),
    },
    timing,
  );
}

/** 끝 결과만(forwarded 빼고) 센다. */
function terminal(): AiOutcome[] {
  return outcomes.filter((outcome) => outcome !== "forwarded");
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  stage1 = fakeClient("stage1");
  stage2 = fakeClient("stage2");
  outcomes = [];
  results = [];
  downs = [];
  logs = [];
  threshold = 0.3;
  ai = build();
});

afterEach(async () => {
  await ai.stop();
  vi.useRealTimers();
});

describe("길 정하기", () => {
  it("1차를 25ms 묶음으로 보내고, 임계값 이상은 2차 결과를 넘기며, 미만은 통과다", async () => {
    stage1.respond = async (items) => ({ model: "s1@1", verdicts: items.map(({ id }, index) => ({ id, unsafeProbability: index === 0 ? 0.6 : 0.1, category: null })) });
    ai.submit(submission("높은 점수"));
    ai.submit(submission("낮은 점수", { sender: "viewer-2" }));
    expect(stage1.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(25);
    expect(stage1.calls).toEqual([[{ id: expect.any(String), text: "높은 점수" }, { id: expect.any(String), text: "낮은 점수" }]]);
    expect(results.map((entry) => entry.content)).toEqual(["높은 점수"]);
    expect(results[0]?.result).toEqual({ unsafeProbability: 0.9, category: "S2", model: "stage2@1" });
    expect(outcomes.sort()).toEqual(["forwarded", "stage1_pass", "stage2_done"]);
  });

  it("16건이 모이면 묶음 창을 기다리지 않고 바로 보낸다", async () => {
    Array.from({ length: 16 }, (_, index) => ai.submit(submission(`문장${index}`, { sender: `v${index}` })));
    await vi.advanceTimersByTimeAsync(0);
    expect(stage1.calls[0]).toHaveLength(16);
  });

  it("키워드 경로는 1차를 거치지 않고 2차로 가며, 1차가 죽어도 간다", async () => {
    stage1.respond = async () => {
      throw new WorkerCallError("unavailable", "socket_missing");
    };
    ai.submit(submission("죽고싶다", { keyword: 7 }));
    await vi.advanceTimersByTimeAsync(30);
    expect(stage1.calls).toHaveLength(0);
    expect(results.map((entry) => entry.content)).toEqual(["죽고싶다"]);
  });

  it("1,000자를 넘거나 짝 없는 서로게이트가 있는 문장은 보내지 않고 미검사로 센다(자르지 않는다)", async () => {
    ai.submit(submission("가".repeat(1_001)));
    ai.submit(submission("가\uD800나"));
    await vi.advanceTimersByTimeAsync(30);
    expect(stage1.calls).toHaveLength(0);
    expect(terminal()).toEqual(["ai_unchecked", "ai_unchecked"]);
  });
});

describe("장애", () => {
  it("1차가 실패하면 묶음은 미검사이고 상태가 down이 되며, 다음 성공에 ok로 돌아온다(원문은 로그에 없다)", async () => {
    stage1.respond = async () => {
      throw new WorkerCallError("unavailable", "timeout");
    };
    ai.submit(submission("채팅표식XYZ"));
    await vi.advanceTimersByTimeAsync(30);
    expect(terminal()).toEqual(["ai_unchecked"]);
    expect(ai.status().stage1.state).toBe("down");
    expect(ai.status().uncheckedLastMinute).toEqual({ dropped: 0, unchecked: 1 });
    expect(logs.join("\n")).not.toContain("채팅표식XYZ");
    stage1.respond = fakeClient("stage1").respond;
    ai.submit(submission("다음 채팅", { sender: "v2" }));
    await vi.advanceTimersByTimeAsync(30);
    expect(ai.status().stage1).toMatchObject({ state: "ok", model: "stage1@1" });
  });

  it("2차가 문장을 거절하면(text_too_long) 미검사이지만 워커는 살아 있다", async () => {
    stage2.respond = async () => {
      throw new WorkerCallError("rejected", "text_too_long");
    };
    ai.submit(submission("긴 문장", { keyword: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(terminal()).toEqual(["ai_unchecked"]);
    expect(ai.status().stage2.state).toBe("ok");
  });

  it("조용한 채널에서도 상태 확인으로 중지를 알아채고(두 워커는 5초 어긋나게 확인), 30초 넘게 이어지면 한 번만 알린다", async () => {
    stage2.healthResponse = async () => {
      throw new WorkerCallError("unavailable", "socket_missing");
    };
    ai.start();
    await vi.advanceTimersByTimeAsync(1);
    expect([ai.status().stage1.state, ai.status().stage2.state]).toEqual(["ok", "unknown"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ai.status().stage2.state).toBe("down");
    await vi.advanceTimersByTimeAsync(35_000);
    expect(downs).toEqual(["stage2"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(downs).toEqual(["stage2"]);
    expect(ai.status().stage1.state).toBe("ok");
  });
});

describe("캐시", () => {
  it("같은 원문은 2차 결과를 다시 쓰고(워커를 부르지 않음), 임계값을 낮추면 캐시된 1차 점수도 2차로 간다", async () => {
    stage1.respond = async (items) => ({ model: "s1@1", verdicts: items.map(({ id }) => ({ id, unsafeProbability: 0.2, category: null })) });
    ai.submit(submission("애매한 문장"));
    await vi.advanceTimersByTimeAsync(30);
    expect(terminal()).toEqual(["stage1_pass"]);
    threshold = 0.1;
    ai.submit(submission("애매한 문장", { sender: "v2" }));
    await vi.advanceTimersByTimeAsync(30);
    expect(stage1.calls).toHaveLength(1);
    expect(stage2.calls).toHaveLength(1);
    ai.submit(submission("애매한 문장", { sender: "v3" }));
    await vi.advanceTimersByTimeAsync(30);
    expect([stage1.calls.length, stage2.calls.length, results.length]).toEqual([1, 1, 2]);
  });

  it("워커가 다른 모델로 다시 뜨면(상태 확인으로 알게 되면) 이전 모델의 점수를 쓰지 않는다", async () => {
    ai.start();
    ai.submit(submission("문장", { keyword: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    stage2.respond = async (items) => ({ model: "stage2@2", verdicts: items.map(({ id }) => ({ id, unsafeProbability: 0.1, category: "S1" })) });
    stage2.healthResponse = async () => "stage2@2";
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ai.status().stage2.model).toBe("stage2@2");
    ai.submit(submission("문장", { keyword: 1, sender: "v2" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(stage2.calls).toHaveLength(2);
    expect(results[1]?.result.model).toBe("stage2@2");
  });
});

describe("2차 대기열", () => {
  it("같은 원문은 한 번만 2차에 보내고 결과를 모두에게 넘긴다(처리 중에 들어온 것 포함)", async () => {
    let release: (() => void) | null = null;
    stage2.respond = (items) =>
      new Promise((resolve) => {
        release = () => resolve({ model: "stage2@1", verdicts: items.map(({ id }) => ({ id, unsafeProbability: 0.95, category: "S6" })) });
      });
    ai.submit(submission("같은 도배", { keyword: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    ai.submit(submission("같은 도배", { keyword: 1, sender: "v2" }));
    ai.submit(submission("같은 도배", { keyword: 1, sender: "v3" }));
    (release as unknown as () => void)();
    await vi.advanceTimersByTimeAsync(0);
    expect(stage2.calls).toHaveLength(1);
    expect(results).toHaveLength(3);
    expect(terminal()).toEqual(["stage2_done", "stage2_done", "stage2_done"]);
  });

  it("15초가 지난 항목은 버리고 과부하(stage2_dropped)로 센다", async () => {
    stage2.respond = hanging;
    ai.submit(submission("처리 중", { keyword: 1 }));
    ai.submit(submission("기다리다 만료", { keyword: 1, sender: "v2" }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(terminal()).toEqual(["stage2_dropped"]);
    expect(ai.status().uncheckedLastMinute.dropped).toBe(1);
  });

  it("메시지마다 끝 결과는 정확히 하나다(넘침·만료·통과·완료가 섞여도)", async () => {
    stage2.respond = hanging;
    const small = build({ batchSize: 4 });
    for (let index = 0; index < 320; index += 1) small.submit(submission(`키워드${index}`, { keyword: 1, sender: `v${index}` }));
    // 처리 중 1건 + 대기열 300건만 들어가고(forwarded), 나머지 19건은 넣지 못해 버린다(forwarded로 세지 않는다).
    expect(outcomes.filter((outcome) => outcome === "forwarded")).toHaveLength(301);
    await vi.advanceTimersByTimeAsync(16_000);
    await small.stop();
    expect(terminal()).toHaveLength(320);
  });
});

describe("수명 주기", () => {
  it("세션을 초기화하면 묶음 대기·1차 요청 중·2차 요청 중 메시지를 미검사로 한 번씩 확정하고, 늦은 결과는 기록하지 않는다", async () => {
    let release1: ((value: WorkerResult) => void) | null = null;
    stage1.respond = (items) => new Promise((resolve) => (release1 = () => resolve({ model: "s1@1", verdicts: items.map(({ id }) => ({ id, unsafeProbability: 0.9, category: null })) })));
    stage2.respond = hanging;
    ai.submit(submission("1차 요청 중"));
    await vi.advanceTimersByTimeAsync(25);
    ai.submit(submission("2차 요청 중", { keyword: 1, sender: "v2" }));
    ai.submit(submission("묶음 대기", { sender: "v3" }));
    ai.resetSession();
    (release1 as unknown as (value: WorkerResult) => void)({ model: "s1@1", verdicts: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(terminal()).toEqual(["ai_unchecked", "ai_unchecked", "ai_unchecked"]);
    expect(results).toHaveLength(0);
  });

  it("멈춘 뒤에는 채팅을 받지 않고, 진행 중인 요청이 끝나기를 기다린다", async () => {
    stage2.respond = hanging;
    ai.submit(submission("요청 중", { keyword: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    await ai.stop();
    ai.submit(submission("멈춘 뒤"));
    await vi.advanceTimersByTimeAsync(100);
    expect(terminal()).toEqual(["ai_unchecked"]);
    expect(stage1.calls).toHaveLength(0);
  });

  it("세션을 초기화하면 캐시를 비워, 새 세션의 같은 문장은 다시 판정한다", async () => {
    ai.submit(submission("가", { keyword: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    ai.resetSession();
    ai.submit(submission("가", { keyword: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(stage2.calls).toHaveLength(2);
    expect(terminal()).toEqual(["stage2_done", "stage2_done"]);
  });
});

describe("리뷰 반영(Codex PR C)", () => {
  it("세션 초기화 뒤 늦게 온 이전 요청의 응답은 새 세션의 같은 문장 항목을 건드리지 않는다", async () => {
    const releases: Array<(result: WorkerResult) => void> = [];
    stage2.respond = () => new Promise((resolve) => releases.push(resolve));
    ai.submit(submission("같은 문장", { keyword: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    ai.resetSession();
    ai.submit(submission("같은 문장", { keyword: 1, sender: "v2" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(2);
    releases[0]?.({ model: "stage2@old", verdicts: [{ id: "x", unsafeProbability: 0.99, category: "S1" }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(0);
    releases[1]?.({ model: "stage2@new", verdicts: [{ id: "y", unsafeProbability: 0.6, category: "S2" }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(results.map((entry) => entry.result)).toEqual([{ unsafeProbability: 0.6, category: "S2", model: "stage2@new" }]);
    expect(ai.status().stage2.model).toBe("stage2@new");
  });

  it("1차 묶음은 요청 본문 바이트 상한을 넘지 않게 나눈다(제어 문자는 JSON에서 6바이트로 늘어난다)", async () => {
    const heavy = "\u0001".repeat(1_000);
    for (let index = 0; index < 16; index += 1) ai.submit(submission(`${heavy}${index}`.slice(0, 1_000), { sender: `v${index}` }));
    await vi.advanceTimersByTimeAsync(200);
    expect(stage1.calls.length).toBeGreaterThan(1);
    for (const call of stage1.calls) expect(Buffer.byteLength(JSON.stringify({ items: call }))).toBeLessThanOrEqual(60_000);
    expect(stage1.calls.flat()).toHaveLength(16);
  });

  it("아주 긴 채팅(1천만 자)은 워커에 보내지 않고 바로 미검사로 센다", async () => {
    ai.submit(submission("가".repeat(10_000_000)));
    await vi.advanceTimersByTimeAsync(30);
    expect([stage1.calls.length, stage2.calls.length]).toEqual([0, 0]);
    expect(terminal()).toEqual(["ai_unchecked"]);
  });
});

describe("리뷰 반영(Codex PR C 2차)", () => {
  it("너무 긴 첫 채팅을 버려도 그 사람의 다음 채팅은 첫 채팅으로 앞줄에 서지 않는다", async () => {
    const releases: Array<() => void> = [];
    const respond = stage2.respond;
    stage2.respond = (items, signal) => (releases.length === 0 ? new Promise((resolve) => releases.push(() => resolve(respond(items, signal)))) : respond(items, signal));
    ai.submit(submission("처리 중", { keyword: 1, sender: "v0" }));
    await vi.advanceTimersByTimeAsync(0);
    ai.submit(submission("가".repeat(1_001), { sender: "v1" }));
    ai.submit(submission("둘째 채팅", { keyword: 1, sender: "v1" }));
    ai.submit(submission("새 사람", { keyword: 1, sender: "v9" }));
    releases[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(stage2.calls.map((call) => call[0]?.text)).toEqual(["처리 중", "새 사람", "둘째 채팅"]);
  });

  it("세션 초기화 뒤 늦게 온 상태 확인 응답은 상태를 바꾸지 않고, 다음 상태 확인을 막지 않는다", async () => {
    // 첫 확인만 중단을 무시하고 붙잡아 둔다(늦은 응답). 그 뒤 확인은 바로 답한다.
    const releases: Array<(model: string) => void> = [];
    let probeCount = 0;
    stage1.healthResponse = () => {
      probeCount += 1;
      return probeCount === 1 ? new Promise((resolve) => releases.push(resolve)) : Promise.resolve("stage1@new");
    };
    ai.start();
    await vi.advanceTimersByTimeAsync(1);
    ai.resetSession();
    releases[0]?.("stage1@old");
    await vi.advanceTimersByTimeAsync(0);
    expect(ai.status().stage1).toMatchObject({ state: "unknown", model: null });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ai.status().stage1).toMatchObject({ state: "ok", model: "stage1@new" });
  });
});

