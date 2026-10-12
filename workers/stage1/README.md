# 1차 분류기 학습·평가 (workers/stage1)

판정 파이프라인 ④단계의 **1차 분류기**를 만드는 곳이다([설계 스펙 §5.2](../../docs/superpowers/specs/2026-10-11-zzirit-guard-design.md)). `beomi/KcELECTRA-base`를 K-HATERS의 이진 라벨(normal=0, offensive·L1_hate·L2_hate=1)로 미세조정한다. 점수가 **0.05 이상**인 메시지만 2차(kanana)로 넘기는 거름망이라, 정확도보다 **유해 재현율**이 중요하다.

- 운영 워커(`127.0.0.1:8711/classify`)는 아직 없다. 2단계에서 이 디렉터리에 추가한다. 여기에는 학습·평가 파이프라인만 있다.
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

[hf CLI](https://huggingface.co/docs/huggingface_hub/guides/cli) 2.x로 받는다(스파이크는 huggingface_hub 2.2.0을 썼다). **리비전을 고정**해서 받는다. 저장소의 `main`은 언제든 바뀔 수 있고, 바뀌면 같은 스크립트로도 결과가 달라진다. 아래 리비전은 2026-10-12에 확인한 값이다. 다른 리비전을 쓰면 모델 카드의 `matches_reference`가 `false`로 남는다.

hf CLI 2.x에서는 **패턴마다 `--include`를 따로** 붙인다. `--include a b`처럼 쓰면 두 번째부터는 파일 이름으로 해석되어 일부만 받는다.

```sh
ML_DIR="$ZG_DATA_DIR/ml"

# 기반 모델: safetensors만 받는다(pytorch_model.bin은 pickle이라 받지 않는다. 있으면 학습 스크립트가 거부한다)
hf download beomi/KcELECTRA-base \
  --revision 681201a097b8120e6dd2a2e63a3e13d338736f88 \
  --include config.json \
  --include model.safetensors \
  --include tokenizer.json \
  --include tokenizer_config.json \
  --include special_tokens_map.json \
  --local-dir "$ML_DIR/base/kcelectra-base"

# 학습 데이터: K-HATERS v2
hf download humane-lab/K-HATERS --repo-type dataset \
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
- 출력 디렉터리(`--out-dir`, 기본 `$ZG_DATA_DIR/ml/stage1/kcelectra-<시각>`)가 **이미 있으면 거부**한다. 앞선 결과를 덮어쓰지 않기 위해서다.
- 로그에는 진행 상황과 지표만 찍고 데이터 원문은 찍지 않는다.
- 빠른 확인(스모크): `uv run python -m zg_stage1.train --max-steps 50 --epochs 1 --out-dir <임시 위치>`

**걸리는 시간(맥 미니 M4 Pro, MPS, 2026-10-12 측정)**: 약 2.6스텝/s(배치 32)였다. epoch당 5,381스텝이라 3 epoch(16,143스텝)는 학습만 **약 1시간 45분**이고, epoch마다 검증·저장에 약 20초가 더 든다. 다른 작업이 GPU를 쓰면 더 느려진다. 진행 로그의 `남은예상`을 본다.

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
| CPU 처리량 | 16건 묶음, max_length 128, 고정 표본(채팅 72문장 × 20) |
| 임계값 선택(참고용) | 검증셋에서 유해 재현율 0.97 이상을 지키는 가장 큰 임계값 |

평가는 약 1~2분 걸린다. 빠른 확인은 `--limit 500`(test·검증 앞 500줄)을 준다.

### 임계값 선택(참고용)

평가가 `validation-scores.json`(검증 점수와 이진 라벨만, 원문 없음)을 함께 남긴다. 다른 재현율 목표로 다시 보려면:

```sh
uv run python -m zg_stage1.thresholds --scores-file "$ZG_DATA_DIR/ml/stage1/kcelectra-<시각>/validation-scores.json" --target-recall 0.97
```

결과는 **참고용**이다. 운영 기본값은 스펙의 0.05로 두고, 바꾸는 결정은 섀도 데이터를 본 뒤 사람이 한다.

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
