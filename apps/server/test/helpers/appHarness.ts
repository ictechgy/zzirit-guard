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
  };
}

/** 테스트용 암호화 키. 같은 데이터 디렉터리를 다시 열 때는 같은 키를 넘겨야 한다. */
export function newEncryptionKey(): Buffer {
  return randomBytes(32);
}
