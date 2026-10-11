# 찌리릿 가드 운영 안내서

맥 미니 한 대에 서버를 설치해 채널 1곳을 운영하는 절차다. 스펙: `docs/superpowers/specs/2026-10-11-zzirit-guard-design.md`.

## 1. 준비물
- macOS 맥 미니(전원 연결, **FileVault 켬**, 스펙 8장), Node.js 22.12 이상, git
- Tailscale 계정과 맥 미니 설치(Funnel 사용 가능해야 함)
- 치지직 개발자 센터 계정(운영자 본인 네이버 계정)

## 2. 치지직 개발자 앱 등록
1. https://developers.chzzk.naver.com 에서 애플리케이션을 만든다. **이름에 chzzk·치지직·naver·네이버를 넣을 수 없다**(예: "찌리릿 가드").
2. 로그인 리디렉션 URL: `https://<기기이름>.<tailnet>.ts.net/auth/callback` (Funnel 주소, 4장 참고)
3. API Scope: 서버가 쓰는 기능은 유저 정보 조회, 채널 관리자 목록 조회, 채팅 메시지 조회(세션 구독), 채팅 메시지 숨기기, 채팅 설정 조회·변경, 임시 제한·활동 제한이다. 조사 당시 문서의 이름은 "유저 정보 조회, 채널 관리자 조회, 채팅 메시지 조회, 채팅 메시지 쓰기, 채팅 설정 조회, 채팅 설정 변경, 활동제한 조회, 활동제한 쓰기"였지만 **개발자 센터 화면에서 확인하지 않았다.** 화면의 실제 이름으로 고르고, 고른 이름을 이 문서에 고쳐 적는다.
4. 발급된 Client ID·Secret은 6장의 `.env`에만 적는다. **누구와도 공유하지 않는다**(약관 제7조②11호·③).
5. 90일 동안 API 사용이 없으면 앱이 삭제된다. 비시즌에도 한 달에 한 번은 서버를 켜 둔다.

## 3. 설치와 빌드
```bash
git clone https://github.com/<계정>/zzirit-guard.git <설치 경로>
cd <설치 경로>
npm ci
npm run build -w @zzirit-guard/server
npm run build -w @zzirit-guard/web
```

## 4. 외부 접속(Tailscale Funnel)
```bash
tailscale funnel --bg 8710
tailscale funnel status   # https://<기기이름>.<tailnet>.ts.net → 127.0.0.1:8710 확인
```
- 명령 형식은 Tailscale 버전에 따라 다를 수 있다. `tailscale funnel --help`로 확인한다.
- 이 주소를 2장의 리디렉션 URL과 6장의 `ZG_PUBLIC_ORIGIN`에 똑같이 쓴다. 매니저에게도 이 주소만 알려 준다(다른 주소로 열면 실시간 연결이 거절된다, 12장).

## 5. 비밀값
```bash
ops/scripts/setup-keychain.sh                       # 토큰 암호화 키(키체인)
npx -w @zzirit-guard/server web-push generate-vapid-keys   # 푸시 알림 키
```

## 6. 환경 파일
```bash
mkdir -p ~/Library/Application\ Support/zzirit-guard
cp ops/env.example ~/Library/Application\ Support/zzirit-guard/.env
chmod 600 ~/Library/Application\ Support/zzirit-guard/.env
```
`.env`를 채운다(**`ZG_DATA_DIR`·`ZG_WEB_DIST`는 `~` 없는 절대 경로**여야 한다. `--env-file`은 `~`를 풀지 않는다): `ZG_PUBLIC_ORIGIN`(Funnel 주소), `ZG_CHANNEL_ID`(스트리머 채널 ID: 채널 주소 `chzzk.naver.com/<채널ID>`의 끝부분), Client ID·Secret, `ZG_DATA_DIR`, `ZG_WEB_DIST`(`<설치 경로>/apps/web/dist`), VAPID 키 3개.

