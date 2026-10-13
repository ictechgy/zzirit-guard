import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { installFatalErrorHandlers } from "./fatalErrors.js";
import { createConsoleLogger, describeError, type Logger } from "./logger.js";
import { loadEncryptionKey, runCommandWithExecFile } from "./security/keychain.js";

/**
 * 새 파일·폴더에서 그룹·다른 사용자 권한을 모두 빼는 umask(077, K13).
 * 왜: 기본 umask 022면 better-sqlite3가 DB와 -wal·-shm을 0644로 만들어, 같은 기기의 다른 계정이 채팅 원문과 푸시 구독 키를 읽을 수 있다.
 */
const PRIVATE_FILE_UMASK = 0o077;

/** 실행 진입점. launchd가 `node --env-file=<.env> dist/main.js`로 실행한다(ops/launchd 참고). */
async function main(): Promise<void> {
  // 이 프로세스가 새로 만드는 파일(DB·-wal·-shm·백업)은 소유자만 읽고 쓰게 한다(K13). 파일을 만들기 전에 가장 먼저 정한다.
  process.umask(PRIVATE_FILE_UMASK);
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
