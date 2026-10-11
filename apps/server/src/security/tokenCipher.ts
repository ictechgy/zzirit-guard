import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** 토큰 문자열을 저장용으로 암호화·복호화한다. */
export interface TokenCipher {
  encrypt(plainText: string): string;
  decrypt(cipherText: string): string;
}

/** 암호문 형식 버전 표시. 나중에 형식을 바꿔도 옛 값을 구분할 수 있게 한다. */
const CIPHER_PREFIX = "v1:";
/** GCM 권장 IV 길이(바이트). */
const IV_LENGTH = 12;
/** GCM 인증 태그 길이(바이트). */
const TAG_LENGTH = 16;

/**
 * AES-256-GCM 암호기를 만든다. GCM은 변조를 감지하므로 DB 파일이 바뀌면 복호화가 실패한다.
 * @param key 32바이트 키(키체인에서 읽은 값)
 */
export function createTokenCipher(key: Buffer): TokenCipher {
  if (key.length !== 32) {
    throw new Error("암호화 키는 32바이트여야 합니다. ops/scripts/setup-keychain.sh로 키를 다시 만드세요.");
  }
  return {
    encrypt: (plainText) => encryptText(key, plainText),
    decrypt: (cipherText) => decryptText(key, cipherText),
  };
}

/** 평문을 "v1:" + base64(IV | 태그 | 암호문)으로 만든다. IV는 매번 새로 뽑는다. */
function encryptText(key: Buffer, plainText: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return CIPHER_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** encryptText의 역. 형식이 다르거나 태그 검증에 실패하면 예외를 던진다. */
function decryptText(key: Buffer, cipherText: string): string {
  if (!cipherText.startsWith(CIPHER_PREFIX)) {
    throw new Error("알 수 없는 암호문 형식입니다. DB가 다른 버전에서 만들어졌는지 확인하세요.");
  }
  const raw = Buffer.from(cipherText.slice(CIPHER_PREFIX.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_LENGTH));
  decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
  return Buffer.concat([decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString("utf8");
}
