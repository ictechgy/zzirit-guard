# 로드맵 2단계(AI) 구현 계획: 1차·2차 워커와 서버 연결

> **실행 방식:** 이 세션이 직접 구현한다(Native). PR마다 Codex 리뷰를 받는다. 단계는 체크박스(`- [ ]`)로 관리한다.

**목표:** 규칙이 판정하지 않은 채팅을 1차(KcELECTRA)·2차(kanana) 워커로 보내, AI 후보·'도움 필요'를 매니저 화면에 올린다. AI는 자동 숨김을 하지 않는다.

**구조:** 워커 두 개가 127.0.0.1에서 같은 `/classify` 계약으로 응답한다. 서버는 동기 규칙 판정 뒤에 비동기 AI 단계를 둔다. 1차는 묶음으로 보내고, 2차는 우선순위 대기열에서 하나씩 보낸다. 결과가 기준을 넘으면 판정 기록을 새로 만들어 알린다.

**기술:** Python 3.12(1차는 PyTorch CPU, 2차는 mlx-lm GPU)와 표준 라이브러리 HTTP 서버, Node 22 + TypeScript(Fastify·better-sqlite3), React PWA, launchd.

**스펙:** [설계 스펙](../specs/2026-10-11-zzirit-guard-design.md) §4·§5.2 ④⑤·§5.3·§5.4·§8·§10, [모델 보강 계획](../../ml/2026-10-14-model-strengthening-plan.md) M3

## 전역 제약

- 워커는 127.0.0.1에만 바인딩한다. 서버가 쓰는 워커 주소도 루프백(127.0.0.1·localhost·[::1])의 http만 받는다(§8).
- 요청마다 비밀값 헤더를 붙인다. 워커가 실행할 때 만든다(§5.3).
- 채팅 원문은 로그에 남기지 않는다. 식별자, 건수, 지연만 남긴다(§8).
- AI 판정은 절대 `auto_hide`가 되지 않는다. 유해 확률이 0.5 이상이면 `candidate`, 0.99 이상이면 '확실' 표시, 가장 높은 범주가 S6이면 `needs_care`다(§5.2 ⑤).
- 2차 대기열은 300건까지 받고, 15초가 지난 항목은 버린다. 우선순위는 키워드 경로, 첫 채팅 사용자, 1차 점수 순이다. 버린 건수는 "AI 미검사"로 센다(§5.4).
- 워커 응답이 2초를 넘으면 실패로 본다. 규칙은 계속 돌고, 화면에 "AI 중지"를 띄운다(§10).
- 같은 정규화 문장의 AI 판정은 10분 동안, 최대 1만 건까지 재사용한다(§5.2 ③).
- 가중치·학습 데이터·실채팅은 저장소에 넣지 않는다. 모델 경로는 인자나 환경 변수로만 받는다.
- 배포(launchd 설치, 키체인)는 사용자가 지시할 때만 한다. 설치 스크립트는 dry-run으로만 확인한다.

## 판단(rulings)

- **R1. 비밀값 전달.** 워커는 시작할 때 `secrets.token_hex(32)`로 비밀값을 만든다. 그 값을 `$ZG_DATA_DIR/run/<워커 이름>.secret`(디렉터리 0700, 파일 0600)에 원자적으로 쓴다. 서버는 이 파일을 읽어 캐시한다. 응답이 401이거나 파일이 없으면 한 번 다시 읽는다. 이렇게 하면 프로세스끼리 순서를 맞출 필요가 없고, 워커를 다시 띄울 때마다 비밀값이 바뀐다.
  - 대안이었던 "설치 때 한 번 만든 고정값"은 스펙의 "실행할 때 만든"과 맞지 않아 버렸다.
- **R2. HTTP 서버.** 표준 라이브러리 `http.server`를 쓴다. 웹 프레임워크 의존성을 늘리지 않기 위해서다(공급망).
  - 1차는 `ThreadingHTTPServer`에 추론 잠금을 둔다. 상태 확인이 추론 뒤에 줄 서지 않게 하기 위해서다.
  - 2차는 단일 스레드 `HTTPServer`다. mlx 모델과 접두 KV 캐시를 여러 스레드가 함께 쓰면 안 되기 때문이다.
