import BetterSqlite3 from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../../src/config.js";
import type { FakeChzzk } from "../fakes/fakeChzzk.js";
import { TEST_VAPID } from "./vapid.js";

/** 테스트 서버의 공개 출처. */
export const ORIGIN = "https://guard.test";

/** 테스트가 만든 임시 데이터 디렉터리. cleanupDataDirectories가 afterEach에서 모두 지운다. */
const createdDirectories: string[] = [];

/** 임시 데이터 디렉터리를 만들어 기록한다. 왜: 테스트마다 DB·백업이 남지 않게 afterEach에서 지우려는 것이다. */
export function createDataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "zg-e2e-"));
  createdDirectories.push(directory);
  return directory;
}

/** 기록된 임시 데이터 디렉터리를 모두 지운다. */
export function cleanupDataDirectories(): void {
  createdDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
}

/** 가짜 치지직을 가리키는 테스트 설정을 만든다. channelId를 바꿔 다른 채널 설정을 흉내 낼 수 있다. */
export function buildTestConfig(fake: FakeChzzk, dataDirectory: string, channelId = fake.owner.channelId): AppConfig {
  return {
    port: 0, publicOrigin: ORIGIN, channelId, chzzkClientId: "test-client", chzzkClientSecret: "test-secret",
    chzzkApiBase: fake.baseUrl, chzzkAuthorizeUrl: "https://chzzk.example/account-interlock", dataDirectory,
    databasePath: join(dataDirectory, "zzirit-guard.sqlite"), backupDirectory: join(dataDirectory, "backups"), keychainService: "unused",
    webDistDirectory: join(dataDirectory, "no-web"), vapidPublicKey: TEST_VAPID.publicKey, vapidPrivateKey: TEST_VAPID.privateKey, vapidSubject: TEST_VAPID.subject,
    aiEnabled: false, aiRunDirectory: join(dataDirectory, "run"),
  };
}

/** 테스트용 암호화 키. 같은 데이터 디렉터리를 다시 열 때는 같은 키를 넘겨야 한다. */
export function newEncryptionKey(): Buffer {
  return randomBytes(32);
}

/**
 * 데이터 디렉터리의 DB에 남은 장애 알림 구독 수를 읽는다. 앱이 연 DB와 따로 읽기 전용으로 열었다 닫는다.
 * 왜: 앱은 DB를 밖으로 내주지 않으므로, 연결 해제가 구독을 지웠는지 파일에서 직접 확인한다(K11).
 * @param dataDirectory buildTestConfig에 넘긴 데이터 디렉터리
 */
export function countPushSubscriptions(dataDirectory: string): number {
  const database = new BetterSqlite3(join(dataDirectory, "zzirit-guard.sqlite"), { readonly: true });
  try {
    return (database.prepare("SELECT COUNT(*) AS count FROM push_subscription").get() as { count: number }).count;
  } finally {
    database.close();
  }
}
