#!/bin/zsh
# 서버나 AI 워커를 로그인 사용자 LaunchAgent로 설치(또는 갱신)하고 시작한다.
# 사용법(sudo 없이 서버를 돌릴 사용자로 실행):
#   ops/scripts/install-launchd.sh                                   서버(기본)
#   ops/scripts/install-launchd.sh stage1-worker <1차 모델 디렉터리>   1차 분류기 워커
#   ops/scripts/install-launchd.sh stage2-worker <2차 모델 디렉터리>   2차 분류기 워커
# Node를 업그레이드하면(경로가 바뀌므로) 서버를 다시 설치한다. 워커는 모델을 바꿀 때 다시 설치한다.
# 시험용 덮어쓰기: ZG_INSTALL_DRY_RUN=1이면 plist를 임시 파일에 만들어 검사만 하고, 기존 plist와 launchctl은 건드리지 않는다.
#   ZG_INSTALL_HOME으로 홈 디렉터리를 바꿀 수 있다(임시 폴더에서 시험할 때만 쓴다).
set -euo pipefail
if [[ "$(id -u)" -eq 0 ]]; then
  echo "root(sudo)로 실행하면 안 됩니다. 서버는 로그인 사용자의 키체인을 읽습니다. sudo 없이 다시 실행하세요." >&2
  exit 1
fi
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
COMPONENT="${1:-server}"
MODEL_DIR="${2:-}"
case "$COMPONENT" in
  server|stage1-worker|stage2-worker) ;;
  *) echo "알 수 없는 구성 요소입니다: $COMPONENT — server, stage1-worker, stage2-worker 중 하나를 주세요." >&2; exit 1 ;;
esac
LABEL="com.zzirit-guard.$COMPONENT"
DOMAIN="gui/$(id -u)"
BASE_HOME="${ZG_INSTALL_HOME:-$HOME}"
DATA_DIR="$BASE_HOME/Library/Application Support/zzirit-guard"
ENV_FILE="$DATA_DIR/.env"
LOG_DIR="$BASE_HOME/Library/Logs/zzirit-guard"
PLIST_DIR="$BASE_HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
IS_DRY_RUN="${ZG_INSTALL_DRY_RUN:-0}"

