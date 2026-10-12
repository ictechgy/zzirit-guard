import { stripInvisibleAndFullwidth } from "./normalize.js";

/**
 * 호스트 바로 뒤에 경로("/")나 포트(":8080")가 오는지 보는 앞쪽 탐색. 3번 그룹으로 잡는다.
 * 왜 포트도 보나: "evil.zzz:8080/x"처럼 포트를 끼우면 경로 휴리스틱(word.word/…)을 피해 갔다(적대적 재점검).
 * 포트는 두 자리 이상만 본다(N2): "T1 vs.GEN:2", "t1.faker:3킬" 같은 점수·횟수 표기를 되돌릴 수 없는 숨김으로 보지 않기 위해서다.
 */
const PATH_OR_PORT_LOOKAHEAD = String.raw`(?=(\/|:\d{2,5}(?!\d))?)`;
/**
 * 호스트 후보를 전부 뽑는 패턴. 1번 그룹은 http(s):// 접두, 2번 그룹은 전체 호스트, 3번 그룹은 바로 뒤의 "/"(경로)나 ":포트"다.
 * 최상위 도메인을 미리 정해 두지 않고 모양만 보는 이유: 목록에 없는 TLD(.bet, .casino)나 IP도 빠짐없이 잡기 위해서다.
 * 앞뒤에 호스트 글자가 이어지면 잘린 조각으로 보지 않도록 막는다.
 * 뒤에 ".한글"이 와도 끊는다: "spam.com.진짜 좋음"처럼 문장 끝 마침표 뒤에 한글을 붙인 주소를 놓치지 않기 위해서다.
 */
const HOST_CANDIDATE_PATTERN = new RegExp(String.raw`(?<![a-z0-9.-])(https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z0-9-]+)(?![a-z0-9-]|\.[a-z0-9])` + PATH_OR_PORT_LOOKAHEAD, "g");
/**
 * 한글 최상위 도메인. .한국(국가 도메인)과 .닷컴·.닷넷(com·net의 한글 IDN)이다.
 * .삼성 같은 브랜드 도메인은 넣지 않는다: "역시.삼성" 같은 대화를 되돌릴 수 없는 자동 숨김으로 보지 않기 위해서다.
 */
const HANGUL_TOP_LEVEL_DOMAINS = ["한국", "닷컴", "닷넷"] as const;
/**
 * 한글 라벨이 든 호스트(IDN) 후보를 뽑는 패턴(S11, X15). 그룹 번호는 HOST_CANDIDATE_PATTERN과 같다.
 * 라벨은 영문·숫자 라벨이거나 한글이 하나 이상 든 한글·숫자 라벨이다(한 라벨에 영문과 한글을 섞지 않는다).
 * 왜 섞지 않나: "링크youtube.com"처럼 한글 낱말에 붙여 쓴 주소를 한 호스트로 읽으면, 허용 도메인 링크를 쓴 정상 채팅을 되돌릴 수 없게 숨긴다.
 * 대신 그런 모양은 containsGluedAllowedLink가 후보로 올려 매니저가 본다(다른 주소일 수 있어서).
 * 마지막 라벨은 영문 TLD(뒤에 "에서" 같은 한글 조사가 붙어도 된다) 또는 한글 TLD(뒤에 한글이 이어지면 낱말로 보고 빼낸다)이다.
 * 한글 라벨에는 앞쪽 탐색(?=…)으로 한글이 있는지 먼저 확인해, 긴 한글 입력에서 되돌아가기가 늘지 않게 한다.
 */