- **R3. 워커 계약.**
  - `POST /classify`. 본문은 `{items:[{id, text}]}`이다. id는 1~64자, text는 1~1,000자, 항목 수는 1차 1~32건, 2차 1~4건이다. 본문은 64KB까지 받는다.
  - 응답은 `{model, items:[{id, unsafe_probability, category}]}`이고 요청과 같은 순서다. 1차의 `category`는 null이고, 2차는 유해 범주 중 확률이 가장 높은 코드("S1"~"S7")다.
  - `GET /health`는 `{model, ready}`를 준다. 두 경로 모두 비밀값을 요구한다.
  - 상태 코드: 비밀값이 틀리면 401(본문에 이유 없음), 형식 오류는 400, 없는 경로는 404, 메서드 오류는 405, 너무 큰 본문은 413이다.
  - 비밀값은 `hmac.compare_digest`로 비교한다.
- **R4. AI 단계에 들어가는 메시지.** 규칙이 판정하지 않았고(`pass`·`none`) 가벼운 반응이 아닌 메시지다.
  - `rule:allow`(채널 허용어)는 들어가지 않는다. 스펙이 AI보다 앞서 통과시키기 때문이다.
  - 중복 문장은 AI 판정 캐시에 결과가 있으면 그 결과를 쓰고, 없으면(아직 처리 중이거나 버려짐) 넘긴다. 처리 중인 같은 문장을 기다리는 기능은 두지 않는다. 같은 문장을 여러 사람이 퍼뜨리면 떼도배 규칙이 맡는다.
- **R5. 요주의 사용자 우선순위.** 지금 파이프라인은 요주의 사용자를 규칙(`rule:watch_user`)에서 후보로 판정하므로, 그 메시지는 AI 단계에 오지 않는다. 그래서 대기열 우선순위에서 이 항목은 빼고, 키워드 경로 > 첫 채팅 사용자 > 1차 점수 > 먼저 온 것 순으로 한다.
  - 대가: 요주의 사용자의 메시지는 AI 범주·확률 없이 규칙 후보로만 올라간다. 스펙 §5.4의 우선순위 문구와 다르므로 스펙에 적는다.
- **R6. 첫 채팅 사용자.** 채팅 연결이 새로 이어질 때(`markConnected`) 비우는, 보낸 사람 채널 id 집합으로 판단한다. 최대 20만 명까지 담고, 넘으면 비운다. 넘쳤을 때 "처음"으로 잘못 보는 것은 우선순위가 잠깐 오르는 정도라 받아들인다.
- **R7. 1차 묶음.** 첫 항목이 들어온 뒤 25ms 안에 모이는 항목, 최대 16건을 한 번에 보낸다. 요청은 한 번에 하나만 보낸다.
  - 기다리는 항목은 512건까지 둔다. 넘치면 그 메시지는 AI 미검사로 센다.
  - 1차가 실패하면 그 묶음 전체가 AI 미검사이고, 1차 상태가 `down`이 된다.
- **R8. 2차 소비.** 한 번에 1건씩, 직렬로 보낸다. 대기열이 꽉 차면 새 항목과 대기열의 가장 낮은 항목 중 낮은 쪽을 버린다.
- **R9. AI 미검사 집계.** 분당 통계 `stage2_dropped`는 "AI 미검사"를 뜻하고, 다음을 모두 센다.
  - 2차 대기열 넘침과 15초 경과.
  - 1차·2차 워커 실패와 시간 초과.
  - 1차 대기 넘침.

  AI를 끈 상태(`ZG_AI_ENABLED` 미설정)는 세지 않는다.
- **R10. 임계값.** 채널 설정 `stage1_threshold`(기본 0.05), `candidate_threshold`(0.5), `sure_threshold`(0.99)를 서버가 읽는다. 매니저 화면에서 1차 임계값만 바꿀 수 있게 한다.
  - 1차 임계값은 모델마다 맞는 값이 다르다. 재학습한 모델은 0.003~0.03 근처다([재학습 결과](../../ml/2026-10-14-stage1-retrain-results.md)). 그래서 운영자가 정한다.
  - 나머지 둘은 스펙 값으로 고정한다. 바꿀 근거(섀도 데이터)가 아직 없다.