# sed 치환부 값에서 &, |, \를 이스케이프한다(구분자가 |이고 &는 '일치한 문자열'이라서).
escape_sed() { print -r -- "$1" | sed -e 's/[&|\\]/\\&/g'; }
# plist(XML) 값에서 &, <, >를 이스케이프한다. sed 이스케이프보다 먼저 적용한다.
escape_xml() { print -r -- "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
# 두 단계를 합친 치환 값.
template_value() { escape_sed "$(escape_xml "$1")"; }

# 서버 설치 준비: node 경로·환경 파일·빌드를 확인한다.
prepare_server() {
  # command -v는 못 찾으면 1을 돌려 set -e가 이유 없이 끝내므로, 빈 값으로 받고 직접 안내한다.
  NODE=$(command -v node || true)
  if [[ -z "$NODE" ]]; then
    echo "node를 찾을 수 없습니다. Node.js 22.12 이상을 설치하고 이 터미널의 PATH에서 node가 보이게 한 뒤 다시 실행하세요." >&2
    exit 1
  fi
  if [[ "$NODE" == *".nvm"* || "$NODE" == *fnm* || "$NODE" == *asdf* || "$NODE" == *volta* ]]; then
    echo "경고: node 경로가 버전 관리자 shim일 수 있습니다($NODE). launchd는 셸 설정을 읽지 않으므로 shim은 실패할 수 있습니다. 실제 node 실행 파일 경로를 쓰는 것이 안전합니다." >&2
  fi
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "환경 파일이 없습니다: $ENV_FILE — ops/env.example을 복사해 채운 뒤 chmod 600 하세요." >&2
    exit 1
  fi
  if [[ ! -f "$ROOT/apps/server/dist/main.js" ]]; then
    echo "서버 빌드가 없습니다. 먼저 npm run build -w @zzirit-guard/server 를 실행하세요." >&2
    exit 1
  fi
}
# 워커 설치 준비: 워커 venv와 모델 디렉터리를 확인한다. 모델 디렉터리는 절대 경로로 바꿔 plist에 넣는다.
prepare_worker() {
  local stage_dir="$ROOT/workers/${COMPONENT%-worker}"
  if [[ ! -x "$stage_dir/.venv/bin/python" ]]; then
    echo "워커 환경이 없습니다: $stage_dir/.venv — 먼저 (cd \"$stage_dir\" && uv sync)를 실행하세요." >&2
    exit 1
  fi
  if [[ -z "$MODEL_DIR" || ! -d "$MODEL_DIR" ]]; then
    echo "모델 디렉터리를 두 번째 인자로 주세요(예: \"$DATA_DIR/ml/${COMPONENT%-worker}/<모델>\"). 받은 값: '${MODEL_DIR}'" >&2
    exit 1
  fi
  MODEL_DIR=$(cd "$MODEL_DIR" && pwd)
}
if [[ "$COMPONENT" == "server" ]]; then prepare_server; else prepare_worker; fi
LOG_BASE="$LOG_DIR/$COMPONENT"
# 로그에는 매니저 채널 ID가 남으므로 폴더는 700, 파일은 600으로 미리 만든다(launchd가 만들면 644가 된다).
(umask 077; mkdir -p "$LOG_DIR" "$PLIST_DIR"; touch "$LOG_BASE.log" "$LOG_BASE.err.log")
chmod 700 "$LOG_DIR"
chmod 600 "$LOG_BASE.log" "$LOG_BASE.err.log"
# 렌더 결과는 대상 옆 임시 파일에 먼저 쓰고, 검사를 통과한 뒤에만 mv로 바꾼다(C05).
# 왜: 대상에 바로 쓰면 검사가 실패했을 때(또는 시험 실행만 해도) 디스크의 정상 plist가 깨진 내용으로 바뀐다.
# 같은 폴더에 만들어야 mv가 같은 파일 시스템 안의 원자적 이름 바꾸기가 된다.
RENDERED=$(mktemp "$PLIST_DIR/.$LABEL.plist.XXXXXX")
# 어떻게 끝나든(검사 실패·시험 실행·중간 오류) 남은 임시 파일을 지운다. mv가 끝난 뒤에는 지울 파일이 없어 아무 일도 하지 않는다.
trap 'rm -f "$RENDERED"' EXIT
sed -e "s|__NODE__|$(template_value "${NODE:-}")|g" -e "s|__ENV_FILE__|$(template_value "$ENV_FILE")|g" \
  -e "s|__REPO__|$(template_value "$ROOT")|g" -e "s|__LOG_DIR__|$(template_value "$LOG_DIR")|g" \
  -e "s|__MODEL_DIR__|$(template_value "$MODEL_DIR")|g" -e "s|__DATA_DIR__|$(template_value "$DATA_DIR")|g" \
  "$ROOT/ops/launchd/$LABEL.plist.template" > "$RENDERED"
# 잘못된 plist를 건 채로 기존 서버를 내리지 않도록, 바꾸고 내리기 전에 문법을 검사한다.
if ! plutil -lint "$RENDERED" >/dev/null; then
  echo "만든 plist가 올바르지 않습니다(검사한 임시 파일: $RENDERED) — 경로에 특수 문자가 있는지 확인하세요. 기존 plist($PLIST)와 서버는 건드리지 않았습니다." >&2
  exit 1
fi
if [[ "$IS_DRY_RUN" == "1" ]]; then
  echo "시험 실행: plist를 임시 파일에 만들어 검사했습니다. 기존 plist($PLIST)와 launchctl은 건드리지 않았습니다."
  exit 0
fi
mv -f "$RENDERED" "$PLIST"
# 이미 떠 있으면 내린다. 떠 있는지 먼저 확인해, 내리기 실패(권한 등)를 '처음 설치'로 잘못 안내하지 않는다.
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  echo "실행 중이던 $COMPONENT를 내렸습니다."
else
  echo "실행 중인 $COMPONENT가 없습니다(처음 설치)."
fi
# bootout 직후에는 작업이 아직 남아 bootstrap이 실패할 수 있어, 한 번 잠시 기다렸다 다시 시도한다.
if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then
  sleep 3
  launchctl bootstrap "$DOMAIN" "$PLIST"
fi
if [[ "$COMPONENT" == "server" ]]; then echo "설치했습니다: $PLIST (node: $NODE)"; else echo "설치했습니다: $PLIST (모델: $MODEL_DIR)"; fi
echo "상태 확인: launchctl print $DOMAIN/$LABEL | grep state"
if [[ "$COMPONENT" == "server" ]]; then echo "로그: tail -f \"$LOG_BASE.log\""; else echo "로그: tail -f \"$LOG_BASE.err.log\""; fi
