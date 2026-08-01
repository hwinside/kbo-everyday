#!/usr/bin/env bash
# player_game_log_ingestions 행 수를 fail-closed 로 조회한다.
#
# 왜 스크립트로 뺐나:
#   워크플로 인라인 `curl -s ... | grep content-range | sed 's|.*/||'` 은
#   ① HTTP 500 이어도 exit 0 ② Content-Range 헤더가 없어도 exit 0 이고
#   결과가 빈 문자열("")이 된다. before/after 두 step 이 함께 빈 값이 되면
#   dry-run 가드의 `before == after` 비교가 ""=="" 로 통과해 버린다(삼순 P0).
#   그래서 HTTP 코드·헤더 존재·숫자 형식을 전부 강제하고, 하나라도 어긋나면 exit 1.
#
# usage: ledger-count.sh <label>
#   env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
#   stdout: 숫자만 (호출측에서 $GITHUB_OUTPUT 에 기록)
set -euo pipefail

LABEL="${1:-ledger}"

: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required}"

HDR_FILE=$(mktemp)
trap 'rm -f "$HDR_FILE"' EXIT

CURL_RC=0
HTTP_CODE=$(curl -sS --fail-with-body \
  "$SUPABASE_URL/rest/v1/player_game_log_ingestions?select=game_id" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Prefer: count=exact" -H "Range: 0-0" \
  -D "$HDR_FILE" -o /dev/null -w '%{http_code}') || CURL_RC=$?

if [ "$CURL_RC" -ne 0 ]; then
  echo "::error::[$LABEL] ledger count request failed (curl exit $CURL_RC, http ${HTTP_CODE:-unknown})" >&2
  exit 1
fi

# --fail-with-body 가 4xx/5xx 를 잡지만, 성공 코드 화이트리스트로 한 번 더 좁힌다.
case "$HTTP_CODE" in
  200|206) ;;
  *)
    echo "::error::[$LABEL] unexpected HTTP status '$HTTP_CODE' from ledger count endpoint" >&2
    exit 1
    ;;
esac

RANGE=$(grep -i '^content-range:' "$HDR_FILE" | tr -d '\r' | tail -1 || true)
if [ -z "$RANGE" ]; then
  echo "::error::[$LABEL] Content-Range header missing — cannot determine ledger count" >&2
  exit 1
fi

COUNT="${RANGE##*/}"
if ! printf '%s' "$COUNT" | grep -Eq '^[0-9]+$'; then
  echo "::error::[$LABEL] ledger count is not a number (Content-Range: '$RANGE')" >&2
  exit 1
fi

printf '%s\n' "$COUNT"
