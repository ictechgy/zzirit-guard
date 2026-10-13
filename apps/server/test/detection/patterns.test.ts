import { describe, expect, it } from "vitest";
import { containsBareHangulLink, containsBlockedLink, containsGluedAllowedLink, containsPhoneNumber, containsPortOnlyLink, looksLikeAddress } from "../../src/detection/patterns.js";

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

describe("한글(IDN) 도메인(S11, X15)", () => {
  it.each([
    "카지노.kr",
    "카지노.한국/abc",
    "https://카지노.한국",
    "가입은 카지노.kr에서",
    "꽁머니123.com 들어와",
    "xn--9n2bp8q.com",
    "xn--9n2bp8q.xn--3e0b707e",
    "spam.xn--3e0b707e/abc",
    "토토사이트.net",
  ])("링크로 잡는다: %s", (text) => {
    expect(containsBlockedLink(text, [])).toBe(true);
  });

  it.each([
    "그래.그래",
    "안녕.하세요",
    "진짜.한국사람 맞음",
    "아 그렇구나.ㅋㅋ",
    "오늘 방송 끝.내일 봐요",
  ])("일반 대화는 링크로 보지 않는다: %s", (text) => {
    expect(containsBlockedLink(text, [])).toBe(false);
  });

  it("한글이 붙은 허용 도메인은 그대로 허용한다(한글을 호스트에 붙여 읽지 않는다)", () => {
    expect(containsBlockedLink("링크youtube.com/watch?v=1", ["youtube.com"])).toBe(false);
    expect(containsBlockedLink("사이트는 youtube.com입니다", ["youtube.com"])).toBe(false);
  });

  it("허용 목록의 한글 도메인은 통과", () => {
    expect(containsBlockedLink("카페.한국/공지", ["카페.한국"])).toBe(false);
  });
});

