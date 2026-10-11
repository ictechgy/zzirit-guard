import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { installFatalErrorHandlers } from "./fatalErrors.js";
import { createConsoleLogger, describeError, type Logger } from "./logger.js";
import { loadEncryptionKey, runCommandWithExecFile } from "./security/keychain.js";

/** 실행 진입점. launchd가 `node --env-file=<.env> dist/main.js`로 실행한다(ops/launchd 참고). */
async function main(): Promise<void> {
  const logger = createConsoleLogger();
  // 시작 도중의 오류까지 로그로 남기도록 가장 먼저 등록한다.
  installFatalErrorHandlers(process, logger, (code) => process.exit(code));
  const config = loadConfig(process.env);
  const encryptionKey = await loadEncryptionKey(config.keychainService, runCommandWithExecFile);
  const app = await createApp(config, { encryptionKey, logger });
  await app.start();
  logger.info("찌리릿 가드 서버를 시작했습니다", { port: config.port, origin: config.publicOrigin });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown(app, logger, signal));
}

/** 종료 신호를 받으면 통계를 저장하고 연결을 닫은 뒤 끝낸다. */
async function shutdown(app: App, logger: Logger, signal: string): Promise<void> {
  logger.info("종료 신호를 받았습니다", { signal });
  try {
    await app.stop();
    process.exit(0);
  } catch (error) {
    logger.error("종료 중 오류", { error: describeError(error) });
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: "error", message: "서버를 시작하지 못했습니다", error: describeError(error) }));
  process.exit(1);
});