## 7. 서버 시작·잠자기·재부팅
```bash
ops/scripts/install-launchd.sh
sudo pmset -a sleep 0 disksleep 0     # 방송 중 잠들지 않게
sudo pmset -a autorestart 1           # 정전 뒤 전기가 들어오면 켜지게(켜지기만 한다, 아래 참고)
```
- 서버는 로그인한 사용자 세션에서 돈다(키체인을 읽어야 해서 LaunchAgent로 둔다). Node를 업그레이드하면 `install-launchd.sh`를 다시 실행한다(node 경로가 plist에 들어간다).
- **FileVault를 켜면 macOS는 자동 로그인을 쓸 수 없다.** 그래서 정전·재부팅 뒤에는 맥 미니가 FileVault 잠금 화면에서 멈추고, 누군가 맥 미니 앞에서 암호를 넣어 로그인해야 Tailscale과 서버가 뜬다. 원격으로는 풀 수 없다.
  - 계획한 재시작(macOS 업데이트 등)은 `sudo fdesetup authrestart`로 하면 다음 한 번의 재시작에서 잠금을 건너뛴다. 이 맥이 지원하는지 먼저 `man fdesetup`으로 확인한다.
  - 방송 전 점검(11장)에서 화면이 열리는지 꼭 확인한다. 정전이 잦은 곳이면 무정전 전원 장치(UPS)를 고려한다.
- `install-launchd.sh`는 root(sudo)로 실행하면 거절한다. 서버를 돌릴 사용자로 실행한다. 로그 폴더는 700, 로그 파일은 600으로 만든다. node 경로가 버전 관리자 shim이면 경고를 낸다.
- 재시작: `launchctl kickstart -k gui/$(id -u)/com.zzirit-guard.server`

## 8. 로그
- 위치: `~/Library/Logs/zzirit-guard/server.log`·`server.err.log`. 채팅 원문은 남지 않는다(식별자만). 다만 **로그에는 매니저 채널 ID가 남으므로 소유자만 읽을 수 있게(폴더 700, 파일 600) 둔다.**
- **newsyslog 같은 자동 회전은 쓰지 않는다.** launchd는 로그 파일을 서버를 띄울 때 한 번만 열고 서버도 파일을 다시 열지 않는다. 그래서 회전 도구가 파일을 옮기면 서버는 옮겨진 옛 파일에 계속 쓰고, 압축 회전이 옛 파일을 지우면 그 뒤 로그가 사라진다.
- 가끔 `ls -lh ~/Library/Logs/zzirit-guard`로 크기를 보고, 커졌으면 서버를 멈추고 옮긴 뒤 다시 띄운다.
```bash
launchctl bootout gui/$(id -u)/com.zzirit-guard.server
cd ~/Library/Logs/zzirit-guard && for name in server server.err; do [[ -f $name.log ]] && mv $name.log $name-$(date +%Y%m%d).log; done
chmod 600 server*.log   # 옮긴 파일도 소유자만 읽게(새 파일은 install-launchd.sh가 600으로 만든다)
<설치 경로>/ops/scripts/install-launchd.sh
```

## 9. 첫 연결(스트리머)
1. 스트리머와 **운영 합의서**(`streamer-agreement-template.md`)를 먼저 주고받는다.
2. 스트리머가 `https://<Funnel 주소>`에서 "스트리머: 채널 연결"을 누르고 치지직 동의 화면에서 허용한다.
3. 채널 공지에 `channel-notice-template.md`를 채워 올린다(개인정보보호법 제37조의2).
- 연결 해제(기록·설정 → 계정 → 채널 연결 해제, 스트리머만): 모든 매니저가 로그아웃되고 자동 기능이 멈춘다. **규칙·설정은 남는다**(다시 연결하면 그대로 쓴다). 연결 해제는 이 서버에 저장한 토큰만 지운다. 치지직 토큰 폐기(revoke) API는 호출하지 않으므로, 치지직 쪽 연동까지 끊으려면 스트리머가 치지직에서 직접 해제한다.

## 10. 매니저 안내
1. 치지직에서 채널 관리자 또는 채팅 운영자로 등록돼 있어야 한다. **방금 등록한 매니저는 최대 5분 동안 로그인이 거부될 수 있다**(서버가 관리자 목록을 5분 동안 캐시한다). 5분 뒤 다시 시도한다.
   치지직 호출 오류가 30분을 넘게 이어지면 캐시도 쓰지 않아 매니저 로그인이 거절된다.
