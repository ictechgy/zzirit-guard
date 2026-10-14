import { chmodSync, readFileSync, symlinkSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerClient, parseClassifyResponse, WorkerCallError, type WorkerStage } from "../../src/ai/workerClient.js";
import { startFakeWorker, stage1Reply, type FakeWorker } from "../fakes/fakeWorker.js";

/** 계약 응답 사례(workers/contract/v1/responses.json). */
interface ResponseCase {
  name: string;
  stage: WorkerStage;
  request_ids: string[];
  body?: unknown;
  raw_body?: string;
  accept: boolean;
}
const responseCases = (
  JSON.parse(readFileSync(join(import.meta.dirname, "../../../../workers/contract/v1/responses.json"), "utf8")) as { cases: ResponseCase[] }
).cases;

/** 채팅 원문 표식. 오류 메시지에 나오면 안 된다. */
const CHAT_SENTINEL = "채팅표식XYZ";

let worker: FakeWorker | null = null;
afterEach(async () => {
  await worker?.close();
  worker = null;
});

/** 실패를 잡아 종류·코드를 돌려준다. */
async function failureOf(promise: Promise<unknown>): Promise<{ kind: string; code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkerCallError) return { kind: error.kind, code: error.code, message: error.message };
    throw error;
  }
  throw new Error("실패해야 하는데 성공했습니다");
}

describe("응답 계약 사례", () => {
  it.each(responseCases.map((testCase) => [testCase.name, testCase] as const))("%s", (_name, testCase) => {
    const body = testCase.raw_body ?? JSON.stringify(testCase.body);
    const parse = () => parseClassifyResponse(testCase.stage, testCase.request_ids, body);
    if (testCase.accept) expect(parse().verdicts.map((verdict) => verdict.id)).toEqual(testCase.request_ids);
    else expect(parse).toThrow(WorkerCallError);
  });
});

describe("워커 호출", () => {
  it("요청 id 순서대로 판정을 받고, 요청 본문은 계약 모양이다", async () => {
    worker = await startFakeWorker(stage1Reply(0.3));
    const client = createWorkerClient({ socketPath: worker.socketPath, stage: "stage1" });
    const result = await client.classify([{ id: "a", text: "가" }, { id: "b", text: "나" }]);
    expect(result).toEqual({ model: "kcelectra-fake@0123456789ab", verdicts: [{ id: "a", unsafeProbability: 0.3, category: null }, { id: "b", unsafeProbability: 0.3, category: null }] });
    expect(JSON.parse(worker.requests[0]?.body ?? "")).toEqual({ items: [{ id: "a", text: "가" }, { id: "b", text: "나" }] });
    expect(await client.health()).toBe("kcelectra-fake@0123456789ab");
  });

  it("4xx는 요청 거절(워커는 살아 있음), 503은 바쁨, 500은 중지로 나눈다", async () => {
    worker = await startFakeWorker(() => ({ status: 400, body: JSON.stringify({ error: "text_too_long" }) }));
    const client = createWorkerClient({ socketPath: worker.socketPath, stage: "stage2" });
    expect(await failureOf(client.classify([{ id: "a", text: CHAT_SENTINEL }]))).toMatchObject({ kind: "rejected", code: "text_too_long" });
    worker.setHandler(() => ({ status: 503, body: JSON.stringify({ error: "busy" }) }));
    expect(await failureOf(client.classify([{ id: "a", text: "가" }]))).toMatchObject({ kind: "busy", code: "busy" });
    worker.setHandler(() => ({ status: 500, body: "<html>" }));
    expect(await failureOf(client.classify([{ id: "a", text: "가" }]))).toMatchObject({ kind: "unavailable", code: "http_500" });
  });

  it("계약에 어긋난 200 응답은 중지로 보고, 오류 메시지에 본문이 없다", async () => {
    worker = await startFakeWorker(() => ({ status: 200, body: JSON.stringify({ contract: 1, model: "m", items: [{ id: "a", unsafe_probability: 0.5, category: null, text: CHAT_SENTINEL }] }) }));
    const failure = await failureOf(createWorkerClient({ socketPath: worker.socketPath, stage: "stage1" }).classify([{ id: "a", text: CHAT_SENTINEL }]));
    expect(failure.kind).toBe("unavailable");
    expect(failure.message).not.toContain(CHAT_SENTINEL);
  });

  it("2초 안에 답하지 않으면 시간 초과로 중지다", async () => {
    worker = await startFakeWorker(() => null);
    const client = createWorkerClient({ socketPath: worker.socketPath, stage: "stage1", timeoutMs: 100 });
    expect(await failureOf(client.classify([{ id: "a", text: "가" }]))).toMatchObject({ kind: "unavailable", code: "timeout" });
  });

  it("서버가 중단하면 aborted다(세션 초기화·종료)", async () => {
    worker = await startFakeWorker(() => null);
    const controller = new AbortController();
    const pending = createWorkerClient({ socketPath: worker.socketPath, stage: "stage1" }).classify([{ id: "a", text: "가" }], controller.signal);
    setTimeout(() => controller.abort(), 20);
    expect(await failureOf(pending)).toMatchObject({ kind: "aborted" });
  });
});

describe("소켓 확인", () => {
  it("소켓이 없으면 보내지 않고 중지다", async () => {
    worker = await startFakeWorker(stage1Reply(0.1));
    const client = createWorkerClient({ socketPath: join(worker.directory, "없음.sock"), stage: "stage1" });
    expect(await failureOf(client.classify([{ id: "a", text: "가" }]))).toMatchObject({ kind: "unavailable", code: "socket_missing" });
    expect(worker.requests).toHaveLength(0);
  });

  it("디렉터리 권한이 0700이 아니면 보내지 않는다(다른 사용자가 소켓을 바꿔치울 수 있다)", async () => {
    worker = await startFakeWorker(stage1Reply(0.1));
    chmodSync(worker.directory, 0o755);
    const client = createWorkerClient({ socketPath: worker.socketPath, stage: "stage1" });
    expect(await failureOf(client.classify([{ id: "a", text: "가" }]))).toMatchObject({ code: "unsafe_directory" });
    expect(worker.requests).toHaveLength(0);
  });

  it("소켓 자리가 심볼릭 링크면 보내지 않는다", async () => {
    worker = await startFakeWorker(stage1Reply(0.1));
    const realPath = join(worker.directory, "real.sock");
    renameSync(worker.socketPath, realPath);
    symlinkSync(realPath, worker.socketPath);
    const client = createWorkerClient({ socketPath: worker.socketPath, stage: "stage1" });
    expect(await failureOf(client.classify([{ id: "a", text: "가" }]))).toMatchObject({ code: "unsafe_socket" });
    unlinkSync(worker.socketPath);
    renameSync(realPath, worker.socketPath);
  });

  it("소유자가 다른 소켓이면 보내지 않는다", async () => {
    worker = await startFakeWorker(stage1Reply(0.1));
    const client = createWorkerClient({ socketPath: worker.socketPath, stage: "stage1", userId: 99_999 });
    expect(await failureOf(client.classify([{ id: "a", text: "가" }]))).toMatchObject({ code: "unsafe_directory" });
  });
});
