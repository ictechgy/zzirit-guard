# 1차 분류기 학습·평가·워커 (workers/stage1)

판정 파이프라인 ④단계의 **1차 분류기**를 만드는 곳이다([설계 스펙 §5.2](../../docs/superpowers/specs/2026-10-11-zzirit-guard-design.md)). `beomi/KcELECTRA-base`를 K-HATERS의 이진 라벨(normal=0, offensive·L1_hate·L2_hate=1)로 미세조정한다. 점수가 **0.05 이상**인 메시지만 2차(kanana)로 넘기는 거름망이라, 정확도보다 **유해 재현율**이 중요하다.

- 학습·평가 파이프라인과, 학습한 모델로 서버에 점수를 주는 **워커**(`zg_stage1.worker`, 아래 "워커 실행")가 있다.
- 워커는 CPU에서 돈다(GPU는 2차 kanana가 쓴다). 그래서 평가도 기본으로 CPU에서 하고, 처리량도 CPU로 잰다.

## 가중치를 배포하지 않는다

미세조정한 가중치는 이 저장소에도, 다른 곳에도 올리지 않는다([스펙 §17](../../docs/superpowers/specs/2026-10-11-zzirit-guard-design.md)). 운영자마다 아래 절차로 **각자 학습**한다. 기반 모델과 학습 데이터도 저장소에 넣지 않는다. 각 공식 저장소에서 받는다.

## 준비

