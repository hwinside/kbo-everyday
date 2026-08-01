#!/usr/bin/env bash
# scripts/ci/ledger-count.sh 회귀 — fail-closed 계약 검증.
#
# 배경(삼순 P0): 기존 워크플로 인라인
#   `curl -s ... -D - -o /dev/null | grep content-range | sed 's|.*/||'`
# 는 HTTP 500 이든 Content-Range 헤더 누락이든 **exit 0 + 빈 문자열("")** 을 뱉었다.
# before/after 두 step 이 함께 "" 가 되면 dry-run 가드의 `before == after` 가
# ""=="" 로 통과해 "DB write 0" 을 거짓 증명한다(false-green).
#
# 로컬 stub 서버로 고정하는 계약:
#   GREEN 정상 206 + `Content-Range: 0-0/15` → exit 0, stdout "15"
#   RED   HTTP 500                          → exit 1, 숫자 미산출
#   RED   Content-Range 헤더 누락            → exit 1
#   RED   Content-Range 값 비숫자(0-0/*)     → exit 1
#   재현  레거시 인라인 파이프라인은 위 RED 3케이스에서 exit 0 + ""
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../ci/ledger-count.sh"
PORT="${LEDGER_COUNT_SMOKE_PORT:-8793}"
PASS=0
FAIL=0

ok()  { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

python3 - "$PORT" <<'PY' &
import http.server, socketserver, sys
PORT = int(sys.argv[1])

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        p = self.path
        if p.startswith('/500'):
            self.send_response(500); self.end_headers()
            self.wfile.write(b'{"message":"boom"}'); return
        if p.startswith('/nohdr'):
            # 200 인데 Content-Range 가 없는 케이스
            self.send_response(200); self.end_headers()
            self.wfile.write(b'[]'); return
        if p.startswith('/nan'):
            self.send_response(206)
            self.send_header('Content-Range', '0-0/*'); self.end_headers()
            self.wfile.write(b'[]'); return
        self.send_response(206)
        self.send_header('Content-Range', '0-0/15'); self.end_headers()
        self.wfile.write(b'[]')

    def log_message(self, *a):
        pass

socketserver.TCPServer.allow_reuse_address = True
socketserver.TCPServer(("127.0.0.1", PORT), H).serve_forever()
PY
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null' EXIT

for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && break
  sleep 0.1
done

# 실제 워크플로가 호출하는 그대로 (SUPABASE_URL 프리픽스만 바꿔 케이스 분기)
run_script() {
  SUPABASE_URL="http://127.0.0.1:$PORT$1" \
  SUPABASE_SERVICE_ROLE_KEY="stub-key" \
    bash "$SCRIPT" smoke 2>/dev/null
}

# 수정 전 워크플로 인라인과 동일한 파이프라인.
# ⚠️ 이 스모크 자체가 `set -o pipefail` 로 돌아가므로, 원본 재현을 위해
#   GHA 기본 셸(`bash -e {0}`, pipefail 없음)과 동일한 환경에서 돌린다.
run_legacy() {
  bash -e -c '
    curl -s "http://127.0.0.1:'"$PORT$1"'/rest/v1/player_game_log_ingestions?select=game_id" \
      -H "Prefer: count=exact" -H "Range: 0-0" -D - -o /dev/null \
      | grep -i "^content-range:" | tr -d "\r" | sed "s|.*/||"
  '
}

echo "[ledger-count guard] fail-closed 계약"

# 1) GREEN — 정상 응답
OUT=$(run_script ""); RC=$?
if [ "$RC" -eq 0 ] && [ "$OUT" = "15" ]; then
  ok "정상 206 → exit 0, count=15"
else
  bad "정상 206: 기대 exit0/15, got exit$RC/'$OUT'"
fi

# 2) RED — HTTP 500
OUT=$(run_script "/500"); RC=$?
if [ "$RC" -ne 0 ] && [ -z "$OUT" ]; then
  ok "HTTP 500 → exit $RC, 숫자 미산출 (fail-closed)"
else
  bad "HTTP 500: 기대 exit≠0/빈값, got exit$RC/'$OUT'"
fi

# 3) RED — Content-Range 헤더 누락
OUT=$(run_script "/nohdr"); RC=$?
if [ "$RC" -ne 0 ] && [ -z "$OUT" ]; then
  ok "Content-Range 누락 → exit $RC, 숫자 미산출"
else
  bad "Content-Range 누락: 기대 exit≠0/빈값, got exit$RC/'$OUT'"
fi

# 4) RED — Content-Range 값이 비숫자
OUT=$(run_script "/nan"); RC=$?
if [ "$RC" -ne 0 ] && [ -z "$OUT" ]; then
  ok "비숫자 Content-Range(0-0/*) → exit $RC, 숫자 미산출"
else
  bad "비숫자 Content-Range: 기대 exit≠0/빈값, got exit$RC/'$OUT'"
fi

# 5) 레거시 인라인 경로가 실제로 false-green 이었음을 재현
for CASE in 500 nohdr nan; do
  LOUT=$(run_legacy "/$CASE"); LRC=$?
  case "$CASE" in
    nan) EXPECT_EMPTY=0 ;;   # 0-0/* 는 '*' 를 그대로 뱉는다 (숫자 아님)
    *)   EXPECT_EMPTY=1 ;;
  esac
  if [ "$LRC" -eq 0 ]; then
    if [ "$EXPECT_EMPTY" -eq 1 ] && [ -z "$LOUT" ]; then
      ok "레거시 인라인 /$CASE → exit 0 + 빈 값 (회귀 재현)"
    elif [ "$EXPECT_EMPTY" -eq 0 ] && ! printf '%s' "$LOUT" | grep -Eq '^[0-9]+$'; then
      ok "레거시 인라인 /$CASE → exit 0 + 비숫자 '$LOUT' (회귀 재현)"
    else
      bad "레거시 /$CASE 재현 실패: out='$LOUT'"
    fi
  else
    bad "레거시 /$CASE 가 exit $LRC — 재현 전제 불일치"
  fi
done

# 6) 구 가드(문자열 동등) vs 신 가드(숫자 assert)
B=""; A=""
if [ "$A" = "$B" ]; then
  ok "구 가드: ''=='' 로 통과 (버그 재현)"
else
  bad "구 가드 재현 실패"
fi
if printf '%s' "$B" | grep -Eq '^[0-9]+$'; then
  bad "신 가드가 빈 값을 숫자로 인정"
else
  ok "신 가드: 빈 값 → 숫자 assert 실패 → RED"
fi
if printf '%s' "15" | grep -Eq '^[0-9]+$'; then
  ok "신 가드: 정상 숫자 통과"
else
  bad "신 가드가 정상 숫자를 거부"
fi

echo ""
echo "[ledger-count guard] PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