describe("호스트 추출과 허용 판단 사이의 파서 차이(적대적 재점검)", () => {
  /** 채널이 허용한 도메인. */
  const allow = ["youtube.com", "allowed.com"];

  it.each([
    ["URL 사용자 정보 뒤의 진짜 호스트", "https://allowed.com@evil.zzz"],
    ["URL 사용자 정보(비밀번호 포함) 뒤의 진짜 호스트", "https://allowed.com:pw@evil.zzz"],
    ["한글 최상위 도메인 .닷컴", "카지노.닷컴"],
    ["한글 최상위 도메인 .닷넷", "spam.닷넷/x"],
    ["허용 도메인 뒤에 붙인 .닷컴", "youtube.com.닷컴"],
    ["RLO로 뒤집어 보이는 주소", "\u202Emoc.lebatsetnoc"],
    ["동그라미 글자", "ⓔⓥⓘⓛ.ⓒⓞⓜ"],
    ["수학 굵은 글자", "𝐞𝐯𝐢𝐥.𝐜𝐨𝐦"],
    ["한 점 리더(U+2024)", "evil\u2024com/x"],
    ["작은 마침표(U+FE52)", "evil\uFE52com/x"],
    ["포트가 붙은 호스트", "evil.zzz:8080/x"],
  ])("우회를 막는다: %s", (_label, text) => {
    expect(containsBlockedLink(text, allow)).toBe(true);
  });

  it.each([
    ["RLO로 뒤집어 보이는 번호", "\u202E8765-4321-010"],
    ["수학 숫자", "𝟎𝟏𝟎-𝟏𝟐𝟑𝟒-𝟓𝟔𝟕𝟖"],
    ["동그라미 숫자", "⓪①⓪-①②③④-⑤⑥⑦⑧"],
  ])("전화번호 우회를 막는다: %s", (_label, text) => {
    expect(containsPhoneNumber(text)).toBe(true);
  });

  it.each([
    "allowed.com.evil.com",
    "evil.com/allowed.com",
    "allowed.com@evil.com",
    "allowed。com.evil.zzz/x",
    "EVIL.COM/X",
    "ｅｖｉｌ．ｃｏｍ",
    "xn--9n2bp8q.xn--3e0b707e",
    "evil.com.",
    "youtube.com.카지노.kr",
    "spam.com.진짜 좋음",
    "evil\u202A.\u202Ccom",
    "토토 youtube.com 텔레 @abc123",
    "토토 youtube.com @abc123",
    "토토 youtube.com 카톡 abc123",
    "토토 youtube.com 010-1234-5678",
  ])("이미 막던 모양은 계속 막는다: %s", (text) => {
    expect(containsBlockedLink(text, allow)).toBe(true);
  });

  it.each(["YOUTUBE.COM/watch", "allowed。com/x", "youtube.com./x", "토토 youtube.com/watch", "역시.삼성", "오늘 ㏂ 10시 방송", "쉬는 시간 11.30:00"])(
    "허용 링크와 일반 대화는 통과: %s",
    (text) => {
      expect(containsBlockedLink(text, allow)).toBe(false);
    },
  );

  it.each(["T1 vs.GEN:2", "e.g:1", "t1.faker:3킬", "a.m:10", "오전 a.m:10 방송"])("한 자리 숫자나 한 글자 끝 라벨에 붙은 콜론은 포트로 보지 않는다(N2): %s", (text) => {
    expect(containsBlockedLink(text, allow)).toBe(false);
  });

  it.each(["evil.zzz:8080/x", "evil.com:8080", "spam.bet:443", "evil.dev:8/x"])("알려진 최상위 도메인이거나 포트 뒤에 경로가 오면 자동 숨김 대상이다(N2, U3): %s", (text) => {
    expect(containsBlockedLink(text, allow)).toBe(true);
  });

  it("한글을 허용 도메인 앞에 붙여 다른 주소일 수 있는 링크는 자동 숨김하지 않고 후보 신호로만 낸다", () => {
    expect(containsBlockedLink("카지노youtube.com/abc", allow)).toBe(false);
    expect(containsGluedAllowedLink("카지노youtube.com/abc", allow)).toBe(true);
    expect(containsGluedAllowedLink("링크YOUTUBE.COM", allow)).toBe(true);
  });

  it("한글을 붙여도 허용 도메인의 하위 도메인으로 읽히면 후보 신호를 내지 않는다", () => {
    expect(containsGluedAllowedLink("카지노m.youtube.com/abc", allow)).toBe(false);
    expect(containsGluedAllowedLink("링크 youtube.com/abc", allow)).toBe(false);
    expect(containsGluedAllowedLink("youtube.com입니다", allow)).toBe(false);
    expect(containsGluedAllowedLink("카지노evil.zzz", allow)).toBe(false);
  });
});

describe("퍼센트 인코딩 등 브라우저가 고쳐 읽는 호스트(K15)", () => {
  it.each([
    ["점까지 인코딩한 호스트", "https://%65%76%69%6c%2e%63%6f%6d"],
    ["일부만 인코딩한 호스트", "가입 http://%65vil.com/x"],
    ["허용 도메인 뒤에 인코딩한 점", "https://allowed.com%2eevil.com"],
    ["16진수 IP 주소", "https://0x7f000001/admin"],
  ])("URL 해석기로 읽은 호스트도 본다: %s", (_label, text) => {
    expect(containsBlockedLink(text, ["allowed.com"])).toBe(true);
  });

  it("풀어 읽은 호스트는 더할 뿐 원문 조각을 지우지 않아, 인코딩으로 가린 주소는 허용 도메인이어도 막는다(보수적)", () => {
    expect(containsBlockedLink("https://%65xample.com/x", ["example.com"])).toBe(true);
    expect(containsBlockedLink("https://%65%78%61%6d%70%6c%65%2e%63%6f%6d/x", ["example.com"])).toBe(false);
  });

  it.each(["https://youtube.com/watch?v=1", "https://카페.한국/공지", "https://localhost", "https://"])("호스트가 그대로이거나 해석할 수 없는 주소는 지금과 같이 본다: %s", (text) => {
    expect(containsBlockedLink(text, ["youtube.com", "카페.한국"])).toBe(false);
  });
});

