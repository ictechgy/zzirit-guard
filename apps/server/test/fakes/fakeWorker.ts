import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

/** 가짜 워커가 요청 하나에 답하는 방법. 본문을 받아 상태·본문을 돌려주거나, null이면 응답하지 않는다(시간 초과 시험). */
export type FakeWorkerHandler = (request: { method: string; path: string; body: string }) => { status: number; body: string } | null;

/** 유닉스 소켓에서 도는 가짜 워커. 짧은 /tmp 경로의 0700 디렉터리에 소켓을 만든다(macOS 소켓 경로 104바이트 상한). */
export interface FakeWorker {
  socketPath: string;
  directory: string;
  /** 받은 요청 본문(시험에서 확인한다). */
  requests: Array<{ method: string; path: string; body: string }>;
  setHandler(handler: FakeWorkerHandler): void;
  close(): Promise<void>;
}

/**
 * 가짜 워커를 띄운다.
 * @param handler 처음 쓸 응답 방법
 * @param socketName 소켓 파일 이름
 */
export async function startFakeWorker(handler: FakeWorkerHandler, socketName = "stage1.sock"): Promise<FakeWorker> {
  const directory = mkdtempSync("/tmp/zgw-");
  chmodSync(directory, 0o700);
  const socketPath = join(directory, socketName);
  const requests: FakeWorker["requests"] = [];
  let current = handler;
  const pending = new Set<ServerResponse>();
  const server: Server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const recorded = { method: incoming.method ?? "", path: incoming.url ?? "", body: Buffer.concat(chunks).toString("utf8") };
      requests.push(recorded);
      const reply = current(recorded);
      if (reply === null) {
        pending.add(outgoing);
        return;
      }
      outgoing.writeHead(reply.status, { "Content-Type": "application/json", Connection: "close" });
      outgoing.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath, directory, requests,
    setHandler: (next) => void (current = next),
    close: async () => {
      pending.forEach((response) => response.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * 계약대로 답하는 가짜 1차 판정: 요청 id마다 고정 확률을 준다.
 * @param probability 모든 항목에 줄 유해 확률
 * @param model 모델 식별자
 */
export function stage1Reply(probability: number, model = "kcelectra-fake@0123456789ab"): FakeWorkerHandler {
  return ({ path, body }) => {
    if (path === "/health") return { status: 200, body: JSON.stringify({ contract: 1, model, ready: true }) };
    const items = (JSON.parse(body) as { items: Array<{ id: string }> }).items;
    return { status: 200, body: JSON.stringify({ contract: 1, model, items: items.map(({ id }) => ({ id, unsafe_probability: probability, category: null })) }) };
  };
}
