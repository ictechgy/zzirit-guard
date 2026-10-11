import { stripInvisibleAndFullwidth } from "./normalize.js";

/**
 * 호스트 후보를 전부 뽑는 패턴. 1번 그룹은 http(s):// 접두, 2번 그룹은 전체 호스트, 3번 그룹은 바로 뒤의 "/"(경로)다.
 * 최상위 도메인을 미리 정해 두지 않고 모양만 보는 이유: 목록에 없는 TLD(.bet, .casino)나 IP도 빠짐없이 잡기 위해서다.
 * 앞뒤에 호스트 글자가 이어지면 잘린 조각으로 보지 않도록 막는다.
 */
const HOST_CANDIDATE_PATTERN = /(?<![a-z0-9.-])(https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z0-9-]+)(?![a-z0-9-]|\.[a-z0-9])(?=(\/)?)/g;
/** 마지막 라벨이 영문자로 시작하는지. "3.5/2" 같은 숫자 표기를 경로 휴리스틱에서 빼기 위해 쓴다. */
const STARTS_WITH_LETTER_PATTERN = /^[a-z]/;
/** 흔한 최상위 도메인. 접두(http://, www.)가 없는 호스트를 링크로 볼지 가리는 데만 쓴다. */
const KNOWN_TOP_LEVEL_DOMAINS: ReadonlySet<string> = new Set([
  "com", "net", "org", "kr", "io", "me", "ly", "gg", "xyz", "co", "tv", "app", "link", "site", "shop", "top", "info", "biz", "cc", "to", "kim", "vip",
]);
/** "텔레 @아이디", "텔레그램 아이디" 같은 연락처 유도(4자 이상 아이디). 도박 단어 없이도 광고로 본다. */
const TELEGRAM_HANDLE_PATTERN = /텔레(?:그램)?\s*[:@]?\s*@?[a-z0-9_]{4,}/i;
/** 연락 수단 단서 뒤에 아이디가 오는 형태. "dm"은 admin 같은 단어 안에 든 것을 빼려고 앞뒤 영문을 막는다. */
const MESSENGER_ID_PATTERN = /(?:텔레(?:그램)?|카톡|디엠|(?<![a-z])dm(?![a-z]))\s*[:@]?\s*@?[a-z0-9_]{3,}/;
/** 도박 관련 단어. 단독으로는 대화일 수 있어(예: 토토로) 실제 연락 수단과 함께일 때만 본다. */
const GAMBLING_PATTERN = /토토(?!로)|카지노|바카라|슬롯|홀덤|먹튀/;
/** 휴대전화 번호(010·011·016·017·018·019 + 7~8자리, 구분자 공백·점·하이픈). 앞뒤에 숫자가 더 붙으면 제외. */
const PHONE_PATTERN = /(?<!\d)01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}(?!\d)/;
/** "○○동/○○읍 … 아파트/빌라/오피스텔/맨션" 형태. 두 글자 이상 동명만 본다("우리 아파트"·"하면 이 빌라" 같은 일반 명사를 막기 위해). */
const NEIGHBORHOOD_BUILDING_PATTERN = /[가-힣]{2,}(?:동|읍)\s+\S*\s*(?:아파트|빌라|오피스텔|맨션)/;
/** "101동 1203호" 형태. */
const UNIT_NUMBER_PATTERN = /\d+\s*동\s*\d+\s*호/;

/** 호스트 후보 하나. hasExplicitPrefix는 http(s):// 또는 www. 로 시작해 링크임이 분명한지, isFollowedBySlash는 바로 뒤에 "/"가 오는지 나타낸다. */
interface HostCandidate {
  readonly host: string;
  readonly hasExplicitPrefix: boolean;
  readonly isFollowedBySlash: boolean;
}

/**
 * 검사 전 공통 전처리. 보이지 않는 문자·전각을 걷어내고 소문자로 맞춘다.
 * 이유: 채팅 UI는 이런 문자를 건너뛰고 링크로 그리므로, 패턴이 보는 문자열도 같아야 우회를 막는다.
 */
function prepareText(text: string): string {
  return stripInvisibleAndFullwidth(text).toLowerCase();
}

/**
 * 텍스트에서 호스트 후보를 모두 뽑는다.
 * @returns 호스트와 접두(scheme/www) 유무 목록
 */
