import { execFile } from "node:child_process";

/** 외부 명령 실행 결과. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** 외부 명령 실행기. 테스트에서 가짜로 바꾸려고 주입한다. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

/** `security` 명령이 항목을 못 찾았을 때의 종료 코드. */
const ITEM_NOT_FOUND_EXIT_CODE = 44;
/** 암호화 키를 저장하는 키체인 계정 이름. setup-keychain.sh와 같아야 한다. */
const ENCRYPTION_KEY_ACCOUNT = "token-encryption-key";
/** 키 형식: 32바이트 = 16진수 64자리. */
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * 키체인에서 토큰 암호화 키를 읽는다. 서버는 읽기만 하고, 키 생성은 setup-keychain.sh가 한다.
 * 키를 명령 인자로 넘기는 생성 작업을 서버에서 하지 않으려는 것이다(프로세스 목록 노출 방지).
 * @param service 키체인 서비스 이름(ZG_KEYCHAIN_SERVICE)
 * @param runCommand security 명령 실행기(테스트에서는 가짜를 주입한다)
 * @returns 32바이트 키 버퍼
 */
export async function loadEncryptionKey(service: string, runCommand: CommandRunner): Promise<Buffer> {
  const result = await runCommand("/usr/bin/security", ["find-generic-password", "-s", service, "-a", ENCRYPTION_KEY_ACCOUNT, "-w"]);
  if (result.exitCode === ITEM_NOT_FOUND_EXIT_CODE) {
    throw new Error(`키체인에 '${service}' 암호화 키가 없습니다. ops/scripts/setup-keychain.sh를 먼저 실행하세요.`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`키체인 읽기 실패(exit ${result.exitCode}): ${result.stderr.trim()} — 로그인 키체인이 잠겨 있는지 확인하세요.`);
  }
  return parseHexKey(result.stdout.trim());
}

/** 16진수 64자리 문자열을 32바이트 버퍼로 바꾼다. */
function parseHexKey(hexText: string): Buffer {
  if (!HEX_KEY_PATTERN.test(hexText)) {
    throw new Error("키체인의 암호화 키 형식이 잘못되었습니다(16진수 64자리여야 함). 항목을 지우고 setup-keychain.sh를 다시 실행하세요.");
  }
  return Buffer.from(hexText, "hex");
}

/** child_process.execFile을 CommandRunner 형태로 감싼다. 0이 아닌 종료도 예외 대신 결과로 돌려준다. */
export const runCommandWithExecFile: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ stdout, stderr: error && !stderr ? error.message : stderr, exitCode });
    });
  });
