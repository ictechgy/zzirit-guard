import { join } from "node:path";
import { z } from "zod";

/** 서버 전체 설정. 환경 변수에서 한 번 읽어 구성 요소에 넘긴다. */
export interface AppConfig {
  port: number;
  publicOrigin: string;
  /** 연결을 허용할 스트리머 채널 ID. 공개 주소로 남이 먼저 자기 채널을 연결해 서버를 가로채는 것을 막는다. */
  channelId: string;
  chzzkClientId: string;
  chzzkClientSecret: string;
  chzzkApiBase: string;
  chzzkAuthorizeUrl: string;
  dataDirectory: string;
  databasePath: string;
  backupDirectory: string;
  keychainService: string;
  webDistDirectory: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
}

/** 설정 오류. 메시지에 빠진 항목과 해결 방법을 담는다. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** 환경 변수 검증 규칙. 비밀값은 ops/env.example을 복사한 .env에서 읽는다. */
const environmentSchema = z.object({
  ZG_PORT: z.coerce.number().int().min(1).max(65535).default(8710),
  /** 공개 출처는 http·https만 허용한다. mailto 등은 origin이 "null"이 되어 Origin 비교를 우회시킬 수 있다. */
  ZG_PUBLIC_ORIGIN: z.url({ protocol: /^https?$/ }),
  ZG_CHANNEL_ID: z.string().min(1),
  ZG_CHZZK_CLIENT_ID: z.string().min(1),
  ZG_CHZZK_CLIENT_SECRET: z.string().min(1),
  ZG_CHZZK_API_BASE: z.url().default("https://openapi.chzzk.naver.com"),
  ZG_CHZZK_AUTHORIZE_URL: z.url().default("https://chzzk.naver.com/account-interlock"),
  ZG_DATA_DIR: z.string().min(1),
  ZG_KEYCHAIN_SERVICE: z.string().min(1).default("zzirit-guard"),
  ZG_WEB_DIST: z.string().min(1),
  ZG_VAPID_PUBLIC_KEY: z.string().min(1),
  ZG_VAPID_PRIVATE_KEY: z.string().min(1),
  ZG_VAPID_SUBJECT: z.string().startsWith("mailto:"),
});

/**
 * 환경 변수를 검증해 AppConfig로 바꾼다.
 * @param environment process.env 같은 키-값 묶음
 * @returns 경로와 출처가 정규화된 AppConfig
 * @throws ConfigError 빠지거나 잘못된 항목이 있을 때(모든 항목을 한 번에 알려 준다)
 */
export function loadConfig(environment: Record<string, string | undefined>): AppConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new ConfigError(`환경 변수가 잘못되었습니다: ${fields}. ops/env.example을 참고해 .env를 채우세요.`);
  }
  return toAppConfig(parsed.data);
}

/**
 * 검증된 환경 변수를 AppConfig로 옮긴다. 출처(origin)는 끝의 '/'를 없애 비교가 쉽게 한다.
 * @param values environmentSchema를 통과한 값
 * @returns 서버가 쓰는 형태의 설정
 */
function toAppConfig(values: z.infer<typeof environmentSchema>): AppConfig {
  return {
    port: values.ZG_PORT,
    publicOrigin: new URL(values.ZG_PUBLIC_ORIGIN).origin,
    channelId: values.ZG_CHANNEL_ID,
    chzzkClientId: values.ZG_CHZZK_CLIENT_ID,
    chzzkClientSecret: values.ZG_CHZZK_CLIENT_SECRET,
    chzzkApiBase: values.ZG_CHZZK_API_BASE.replace(/\/$/, ""),
    chzzkAuthorizeUrl: values.ZG_CHZZK_AUTHORIZE_URL,
    dataDirectory: values.ZG_DATA_DIR,
    databasePath: join(values.ZG_DATA_DIR, "zzirit-guard.sqlite"),
    backupDirectory: join(values.ZG_DATA_DIR, "backups"),
    keychainService: values.ZG_KEYCHAIN_SERVICE,
    webDistDirectory: values.ZG_WEB_DIST,
    vapidPublicKey: values.ZG_VAPID_PUBLIC_KEY,
    vapidPrivateKey: values.ZG_VAPID_PRIVATE_KEY,
    vapidSubject: values.ZG_VAPID_SUBJECT,
  };
}
