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
    "3.5/2 정도",
  ])("일반 대화는 통과: %s", (text) => {
    expect(containsBlockedLink(text, [])).toBe(false);
  });

  it("허용 도메인과 그 하위 도메인은 통과", () => {
    expect(containsBlockedLink("https://www.youtube.com/watch?v=1", ["youtube.com"])).toBe(false);
    expect(containsBlockedLink("m.youtube.com/abc", ["youtube.com"])).toBe(false);
    expect(containsBlockedLink("fakeyoutube.com/abc", ["youtube.com"])).toBe(true);
  });

  it("허용 도메인 뒤에 다른 도메인을 붙인 우회는 막는다", () => {
    expect(containsBlockedLink("youtube.com.de/x", ["youtube.com"])).toBe(true);
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
