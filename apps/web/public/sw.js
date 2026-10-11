// 서비스 워커: 푸시 알림 표시와 알림 클릭 시 앱 열기만 한다.
// 오프라인 캐시는 하지 않는다. 옛 화면을 보고 이미 처리된 후보에 조치하는 일을 막기 위해서다.

/** 푸시 내용을 읽는다. JSON이 아니면 본문 텍스트를 그대로 쓴다. */
function readPushMessage(data) {
  if (!data) return { title: "찌리릿 가드", body: "" };
  try {
    return data.json();
  } catch (error) {
    console.warn("푸시 내용이 JSON이 아닙니다", error);
    return { title: "찌리릿 가드", body: data.text() };
  }
}

self.addEventListener("push", (event) => {
  const message = readPushMessage(event.data);
  event.waitUntil(self.registration.showNotification(message.title, { body: message.body, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png" }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((windows) => (windows[0] ? windows[0].focus() : self.clients.openWindow("/"))),
  );
});
