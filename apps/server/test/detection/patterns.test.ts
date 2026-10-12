import { describe, expect, it } from "vitest";
import { containsBlockedLink, containsPhoneNumber, looksLikeAddress } from "../../src/detection/patterns.js";

describe("containsBlockedLink", () => {
  it.each([
    "무료 치킨 쿠폰 받기 👉 bit.ly/free-chk",
    "카지노 사이트 추천 www.xx-casino.com",
    "https://open.kakao.com/o/abcd 들어와",
    "t.me/spamroom",
    "토토 신규가입 3만 포인트 지급 텔레 @abc123",
    "텔레그램 abcd1234 연락",
    "https://spam.bet/abc",
    "https://foo.casino",
    "http://1.2.3.4/x",
    "evil​.com/x",
    "ｅｖｉｌ．ｃｏｍ/x",
    "foo.de/abc",
    "룬 슬롯 꽁머니 카톡 abc123",
    "슬롯 꽁머니 카톡 abc123",
    "토토 사이트 010-1234-5678",
    "토토 가입 @abc123",
    "카지노 문의 @gamble_vip",
    "카톡 아이디 abc123 토토",
    "youtube.com.de",
    "visit spam。com",
    "spam[.]com",
    "spam(.)com/abc",
    "evil.de",
    "spam.ru 들어와",
  ])("광고·링크를 잡는다: %s", (text) => {
    expect(containsBlockedLink(text, [])).toBe(true);
  });

  it.each([
    "오늘 3.5시간 방송함",
    "ver.2 패치 좋네",
    "다음 판은 원딜 해주세요",
    "토토로 귀엽다",
    "룬 슬롯 admin이 정해줌",
    "길드 가입 슬롯 몇개야",
    "먹튀 문의 많네",
    "@스트리머 슬롯 몇개",
    "슬롯 dm 주세요",
    "3.5/2 정도",
  ])("일반 대화는 통과: %s", (text) => {
    expect(containsBlockedLink(text, [])).toBe(false);
  });

  it("허용 도메인과 그 하위 도메인은 통과", () => {
    expect(containsBlockedLink("https://www.youtube.com/watch?v=1", ["youtube.com"])).toBe(false);
    expect(containsBlockedLink("m.youtube.com/abc", ["youtube.com"])).toBe(false);
    expect(containsBlockedLink("fakeyoutube.com/abc", ["youtube.com"])).toBe(true);
  });

  it("도박 단어와 함께여도 허용 도메인 링크는 연락 수단으로 세지 않는다(S10, M09)", () => {
    expect(containsBlockedLink("홀덤 방송 youtube.com/abc 보러 와", ["youtube.com"])).toBe(false);
    expect(containsBlockedLink("슬롯 하이라이트 https://www.youtube.com/watch?v=1", ["youtube.com"])).toBe(false);
    expect(containsBlockedLink("카지노 브금 m.youtube.com/abc", ["youtube.com"])).toBe(false);
  });

  it("허용 도메인 링크가 있어도 다른 연락 수단이 함께면 도박 광고로 잡는다(S10)", () => {
    expect(containsBlockedLink("토토 youtube.com/abc 010-1234-5678", ["youtube.com"])).toBe(true);
    expect(containsBlockedLink("카지노 youtube.com/abc 카톡 abc123", ["youtube.com"])).toBe(true);
    expect(containsBlockedLink("홀덤 youtube.com/abc spam.ru", ["youtube.com"])).toBe(true);
  });

  it("허용 도메인 뒤에 다른 도메인을 붙인 우회는 막는다", () => {
    expect(containsBlockedLink("youtube.com.de/x", ["youtube.com"])).toBe(true);
  });
});

describe("bidi·서식 제어 문자로 끊은 링크·전화번호(S9, M08)", () => {
  it.each([
    ["LRE·PDF(U+202A·U+202C)", "evil\u202A.\u202Ccom/x"],
    ["RLO(U+202E)", "spam\u202E.ru 들어와"],
    ["LRI~PDI(U+2066~2069)", "t\u2066.\u2069me/spamroom"],
    ["ALM(U+061C)", "bit\u061C.ly/free"],
    ["LRM·RLM(U+200E·U+200F)", "evil\u200E.\u200Fde"],
  ])("%s로 끊어도 링크로 잡는다", (_label, text) => {
    expect(containsBlockedLink(text, [])).toBe(true);
  });

  it.each([
    ["U+202A·U+202C", "010\u202A1234\u202C5678"],
    ["U+2066·U+2069", "010-\u20661234\u2069-5678"],
    ["U+061C", "010\u061C1234\u061C5678"],
    ["U+202E", "0\u202E1012345678"],
  ])("%s로 끊은 전화번호도 잡는다", (_label, text) => {
    expect(containsPhoneNumber(text)).toBe(true);
  });
});

describe("containsPhoneNumber", () => {
  it.each(["010-1234-5678 이 번호로", "01012345678", "010 1234 5678", "011.123.4567", "010​1234​5678"])("잡는다: %s", (text) => {
    expect(containsPhoneNumber(text)).toBe(true);
  });
  it.each(["구독자 1000명", "2026-10-11 방송", "0101234567890123"])("통과: %s", (text) => {
    expect(containsPhoneNumber(text)).toBe(false);
  });
});

describe("looksLikeAddress", () => {
  it.each(["얘 실명 김민수고 분당 정자동 OO아파트 산다", "101동 1203호 맞지?", "역삼동 래미안 아파트"])("잡는다: %s", (text) => {
    expect(looksLikeAddress(text)).toBe(true);
  });
  it.each(["오후 3시로 10분 미뤄요", "동네 친구랑 봄", "아파트 게임 재밌다", "우리 아파트 층간소음 심함", "그러면 아파트 사야지", "하면 이 빌라 어때"])("통과: %s", (text) => {
    expect(looksLikeAddress(text)).toBe(false);
  });
});