const HANGUL_HOST_CANDIDATE_PATTERN = new RegExp(
  String.raw`(?<![a-z0-9가-힣.-])(https?:\/\/)?((?:(?:[a-z0-9-]+|(?=[가-힣0-9-]*[가-힣])[가-힣0-9-]+)\.)+` +
    String.raw`(?:(?:${HANGUL_TOP_LEVEL_DOMAINS.join("|")})(?![a-z0-9가-힣-])|[a-z0-9-]+(?![a-z0-9-])))(?!\.[a-z0-9가-힣])` +
    PATH_OR_PORT_LOOKAHEAD,
  "g",
);
/** 한글 음절. 한글 호스트 후보만 골라낼 때 쓴다(영문 호스트는 HOST_CANDIDATE_PATTERN이 맡는다). */
const HANGUL_SYLLABLE_PATTERN = /[가-힣]/;
/** 퓨니코드(IDN을 ASCII로 쓴 형태) 라벨 접두. "xn--3e0b707e"(한국)처럼 목록에 없는 TLD로도 링크를 만들 수 있다. */
const PUNYCODE_LABEL_PREFIX = "xn--";
/**
 * 마지막 라벨이 최상위 도메인 모양(영문자로 시작하는 두 글자 이상)인지. 경로·포트 휴리스틱에만 쓴다.
 * 왜: "3.5/2" 같은 숫자 표기와 "e.g:10"·"a.m:10" 같은 한 글자 약어를 빼기 위해서다. 한 글자 최상위 도메인은 없다(N2).
 */
const TOP_LEVEL_DOMAIN_SHAPE_PATTERN = /^[a-z][a-z0-9-]/;
/**
 * 흔한 최상위 도메인. 접두(http://, www.)가 없는 호스트를 링크로 볼지 가리는 데만 쓴다.
 * 호스트의 첫 라벨을 뺀 나머지 라벨 중 하나라도 여기 있으면 링크로 본다("youtube.com.de", "spam.ru" 같은 우회를 막기 위해).
 */
const KNOWN_TOP_LEVEL_DOMAINS: ReadonlySet<string> = new Set([
  "com", "net", "org", "kr", "io", "me", "ly", "gg", "xyz", "co", "tv", "app", "link", "site", "shop", "top", "info", "biz", "cc", "to", "kim", "vip",
  "bet", "win", "club", "online", "casino", "live", "fun", "store", "cloud", "pro", "asia", "games", "poker",
  "de", "ru", "cn", "jp", "us", "uk", "vn", "ph", "tw", "hk", "sg", "su", "ws",
  // 한글 최상위 도메인. 한글 호스트 후보에서만 나온다(S11).
  ...HANGUL_TOP_LEVEL_DOMAINS,
]);
/** "텔레 @아이디", "텔레그램 아이디" 같은 연락처 유도(4자 이상 아이디). 도박 단어 없이도 광고로 본다. */
const TELEGRAM_HANDLE_PATTERN = /텔레(?:그램)?\s{0,3}[:@]?\s{0,3}@?[a-z0-9_]{4,}/;
/**
 * 연락 수단 단서 뒤에 "아이디/id" 단어와 아이디가 오는 형태. "dm"은 admin 같은 단어 안에 든 것을 빼려고 앞뒤 영문을 막는다.
 * 사이 공백은 3칸 이하로 제한해 긴 공백 입력에서 매칭이 오래 걸리지 않게 한다.
 */
const MESSENGER_ID_PATTERN = /(?:텔레(?:그램)?|카톡|디엠|(?<![a-z])dm(?![a-z]))\s{0,3}(?:아이디|id)?\s{0,3}[:@]?\s{0,3}@?[a-z0-9_]{3,}/;
/** "@아이디" 형태(영문·숫자·밑줄 3자 이상). 한글 닉네임이나 혼자 쓴 @는 연락처로 보지 않는다("@스트리머 슬롯" 오탐 방지). */
const HANDLE_PATTERN = /@[a-z0-9_]{3,}/;
/** 도박 관련 단어. 단독으로는 대화일 수 있어(예: 토토로) 실제 연락 수단과 함께일 때만 본다. */
const GAMBLING_PATTERN = /토토(?!로)|카지노|바카라|슬롯|홀덤|먹튀/;
/** 휴대전화 번호(010·011·016·017·018·019 + 7~8자리, 구분자 공백·점·하이픈). 앞뒤에 숫자가 더 붙으면 제외. */
const PHONE_PATTERN = /(?<!\d)01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}(?!\d)/;
/** "○○동/○○읍 … 아파트/빌라/오피스텔/맨션" 형태. 두 글자 이상 동명만 본다("우리 아파트"·"하면 이 빌라" 같은 일반 명사를 막기 위해). */
const NEIGHBORHOOD_BUILDING_PATTERN = /[가-힣]{2,}(?:동|읍)\s+\S*\s*(?:아파트|빌라|오피스텔|맨션)/;
/** "101동 1203호" 형태. */
const UNIT_NUMBER_PATTERN = /\d+\s*동\s*\d+\s*호/;
/** 가운데 점 계열 문자(。 U+3002, ｡ U+FF61). 채팅 UI가 마침표로 그려 주므로 "."로 맞춘다. */
const IDEOGRAPHIC_DOT_PATTERN = /[。｡]/g;
/** 도메인 점을 흐리려고 쓰는 [.] 와 (.) 표기. */
const BRACKETED_DOT_PATTERN = /\[\.\]|\(\.\)/g;
/**
 * "scheme://사용자 정보@"까지의 토큰. 이 뒤에 오는 호스트가 브라우저가 실제로 가는 주소다.
 * 왜: "https://allowed.com:pw@evil.zzz"는 사람 눈에 허용 도메인처럼 보이지만 실제 호스트는 evil.zzz다(적대적 재점검).
 */