- **R11. 판정 기록.** AI 결과는 새 판정 기록이 된다. 이유는 `ai:S2`처럼 쓰고, `unsafe_probability`와 `category`를 저장해 DTO까지 싣는다. '확실'은 서버가 계산해 DTO의 `sure`로 보낸다.
  - 실시간 채팅 줄은 이미 `pass`로 나갔으므로 바꾸지 않는다. 후보 목록에만 올라간다.
  - `needs_care`도 분당 `candidates`로 센다. 따로 칸을 두지 않는다.
- **R12. 켜고 끄기.** `ZG_AI_ENABLED=1`일 때만 AI 단계를 만든다. 기본은 꺼짐이라, 워커를 설치하지 않은 지금 배포는 그대로 돈다.
- **R13. 워커 스레드.** 1차 워커의 PyTorch 스레드 수는 `--threads`(기본 6)로 정한다. 맥 미니는 12코어이고, 서버(Node)와 2차(GPU) 몫을 남긴다.

## 리뷰 초점(테스트로 고정할 것)

1. 워커가 죽었거나 멈췄을 때: 2초 뒤 실패로 처리하고, 규칙 판정과 채팅 줄 전송은 막히지 않는다. 상태는 `down`이 됐다가 다음 성공 때 `ok`로 돌아온다.
2. 워커를 다시 띄워 비밀값이 바뀌었을 때: 서버가 401을 받으면 파일을 다시 읽고 한 번 더 보낸다.
3. 과부하: 2차 대기열이 300건을 넘거나 15초가 지나면 버리고 센다. 키워드 경로 항목은 1차 점수가 높은 항목보다 먼저 나간다.
4. 공격자 입력: 아주 긴 문장, 제어 문자, 잘못된 JSON, 큰 본문, 비밀값 없는 요청. 워커는 4xx로 거절하고 원문을 로그에 남기지 않는다.
5. 권한자·허용어·가벼운 반응·중복: AI 단계에 들어가는지와 결과가 어떻게 기록되는지(R4).

---

## Task 1: 1차 워커 (PR A)

**파일**
- 만들기: `workers/stage1/zg_stage1/worker.py`(HTTP·인증·검증), `workers/stage1/zg_stage1/worker_secret.py`(비밀값 파일), `workers/stage1/tests/test_worker.py`, `workers/stage1/tests/test_worker_secret.py`
- 고치기: `workers/stage1/README.md`(실행 방법)

**인터페이스**
- `python -m zg_stage1.worker --model-dir <학습 결과> [--port 8711] [--threads 6] [--secret-name stage1-worker]`
- 모델은 `inference.json` 계약대로 불러온다(`load_trained_classifier`, `load_trained_tokenizer`, max_length). 점수는 `score_texts`로 낸다.
- 공용 부분(`worker_secret.py`의 `write_worker_secret(data_dir, name) -> str`, 요청 검증)은 2차 워커가 같은 규칙을 따르게 문서로 남긴다. 2차는 별도 uv 프로젝트라 코드를 공유하지 않고, 같은 테스트 목록으로 맞춘다.

**단계**
- [ ] 비밀값 파일 테스트를 쓴다(권한 0600·0700, 원자적 교체, 64자 hex).
- [ ] 비밀값 파일 쓰기를 구현한다.
- [ ] 요청 검증 테스트를 쓴다(항목 수·id·text 길이·형식·본문 크기).
- [ ] 검증을 구현한다. 순수 함수이고 점수 함수를 주입받는다.
- [ ] HTTP 테스트를 쓴다. 포트 0에 띄우고 가짜 점수 함수로 401·400·404·405·413·200, 순서 유지, `/health`를 본다.
- [ ] 서버를 구현하고, 로그에 건수와 지연만 남는지 테스트한다.
- [ ] 실제 모델로 스모크를 돈다(커밋하지 않는 확인): 72문장 점수가 `zg_stage1.evaluate`와 같은지, 묶음 16의 지연.
- [ ] README에 실행 방법을 적고, ruff·mypy·pytest를 통과시킨다. 커밋하고 Codex 리뷰를 받은 뒤 PR을 연다.

