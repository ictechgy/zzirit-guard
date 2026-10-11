import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

/**
 * 서비스 워커를 등록한다(푸시 알림용). 실패해도 앱은 동작하므로 경고만 남긴다.
 * 등록이 실패하면 "장애 알림 받기"는 enablePush의 준비 시간 제한(10초) 뒤 이유를 보여 준다(X3).
 */
function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch((error: unknown) => console.warn("서비스 워커 등록 실패(장애 알림을 받을 수 없습니다)", error));
}

registerServiceWorker();
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