const URL_USERINFO_TOKEN_PATTERN = /^https?:\/\/[^/?#]*@$/;
/** 공백 문자 하나. 사용자 정보 토큰의 시작(앞의 공백 다음)을 찾을 때 쓴다. */
const WHITESPACE_PATTERN = /\s/;
/** 한글 낱말에 붙여 쓴 호스트를 찾을 때 거꾸로 훑는 라벨 글자(한글 음절·영문·숫자·하이픈). */
const GLUED_LABEL_CHARACTER_PATTERN = /[가-힣a-z0-9-]/;
/**
 * 오른쪽→왼쪽 강제(RLO, U+202E). 이 뒤의 글자는 화면에 거꾸로 그려진다.
 * 왜: "(RLO)moc.lebatsetnoc"는 화면에 "contestable.com"으로 보이는데, 제어 문자만 지우고 논리 순서로 읽으면 링크가 아니다(적대적 재점검).
 */
const RIGHT_TO_LEFT_OVERRIDE = "\u202E";
/** RLO 구간을 끝내는 문자: PDF(U+202C)와 PDI(U+2069). */
const OVERRIDE_END_PATTERN = /[\u202C\u2069]/;

/**
 * 호스트 후보 하나. hasExplicitPrefix는 http(s):// 또는 www. 로 시작하거나 URL 사용자 정보(…@) 뒤에 와서 링크임이 분명한지,
 * isFollowedBySlash는 바로 뒤에 "/"나 ":포트"가 오는지, start는 텍스트에서 호스트가 시작하는 위치다.
 */
interface HostCandidate {
  readonly host: string;
  readonly hasExplicitPrefix: boolean;
  readonly isFollowedBySlash: boolean;
  readonly start: number;
}

/**
 * 검사 전 공통 전처리. 보이지 않는 문자·전각을 걷어내고, 호환 문자를 기본 문자로 바꾼 뒤(NFKC) 소문자로 맞춘다.
 * 이유: 채팅 UI는 이런 문자를 건너뛰고 링크로 그리므로, 패턴이 보는 문자열도 같아야 우회를 막는다.
 * NFKC는 브라우저 주소 처리(UTS 46)처럼 "ⓔⓥⓘⓛ.ⓒⓞⓜ"·"𝐞𝐯𝐢𝐥.𝐜𝐨𝐦"·"evil․com"(한 점 리더)·"𝟎𝟏𝟎…"를 기본 글자로 맞춘다(적대적 재점검).
 * 금칙어 비교(normalize.ts)에는 넣지 않는다: 호환 자모가 조합형으로 바뀌어 자모 조합 단계가 달라지기 때문이다.
 */
function prepareText(text: string): string {
  return stripInvisibleAndFullwidth(text).normalize("NFKC").toLowerCase();
}

/**
 * 검사할 읽기 순서들. 기본은 원문(논리 순서) 하나이고, RLO가 있으면 화면에 보이는 순서로 뒤집은 것도 함께 본다.
 * 둘 중 하나라도 걸리면 걸린 것으로 본다. 정상 채팅에는 RLO가 거의 없어 오탐 걱정이 작다.
 * @param text 원문
 */
function readingOrders(text: string): string[] {
  return text.includes(RIGHT_TO_LEFT_OVERRIDE) ? [text, toDisplayOrder(text)] : [text];
}

/**
 * RLO 구간(RLO 뒤부터 PDF·PDI 또는 끝까지)을 거꾸로 뒤집어 화면에 보이는 순서에 가깝게 만든다. 중첩은 따로 다루지 않는다.
 * @param text RLO가 든 원문
 */
function toDisplayOrder(text: string): string {
  return text
    .split(RIGHT_TO_LEFT_OVERRIDE)
    .map((segment, index) => (index === 0 ? segment : reverseOverriddenPart(segment)))
    .join("");
}

/**
 * RLO 바로 뒤 조각에서 구간 끝(PDF·PDI) 전까지만 글자 순서를 뒤집는다.
 * @param segment RLO 뒤의 조각
 */
function reverseOverriddenPart(segment: string): string {
  const end = segment.search(OVERRIDE_END_PATTERN);
  const overridden = end === -1 ? segment : segment.slice(0, end);
  return [...overridden].reverse().join("") + (end === -1 ? "" : segment.slice(end));
}

/**
 * 링크 검사용 전처리. 공통 전처리 뒤에 가운데 점과 [.] (.) 표기를 "."로 바꾼다.
 * 이유: "spam[.]com"처럼 점을 가려 쓴 주소는 사람에게는 링크로 보이므로, 호스트 추출 전에 같은 모양으로 맞춘다.
 */
function prepareLinkText(text: string): string {
  return prepareText(text).replace(IDEOGRAPHIC_DOT_PATTERN, ".").replace(BRACKETED_DOT_PATTERN, ".");
}

/**
 * 텍스트에서 호스트 후보를 모두 뽑는다: 영문 호스트와, 한글 라벨이 든 호스트(IDN, S11).
 * @returns 호스트와 접두(scheme/www) 유무, 뒤따르는 경로 유무 목록
 */
function extractHostCandidates(text: string): HostCandidate[] {
  const hangulCandidates = matchHostCandidates(text, HANGUL_HOST_CANDIDATE_PATTERN).filter((candidate) => HANGUL_SYLLABLE_PATTERN.test(candidate.host));
  return [...matchHostCandidates(text, HOST_CANDIDATE_PATTERN), ...hangulCandidates];
}

/**
 * 패턴 하나로 호스트 후보를 뽑는다. 두 패턴은 그룹 번호(1: 접두, 2: 호스트, 3: 뒤따르는 "/")가 같다.
 * @param text 링크 검사용 전처리를 거친 텍스트
 * @param pattern HOST_CANDIDATE_PATTERN 또는 HANGUL_HOST_CANDIDATE_PATTERN(g 플래그)
 */
function matchHostCandidates(text: string, pattern: RegExp): HostCandidate[] {
  return [...text.matchAll(pattern)].map((match) => {
    const host = match[2] ?? "";
    const start = match.index + (match[1]?.length ?? 0);
    const hasExplicitPrefix = match[1] !== undefined || host.startsWith("www.") || isAfterUrlUserinfo(text, start);
    return { host, hasExplicitPrefix, isFollowedBySlash: match[3] !== undefined, start };
  });
}

/**
 * 호스트가 "https://사용자정보@" 바로 뒤에 오는지 본다. 그렇다면 브라우저가 실제로 가는 호스트라 링크로 본다.
 * @param text 링크 검사용 전처리를 거친 텍스트
 * @param hostStart 호스트가 시작하는 위치
 */
function isAfterUrlUserinfo(text: string, hostStart: number): boolean {
  if (text[hostStart - 1] !== "@") return false;
  let tokenStart = hostStart;
  while (tokenStart > 0 && !WHITESPACE_PATTERN.test(text[tokenStart - 1] ?? "")) tokenStart -= 1;
  return URL_USERINFO_TOKEN_PATTERN.test(text.slice(tokenStart, hostStart));
}

/** 호스트에 퓨니코드 라벨(xn--)이 하나라도 있는지 본다. 사람이 IDN 주소를 ASCII로 옮겨 쓴 것이므로 링크로 본다(S11). */
function hasPunycodeLabel(host: string): boolean {
  return host.split(".").some((label) => label.startsWith(PUNYCODE_LABEL_PREFIX));
}

/**
 * 호스트에 알려진 TLD가 첫 라벨 뒤에 하나라도 있는지 본다. "youtube.com.de"처럼 TLD가 중간에 있어도 링크로 보기 위해서다.
 * 첫 라벨은 제외한다. "com.xyz" 같은 이름 조합을 TLD로 오인하지 않기 위해서다.
 */
function hasKnownTopLevelDomain(host: string): boolean {
  return host.split(".").slice(1).some((label) => KNOWN_TOP_LEVEL_DOMAINS.has(label));
}

/**
 * 후보가 링크인지 본다.
 * 1) 접두가 있으면 TLD와 상관없이 링크(.bet, IP 포함).
 * 2) 퓨니코드 라벨(xn--)이 있으면 링크(S11).
 * 3) 접두가 없어도 "word.word/..."·"word.word:8080"(접두 없이 경로·포트가 붙은 호스트)은 거의 항상 URL이라 링크로 본다.
 *    단, 마지막 라벨이 영문자로 시작하는 두 글자 이상이어야 한다("3.5/2 정도" 같은 숫자 표기, "a.m:10" 같은 한 글자 약어, "그래.그래/…" 같은 한글 표기는 제외).
 * 4) 그 밖에는 첫 라벨 뒤에 알려진 TLD(.한국 포함)가 있을 때만 링크다("3.5", "ver.2", "안녕.하세요" 같은 표기를 거르기 위해).
 */
function isLinkCandidate(candidate: HostCandidate): boolean {
  if (candidate.hasExplicitPrefix || hasPunycodeLabel(candidate.host)) return true;
  const lastLabel = candidate.host.split(".").at(-1) ?? "";
  if (candidate.isFollowedBySlash && TOP_LEVEL_DOMAIN_SHAPE_PATTERN.test(lastLabel)) return true;
  return hasKnownTopLevelDomain(candidate.host);
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

/**
 * 텍스트에서 링크로 볼 호스트를 모두 뽑는다(맨 앞 www. 제거).
 * @param linkText prepareLinkText를 거친 텍스트
 */
function extractLinkHosts(linkText: string): string[] {
  return extractHostCandidates(linkText).filter(isLinkCandidate).map((candidate) => stripLeadingWww(candidate.host));
}

/**
 * 허용 도메인이 아닌 링크가 하나라도 있는지 본다.
 * @param linkHosts extractLinkHosts 결과
 * @param allowDomains 채널이 허용한 도메인
 */
function hasBlockedHost(linkHosts: readonly string[], allowDomains: readonly string[]): boolean {
  return linkHosts.some((host) => !isAllowedHost(host, allowDomains));
}

/**
 * 도박 단어가 실제 연락 수단과 함께 있는지 본다. 연락 수단은 messenger 아이디, "@아이디", 휴대전화 번호, 허용되지 않은 링크 중 하나다.
 * 단순히 "가입·문의·@"만 있는 것은 일반 대화와 구분되지 않으므로 세지 않는다.
 * 허용 도메인 링크는 연락 수단으로 세지 않는다(S10, M09). 왜: 홀덤·슬롯 방송에서 "홀덤 하이라이트 youtube.com/…" 같은 정상 채팅이
 * 되돌릴 수 없는 자동 숨김이 됐다. 채널이 허용한 주소는 광고 연락처가 아니다.
 * @param linkText prepareLinkText를 거친 텍스트
 * @param linkHosts extractLinkHosts 결과
 * @param allowDomains 채널이 허용한 도메인
 */
function hasRealContact(linkText: string, linkHosts: readonly string[], allowDomains: readonly string[]): boolean {
  return MESSENGER_ID_PATTERN.test(linkText) || HANDLE_PATTERN.test(linkText) || containsPhoneNumber(linkText) || hasBlockedHost(linkHosts, allowDomains);
}

/**
 * 광고·외부 링크·연락처 유도가 있는지 본다(스펙 5.2 광고 링크 규칙).
 * @param text 원문(정규화 전). 보이지 않는 문자·전각은 내부에서 걷어낸다.
 * @param allowDomains 채널이 허용한 도메인(소문자, www 제거). 하위 도메인까지 허용한다.
 */
export function containsBlockedLink(text: string, allowDomains: readonly string[]): boolean {
  return readingOrders(text).some((reading) => hasBlockedLinkIn(prepareLinkText(reading), allowDomains));
}

/**
 * 읽기 순서 하나에서 광고·외부 링크·연락처 유도를 찾는다(containsBlockedLink 본체).
 * @param linkText prepareLinkText를 거친 텍스트
 * @param allowDomains 채널이 허용한 도메인
 */
function hasBlockedLinkIn(linkText: string, allowDomains: readonly string[]): boolean {
  const linkHosts = extractLinkHosts(linkText);
  if (hasBlockedHost(linkHosts, allowDomains)) return true;
  if (TELEGRAM_HANDLE_PATTERN.test(linkText)) return true;
  return GAMBLING_PATTERN.test(linkText) && hasRealContact(linkText, linkHosts, allowDomains);
}

/**
 * 허용 도메인 링크인데 바로 앞에 한글이 붙어, 다른 주소(예: "카지노youtube.com" = 한글 IDN 도메인)로 읽힐 수 있는지 본다.
 * 왜 자동 숨김이 아니라 후보 신호인가: "링크youtube.com"처럼 낱말에 붙여 쓴 정상 링크와 구분할 수 없어,
 * 되돌릴 수 없는 숨김 대신 매니저가 보게 한다. 붙여 읽어도 허용 도메인의 하위 도메인이면("카지노m.youtube.com") 신호를 내지 않는다.
 * @param text 원문(정규화 전)
 * @param allowDomains 채널이 허용한 도메인
 */
export function containsGluedAllowedLink(text: string, allowDomains: readonly string[]): boolean {
  return readingOrders(text).some((reading) => hasGluedAllowedHost(prepareLinkText(reading), allowDomains));
}

/**
 * 읽기 순서 하나에서 한글이 붙은 허용 도메인 링크를 찾는다(containsGluedAllowedLink 본체).
 * @param linkText prepareLinkText를 거친 텍스트
 * @param allowDomains 채널이 허용한 도메인
 */
function hasGluedAllowedHost(linkText: string, allowDomains: readonly string[]): boolean {
  return matchHostCandidates(linkText, HOST_CANDIDATE_PATTERN).some((candidate) => {
    const gluedPrefix = gluedHangulPrefix(linkText, candidate.start);
    if (gluedPrefix === "" || !isLinkCandidate(candidate)) return false;
    return isAllowedHost(stripLeadingWww(candidate.host), allowDomains) && !isAllowedHost(gluedPrefix + candidate.host, allowDomains);
  });
}

/**
 * 호스트 바로 앞에 공백 없이 붙은 라벨 글자 묶음을 돌려준다. 한글이 하나도 없으면 빈 문자열.
 * @param text 링크 검사용 전처리를 거친 텍스트
 * @param hostStart 호스트가 시작하는 위치
 */
function gluedHangulPrefix(text: string, hostStart: number): string {
  let prefixStart = hostStart;
  while (prefixStart > 0 && GLUED_LABEL_CHARACTER_PATTERN.test(text[prefixStart - 1] ?? "")) prefixStart -= 1;
  const prefix = text.slice(prefixStart, hostStart);
  return HANGUL_SYLLABLE_PATTERN.test(prefix) ? prefix : "";
}

/**
 * 휴대전화 번호가 있는지 본다(신상 노출 방지). 보이지 않는 문자로 끊긴 번호, 호환 숫자(𝟎·⓪), RLO로 뒤집어 보이게 한 번호도 찾는다.
 * @param text 원문(정규화 전)
 */
export function containsPhoneNumber(text: string): boolean {
  return readingOrders(text).some((reading) => PHONE_PATTERN.test(prepareText(reading)));
}

/**
 * 주소처럼 보이는 표현이 있는지 본다. 오탐이 있을 수 있어 후보로만 쓴다.
 * @param text 원문(정규화 전)
 */
export function looksLikeAddress(text: string): boolean {
  return readingOrders(text).some((reading) => {
    const prepared = prepareText(reading);
    return NEIGHBORHOOD_BUILDING_PATTERN.test(prepared) || UNIT_NUMBER_PATTERN.test(prepared);
  });
}