2. 치지직에서 매니저를 해제하면, 서버가 5분마다 역할을 다시 확인하고 목록 캐시도 최대 5분이라 **치지직 API가 응답하는 동안에는 최대 약 10분 안에** 그 사람의 화면이 로그인 화면으로 돌아간다. 치지직 API가 장애이면 확인이 실패해도 세션을 유지하므로, 해임된 매니저는 API가 회복되거나 세션 만료(12시간) 전까지 기존 세션을 쓸 수 있다. 30분이 넘으면 막히는 것은 새 로그인뿐이다. 로그에 `역할 재확인 실패`가 보이면 이 상황이다.
3. 휴대폰으로 Funnel 주소 → "매니저 로그인".
4. iPhone: Safari 공유 → "홈 화면에 추가" 후 그 앱에서 "기록·설정 → 계정 → 장애 알림 받기"(iOS 16.4 이상). 홈 화면 앱 안에서 치지직 로그인이 끝나는지는 아직 실기기로 확인하지 않았다(실기기 점검표). 확인한 결과와, 안 될 때의 방법을 이 장에 적는다.
5. 푸시 알림은 Funnel HTTPS 주소에서만 구독할 수 있고, 서버는 FCM·Mozilla autopush·`*.push.apple.com`·`*.notify.windows.com` 구독만 받는다.
6. 로그아웃하면 그 기기의 장애 알림 구독도 해지된다.

## 11. 방송 전 점검(기록·설정 → 상태 점검)
- 이 표는 15초마다 서버에서 다시 읽는다.
- 채널: (채널 이름) / 치지직 채팅 연결: 연결됨 / 숨김·제재 가능: 가능 / 마지막 채팅 수신: 채팅이 오고 있으면 방금 / 처리 대기 중인 조치: 0건 근처
- 하나라도 아니면 12장.

## 12. 장애 대응
| 증상 | 조치 |
|---|---|
| "숨김·제재 불가(스트리머 재연결 필요)" | 스트리머가 "스트리머: 채널 연결"을 다시 한다 |
| 채팅 연결 끊김이 계속 | 로그 확인 → 서버 재시작(7장) |
| 화면이 안 열림 | 맥 미니가 FileVault 잠금 화면에 멈췄는지(7장), `tailscale funnel status`, `launchctl print gui/$(id -u)/com.zzirit-guard.server` 확인 |
| "실시간 연결이 계속 거절됩니다" | Funnel 주소(`ZG_PUBLIC_ORIGIN`과 같은 주소)로 열었는지 확인한 뒤 '다시 연결' |
| 로그인 화면에 "요청이 너무 많습니다" | 잠시 기다렸다 다시 한다. 계속되면 누군가 로그인 주소를 반복해서 부르는 것이므로 로그를 본다. 이미 로그인한 스트리머는 재연결할 수 있다(18장) |
| 자동 숨김이 저절로 꺼짐 | 기록·설정 → 감사 기록에서 이유("1분 한도 초과"·"치지직 호출 실패 증가")를 확인하고 규칙을 고친다 |
| 후보 화면 "숨김 대기·실패"에 항목이 남음 | 스위치가 꺼져 취소됐거나 치지직 호출이 실패한 자동 숨김이다. 필요하면 '숨기기'로 직접 숨긴다 |
| 서버가 계속 재시작됨(설정 오류) | 설정 오류면 서버가 종료되고 launchd가 다시 띄우는 일을 되풀이한다(실패 종료일 때만 재시작, 10초 간격). `server.err.log`를 보고 `.env`를 고친다. 멈추려면 `launchctl bootout gui/$(id -u)/com.zzirit-guard.server` |
| 웹을 다시 빌드한 뒤 화면이 비어 있음 | 서버를 재시작한다(14장) |

## 13. 백업과 복원
- 서버는 시작 5분 뒤와 그 뒤 매일 `$ZG_DATA_DIR/backups/`에 `zzirit-guard-YYYYMMDD-HHMMSS.sqlite`(소유자만 읽기)를 만들고 최근 7개를 남긴다. 그래서 보관 기간이 지나 DB에서 지운 원문도 **백업에는 최대 7일 더 남는다**(공지·합의서에 적는다).
- 복원: 서버를 멈추고, 지금 DB의 `-wal`·`-shm` 파일을 지운 뒤 백업으로 바꾸고 다시 띄운다. **`-wal`을 남기면 옛 기록이 복원본에 섞인다**(DB는 WAL 모드다).
```bash
launchctl bootout gui/$(id -u)/com.zzirit-guard.server
cd "$HOME/Library/Application Support/zzirit-guard"      # ZG_DATA_DIR
rm -f zzirit-guard.sqlite-wal zzirit-guard.sqlite-shm
cp backups/zzirit-guard-YYYYMMDD-HHMMSS.sqlite zzirit-guard.sqlite
chmod 600 zzirit-guard.sqlite
<설치 경로>/ops/scripts/install-launchd.sh
```
- 복원한 DB에서 보관 기간이 지난 내용은 다음 매일 정리(서버 시작 5분 뒤, 그 뒤 매일)가 돌 때까지 남아 있다.
- 같은 맥(같은 키체인 키)에서만 토큰을 읽을 수 있다.