describe("한글 낱말 + 알려진 최상위 도메인(N1): 단서가 없으면 자동 숨김 대신 후보", () => {
  /** 채널이 허용한 도메인. */
  const allow = ["youtube.com"];

  it.each([
    "좋아요.me", "진짜.kr", "응.com", "그래.co", "헐.live", "레전드.club", "역시.Pro 선수", "방송 재밌다.me too",
    "네이버.com 쳐봐", "유튜브.com", "구글.com에서 찾아봐", "가자.한국!", "역시.한국", "대한민국.한국", "응원합니다.한국.", "네이버.닷컴",
  ])("자동 숨김하지 않고 한글 주소 후보 신호만 낸다: %s", (text) => {
    expect(containsBlockedLink(text, allow)).toBe(false);
    expect(containsBareHangulLink(text, allow)).toBe(true);
  });

  it.each([
    "카지노.kr", "토토사이트.net", "가입은 카지노.kr에서", "카지노.한국/abc", "https://카지노.한국", "https://네이버.com",
    "네이버.com/abc", "네이버.com:8080", "xn--9n2bp8q.xn--3e0b707e", "슬롯 좋아요.me", "ㅋㅏㅈㅣㄴㅗ.kr",
  ])("도박 단어·접두·경로·포트·퓨니코드 단서가 있으면 계속 자동 숨김 대상이다: %s", (text) => {
    expect(containsBlockedLink(text, allow)).toBe(true);
  });

  it.each([
    "좋아.evil.com", "이벤트.evil.bet", "좋아.evil.한국", "좋아.com.evil.bet", "좋아．evil．com", "좋아。evil。com", "좋아\u2066.\u2069evil.com",
  ])("한글 라벨이 영문 도메인의 하위 도메인일 뿐이면(등록 도메인이 영문) 후보로 낮추지 않고 자동 숨김한다(적대적 재점검): %s", (text) => {
    expect(containsBlockedLink(text, allow)).toBe(true);
  });

  it.each(["카지노.kr evil.com/x", "좋아요.me evil.zzz/x", "좋아요.me evil.com", "가자.한국 spam.ru"])(
    "한글 주소와 영문 링크가 함께 있으면 영문 링크 때문에 자동 숨김한다(적대적 재점검): %s",
    (text) => {
      expect(containsBlockedLink(text, allow)).toBe(true);
    },
  );

  it("한글 등록 도메인 앞의 하위 도메인은 후보 그대로다(U2: 단서 없는 한글 주소는 확실하지 않다)", () => {
    expect(containsBlockedLink("무료쿠폰.kr", allow)).toBe(false);
    expect(containsBareHangulLink("무료쿠폰.kr", allow)).toBe(true);
    expect(containsBareHangulLink("evil.좋아.com", allow)).toBe(true);
  });

  it("허용한 한글 도메인은 후보 신호도 내지 않는다", () => {
    expect(containsBareHangulLink("카페.한국", ["카페.한국"])).toBe(false);
  });

  it("영문 호스트는 한글 주소 후보 신호를 내지 않는다", () => {
    expect(containsBareHangulLink("spam.com", allow)).toBe(false);
    expect(containsBareHangulLink("안녕.하세요", allow)).toBe(false);
  });
});

