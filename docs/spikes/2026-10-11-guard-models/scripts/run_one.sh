#!/bin/zsh
# 모델 1개를 (필요하면) 양자화한 뒤 측정한다.
# 사용법: run_one.sh <원본 디렉터리 이름> <계열 kanana|qwen> <bits: 4|8|bf16>
# 원본은 신뢰하지 않는 다운로드물이라 파이썬은 -I(격리 모드)로, 작업 디렉터리는 scripts에서 실행한다.
set -euo pipefail

SPIKE=${SPIKE_DIR:?SPIKE_DIR에 스파이크 작업 디렉터리(venv·models·results가 있는 곳)를 지정하세요}
PYTHON=$SPIKE/venv/bin/python
SOURCE_NAME=$1
FAMILY=$2
BITS=$3
SOURCE_DIR=$SPIKE/models/$SOURCE_NAME
RUN_LABEL=${SOURCE_NAME%-bf16}-$BITS${LABEL_SUFFIX:-}

cd $SPIKE/scripts

if [[ $BITS == bf16 ]]; then
  MODEL_DIR=$SOURCE_DIR
else
  MODEL_DIR=$SPIKE/models_q/${SOURCE_NAME%-bf16}-$BITS
  if [[ ! -f $MODEL_DIR/config.json ]]; then
    mkdir -p $SPIKE/models_q
    echo "[양자화] $SOURCE_NAME → ${BITS}bit"
    $PYTHON -I -m mlx_lm convert --hf-path $SOURCE_DIR --mlx-path $MODEL_DIR -q --q-bits $BITS --q-group-size 64
  fi
fi

echo "[측정] $RUN_LABEL"
$PYTHON -I $SPIKE/scripts/bench_guard.py \
  --model-dir $MODEL_DIR --family $FAMILY --run-label $RUN_LABEL \
  --chat-file $SPIKE/data_chat/chat_samples.jsonl \
  --khaters-file $SPIKE/data_khaters/test_v2.jsonl \
  --khaters-per-label 100 --out-dir $SPIKE/results ${=EXTRA_FLAGS:-}
