import { chmodSync, mkdirSync } from "node:fs";
import { describeError } from "../logger.js";

/**
 * 데이터 폴더 권한(소유자만 접근, 0700, K13).
 * 왜: DB에는 채팅 원문·닉네임·암호화된 토큰·푸시 구독 키가 들어 있어, 같은 기기의 다른 계정이 읽으면 안 된다.
 */
export const DATA_DIRECTORY_MODE = 0o700;
/** DB 파일과 -wal·-shm 파일 권한(소유자만 읽기·쓰기, 0600, K13). 이유는 DATA_DIRECTORY_MODE와 같다. */
export const DATABASE_FILE_MODE = 0o600;
/** SQLite WAL 모드에서 DB와 함께 생기는 파일 접미사(빈 문자열은 DB 파일 자체). -wal에도 지운 원문 페이지가 잠시 남는다. */
const DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;

/**
 * 데이터 폴더를 만들고 소유자 전용(0700)으로 맞춘다(K13).
 * 왜 chmod를 또 하나: mkdir의 mode는 새로 만들 때만 쓰이고 umask에 깎이므로, 예전 설치에서 0755로 만든 폴더는 그대로 남는다.
 * 주의: ZG_DATA_DIR은 이 서버만 쓰는 폴더여야 한다(다른 용도로 쓰는 폴더의 권한도 좁혀진다).
 * @param directory 데이터 폴더(ZG_DATA_DIR)
 * @throws Error 권한을 바꾸지 못했을 때(경로와 해결 방법을 담는다)
 */
export function restrictDataDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: DATA_DIRECTORY_MODE });
  changeMode(directory, DATA_DIRECTORY_MODE);
}

/**
 * DB 파일과 -wal·-shm 파일이 있으면 소유자 전용(0600)으로 맞춘다(K13). DB를 연 뒤에 부른다.
 * 왜: 예전 설치에서 umask 022로 만든 파일은 0644라 다른 계정이 읽을 수 있다. SQLite는 -wal·-shm을 DB 파일과 같은 권한으로 만들므로
 * DB 파일을 먼저 좁혀 두면 나중에 다시 생기는 -wal·-shm도 0600이 된다.
 * @param databasePath DB 파일 경로
 * @throws Error 없는 파일이 아닌 이유로 권한을 바꾸지 못했을 때
 */
export function restrictDatabaseFiles(databasePath: string): void {
  for (const suffix of DATABASE_FILE_SUFFIXES) changeMode(`${databasePath}${suffix}`, DATABASE_FILE_MODE, { isOptional: true });
}

/**
 * 권한을 바꾼다. 실패하면 경로와 해결 방법을 담은 오류로 다시 던진다.
 * @param path 바꿀 파일·폴더
 * @param mode 권한 비트
 * @param options isOptional이면 없는 파일(ENOENT)은 고칠 것이 없으므로 건너뛴다
 */
function changeMode(path: string, mode: number, options: { isOptional?: boolean } = {}): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    if (options.isOptional && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`${path}의 권한을 바꾸지 못했습니다(${describeError(error)}). 이 파일의 주인이 서버를 실행하는 사용자인지 확인하세요.`, { cause: error });
  }
}
