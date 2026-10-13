import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIRECTORY_MODE, DATABASE_FILE_MODE, restrictDatabaseFiles, restrictDataDirectory } from "../../src/db/filePermissions.js";

/** 이 테스트만 쓰는 OS 임시 폴더. 권한 변경은 이 안에서만 한다. */
let sandbox: string;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "zg-permissions-"));
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

/** 파일·폴더의 권한 비트(rwx 9비트). */
function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/** 내용이 있는 파일을 만들고 권한을 넓게(0644) 둔다. 예전 설치에서 umask 022로 만들어진 파일을 흉내 낸다. */
function createWideFile(path: string): void {
  writeFileSync(path, "data");
  chmodSync(path, 0o644);
}

describe("데이터 폴더 권한(K13)", () => {
  it("이미 0755로 있던 데이터 폴더를 0700으로 좁힌다", () => {
    const directory = join(sandbox, "data");
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);
    restrictDataDirectory(directory);
    expect(DATA_DIRECTORY_MODE).toBe(0o700);
    expect(modeOf(directory)).toBe(0o700);
  });

  it("없는 데이터 폴더는 0700으로 만든다", () => {
    const directory = join(sandbox, "missing", "data");
    restrictDataDirectory(directory);
    expect(modeOf(directory)).toBe(0o700);
  });
});

describe("DB 파일 권한(K13)", () => {
  it("DB 파일과 -wal·-shm을 0600으로 좁힌다", () => {
    const databasePath = join(sandbox, "zzirit-guard.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) createWideFile(`${databasePath}${suffix}`);
    restrictDatabaseFiles(databasePath);
    expect(DATABASE_FILE_MODE).toBe(0o600);
    expect(["", "-wal", "-shm"].map((suffix) => modeOf(`${databasePath}${suffix}`))).toEqual([0o600, 0o600, 0o600]);
  });

  it("-wal·-shm이 없으면 있는 파일만 고치고 실패하지 않는다", () => {
    const databasePath = join(sandbox, "zzirit-guard.sqlite");
    createWideFile(databasePath);
    expect(() => restrictDatabaseFiles(databasePath)).not.toThrow();
    expect(modeOf(databasePath)).toBe(0o600);
  });

  it("없는 파일이 아닌 다른 이유로 실패하면 경로와 해결 방법을 담아 던진다", () => {
    const notDirectory = join(sandbox, "file");
    createWideFile(notDirectory);
    expect(() => restrictDatabaseFiles(join(notDirectory, "zzirit-guard.sqlite"))).toThrow(/권한을 바꾸지 못했습니다.*ENOTDIR/);
  });
});
