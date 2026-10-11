/**
 * 도메인 모양의 문자열. 흔한 최상위 도메인만 보고, 숫자 버전 표기(ver.2)나 소수(3.5)는 걸리지 않게 한다.
 * 1번 그룹이 호스트 이름이다.
 */
const DOMAIN_PATTERN =
  /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+(?:com|net|org|kr|io|me|ly|gg|xyz|co|tv|app|link|site|shop|top|info|biz|cc|to|kim|vip))(?![a-z0-9-])/gi;
/** "텔레 @아이디", "텔레그램 아이디" 같은 연락처 유도. */
const TELEGRAM_HANDLE_PATTERN = /텔레(?:그램)?\s*[:@]?\s*@?[a-z0-9_]{4,}/i;
/** 도박 관련 단어. 단독으로는 대화일 수 있어(예: 토토로) 연락 유도와 함께일 때만 본다. */
const GAMBLING_PATTERN = /토토(?!로)|카지노|바카라|슬롯|홀덤|먹튀/;
/** 연락·가입 유도 표현. */
const CONTACT_PATTERN = /텔레|카톡|디엠|dm|문의|가입|@/i;
/** 휴대전화 번호(010·011·016·017·018·019 + 7~8자리, 구분자 공백·점·하이픈). 앞뒤에 숫자가 더 붙으면 제외. */
const PHONE_PATTERN = /(?<!\d)01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}(?!\d)/;
/** "○○동 … 아파트/빌라/오피스텔/맨션" 형태. */
const NEIGHBORHOOD_BUILDING_PATTERN = /[가-힣]+(?:동|읍|면|리)\s+\S*\s*(?:아파트|빌라|오피스텔|맨션)/;
/** "101동 1203호" 형태. */
const UNIT_NUMBER_PATTERN = /\d+\s*동\s*\d+\s*호/;

/**
 * 광고·외부 링크·연락처 유도가 있는지 본다(스펙 5.2 광고 링크 규칙).
 * @param allowDomains 채널이 허용한 도메인(소문자, www 제거). 하위 도메인까지 허용한다.
 */
export function containsBlockedLink(text: string, allowDomains: readonly string[]): boolean {
  const hosts = [...text.matchAll(DOMAIN_PATTERN)].map((match) => (match[1] ?? "").toLowerCase().replace(/^www\./, ""));
  if (hosts.some((host) => !isAllowedHost(host, allowDomains))) return true;
  if (TELEGRAM_HANDLE_PATTERN.test(text)) return true;
  return GAMBLING_PATTERN.test(text) && CONTACT_PATTERN.test(text);
}

/** 호스트가 허용 도메인이거나 그 하위 도메인인지 본다("fakeyoutube.com"은 허용하지 않는다). */
function isAllowedHost(host: string, allowDomains: readonly string[]): boolean {
  return allowDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** 휴대전화 번호가 있는지 본다(신상 노출 방지). */
export function containsPhoneNumber(text: string): boolean {
  return PHONE_PATTERN.test(text);
}

/** 주소처럼 보이는 표현이 있는지 본다. 오탐이 있을 수 있어 후보로만 쓴다. */
export function looksLikeAddress(text: string): boolean {
  return NEIGHBORHOOD_BUILDING_PATTERN.test(text) || UNIT_NUMBER_PATTERN.test(text);
}
