#!/bin/zsh
# 토큰 암호화 키를 키체인에 한 번 만든다. 이미 있으면 아무것도 하지 않는다.
# 키는 zsh 내장 printf로 `security -i`의 표준 입력에만 넘기므로 어떤 프로세스의 argv(ps 출력)에도 나타나지 않는다.
# 명령이 성공해도 exit 코드가 믿을 수 없어(잘못된 키체인 경로도 0을 반환함) 항목 존재를 다시 확인한다.
#
# 사용법: ops/scripts/setup-keychain.sh [서비스이름(기본 zzirit-guard)]
# 환경 변수 ZG_KEYCHAIN_PATH: 지정하면 그 키체인 파일에 만든다(검증용). 비우면 로그인 키체인을 쓴다.
#   경로에 공백이 없어야 한다(security -i 명령 줄이 공백으로 나뉜다).
set -euo pipefail
SERVICE=${1:-zzirit-guard}
ACCOUNT=token-encryption-key
KEYCHAIN_PATH=${ZG_KEYCHAIN_PATH:-}

if /usr/bin/security find-generic-password -s "$SERVICE" -a "$ACCOUNT" ${KEYCHAIN_PATH:+"$KEYCHAIN_PATH"} >/dev/null 2>&1; then
  echo "이미 키가 있습니다: $SERVICE/$ACCOUNT (지우면 저장된 토큰을 읽을 수 없게 됩니다)"
  exit 0
fi

KEY=$(/usr/bin/openssl rand -hex 32)
ADD_COMMAND="add-generic-password -s $SERVICE -a $ACCOUNT -w $KEY"
if [[ -n $KEYCHAIN_PATH ]]; then
  ADD_COMMAND="$ADD_COMMAND $KEYCHAIN_PATH"
fi
# printf는 zsh 내장이라 KEY가 외부 프로세스 인자로 나가지 않는다.
if ! printf '%s\n' "$ADD_COMMAND" | /usr/bin/security -i >/dev/null; then
  echo "키체인 항목 추가 명령이 실패했습니다. 키체인 잠금 상태와 ZG_KEYCHAIN_PATH를 확인하세요." >&2
fi

if ! /usr/bin/security find-generic-password -s "$SERVICE" -a "$ACCOUNT" ${KEYCHAIN_PATH:+"$KEYCHAIN_PATH"} >/dev/null 2>&1; then
  echo "키체인에 $SERVICE/$ACCOUNT 항목이 없습니다. 위 오류를 확인한 뒤 다시 실행하세요." >&2
  exit 1
fi
echo "키체인에 암호화 키를 만들었습니다: $SERVICE/$ACCOUNT"
