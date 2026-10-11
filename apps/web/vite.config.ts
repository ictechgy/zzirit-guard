// 웹 빌드·테스트 설정.
// 개발 서버(npm run dev)에는 서버 프록시를 두지 않는다(R-21). 로그인 콜백 주소는 ZG_PUBLIC_ORIGIN으로 고정이고(authFlow.ts),
// 세션 쿠키는 Secure이며, 상태 변경 요청과 WebSocket은 Origin이 ZG_PUBLIC_ORIGIN과 같아야 해서(server.ts),
// localhost:5173을 거치면 로그인·조치·실시간이 모두 거절된다. 실제 동작은 서버가 제공하는 빌드(dist)를 Funnel 주소로 열어 확인한다.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // globals: React Testing Library가 테스트마다 화면을 자동 정리(cleanup)하려면 전역 afterEach가 필요하다.
  test: { environment: "jsdom", globals: true, include: ["test/**/*.test.{ts,tsx}"] },
});