describe("포트만 붙은 모르는 최상위 도메인(U3): 자동 숨김 대신 후보(rule:link_port)", () => {
  it.each(["T1 vs.GEN:13", "t1.faker:12킬", "dk.showmaker:15킬", "lv.max:99", "evil.zzz:8080", "evil.zzz:80"])(
    "자동 숨김하지 않고 포트 주소 후보 신호만 낸다: %s",
    (text) => {
      expect(containsBlockedLink(text, [])).toBe(false);
      expect(containsPortOnlyLink(text, [])).toBe(true);
    },
  );

  it.each(["evil.zzz:8080/x", "evil.com:8080", "https://evil.zzz:8080", "토토 evil.zzz:8080"])(
    "경로·알려진 최상위 도메인·접두·도박 단어가 있으면 자동 숨김 대상이다: %s",
    (text) => {
      expect(containsBlockedLink(text, [])).toBe(true);
    },
  );

  it("포트가 없거나 한 자리 숫자 콜론이면 포트 주소 후보 신호도 내지 않는다", () => {
    expect(containsPortOnlyLink("evil.zzz", [])).toBe(false);
    expect(containsPortOnlyLink("T1 vs.GEN:2", [])).toBe(false);
    expect(containsPortOnlyLink("a.m:10", [])).toBe(false);
  });

  it("허용한 도메인에 포트만 붙으면 후보 신호를 내지 않는다", () => {
    expect(containsPortOnlyLink("my.stream:8080", ["my.stream"])).toBe(false);
  });
});

describe("NFKC가 호스트·번호 경계를 옮겨 생긴 우회(B1): NFKC 한 형태와 하지 않은 형태를 모두 본다", () => {
  it.each(["evil.com™", "spam.ru① 접속", "…evil.com", "…t.me/abc", "①https://evil.zzz", "open.kakao.com™ 들어와", "t.me①/abc", "bit.ly™/abc"])(
    "main에서 막던 링크를 계속 막는다: %s",
    (text) => {
      expect(containsBlockedLink(text, [])).toBe(true);
    },
  );

  it.each(["010-1234-5678①", "①010-1234-5678", "01012345678™", "010-1234-5678²"])("main에서 막던 번호를 계속 막는다: %s", (text) => {
    expect(containsPhoneNumber(text)).toBe(true);
  });

  it("NFKC로만 보이는 우회(동그라미·수학 글자)도 계속 막는다", () => {
    expect(containsBlockedLink("ⓔⓥⓘⓛ.ⓒⓞⓜ", [])).toBe(true);
    expect(containsPhoneNumber("𝟎𝟏𝟎-𝟏𝟐𝟑𝟒-𝟓𝟔𝟕𝟖")).toBe(true);
  });
});

describe("점 바로 뒤 추출 금지로 생긴 우회(B2): 점 앞 글자가 호스트 글자일 때만 막는다", () => {
  it.each([
    "좋아.me_.evil.com", "좋아.me가.evil.com", "좋아.me!.evil.com", "좋아.me..evil.com", "가자.한국_.evil.com", "좋아.me_.bit.ly/abc",
    "ㅋ.evil.com", "..evil.com", "a가.evil.com", "ㅋㅋ.bit.ly/abc", "아 진짜...evil.com 가봐",
  ])("한글 주소 뒤나 구분 문자 뒤의 영문 도메인을 놓치지 않고 막는다: %s", (text) => {
    expect(containsBlockedLink(text, [])).toBe(true);
  });

  it.each(["ㅋ.카지노.kr", "..카지노.한국", "아!.토토사이트.net"])("구분 문자 뒤의 한글 도박 주소도 놓치지 않는다: %s", (text) => {
    expect(containsBlockedLink(text, [])).toBe(true);
  });

  it.each(["아...ok.com", "ㅇㅇ...co.kr"])("말줄임표 뒤에 진짜 도메인이 오면 막는다(받아들인 오탐): %s", (text) => {
    expect(containsBlockedLink(text, [])).toBe(true);
  });

  it.each(["음... 그래", "ㅋㅋ...ㅋㅋ", "아..진짜", "오늘 3.5시간 방송함", "ver.2 패치 좋네", "그래.그래", "끝...이 아니다"])("일반 대화는 계속 통과: %s", (text) => {
    expect(containsBlockedLink(text, [])).toBe(false);
  });

  it("점 앞이 호스트 글자면(도메인의 중간 라벨) 따로 뽑지 않는다", () => {
    expect(containsBlockedLink("youtube.com.de", ["youtube.com"])).toBe(true);
    expect(containsBlockedLink("m.youtube.com/abc", ["youtube.com"])).toBe(false);
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
