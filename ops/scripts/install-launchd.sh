#!/bin/zsh
# 서버를 로그인 사용자 LaunchAgent로 설치(또는 갱신)하고 시작한다.
# 사용법: ops/scripts/install-launchd.sh
# Node를 업그레이드하면(경로가 바뀌므로) 다시 실행한다.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LABEL=com.zzirit-guard.server
DOMAIN="gui/$(id -u)"
DATA_DIR="$HOME/Library/Application Support/zzirit-guard"
ENV_FILE="$DATA_DIR/.env"
LOG_DIR="$HOME/Library/Logs/zzirit-guard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# command -v는 못 찾으면 1을 돌려 set -e가 이유 없이 끝내므로, 빈 값으로 받고 직접 안내한다.
NODE=$(command -v node || true)
if [[ -z "$NODE" ]]; then
  echo "node를 찾을 수 없습니다. Node.js 22.12 이상을 설치하고 이 터미널의 PATH에서 node가 보이게 한 뒤 다시 실행하세요." >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "환경 파일이 없습니다: $ENV_FILE — ops/env.example을 복사해 채운 뒤 chmod 600 하세요." >&2
  exit 1
fi
if [[ ! -f "$ROOT/apps/server/dist/main.js" ]]; then
  echo "서버 빌드가 없습니다. 먼저 npm run build -w @zzirit-guard/server 를 실행하세요." >&2
  exit 1
fi
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE|g" -e "s|__ENV_FILE__|$ENV_FILE|g" -e "s|__REPO__|$ROOT|g" -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$ROOT/ops/launchd/$LABEL.plist.template" > "$PLIST"
# 이미 떠 있으면 내린다. 떠 있는지 먼저 확인해, 내리기 실패(권한 등)를 '처음 설치'로 잘못 안내하지 않는다.
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  echo "실행 중이던 서버를 내렸습니다."
else
  echo "실행 중인 서버가 없습니다(처음 설치)."
fi
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "설치했습니다: $PLIST (node: $NODE)"
echo "상태 확인: launchctl print $DOMAIN/$LABEL | grep state"
echo "로그: tail -f \"$LOG_DIR/server.log\""
