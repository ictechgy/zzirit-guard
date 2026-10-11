// 서버 테스트 설정. 가짜 치지직 서버를 띄우는 통합 테스트가 있어 기본 제한 시간을 늘린다.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 15_000, environment: "node" },
});