function extractHostCandidates(text: string): HostCandidate[] {
  return [...text.matchAll(HOST_CANDIDATE_PATTERN)].map((match) => {
    const host = match[2] ?? "";
    return { host, hasExplicitPrefix: match[1] !== undefined || host.startsWith("www."), isFollowedBySlash: match[3] !== undefined };
  });
}

/**
 * 후보가 링크인지 본다.
 * 1) 접두가 있으면 TLD와 상관없이 링크(.bet, IP 포함).
 * 2) 접두가 없어도 "word.word/..."(접두 없이 경로가 붙은 호스트)는 거의 항상 URL이라 링크로 본다.
 *    단, 마지막 라벨이 영문자로 시작해야 한다("3.5/2 정도" 같은 숫자 표기는 제외).
 * 3) 그 밖에는 마지막 라벨이 알려진 TLD일 때만 링크다("3.5", "ver.2" 같은 숫자 표기를 거르기 위해).
 */
function isLinkCandidate(candidate: HostCandidate): boolean {
  if (candidate.hasExplicitPrefix) return true;
  const lastLabel = candidate.host.split(".").at(-1) ?? "";
  if (candidate.isFollowedBySlash && STARTS_WITH_LETTER_PATTERN.test(lastLabel)) return true;
  return KNOWN_TOP_LEVEL_DOMAINS.has(lastLabel);
}

/** 맨 앞의 www.를 떼어 허용 목록과 비교할 호스트를 만든다. */
function stripLeadingWww(host: string): string {
  return host.replace(/^www\./, "");
}

/**
 * 호스트가 허용 도메인이거나 그 하위 도메인인지 본다. 전체 호스트로 비교해야 "youtube.com.de"가 "youtube.com"으로 통과하지 않는다.
 * "fakeyoutube.com"은 "." 경계가 없으므로 허용하지 않는다.
 */
function isAllowedHost(host: string, allowDomains: readonly string[]): boolean {
  return allowDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** 텍스트에 링크로 볼 호스트가 하나라도 있는지 본다. */
function hasAnyLink(text: string): boolean {
  return extractHostCandidates(text).some(isLinkCandidate);
}

/**
 * 도박 단어가 실제 연락 수단과 함께 있는지 본다. 연락 수단은 messenger 아이디, 휴대전화 번호, 링크 중 하나다.
 * 단순히 "가입·문의·@"만 있는 것은 일반 대화와 구분되지 않으므로 세지 않는다.
 */
function hasRealContact(text: string): boolean {
  return MESSENGER_ID_PATTERN.test(text) || containsPhoneNumber(text) || hasAnyLink(text);
}

/**
 * 광고·외부 링크·연락처 유도가 있는지 본다(스펙 5.2 광고 링크 규칙).
 * @param text 원문(정규화 전). 보이지 않는 문자·전각은 내부에서 걷어낸다.
 * @param allowDomains 채널이 허용한 도메인(소문자, www 제거). 하위 도메인까지 허용한다.
 */
export function containsBlockedLink(text: string, allowDomains: readonly string[]): boolean {
  const prepared = prepareText(text);
  const linkHosts = extractHostCandidates(prepared).filter(isLinkCandidate).map((candidate) => stripLeadingWww(candidate.host));
  if (linkHosts.some((host) => !isAllowedHost(host, allowDomains))) return true;
  if (TELEGRAM_HANDLE_PATTERN.test(prepared)) return true;
  return GAMBLING_PATTERN.test(prepared) && hasRealContact(prepared);
}

/**
 * 휴대전화 번호가 있는지 본다(신상 노출 방지). 보이지 않는 문자로 끊긴 번호도 찾는다.
 * @param text 원문(정규화 전)
 */
export function containsPhoneNumber(text: string): boolean {
  return PHONE_PATTERN.test(prepareText(text));
}

/**
 * 주소처럼 보이는 표현이 있는지 본다. 오탐이 있을 수 있어 후보로만 쓴다.
 * @param text 원문(정규화 전)
 */
export function looksLikeAddress(text: string): boolean {
  const prepared = prepareText(text);
  return NEIGHBORHOOD_BUILDING_PATTERN.test(prepared) || UNIT_NUMBER_PATTERN.test(prepared);
}