## Task 2: 2차 워커 (PR B)

**파일**
- 만들기: `workers/stage2/`
  - `pyproject.toml`: mlx-lm 고정, `exclude-newer`
  - `uv.lock`
  - `zg_stage2/{__init__,classifier,worker,worker_secret,errors}.py`
  - `tests/`
  - `README.md`

**인터페이스**
- `python -m zg_stage2.worker --model-dir <kanana-safeguard-8b mlx 4비트> [--port 8712]`
- `classifier.py`
  - 모델 카드 템플릿으로 `[user, 빈 assistant]` 메시지를 만든다.
  - 접두 KV 캐시를 쓴다. 고정 템플릿 앞부분을 한 번 계산하고, 판정마다 되감는다.
  - 마지막 logits에서 `<SAFE>`, `<UNSAFE-S1..7>` 확률을 구한다. 유해 확률은 UNSAFE 합이고, 범주는 UNSAFE 중 가장 높은 것이다.
  - 분류 토큰이 단일 토큰이 아니면 시작을 거부한다.
- 근거 코드: `docs/spikes/2026-10-11-guard-models/scripts/bench_guard.py`의 `classify_with_kanana`·`PrefixCache`(버리는 코드라 다시 쓴다).

**단계**
- [ ] uv 프로젝트를 만든다. mlx-lm은 스파이크와 같은 0.32 계열이고, 잠금 시점보다 2주 전 배포본이어야 한다.
- [ ] 확률·범주 계산(순수 함수)의 테스트와 구현을 쓴다.
- [ ] 요청 검증·HTTP·비밀값 테스트를 1차와 같은 목록으로 쓴다(가짜 분류기).
- [ ] 실제 모델로 스모크를 돈다(커밋하지 않음): 스파이크 결과와 같은 문장의 확률이 맞는지, 1건 지연이 약 100ms인지.
- [ ] README를 쓰고 ruff·mypy·pytest를 통과시킨다. 커밋하고 Codex 리뷰를 받은 뒤 PR을 연다.

## Task 3: 서버 AI 단계 (PR C)

**파일**
- 고치기:
  - `apps/server/src/detection/pipeline.ts`: `DetectionResult`에 `aiEligible`, `keywordRouteId`, `normalizedKey`를 더한다.
  - `apps/server/src/detection/messageTraits.ts`: `duplicateKeyOf`를 내보낸다.
  - `apps/server/src/config.ts`: `ZG_AI_ENABLED`, `ZG_STAGE1_URL`, `ZG_STAGE2_URL`. 루프백 검증을 한다.
  - `apps/server/src/app.ts`: 연결하고, 타이머와 정지를 붙인다.
  - `apps/server/src/actions/decisionHandler.ts`: AI 단계로 넘기고, AI 결과를 기록한다.
  - `apps/server/src/records/verdictRepository.ts`: DTO에 확률·범주·`sure`를 싣는다.
  - `apps/server/src/records/settingsRepository.ts`: 실수 설정 3개를 읽는다. 1차 임계값은 쓸 수도 있다.
  - `apps/server/src/http/routes.ts`: 설정 스키마.
  - `packages/shared/src/index.ts`: `VerdictDto.unsafeProbability/category/sure`, `ServerStatus.ai`, `SettingsDto.stage1Threshold`.
- 만들기:
  - `apps/server/src/ai/workerClient.ts`: 비밀값 파일, 2초 시간 초과, 401 때 한 번 다시 시도, 응답 검증.
  - `apps/server/src/ai/stage1Batcher.ts`: 25ms·16건, 대기 512건.
  - `apps/server/src/ai/stage2Queue.ts`: 300건, 15초, 우선순위.
  - `apps/server/src/ai/aiVerdictCache.ts`: 10분, 1만 건 LRU.
  - `apps/server/src/ai/firstChatters.ts`.
  - `apps/server/src/ai/aiStage.ts`: 이것들을 묶어 결과를 콜백으로 낸다.
  - `apps/server/src/ai/aiStatus.ts`.
  - `apps/server/test/ai/*.test.ts`

