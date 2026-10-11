#!/bin/zsh
# 토큰 암호화 키를 로그인 키체인에 한 번 만든다. 이미 있으면 아무것도 하지 않는다.
# 사용법: ops/scripts/setup-keychain.sh [서비스이름(기본 zzirit-guard)]
set -euo pipefail
SERVICE=${1:-zzirit-guard}
ACCOUNT=token-encryption-key
if /usr/bin/security find-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1; then
  echo "이미 키가 있습니다: $SERVICE/$ACCOUNT (지우면 저장된 토큰을 읽을 수 없게 됩니다)"
  exit 0
fi
KEY=$(/usr/bin/openssl rand -hex 32)
/usr/bin/security add-generic-password -s "$SERVICE" -a "$ACCOUNT" -w "$KEY"
echo "키체인에 암호화 키를 만들었습니다: $SERVICE/$ACCOUNT"
