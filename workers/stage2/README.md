# 2차 분류기 워커 (workers/stage2)

판정 파이프라인 ⑤단계의 **2차 분류기**다([설계 스펙 §5.2](../../docs/superpowers/specs/2026-10-11-zzirit-guard-design.md)). 1차를 넘긴 채팅과 키워드 경로 채팅을 `kakaocorp/kanana-safeguard-8b`(Apache-2.0)로 판정한다.
- 결과는 유해 확률(UNSAFE 분류 토큰 확률의 합)과 가장 높은 유해 범주(S1~S7)다.
- 서버와 주고받는 약속은 [워커 계약 v1](../contract/README.md)이다.

- AI 판정은 자동 숨김을 하지 않는다. 서버가 확률 0.5 이상을 후보로, S6(자살·자해)을 '도움 필요'로 올린다.
- 맥 미니 GPU(mlx)에서 직렬로 돈다. 측정값은 아래 "측정"에 있다.

## 준비

macOS(Apple Silicon)와 [uv](https://docs.astral.sh/uv/)가 필요하다. 의존성은 `uv.lock`에 고정되어 있다(파이썬 3.12, mlx-lm 0.31.3). 잠금 시점 기준 2주 넘게 공개된 배포본만 쓴다.

```sh
cd workers/stage2
uv sync
export ZG_DATA_DIR="$HOME/Library/Application Support/zzirit-guard"   # 서버와 같은 데이터 디렉터리
```

### 모델 받기와 4비트 변환

가중치는 저장소에 넣지 않는다. 공식 저장소에서 받아 각자 변환한다. 변환은 bf16 원본(약 16GB)을 읽어 4비트(약 5GB)로 쓴다.

```sh
uv run python -m mlx_lm convert --hf-path kakaocorp/kanana-safeguard-8b \
  --mlx-path "$ZG_DATA_DIR/ml/stage2/kanana-safeguard-8b-mlx-4bit" -q --q-bits 4 --q-group-size 64
```

변환이 끝나면 bf16 원본 캐시(`~/.cache/huggingface`)는 지워도 된다.

## 워커 실행

```sh
uv run python -m zg_stage2.worker --model-dir "$ZG_DATA_DIR/ml/stage2/kanana-safeguard-8b-mlx-4bit"
```

- **소켓:** `$ZG_DATA_DIR/run/stage2.sock`(디렉터리 0700, 소켓 0600)에서만 듣는다. TCP 포트를 쓰지 않는다.
- **시작 순서:** 잠금(`run/stage2.lock`) → 남은 소켓 정리 → 모델 불러오기·데우기 → 소켓. 같은 워커를 두 번 띄우면 두 번째는 소켓을 건드리지 않고 끝난다.
- **모델 경로:** 로컬 디렉터리만 받는다. 허깅페이스 허브를 오프라인으로 두어, 경로를 잘못 주어도 인터넷에서 받지 않는다.
  - 모델 식별자는 `<디렉터리 이름>@<가중치·토크나이저·채팅 템플릿 sha256 앞 12자>`다. 서버는 이 값이 바뀌면 점수 캐시를 비운다.
- **입력:** 모델 카드대로 `[사용자 발화, 빈 assistant]`를 채팅 템플릿에 넣는다. 다음 토큰 하나의 분포에서 `<SAFE>`, `<UNSAFE-S1>`~`<UNSAFE-S7>` 확률을 읽는다.
  - 분류 토큰이 각각 토큰 하나가 아니거나, 서로 겹치거나, unk면(다른 판의 토크나이저) 시작하지 않는다.
  - `config.json`에 `model_file`(모델 디렉터리의 파이썬 코드)이 있으면 시작하지 않는다. 원격 코드도 실행하지 않는다.
- **채팅은 공격자 입력이다.** 프롬프트를 템플릿 앞부분, 채팅 내용, 템플릿 뒷부분으로 따로 토큰화한다.
  - 채팅 안의 특수 토큰(`<|eot_id|>` 등)은 일반 글자로 쪼갠다.
  - 분류 토큰·역할 표시(`<SAFE>`, `</human>` 등)는 꺾쇠를 전각(＜＞)으로 바꿔, 채팅이 템플릿 경계를 넘거나 정답 토큰을 흉내 내지 못하게 한다.
- **길이:** 채팅 내용이 384토큰을 넘으면 판정하지 않고 400 `text_too_long`으로 답한다(자르지 않는다). 한 요청은 1건이다.
- **접두 KV 캐시:** 템플릿 앞부분(58토큰)을 한 번만 계산해 두고, 판정마다(예외가 나도) 모든 층을 되감는다.
  - 작은 float32 모델에서는 캐시를 쓴 결과가 전체 계산과 같다.
  - 실제 4비트 모델에서는 확률이 최대 0.06 다르다(72문장 기준, 범주는 모두 같음). 스파이크에서도 본 수치 차이다.
- **한도와 로그:** 1차 워커와 같다(동시 연결 4개, 요청 마감 5초, 추론 대기 5초, 멈춘 추론 10초면 종료 코드 70). 로그에는 건수와 지연만 남긴다.

## 공용 모듈

`zg_stage2/worker_contract.py`, `worker_runtime.py`, `worker_server.py`, `tests/worker_cases.py`는 1차 워커(`workers/stage1`)에서 패키지 이름만 바꿔 복사한 것이다.
- 두 워커는 의존성이 달라(PyTorch·mlx) 패키지로 나누지 않는다.
- `tests/test_shared_copies.py`가 두 벌이 같은지 본다. 고칠 때는 1차를 고친 뒤 다시 복사한다.

```sh
for name in worker_contract worker_runtime worker_server; do
  sed 's/zg_stage1/zg_stage2/g' ../stage1/zg_stage1/$name.py > zg_stage2/$name.py
done
sed 's/zg_stage1/zg_stage2/g' ../stage1/tests/worker_cases.py > tests/worker_cases.py
```

## 측정(2026-10-14, 맥 미니 M4 Pro 24GB)

봉인한 72문장을 워커 소켓으로 1건씩 보낸 값이다. 72문장은 측정만 하고, 임계값을 맞추는 데 쓰지 않는다.

| 항목 | 값 |
|---|---|
| 1건 지연(HTTP 포함) | 중앙값 100ms, p95 104ms |
| 정밀도 / 재현율(확률 0.5 이상) | 0.973 / 0.766 |
| 그룹별 표시 | [스파이크](../../docs/spikes/2026-10-11-guard-models/README.md)와 같음(일반 0/15, 자해 3/3, 광고 1/5 등) |
| 긴 입력(한 건) | 한국어 100자 0.37초, 300자 0.64초, 1,000자 2.6초, 이모지 1,000개 5.9초 |

프롬프트 처리는 초당 약 350~400토큰이다. 그래서 채팅 내용을 384토큰(약 1초)까지만 판정한다. 짧은 채팅이 많을수록 2차가 감당하는 건수가 늘어난다.

## 개발

```sh
uv run ruff check . && uv run ruff format --check . && uv run mypy zg_stage2 && uv run pytest -q
# 실제 모델로 접두 캐시 결과를 확인(선택)
ZG_STAGE2_MODEL_DIR="$ZG_DATA_DIR/ml/stage2/kanana-safeguard-8b-mlx-4bit" uv run pytest -q tests/test_classifier.py -k real
```

## 라이선스와 출처 표기

- 이 디렉터리의 코드: Apache-2.0(저장소 라이선스).
- 모델: [kakaocorp/kanana-safeguard-8b](https://huggingface.co/kakaocorp/kanana-safeguard-8b), Apache-2.0. 가중치를 배포하지 않는다.
- [mlx-lm](https://github.com/ml-explore/mlx-lm): MIT.
