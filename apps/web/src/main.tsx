import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

/**
 * 서비스 워커를 등록한다(푸시 알림용). 실패해도 앱은 동작하므로 경고만 남긴다.
 * 등록이 실패하면 "장애 알림 받기"는 enablePush의 준비 시간 제한(10초) 뒤 이유를 보여 준다(X3).
 */
function registerServiceWorker(): void {
  // 왜 PROD만인가: 개발 서버에는 /sw.js가 서버 빌드와 다르고, 등록해 두면 개발 중 옛 워커가 남는다.
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch((error: unknown) => console.warn("서비스 워커 등록 실패(장애 알림을 받을 수 없습니다)", error));
}

registerServiceWorker();
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
