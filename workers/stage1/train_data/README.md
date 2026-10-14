# 학습용 허용 문장(허용 어려운 예제)

> ⚠️ **비속어가 들어 있습니다.** 칭찬·감탄으로 쓴 욕, 게임 속 전투 표현, 욕설을 인용·신고하는 문장처럼 겉보기에는 거칠지만 숨기면 안 되는 합성 문장입니다. 실제 채팅이 아니고 실존 인물 정보가 없습니다.

- 계획: [모델 보강 계획](../../../docs/ml/2026-10-14-model-strengthening-plan.md) M2
- 기준선: [채팅 평가 기준선](../../../docs/ml/2026-10-14-chat-eval-baseline.md). 지금 1차 분류기는 칭찬 비속어의 75~87%를 2차로 넘긴다.
- 라벨 정책: [채팅 평가셋 라벨 정책](../../../docs/ml/chat-eval-policy.md)의 허용 유형

## 파일

`hard-negatives-v2.jsonl`(3,668줄): 한 줄에 한 문장이다. 필드는 `id`, `label`(항상 `allow`), `category`(허용 유형), `family`, `author`, `reviewer`, `text`다.

## 만든 방법

1. v1: Claude(claude-opus-5.5)가 허용 유형별로 3,000줄을 썼다. 작성자는 평가셋과 72문장을 보지 않았다.
   - 칭찬 비속어 1,000줄
   - 게임 속 전투 500줄
   - 인용·신고 500줄
   - 일반·숫자 모양·짧은 문장 1,000줄
2. 평가셋(개발·보류)이나 72문장과 같거나 거의 같은 문장, 그리고 셋 안의 중복을 뺐다.
3. Codex(gpt-5.6-sol)가 라벨을 검토했다. 허용이 확실하지 않은 문장은 뺐다(사람·집단을 깎아내림, 실제 협박으로 읽힘, 자해, 성적 발언, 애매함).
   - 최종 2,934줄: 칭찬 비속어 986, 일반 747, 인용·신고 499, 게임 속 전투 479, 숫자 모양 124, 짧은 문장 99.
   - 겹침으로 45줄, 검토로 21줄을 뺐다.
4. v2: 짧은 반응·일반 대화를 800줄 더 썼다(비속어 없음). v1로 학습한 모델이 짧은 일반 문장을 2차로 많이 넘겼기 때문이다.
   - 평가셋·72문장·기존 문장과 겹치는 66줄을 빼고 734줄을 더했다. Codex 검토에서 뺀 줄은 없다.
5. 보류셋을 쓴 모델(Codex)은 이 문장을 쓰지 않았다. 그래서 보류셋으로 '다른 모델이 쓴 문장에도 효과가 남는지'를 볼 수 있다. 개발셋의 허용 문장은 같은 Claude가 써서 개발셋 숫자는 좋게 나올 수 있다.

## 판(version)

v2 파일은 v1(앞 2,934줄, `hn-0001`~`hn-2934`) 뒤에 734줄을 덧붙인 것이다. `zg_stage1.training_mix`는 판별 줄 수와 sha256을 기록해 두고, 파일에서 그 판의 줄만 꺼낼 때 sha256을 확인한다.
- 앞선 판의 줄은 고치지 않는다. 고치면 그 판으로 학습한 모델을 다시 만들 수 없다. 새 문장은 파일 뒤에 덧붙이고 새 판을 기록한다.
- M2 1차 후보(`kcelectra-hn-f73-r3`)는 v1로 학습했다. v2는 결과가 나빠 기본값이 아니다([재학습 결과](../../../docs/ml/2026-10-14-stage1-retrain-results.md)).

## 쓰는 법

`zg_stage1.training_mix`가 K-HATERS train과 이 파일을 섞어 학습 파일을 만든다. 학습 파일과 manifest(`<학습 파일 이름>.manifest.json`)는 저장소 밖에 쓴다.
- 만들 때마다 평가셋(개발·보류)·72문장과 겹치는지 다시 확인한다. 이 파일의 문장이 겹치면 오류를 낸다. K-HATERS 줄이 겹치면 빼고 manifest에 id만 남긴다. 공식 train_v2에서는 짧은 인사·감사 문장 25줄이 빠진다(평가 문장 9개와 같은 문장).
- 기본값은 후보 설정(v1, K-HATERS 유해 비율 그대로, 3번 반복, 시드 20261014)이다.
- M2 2차 생성 파일은 한 줄에 `{"id": "안전한-외부-id", "text": "자리표시자 문장"}`를 쓴다. `--generated-harmful`은 `offensive`, `--generated-allow`는 `normal`로 들어가며 각각 반복 횟수를 정할 수 있다. 파일 출처와 반복 횟수, 공개 평가 겹침으로 빠진 생성 id는 manifest에 남는다.
- `--sealed-holdout`은 모든 학습 행과 반복본을 만든 뒤 chat eval 형식의 봉인 보류셋으로 단방향 겹침을 검사한다. manifest에는 봉인 파일 이름·sha256, 출처별 제외 건수, 제외한 학습 id만 남고 봉인 id·문장·유사도는 남지 않는다.

```bash
uv run python -m zg_stage1.training_mix --out "$ZG_DATA_DIR/ml/data/mix/train-hn-v1-r3.jsonl"
uv run python -m zg_stage1.training_mix \
  --out "$ZG_DATA_DIR/ml/data/mix/train-m2r2.jsonl" \
  --generated-harmful "$ZG_DATA_DIR/ml/data/m2r2/generated-harmful.jsonl" \
  --generated-harmful-repeat 1 \
  --generated-allow "$ZG_DATA_DIR/ml/data/m2r2/generated-allow.jsonl" \
  --generated-allow-repeat 2 \
  --sealed-holdout "$ZG_DATA_DIR/ml/data/m2r2/sealed/chat-holdout-v3.jsonl"
uv run python -m zg_stage1.train --train-file "$ZG_DATA_DIR/ml/data/mix/train-hn-v1-r3.jsonl" --epochs 2
```

## 라이선스

이 폴더의 문장은 이 저장소와 같은 Apache-2.0으로 배포한다.
