import webpush from "web-push";

/**
 * 테스트용 VAPID 설정. 서버가 시작할 때 web-push로 키 형식을 검사하므로(F9.4) 올바른 키 쌍이 필요하다.
 * 키를 저장소에 적어 두지 않고 테스트를 돌릴 때마다 새로 만든다. 비밀 키 모양의 문자열이 저장소에 남지 않게 하려는 것이다.
 */
export const TEST_VAPID = { ...webpush.generateVAPIDKeys(), subject: "mailto:owner@example.com" };
