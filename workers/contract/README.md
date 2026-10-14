# 워커 계약 v1

서버가 1차(KcELECTRA)·2차(kanana) 워커를 부르는 약속이다. 두 워커와 서버 클라이언트가 이 문서와 `v1/`의 시험 사례를 함께 따른다. 모델을 바꿔도 이 계약이 같으면 서버는 그대로 둔다([설계 스펙 §5.3](../../docs/superpowers/specs/2026-10-11-zzirit-guard-design.md)).

## 연결

- 워커는 `$ZG_DATA_DIR/run/`(권한 0700, 서버와 같은 사용자 소유)의 유닉스 소켓에서 HTTP/1.1로 듣는다. 1차는 `stage1.sock`, 2차는 `stage2.sock`이다. 소켓 권한은 0600이다.
  - 왜: TCP 포트는 다른 사용자도 바인딩할 수 있다. 그래서 워커가 꺼진 사이에 다른 사용자 프로세스가 그 주소로 기다리면 채팅 원문을 받거나 가짜 판정을 돌려줄 수 있다. 이 사용자만 들어갈 수 있는 디렉터리의 소켓은 그럴 수 없다.
  - 같은 사용자의 다른 프로세스는 막지 않는다. 그 프로세스는 이미 데이터 디렉터리를 읽을 수 있다.
- 서버는 연결하기 전에 디렉터리와 소켓을 `lstat`으로 확인한다. 심볼릭 링크가 아니어야 하고, 소유자가 같아야 하고, 디렉터리 권한은 0700이어야 한다.
- 요청마다 응답 뒤 연결을 닫는다(`Connection: close`).
- 워커는 모델을 다 불러온 뒤에 소켓을 만든다. 소켓이 있으면 받을 준비가 된 것이다.

## `POST /classify`

요청 헤더
- `Content-Type: application/json`(`; charset=utf-8`은 붙여도 된다)
- `Content-Length` 필수, 65,536바이트 이하. `Transfer-Encoding`은 받지 않는다.

요청 본문(UTF-8 JSON)

```json
{"items": [{"id": "m-1", "text": "채팅 한 줄"}]}
```

- 최상위 키는 `items` 하나뿐이다. 항목의 키는 `id`, `text` 둘뿐이다. 다른 키가 있으면 400이다.
- `id`: `^[A-Za-z0-9_-]{1,64}$`. 한 요청 안에서 겹치지 않는다.
- `text`: 1~1,000 유니코드 코드 포인트. 짝 없는 서로게이트가 있으면 400이다.
- 항목 수: 1차 1~32건, 2차 1~4건.

응답 200

```json
{"contract": 1, "model": "kcelectra-hn-v1-r3@0123456789ab", "items": [{"id": "m-1", "unsafe_probability": 0.031, "category": null}]}
```

- `model`: 1~200자. `<모델 디렉터리 이름>@<가중치 sha256 앞 12자>`다. 서버는 이 값이 바뀌면 그 단계의 점수 캐시를 비운다.
- `items`: 요청과 같은 순서, 같은 id. 개수도 같다.
- `unsafe_probability`: 0 이상 1 이하의 유한한 수.
- `category`: 1차는 `null`. 2차는 `"S1"`~`"S7"` 중 유해 확률이 가장 높은 범주다(kanana-safeguard 모델 카드: S1 증오, S2 괴롭힘, S3 성적 콘텐츠, S4 범죄, S5 아동 성착취, S6 자살·자해, S7 잘못된 정보).

## `GET /health`

```json
{"contract": 1, "model": "…", "ready": true}
```

추론과 상관없이 바로 답한다.

## 오류

본문은 `{"error": "<코드>"}`뿐이다. 요청 내용을 되돌려 쓰지 않는다(채팅 원문이 오류·로그로 새지 않게).

| 상태 | 코드 | 때 |
|---|---|---|
| 400 | `invalid_json` | UTF-8 JSON이 아님 |
| 400 | `invalid_body` | 키·형식이 다름, 항목이 0건 |
| 400 | `too_many_items` | 항목 수 상한을 넘음 |
| 400 | `bad_id` | id 형식이 틀림 |
| 400 | `duplicate_id` | id가 겹침 |
| 400 | `bad_text` | text가 비었거나 1,000자를 넘거나 짝 없는 서로게이트가 있음 |
| 400 | `content_type` | JSON이 아님 |
| 400 | `transfer_encoding` | `Transfer-Encoding`이 있음 |
| 404 | `not_found` | 없는 경로 |
| 405 | `method_not_allowed` | 경로는 맞는데 메서드가 다름 |
| 411 | `length_required` | `Content-Length`가 없음 |
| 413 | `payload_too_large` | 본문이 65,536바이트를 넘음 |
| 503 | `busy` | 동시 처리 한도를 넘었거나 추론이 5초 안에 끝나지 않음 |

## 시험 사례

- `v1/requests.json`: 요청 사례와 워커별 기대 상태 코드. `generate`가 있으면 그 설명대로 본문을 만든다.
- `v1/responses.json`: 서버 클라이언트가 받아들일 응답과 거절할 응답.

계약을 바꾸면 `contract` 번호를 올리고 `v2/`를 새로 만든다. 받는 쪽은 모르는 번호를 거절한다.