**단계**
- [ ] 파이프라인이 키워드 경로 번호와 AI 대상 여부를 내도록 바꾼다. 기존 "키워드 경로는 영향 없음" 테스트는 "판정은 바뀌지 않고 경로 번호만 실린다"로 바꾼다.
- [ ] 워커 클라이언트 테스트와 구현을 쓴다. 가짜 워커 HTTP 서버로 다음을 본다.
  - 200, 401 뒤 다시 읽기, 시간 초과, 연결 거부, 잘못된 응답(id 불일치·NaN·범위 밖).
- [ ] 대기열·묶음·캐시·첫 채팅 사용자 테스트와 구현을 쓴다(가짜 시계).
- [ ] AI 단계 통합 테스트를 쓴다. 가짜 클라이언트로 다음을 본다.
  - 1차 점수가 임계값 미만이면 넘김, 키워드 경로면 2차, 결과가 0.5·0.99·S6일 때.
  - 실패 때 미검사 집계와 상태.
- [ ] 결정 처리기에 AI 결과 기록, 통계(`stage1_forwarded`·`stage2_done`·`stage2_dropped`·`candidates`), 알림을 붙인다.
- [ ] 상태에 `ai`를 더하고 설정 API에 1차 임계값을 더한다.
- [ ] 서버 lint·typecheck·test를 통과시킨다. 커밋하고 Codex 리뷰를 받는다.

## Task 4: 웹 (PR C에 함께)

**파일**
- 고치기: `apps/web/src/domain/verdictReason.ts`(`ai:S1~S7` 범주 이름), `components/CandidateGroupCard.tsx`(확률·'확실' 표시), `components/StatusBanner.tsx`("AI 중지"), `settings/StatusSection.tsx`(워커 상태·대기열), `settings/LimitsSection.tsx`(1차 임계값), `settings/StatsSection.tsx`(AI 미검사 표시)
- 테스트: 해당 `*.test.tsx`

**단계**
- [ ] 범주 이름은 모델 카드를 따른다. S1 증오, S2 괴롭힘, S3 성적 콘텐츠, S4 범죄, S5 아동 성착취, S6 자살·자해, S7 잘못된 정보.
- [ ] 확률은 소수 둘째 자리까지 보인다. '확실' 배지는 DTO의 `sure`로만 정한다.
- [ ] AI를 켜지 않은 배포에서는 AI 상태 줄과 배너를 보이지 않는다.
- [ ] 웹 lint·typecheck·test를 통과시킨다.

## Task 5: 운영 (PR D)

**파일**
- 만들기: `ops/launchd/com.zzirit-guard.stage1-worker.plist.template`, `ops/launchd/com.zzirit-guard.stage2-worker.plist.template`
- 고치기: `ops/scripts/install-launchd.sh`(구성 요소 인자. 기본은 지금처럼 server), `ops/env.example`(AI 변수), `docs/operations/operator-guide.md`(워커 설치·모델 고르기·임계값 정하기·AI 중지 대응)

**단계**
- [ ] plist는 워커 venv의 python을 직접 부른다(uv를 launchd PATH에 두지 않기 위해서다). KeepAlive와 로그 경로는 서버와 같은 방식이다.
- [ ] 설치 스크립트는 dry-run과 `plutil -lint`로만 확인한다. 실제 설치는 사용자가 지시할 때 한다.
- [ ] 문서에 1차 임계값 고르는 법을 적는다. 개발셋과 `zg_stage1.evaluate_chat`으로 정하고, 보류셋은 한 번만 본다.
- [ ] 스펙 §5.4에 R5(요주의 사용자 우선순위)를, §5.3에 R1(비밀값 파일)을 반영한다.
- [ ] 커밋하고 Codex 리뷰를 받은 뒤 PR을 연다.

## 하지 않는 것

- AI 자동 숨김: 섀도 데이터를 본 뒤에 다시 정한다(§5.2 ⑤).
- 실채팅으로 임계값을 맞추는 일: 치지직 서면 회신과 운영자 합의 뒤에 한다.
- 처리 중인 같은 문장 기다리기, 실시간 채팅 줄의 AI 결과 갱신(R4·R11).
