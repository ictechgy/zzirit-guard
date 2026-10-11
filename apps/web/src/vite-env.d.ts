/// <reference types="vite/client" />

/** 빌드 시 주입하는 환경 값. */
interface ImportMetaEnv {
  /** API 주소 앞부분. 비우면 같은 출처. */
  readonly VITE_API_BASE?: string;
}

/** import.meta에 위 환경 값 타입을 붙인다. */
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