macOS(Apple Silicon)와 [uv](https://docs.astral.sh/uv/)가 필요하다. 의존성은 `uv.lock`에 고정되어 있다(파이썬 3.12, torch 2.12.0, transformers 5.8.1).

```sh
cd workers/stage1
uv sync
export ZG_DATA_DIR="$HOME/Library/Application Support/zzirit-guard"   # 서버와 같은 데이터 디렉터리
```

모든 경로는 인자나 환경 변수로 정한다. 우선순위는 `--ml-dir` → `ZG_ML_DIR` → `$ZG_DATA_DIR/ml`이고, 그 아래 구조는 다음과 같다.

```
$ZG_DATA_DIR/ml/
  base/kcelectra-base/        기반 모델(아래에서 받음)
  data/k-haters/              K-HATERS v2(아래에서 받음)
  stage1/kcelectra-<시각>/     학습 결과(가중치·모델 카드·평가 결과)
```

## 기반 모델과 데이터 받기

[hf CLI](https://huggingface.co/docs/huggingface_hub/guides/cli) 2.x로 받는다. **리비전을 고정**해서 받는다. 저장소의 `main`은 언제든 바뀔 수 있고, 바뀌면 같은 스크립트로도 결과가 달라진다. 아래 리비전은 2026-10-12에 확인한 값이다. 다른 리비전을 쓰면 모델 카드의 `matches_reference`가 `false`로 남는다.

`hf`는 이 프로젝트의 의존성이 아니다(학습·평가는 네트워크에 접속하지 않는다). 받을 때만 쓰므로 둘 중 하나로 준비한다. 아래 명령은 huggingface_hub 2.0.0으로 2026-10-12에 확인했다(`--dry-run`으로 받을 파일 목록을 먼저 볼 수 있다).

- 설치 없이 한 번만 쓰기: `uvx --from "huggingface_hub==2.0.0" hf download …` (아래 예시가 이 형태다)
- 계속 쓰기: `uv tool install "huggingface_hub==2.0.0"`로 설치한 뒤 `hf download …`

hf CLI 2.x에서는 **패턴마다 `--include`를 따로** 붙인다. `--include a b`처럼 쓰면 두 번째부터는 파일 이름으로 해석되어 일부만 받는다.

```sh
ML_DIR="$ZG_DATA_DIR/ml"

# 기반 모델: safetensors만 받는다(pytorch_model.bin은 pickle이라 받지 않는다. 있으면 학습 스크립트가 거부한다)
uvx --from "huggingface_hub==2.0.0" hf download beomi/KcELECTRA-base \
  --revision 681201a097b8120e6dd2a2e63a3e13d338736f88 \
  --include config.json \
  --include model.safetensors \
  --include tokenizer.json \
  --include tokenizer_config.json \
  --include special_tokens_map.json \
  --local-dir "$ML_DIR/base/kcelectra-base"

# 학습 데이터: K-HATERS v2
uvx --from "huggingface_hub==2.0.0" hf download humane-lab/K-HATERS --repo-type dataset \
  --revision b96dc29e056eda8e658d740444b8baf95e226cee \
  --include train_v2.jsonl \
  --include val_v2.jsonl \
  --include test_v2.jsonl \
  --include README.md \
  --local-dir "$ML_DIR/data/k-haters"
```

받은 파일이 위 리비전과 같은지 확인한다(학습 스크립트도 같은 값을 모델 카드에 대조해 남긴다).

```sh
cd "$ML_DIR" && shasum -a 256 -c <<'EOF'
dc015d95afa81351e096dfadf95771eeafee3ec0a90709e9cb569c11797fd889  base/kcelectra-base/model.safetensors
3039eb0970ee2d3c67ee46f7bea94e3c559dcdc2ff5cce44c7d58b429035d07a  data/k-haters/train_v2.jsonl
e6788561038c8aa1c0f8ecbc94a1c6a1aedb5ec9703d1bab6250c81d4097864d  data/k-haters/val_v2.jsonl
d5c29d7cedce60f28ee14f5a8372d9f1d6698dc591408b408cd2e65ee1a86b5e  data/k-haters/test_v2.jsonl
EOF
```

받은 모델·데이터는 신뢰하지 않는 입력으로 다룬다. 스크립트는 `trust_remote_code=False`, `use_safetensors=True`, `local_files_only=True`로만 읽는다.

## 학습

```sh
cd workers/stage1
uv run python -m zg_stage1.train
```

- 기본값: 최대 3 epoch, 배치 32, 학습률 5e-5(선형 워밍업 6% 뒤 선형 감쇠), max_length 128, 시드 20261011, 장치 auto(MPS가 되면 MPS).
- 길이가 비슷한 문장끼리 배치를 만들어 패딩 낭비를 줄인다.
- epoch마다 검증 AUC를 재고 **가장 높은 epoch만** fp32 safetensors로 남긴다. 최고치를 넘지 못한 epoch가 연속 2번 나오면 멈춘다(`--early-stop-patience`).
- 출력 디렉터리(`--out-dir`, 기본 `$ZG_DATA_DIR/ml/stage1/kcelectra-<시각>`)가 **이미 있거나 저장소 안이면 거부**한다. 앞선 결과를 덮어쓰지 않고, 가중치가 실수로 커밋되지 않게 하기 위해서다.
- 최고 epoch는 출력 디렉터리 안의 임시 하위 디렉터리에 먼저 저장한 뒤 옮겨 넣는다. 저장 중에 끊겨도 반쯤 쓴 가중치가 남지 않는다. 저장 직후에는 토크나이저를 다시 불러와 학습 중인 것과 같은 토큰을 내는지 확인한다.
- 로그에는 진행 상황과 지표만 찍고 데이터 원문은 찍지 않는다.
- 빠른 확인(스모크): `uv run python -m zg_stage1.train --max-steps 50 --epochs 1 --out-dir <임시 위치>`

**걸리는 시간(맥 미니 M4 Pro, MPS, 2026-10-12 실측)**: 약 2.57스텝/s(배치 32)다. epoch당 5,380스텝이라 3 epoch는 16,140스텝이고, 실제 전체 학습은 검증·저장을 포함해 **104.8분**이 걸렸다(epoch마다 검증 약 16~23초). 다른 작업이 GPU를 쓰면 더 느려진다. 진행 로그의 `남은예상`을 본다. 결과는 [1차 분류기 학습 결과](../../docs/ml/stage1-classifier-results.md)에 정리했다.

출력 파일:

| 파일 | 내용 |
|---|---|
| `model.safetensors`, `config.json` | 최고 epoch의 가중치(fp32)와 설정(라벨 이름 normal·toxic) |
| `tokenizer.json`, `tokenizer_config.json` | 토크나이저. 문장을 `[CLS] … [SEP]`으로 감싸는 규칙이 들어 있다(아래 참고) |
| `inference.json` | 워커용 추론 계약: `max_length`, 유해 칸 번호(`toxic_class_index`), `[CLS]`·`[SEP]` 요구와 토큰 번호(아래 참고) |
| `model-card.json` | 기반 모델 이름과 `model.safetensors` sha256, 데이터 파일 sha256, 하이퍼파라미터·시드·라이브러리 버전, epoch별 검증 지표, 선택한 epoch, 시각, 라이선스·출처 표기 |

학습이 중간에 끊기면 카드의 `status`가 `interrupted`로 남고, 그때까지의 최고 epoch 가중치가 남는다.

### 입력 형식: `[CLS] 문장 [SEP]`

`beomi/KcELECTRA-base`의 현재 리비전(v2023, 바이트 단위 BPE)의 `tokenizer.json`에는 특수 토큰을 붙이는 규칙이 없다. ELECTRA 분류 헤드는 첫 위치의 벡터로 판정하므로, 학습 스크립트가 토크나이저에 `[CLS] … [SEP]` 규칙을 넣고 그대로 저장한다. **워커는 학습 결과 디렉터리의 토크나이저를 그대로 써야 한다.** 평가 스크립트는 이 규칙이 없는 토크나이저를 거부한다. (스파이크 코드는 이 규칙 없이 학습했다.)

**워커는 `inference.json`을 읽어 따라야 한다.** 학습 때의 값을 추측하면 점수가 조용히 어긋나기 때문이다.

| 필드 | 뜻 |
|---|---|
| `max_length` | 이 값으로 자른다(`[CLS]`·`[SEP]` 포함). 학습·평가와 같은 값이다 |
| `toxic_class_index` | softmax 출력에서 유해 확률 칸(1). 점수 = `softmax(logits)[toxic_class_index]` |
| `special_tokens` | `requires_cls_sep_wrapping`이 `true`면, 토크나이저 결과가 `cls_token_id`로 시작하고 `sep_token_id`로 끝나는지 시작할 때 확인한다 |
| `schema_version` | 모르는 버전이면 워커는 시작하지 않는다 |

학습은 출력 디렉터리를 만들 때 `inference.json`을 쓴다. 이 파일이 생기기 전에 학습한 결과에는 다시 학습하지 않고 써 넣는다(`max_length`는 `model-card.json`에서 읽는다).

```sh
uv run python -m zg_stage1.write_inference_contract --model-dir "$ZG_DATA_DIR/ml/stage1/kcelectra-<시각>"
```

평가도 `inference.json`의 `max_length`를 모델 카드보다 먼저 쓴다.

## 평가

```sh
uv run python -m zg_stage1.evaluate --model-dir "$ZG_DATA_DIR/ml/stage1/kcelectra-<시각>"
```

CPU에서 돌고(워커와 같은 조건), 결과를 모델 디렉터리의 `evaluation.json`에 쓰고 Markdown 요약을 출력한다. 이미 결과가 있으면 `--overwrite` 없이는 덮어쓰지 않는다.

| 항목 | 내용 |
|---|---|
| K-HATERS test(1만 건) | AUC, F1@0.5, 임계값 0.01·0.02·0.05·0.1·0.2·0.3·0.5별 유해 재현율·2차 전달율(2차로 보내는 비율)·정밀도, 원래 라벨별 표시 비율 |
| K-HATERS 회귀 표본 400건 | 라벨별 100건, 시드 20261011. 스파이크의 kanana 측정과 같은 표본이다([스펙 §13](../../docs/superpowers/specs/2026-10-11-zzirit-guard-design.md)) |
| 채팅 회귀 72문장 | 문장별 점수(**id로만** 표시), 범주별 재현율(임계값 0.05) |
| CPU 처리량 | 16건 묶음, max_length 128, 고정 표본(채팅 72문장 × 20). **다른 작업이 없는 상태**(학습·2차 워커·무거운 앱을 끈 상태)에서 잰 값만 비교한다 |
| 임계값 선택(참고용) | 검증셋에서 유해 재현율 0.97 이상을 지키는 가장 큰 임계값 |

평가는 약 1~2분 걸린다. 빠른 확인은 `--limit 500`(test·검증 앞 500줄)을 준다.

### 임계값 선택(참고용)

평가가 `validation-scores.json`(검증 점수와 이진 라벨만, 원문 없음)을 함께 남긴다. 다른 재현율 목표로 다시 보려면:

```sh
uv run python -m zg_stage1.thresholds --scores-file "$ZG_DATA_DIR/ml/stage1/kcelectra-<시각>/validation-scores.json" --target-recall 0.97
```

결과는 **참고용**이다. 운영 기본값은 스펙의 0.05로 두고, 바꾸는 결정은 섀도 데이터를 본 뒤 사람이 한다.

### 채팅 평가셋과 2차 용량

1차 분류기를 '2차가 감당하는 양 안에서 핵심 범주를 놓치지 않는 거름망'으로 본다([모델 보강 계획](../../docs/ml/2026-10-14-model-strengthening-plan.md), [기준선](../../docs/ml/2026-10-14-chat-eval-baseline.md)).

```sh
# 1) 2차(kanana) 대기열이 감당하는 최대 전달률(F_max)을 초당 채팅량별로 계산한다
uv run python -m zg_stage1.capacity --rates 10 20 30 50

# 2) 평가셋 형식·겹침 검사(72문장, 두 셋 사이, 셋 안)
uv run python -m zg_stage1.chat_eval_data eval_data/chat-dev-v2.jsonl eval_data/chat-holdout-v2.jsonl

# 3) 개발셋에서 F_max 예산을 지키는 임계값을 고른다
uv run python -m zg_stage1.evaluate_chat --model-dir "$ZG_DATA_DIR/ml/stage1/kcelectra-<시각>" \
  --eval-file eval_data/chat-dev-v2.jsonl --forward-budget 0.304

# 4) 3의 결과(같은 모델)로 보류셋을 한 번 본다. 임계값 하나의 집계만 남고, 결과 파일은 덮어쓰지 않는다
uv run python -m zg_stage1.evaluate_chat --model-dir "$ZG_DATA_DIR/ml/stage1/kcelectra-<시각>" \
  --eval-file eval_data/chat-holdout-v2.jsonl --dev-report "$ZG_DATA_DIR/ml/stage1/kcelectra-<시각>/chat-eval-dev.json"
```

- 가중 전달률은 가정한 트래픽 구성비(`evaluate_chat.DEFAULT_TRAFFIC_MIX`)로 계산한다. 실측 비율이 생기면 `--mix-file`로 바꾼다.

### 규칙·키워드 경로까지 합친 평가

실제 경로는 "규칙 → 키워드 경로 → 1차"다. 서버의 규칙 평가 도구로 문장별 규칙 판정을 만든 뒤 `--rule-routes`로 합친다.

```sh
# 저장소 루트에서. 문장마다 규칙 판정·키워드 경로 일치·AI 건너뜀 여부와 평가셋 해시·규칙 목록 지문을 쓴다(원문 없음)
npm run build -w @zzirit-guard/server
node apps/server/dist/tools/evaluateRules.js --eval-file workers/stage1/eval_data/chat-dev-v2.jsonl --output <scratch>/rules-dev.jsonl
# 개발셋은 --keywords <파일>로 목록을 더해 볼 수 있다. 보류셋은 저장소 기본 목록(defaultRules.ts)으로만 돌린다

uv run python -m zg_stage1.evaluate_chat --model-dir <모델> --eval-file eval_data/chat-dev-v2.jsonl \
  --forward-budget 0.304 --rule-routes <scratch>/rules-dev.jsonl
```

- 재현율은 규칙·키워드·1차 중 하나라도 잡으면 잡은 것으로 센다.
- 2차 부하는 규칙이 먼저 판정한 문장과 가벼운 반응(ㅋㅋ 등)을 빼고, 키워드나 1차로 2차에 가는 문장만 센다.
- 보류셋은 개발셋과 같은 모델(가중치 sha256)과 같은 규칙 목록 지문이어야 평가한다.
- 알려진 한계:
  - 예외 단어는 공백을 지운 문장에서 찾는다. 그래서 운영자가 넣은 예외 단어가 키워드를 품으면 그 키워드를 가릴 수 있다(기본 목록에서는 피했다).
  - 보류셋의 문장별 규칙 결과 파일은 남는다. 보류셋으로 목록을 다듬지 않는 것은 절차(기본 목록 커밋 → 개발셋 → 보류셋 한 번)로 지킨다.
- 72문장 회귀 세트는 봉인했다. 파일이 바뀌면 테스트와 겹침 검사가 실패한다.
- `evaluate_chat`도 평가 전에 같은 검사(72문장 겹침, 셋 안 중복, 애매 5% 이하, 범주마다 20문장 이상)를 한다.
- F_max는 시드가 다른 반복 5번 모두에서 기준을 지키는 값이다.

### M2 3차 학습·경로 끝·판정 도구

기준과 실행 순서는 [M2 3차 계획](../../docs/ml/2026-10-15-m2-round3-plan.md)을 따른다. 기존 명령은 새 선택지를 주지 않으면 같은 학습 행과 평가 JSON을 만든다.

```sh
# D: 대상 없는 offensive 제외. target_label 전체를 엄격히 검사하고 manifest에 제외 id 지문을 남긴다.
uv run python -m zg_stage1.training_mix --out <새 학습.jsonl> \
  --drop-untargeted-offensive [기존 H1T2 입력 선택지...]

# W: friendly_profanity만 9회, 다른 허용 문장은 --extra-repeat 3회
uv run python -m zg_stage1.training_mix --out <새 학습.jsonl> \
  --extra-repeat 3 --friendly-profanity-repeat 9 [기존 H1T2 입력 선택지...]

# D와 H1T2를 같은 정책 정렬 validation으로 비교
uv run python -m zg_stage1.validation_auc --model-dir <모델> --val-file <val_v2.jsonl> \
  --exclude-untargeted-offensive --output <새 auc.json>

# 2차 점수를 경로 끝 후보율에 합친 단일/앙상블 개발셋 평가
uv run python -m zg_stage1.evaluate_chat --model-dir <시드1> --model-dir <시드2> --model-dir <시드3> \
  --eval-file eval_data/chat-dev-v2.jsonl --forward-budget 0.304 \
  --rule-routes <rules.jsonl> --short-rule 5:4 --stage2-scores <stage2-scores.json> --output <ensemble-dev.json>

# 학습 전 R0 중단 조건과 범주별 2차 단독 후보율
uv run python -m zg_stage1.round3_decision precheck \
  --eval-file eval_data/chat-dev-v2.jsonl --rule-routes <R0-rules.jsonl> \
  --stage2-scores <stage2-scores.json> --output <precheck.json>
```

`--drop-untargeted-offensive`(D)와 `--friendly-profanity-repeat`(W)는 서로 배타적이다. W는 저장소에 고정한 허용 문장 v1에만 쓸 수 있고, 실행 전 v1의 `friendly_profanity`가 986줄인지 확인한다. D의 `ids_sha256`와 정책 정렬 AUC의 `excluded_ids_sha256`는 K-HATERS id를 **정수 오름차순**으로 정렬해 `"<id>\n"`을 이어 붙인 UTF-8의 sha256이다. 정수가 아닌 id는 거절한다.

`evaluate_chat`은 `--stage2-scores`를 준 dev 보고서에 결정 임계값의 `item_flags`(채점 id별 `routed`, `goes_to_stage2`, `endpoint`)와 `weighted_forward_rate_exact`, `within_budget`을 남긴다. 판정·부트스트랩은 반올림된 `scores`가 아닌 이 플래그만 쓰며, 플래그로 재계산한 범주별 비율이 보고서 집계와 다르면 멈춘다. holdout은 dev 보고서의 예산으로 exact 부하를 판정하고 문장별 플래그는 남기지 않는다.

`round3_decision dev`의 CONFIG은 `variant`(`D`/`W`), `dev_file`, R0 `rule_routes`, `stage2_scores`, 고정 `short_rule` 5:4, 모델별 `training_data_sha256`(`H1T2`는 `9ffd01627a95c73ff2b21de24884913d525fbabba3af43b4cdd6c921da8d4a62`, X는 해당 학습 파일 지문), `reports`(`single` 3개 `{seed,path}`, `ensemble` 1개, `pair_ensembles` 3개), `validation_auc`, `manifest` 출처를 담는다. 상대경로는 CONFIG 파일 기준이다. 시드와 학습 파일 지문의 근거는 각 모델의 `model-card.json` → `hyperparameters.seed`와 `training_data.train.sha256`이고, `evaluate_chat`이 이를 단일/앙상블 보고서에 복사한다. 판정기는 보고서와 AUC 모델 카드가 CONFIG의 같은 모델 출처인지, 단일 시드가 `20261011, 20261021, 20261031` 오름차순인지, 앙상블 가중치 집합·순서와 세 두-시드 조합이 정확한지 검사한다.

W의 `validation_auc.H1T2`/`validation_auc.W`는 각 시드 모델 카드이며 `best_validation_auc`가 필수다. D의 두 항목은 시드별 서로 다른 정책 정렬 AUC 파일 3개씩이고, 추가로 H1T2 모델 카드 3개를 `validation_auc.original_h1t2`에 둔다. 승자가 있으면 판정 JSON 옆에 Markdown과 `.manifest.json` 초안을 쓴다. `manifest` 입력에는 보류셋·커밋 지문과 함께 `evaluate_rules_sha256`(실제 실행할 `evaluateRules.js`)를 넣는다.

```sh
uv run python -m zg_stage1.round3_decision dev --config <round3-config.json> --output <decision.json>
uv run python -m zg_stage1.round3_decision holdout --manifest <decision.manifest.json> \
  --holdout-reports <보고서...> --output <verdict.json>
```

봉인 보류셋은 개별 명령을 손으로 실행하지 않고 저장소 루트에서 한 명령으로 끝낸다. 키워드 파일이 없으면 네 번째 인자에 `-`를 준다. 데이터 디렉터리는 여섯 번째 인자로 주며 `ZG_DATA_DIR`를 읽지 않는다. 생성한 manifest는 평가 코드 밖인 `docs/ml/m2-round3-decisions/` 아래에 결정 기록으로 두고 먼저 커밋한다. 스크립트는 manifest의 `evaluation_code_commit`이 HEAD의 조상인지, 그 커밋부터 HEAD까지 `workers/`·`apps/server/`가 바뀌지 않았는지와 깨끗한 작업 트리(`.serena/` 제외), `uv`·`node`, `evaluateRules.js`, 보류셋·1차 가중치·2차 모델 지문을 추론 전에 확인한다.

판정을 쓴 뒤 출력 부모 안의 숨은 스테이징 디렉터리에 판정·보고서·원시 점수·로그를 모두 모으고, 출력 디렉터리가 없음을 다시 전제로 디렉터리 rename 한 번으로 공개한다. 단일은 시드별 1차 원시 점수, 앙상블은 구성 모델별·평균 점수, 2차 원시 점수와 각 sha256을 남긴다. 사전 검사가 실패하면 stderr에 `preflight: <reason>`(예: `code_commit_not_ancestor`, `evaluation_code_changed`, `worktree_dirty`, `output_parent_missing`)만 쓰며 보류셋 내용이나 점수를 쓰지 않는다. 이후 단계 실패는 종전처럼 단계 이름만 쓴다.

```sh
workers/stage1/scripts/round3-holdout.sh \
  <manifest.json> <holdout.jsonl> apps/server/dist/tools/evaluateRules.js - \
  <2차 모델 디렉터리> <찌리릿 가드 데이터 디렉터리> <새 출력 디렉터리>
```

## 워커 실행

학습한 모델로 서버에 1차 점수를 준다. 서버와 주고받는 약속은 [워커 계약 v1](../contract/README.md)이다.

```sh
cd workers/stage1
export ZG_DATA_DIR="$HOME/Library/Application Support/zzirit-guard"   # 서버와 같은 데이터 디렉터리
uv run python -m zg_stage1.worker --model-dir "$ZG_DATA_DIR/ml/stage1/<학습 결과>"
```

- **소켓:** `$ZG_DATA_DIR/run/stage1.sock`(디렉터리 0700, 소켓 0600)에서만 듣는다.
  - TCP 포트를 쓰지 않는다. 다른 사용자 프로세스가 같은 주소로 기다렸다가 채팅을 받는 일을 막기 위해서다.
  - 소켓 경로가 103바이트를 넘으면 시작하지 않는다. 그때는 `ZG_DATA_DIR`을 짧은 경로로 둔다.
- **시작 순서:** 잠금(`run/stage1.lock`) → 남은 소켓 정리 → 모델 불러오기·데우기 → 소켓.
  - 같은 워커를 두 번 띄우면 두 번째는 소켓을 건드리지 않고 끝난다.
  - 소켓이 있으면 받을 준비가 된 것이다.
- **모델:** 학습 결과의 `inference.json`(추론 계약)대로 채점한다. 계약이 없으면 시작하지 않는다.
  - 모델 식별자는 `<디렉터리 이름>@<가중치·토크나이저·설정·계약 sha256 앞 12자>`다. 서버는 이 값이 바뀌면 점수 캐시를 비운다.
- **CPU:** 기본 6스레드다(`--threads`). GPU는 2차 워커가 쓴다.
- **한도:** 동시 처리 연결 4개, 연결당 5초. 추론이 5초 안에 끝나지 않으면 503이다. 추론 하나가 10초를 넘으면 멈춘 것으로 보고 종료 코드 70으로 끝낸다. launchd가 다시 띄운다.
- **로그:** 요청마다 경로·상태·건수·지연만 남긴다. 채팅 원문은 남기지 않는다.

## 알려진 한계

- 학습 데이터(K-HATERS)는 뉴스 댓글이라 방송 채팅과 말투가 다르다.
- 스파이크에서 1차 분류기는 **성희롱·자해·협박·신상·광고**를 놓쳤다(학습 데이터에 없는 범주). 이 범주는 키워드 경로와 규칙, 2차(kanana)가 맡는다(스펙 §5.2).
- MPS의 일부 연산은 비결정적이라, 같은 시드여도 결과가 소수점 아래에서 조금 다를 수 있다.
- **실채팅으로는 학습하지 않는다.** 치지직의 서면 회신 전에는 실채팅을 학습·평가용으로 모으지 않는다(스펙 §9).

## 개발

```sh
uv run pytest            # 단위 테스트(모델 다운로드·네트워크 없음)
uv run ruff check .      # 린트
uv run mypy zg_stage1    # 타입 검사
```

## 라이선스와 출처 표기

| 구성 요소 | 라이선스 | 표기 |
|---|---|---|
| [beomi/KcELECTRA-base](https://huggingface.co/beomi/KcELECTRA-base) | MIT | Junbum Lee. *KcELECTRA: Korean comments ELECTRA.* GitHub, 2021. https://github.com/Beomi/KcELECTRA |
| [humane-lab/K-HATERS](https://huggingface.co/datasets/humane-lab/K-HATERS) | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Chaewon Park, Suhwan Kim, Kyubyong Park, Kunwoo Park. *K-HATERS: A Hate Speech Detection Corpus in Korean with Target-Specific Ratings.* Findings of EMNLP 2023. 라벨 4종을 이진으로 바꿔 썼다 |

학습한 가중치는 두 저작물에서 나온 결과물이다. 배포하지 않는 것이 원칙이고, 부득이 배포한다면 K-HATERS 출처와 변경 사항, KcELECTRA의 MIT 저작권 고지를 함께 표기해야 한다. `model-card.json`의 `licenses`에도 같은 내용이 들어 있다.