### 보관 기간
- 기본값은 판정 원문 30일, 조치 기록(감사) 180일이다(기록·설정 → 한도·보관 기간).
- 삭제는 설정 행들 가운데 **가장 짧은 기간**을 기준으로 한다.
- 매일 백업 7개 때문에 원문은 백업에 최대 7일 더 남는다.
- DB는 `secure_delete`를 켜 지운 자리를 덮어쓰고, 보관 정리 뒤 WAL을 체크포인트한다.

## 14. 업데이트
```bash
cd <설치 경로>
git pull --ff-only
npm ci
npm run build -w @zzirit-guard/server
npm run build -w @zzirit-guard/web
launchctl kickstart -k gui/$(id -u)/com.zzirit-guard.server
```
- **웹만 다시 빌드해도 서버를 재시작해야 한다.** 서버는 시작할 때 `dist`의 파일 목록으로 경로를 만든다(@fastify/static `wildcard: false`, 문서 기준이며 실행해 보지는 않았다). 새 빌드의 파일 이름(해시)이 재시작 전까지 없는 경로가 되어 화면이 비어 보일 수 있다.

## 15. 자동 숨김을 켜기 전에(로드맵 3단계)
- 스펙 14장의 기준은 "섀도 판정에 매니저가 동의한 비율 95% 이상"이다. **지금 화면에는 이 비율을 바로 보여 주는 곳이 없고, 스위치는 규칙별이 아니라 채널에 하나뿐이다.**
- 그 전까지는 방송마다 섀도 구역("켜져 있었으면 숨겼을 메시지")에서 '숨기기'(동의)와 '오판'(동의 안 함)을 누른 건수를 적어 동의 비율 = 숨기기 ÷ (숨기기 + 오판)으로 계산한다.
- 기록·설정 → 오판 검토에서 오판이 나온 규칙을 먼저 고친다(예외 단어·허용어 추가, 금칙어 강을 약으로 옮기기).
- 동의 비율이 방송 2회 이상 95%를 넘고 오판 검토에 새 오판이 없을 때 스위치를 켠다. 켜면 채널 전체에 적용된다.

## 16. 치지직 기본 도구로 하는 일
- **영구 제한(활동 제한)과 그 해제는 이 앱에 화면이 없다. 치지직 기본 도구(방송 관리 화면)로 한다.** 이 앱의 버튼은 숨기기·임시 제한·무시·오판뿐이다(스펙 6장).
- 이의 제기로 제재를 풀어야 하면 치지직 기본 도구에서 해제하고, 앱의 감사 기록(기록·설정)과 맞춰 본다.
- 숨긴 채팅은 되돌릴 수 없다(치지직에 숨김 해제 API가 없다).
- 이 앱이 멈춰도 매니저는 치지직 기본 도구로 관리할 수 있다(스펙 10장).

## 17. 개발 메모
- `npm run dev -w @zzirit-guard/web`(Vite 개발 서버)에는 서버 프록시를 두지 않았다. 로그인 콜백 주소는 `ZG_PUBLIC_ORIGIN`으로 고정이고, 세션 쿠키는 Secure이며, 상태 변경 요청과 WebSocket은 Origin이 `ZG_PUBLIC_ORIGIN`과 같아야 해서 `localhost:5173`을 거치면 로그인·조치·실시간이 모두 거절되기 때문이다.
- 화면 동작은 테스트(`npm test -w @zzirit-guard/web`)로, 실제 연결은 빌드해 서버가 제공하는 화면(Funnel 주소)으로 확인한다(빌드 뒤 서버 재시작, 14장).

## 18. 로그인 요청 한도(서버)
- 로그인 시작 1분에 30회, 콜백 1분에 60회(서버가 발급한 state의 콜백만 센다), /auth 전체 합쳐 1분에 120회가 상한이다.
- 로그인한 스트리머(소유자 세션)는 시작·콜백 한도를 받지 않아 재연결이 막히지 않는다. 다른 로그인 세션은 전체 상한(120)만 건너뛴다.
- 누군가 로그인 주소를 계속 부르는 동안에는 세션 없는 새 로그인이 막힐 수 있고, 멈추면 수 초 안에 회복한다.
- 한도를 넘으면 `/?loginError=`로 돌아가 "요청이 너무 많습니다…" 문구가 보인다.
