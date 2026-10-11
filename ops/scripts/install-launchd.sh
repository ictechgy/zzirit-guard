#!/bin/zsh
# 서버를 로그인 사용자 LaunchAgent로 설치(또는 갱신)하고 시작한다.
# 사용법: ops/scripts/install-launchd.sh   (sudo 없이 서버를 돌릴 사용자로 실행)
# Node를 업그레이드하면(경로가 바뀌므로) 다시 실행한다.
# 시험용 덮어쓰기: ZG_INSTALL_DRY_RUN=1이면 plist만 만들어 검사하고 launchctl은 건드리지 않는다.
#   ZG_INSTALL_HOME으로 홈 디렉터리를 바꿀 수 있다(임시 폴더에서 시험할 때만 쓴다).
set -euo pipefail
if [[ "$(id -u)" -eq 0 ]]; then
  echo "root(sudo)로 실행하면 안 됩니다. 서버는 로그인 사용자의 키체인을 읽습니다. sudo 없이 다시 실행하세요." >&2
  exit 1
fi
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LABEL=com.zzirit-guard.server
DOMAIN="gui/$(id -u)"
BASE_HOME="${ZG_INSTALL_HOME:-$HOME}"
DATA_DIR="$BASE_HOME/Library/Application Support/zzirit-guard"
ENV_FILE="$DATA_DIR/.env"
LOG_DIR="$BASE_HOME/Library/Logs/zzirit-guard"
PLIST="$BASE_HOME/Library/LaunchAgents/$LABEL.plist"
IS_DRY_RUN="${ZG_INSTALL_DRY_RUN:-0}"

# sed 치환부 값에서 &, |, \를 이스케이프한다(구분자가 |이고 &는 '일치한 문자열'이라서).
escape_sed() { print -r -- "$1" | sed -e 's/[&|\\]/\\&/g'; }
# plist(XML) 값에서 &, <, >를 이스케이프한다. sed 이스케이프보다 먼저 적용한다.
escape_xml() { print -r -- "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
# 두 단계를 합친 치환 값.
template_value() { escape_sed "$(escape_xml "$1")"; }

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
# 로그에는 매니저 채널 ID가 남으므로 폴더는 700, 파일은 600으로 미리 만든다(launchd가 만들면 644가 된다).
(umask 077; mkdir -p "$LOG_DIR" "$BASE_HOME/Library/LaunchAgents"; touch "$LOG_DIR/server.log" "$LOG_DIR/server.err.log")
chmod 700 "$LOG_DIR"
chmod 600 "$LOG_DIR/server.log" "$LOG_DIR/server.err.log"
sed -e "s|__NODE__|$(template_value "$NODE")|g" -e "s|__ENV_FILE__|$(template_value "$ENV_FILE")|g" \
  -e "s|__REPO__|$(template_value "$ROOT")|g" -e "s|__LOG_DIR__|$(template_value "$LOG_DIR")|g" \
  "$ROOT/ops/launchd/$LABEL.plist.template" > "$PLIST"
# 잘못된 plist를 건 채로 기존 서버를 내리지 않도록, 내리기 전에 문법을 검사한다.
if ! plutil -lint "$PLIST" >/dev/null; then
  echo "만든 plist가 올바르지 않습니다: $PLIST — 경로에 특수 문자가 있는지 확인하세요. 기존 서버는 건드리지 않았습니다." >&2
  exit 1
fi
if [[ "$IS_DRY_RUN" == "1" ]]; then
  echo "시험 실행: plist를 만들고 검사했습니다($PLIST). launchctl은 건드리지 않았습니다."
  exit 0
fi
# 이미 떠 있으면 내린다. 떠 있는지 먼저 확인해, 내리기 실패(권한 등)를 '처음 설치'로 잘못 안내하지 않는다.
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  echo "실행 중이던 서버를 내렸습니다."
else
  echo "실행 중인 서버가 없습니다(처음 설치)."
fi
# bootout 직후에는 작업이 아직 남아 bootstrap이 실패할 수 있어, 한 번 잠시 기다렸다 다시 시도한다.
if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then
  sleep 3
  launchctl bootstrap "$DOMAIN" "$PLIST"
fi
echo "설치했습니다: $PLIST (node: $NODE)"
echo "상태 확인: launchctl print $DOMAIN/$LABEL | grep state"
echo "로그: tail -f \"$LOG_DIR/server.log\""
