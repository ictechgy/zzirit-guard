import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectWithSocketIo, createChatReceiver, type ChatReceiver } from "../../src/chat/chatReceiver.js";
import type { ChzzkApi } from "../../src/chzzk/apiClient.js";
import type { TokenManager } from "../../src/connection/tokenManager.js";
import { silentLogger } from "../../src/logger.js";
import { waitFor } from "../helpers/waitFor.js";

/** 테스트 동안 프로세스에 떨어진 uncaughtException·unhandledRejection 기록. */
let fatalErrors: unknown[];
/** 업그레이드 요청을 받고도 응답하지 않는 TCP 서버(연결이 CONNECTING에 머물게 한다). */
let silentServer: Server;
/** 서버가 받은 소켓들. 정리할 때 직접 끊어야 server.close()가 끝난다. */
let openSockets: Socket[];
let receiver: ChatReceiver | null;
const onFatal = (error: unknown): void => { fatalErrors.push(error); };

beforeEach(async () => {
  fatalErrors = [];
  receiver = null;
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  openSockets = [];
  silentServer = createServer((socket) => { openSockets.push(socket); });
  await new Promise<void>((resolve) => silentServer.listen(0, "127.0.0.1", resolve));
});
afterEach(async () => {
  receiver?.stop();
  process.off("uncaughtException", onFatal);
  process.off("unhandledRejection", onFatal);
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((resolve) => silentServer.close(() => resolve()));
});

/** 주어진 포트로 소켓을 여는 수신기를 만든다. 세션 URL 발급과 토큰은 가짜다. */
function createReceiverFor(port: number): ChatReceiver {
  const api = { createSessionUrl: async () => `http://127.0.0.1:${port}`, subscribeChat: async () => undefined } as unknown as ChzzkApi;
  const tokenManager = { getAccessToken: async () => "token" } as unknown as TokenManager;
  return createChatReceiver({
    api, tokenManager, connect: connectWithSocketIo, clock: Date.now, logger: silentLogger, connectedChannelId: () => "owner-channel",
    onChat: () => undefined, onConnectionChange: () => undefined, onInvalidEvent: () => undefined, onRevoked: () => undefined,
  });
}

/** 이벤트 루프를 ms만큼 돌려, 비동기로 던져지는 예외가 나타날 시간을 준다. */
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("ChatReceiver 연결 실패 안전성", () => {
  it("연결이 거부돼도 프로세스 예외 없이 연결 안 됨 상태를 유지한다", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    receiver = createReceiverFor(port);
    receiver.start();
    await settle(500);
    expect(fatalErrors).toEqual([]);
    expect(receiver.isConnected()).toBe(false);
  });

  it("업그레이드가 멈춘 연결이 시간 초과돼도 프로세스 예외가 없다", async () => {
    receiver = createReceiverFor((silentServer.address() as AddressInfo).port);
    receiver.start();
    await settle(3600);
    expect(fatalErrors).toEqual([]);
    expect(receiver.isConnected()).toBe(false);
  }, 10_000);

  it("연결 중에 stop()을 불러도 프로세스 예외가 없다", async () => {
    receiver = createReceiverFor((silentServer.address() as AddressInfo).port);
    receiver.start();
    await waitFor(() => silentServer.listening);
    await settle(200);
    receiver.stop();
    await settle(300);
    expect(fatalErrors).toEqual([]);
    expect(receiver.isConnected()).toBe(false);
  });
});
