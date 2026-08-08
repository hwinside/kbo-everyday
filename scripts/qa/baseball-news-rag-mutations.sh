#!/usr/bin/env bash
# 기사 근거 적재 게이트(qa:baseball-news-rag)의 검출력 증명.
#
# 각 변이는 삼순 P0 지적에 정확히 대응하는 **실제 결함**이다. 게이트가 GREEN 이면 그 게이트는
# 결함을 못 잡는다는 뜻이므로 이 스크립트가 실패한다.
#
# 파일 복원은 백업본 복사로만 한다 — `git checkout --` 은 다른 세션 작업을 날린다(P0).
set -uo pipefail
cd "$(dirname "$0")/../.."

ROUTE="src/app/api/cron/news-clipping/route.ts"
LIB="src/lib/news-clipping.ts"
EMBED="src/app/api/cron/news-rag-embed/route.ts"
INGEST="src/lib/baseball-qa/rag/news-ingest.ts"
MIGRATION="supabase/migrations/20260805180000_baseball_genius_news_articles.sql"
BACKFILL="src/app/api/cron/news-rag-backfill/route.ts"
VERCEL="vercel.json"
# ⚠️ 변이가 건드리는 파일은 **반드시** 이 배열에 있어야 한다. 빠지면 복원이 안 돼
# 변이가 워킹트리에 그대로 남는다(M19 실측 — naver-news.ts 누락으로 res.ok 가 사라졌다).
NAVER="src/lib/naver-news.ts"
OUTCOME="src/lib/baseball-qa/rag/news-backfill-outcome.ts"
FILES=("$ROUTE" "$LIB" "$EMBED" "$INGEST" "$MIGRATION" "$BACKFILL" "$VERCEL" "$NAVER" "$OUTCOME")

BACKUP=$(mktemp -d)
trap 'for f in "${FILES[@]}"; do cp "$BACKUP/$(echo "$f" | tr / _)" "$f"; done; rm -rf "$BACKUP"' EXIT
for f in "${FILES[@]}"; do cp "$f" "$BACKUP/$(echo "$f" | tr / _)"; done

restore() { for f in "${FILES[@]}"; do cp "$BACKUP/$(echo "$f" | tr / _)" "$f"; done; }

# 복원 누락 감지 — 변이가 손대는 모든 파일이 백업 목록에 있는지 sha256 로 확인한다.
snapshot_hashes() { for f in "${FILES[@]}"; do shasum -a 256 "$f"; done; }
BASELINE_HASHES=$(snapshot_hashes)

FAILED=0
run_mutation() {
  local label="$1"; shift
  restore
  if ! "$@"; then
    echo "SKIP(patch failed) $label"
    FAILED=1
    restore
    return
  fi
  if npm run --silent qa:baseball-news-rag >/dev/null 2>&1; then
    echo "GREEN(검출 실패) $label"
    FAILED=1
  else
    echo "RED $label"
  fi
  restore
}

# M1 — sink 를 사진/타팀 필터 뒤로 옮긴다. 종합기사가 근거에서 빠지는 실제 결함이며,
#      기존 게이트는 hasClippingTitleSignal 하나만 봐서 이걸 GREEN 으로 통과시켰다.
m1() {
  python3 - "$LIB" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
start=s.index("  // 야잘알봇 RAG 적재 분기")
end=s.index("  const seen = new Set<string>();")
block=s[start:end]
anchor="    if (isOtherTeamTitle(item.title, teamShort)) return false;\n"
assert anchor in s
s=s[:start]+s[end:]
s=s.replace(anchor, anchor+"\n"+block, 1)
open(p,'w').write(s)
PY
}

# M2 — 적재를 발송 앞으로 되돌린다(삼순 P0: 발송 경로 보호).
m2() {
  python3 - "$ROUTE" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
start=s.index("  // 3) 야잘알봇 근거 적재")
end=s.index("  return NextResponse.json({ ok: true, clipDate, results, ragIngest: ingested });")
block=s[start:end]
s=s[:start]+s[end:]
anchor="  // 2) 발송 — 팀별 전용 클리퍼 계정에서"
assert anchor in s
s=s.replace(anchor, block+anchor, 1)
open(p,'w').write(s)
PY
}

# M3 — 적재 실패를 rethrow. 호출측이 try 를 안 감쌌으므로 발송 route 가 통째로 죽는다.
m3() {
  python3 - "$INGEST" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
old='      console.error("[news-rag-ingest] upsert failed:", message);'
new='      console.error("[news-rag-ingest] upsert failed:", message);\n      throw e;'
assert old in s
open(p,'w').write(s.replace(old,new,1))
PY
}

# M4 — 예산 체크 제거. 적재가 무한정 매달려도 멈추지 않는다.
m4() {
  python3 - "$INGEST" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
old="    if (now() >= deadline) {"
new="    if (false && now() >= deadline) {"
assert old in s
open(p,'w').write(s.replace(old,new,1))
PY
}

# M5 — team_ids 를 합집합 대신 덮어쓴다(삼순 P0: 한쪽 팀 근거 소실).
m5() {
  python3 - "$MIGRATION" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
old="""      team_ids = (
        SELECT array_agg(DISTINCT t ORDER BY t)
        FROM unnest(target.team_ids || EXCLUDED.team_ids) AS t
      ),"""
new="      team_ids = EXCLUDED.team_ids,"
assert old in s
open(p,'w').write(s.replace(old,new,1))
PY
}

# M6 — 임베딩 write 의 content_hash CAS 제거(삼순 P0: 새 본문에 옛 벡터).
m6() {
  python3 - "$EMBED" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
old='      .eq("content_hash", row.content_hash)\n'
assert old in s
open(p,'w').write(s.replace(old,"",1))
PY
}

# M7 — 수집 실패·API미도달을 전부 ok 로 기록. "그날 기사 0건" 과 구분이 사라진다.
m7() {
  python3 - "$INGEST" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old='''      status: collection.error
        ? "collect_failed"
        : collection.apiUnreached
          ? "api_unreached"
          : "ok",'''
new='      status: "ok",'
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# M7b — API미도달만 ok 로 접어붙인다. "못 가져온 날짜" 가 "근거 없는 날짜" 로 둔갑한다.
m7b() {
  python3 - "$INGEST" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old='''        : collection.apiUnreached
          ? "api_unreached"
          : "ok",'''
new='        : "ok",'
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# M7c — 증명 컬럼(reached_api_limit/oldest_reached/queries_used)을 DB 에 안 남긴다.
#       응답 JSON 에만 있으면 실행이 끝나는 순간 "N일 범위 확보" 를 증명할 수 없다.
m7c() {
  python3 - "$INGEST" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old='''      reached_api_limit: collection.reachedApiLimit ?? false,
      oldest_reached: collection.oldestReached ?? null,
      queries_used: collection.queriesUsed ?? 0,'''
new='''      reached_api_limit: false,
      oldest_reached: null,
      queries_used: 0,'''
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# M8 — 배치 내 중복 article_key 병합 제거. ON CONFLICT 가 배치 전체를 죽인다.
m8() {
  python3 - "$MIGRATION" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
old="    SELECT DISTINCT ON (i.article_key)"
new="    SELECT"
assert old in s
open(p,'w').write(s.replace(old,new,1))
PY
}

# M9 — 본문 변경 시 임베딩 무효화 제거. 바뀐 본문에 옛 벡터가 남는다.
m9() {
  python3 - "$MIGRATION" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
old="""      embedding = CASE
        WHEN target.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN NULL
        ELSE target.embedding END,"""
new="      embedding = target.embedding,"
assert old in s
open(p,'w').write(s.replace(old,new,1))
PY
}

# M10 — 커버리지 원장 write 자체를 제거.
m10() {
  python3 - "$INGEST" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
old="  if (coverage.length > 0) {"
new="  if (false && coverage.length > 0) {"
assert old in s
open(p,'w').write(s.replace(old,new,1))
PY
}

# M11 — 배치 상한 제거. 한 번의 실수로 트랜잭션이 무한정 커진다.
m11() {
  python3 - "$MIGRATION" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
old="""  IF v_count > 500 THEN
    RAISE EXCEPTION 'batch too large: % (max 500)', v_count;
  END IF;"""
assert old in s
open(p,'w').write(s.replace(old,"",1))
PY
}

# M12 — 페이지 상한 절단 신호를 항상 false 로. 근거 누락을 사후에 알 수 없다.
m12() {
  python3 - "$LIB" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
old='    onRawCandidates(teamId, raw, { truncated, pagesFetched: pages.length });'
new='    onRawCandidates(teamId, raw, { truncated: false, pagesFetched: pages.length });'
assert old in s
open(p,'w').write(s.replace(old,new,1))
PY
}

# M13 — 백필이 발송 빌더를 재사용한다. 백필 1회로 과거 날짜 쪽지가 유저에게 쏟아진다.
m13() {
  python3 - "$BACKFILL" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old='import { collectBackfillCandidates, kstDateString } from "@/lib/news-clipping";'
new='import { collectBackfillCandidates, kstDateString, buildTeamClipping } from "@/lib/news-clipping";'
assert old in s
s=s.replace(old,new,1)
old2='      const result = await collectBackfillCandidates('
new2='      await buildTeamClipping(team.id, team.shortName, team.name);\n      const result = await collectBackfillCandidates('
assert old2 in s
open(p,'w').write(s.replace(old2,new2,1))
PYEOF
}

# M14 — 백필을 cron 에 등록한다. 매일 팀당 1,000건을 재수집해 네이버 호출만 태운다.
m14() {
  python3 - "$VERCEL" <<'PYEOF'
import sys, json
p=sys.argv[1]; d=json.load(open(p))
d.setdefault("crons",[]).append({"path":"/api/cron/news-rag-backfill","schedule":"0 5 * * *"})
json.dump(d,open(p,'w'),ensure_ascii=False,indent=2)
open(p,'a').write("\n")
PYEOF
}

# M15 — 커버리지를 팀 단위로 되돌린다. 백필의 날짜별 근거량이 한 행으로 뭉개진다.
m15() {
  python3 - "$INGEST" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old="      clip_date: rowDate,"
new="      clip_date: clipDate,"
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# M16 — API 깊이 한계 신호를 죽인다. 창을 못 덮었는데 덮은 것처럼 보인다.
m16() {
  python3 - "$LIB" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old="    reachedApiLimit: !covered,"
new="    reachedApiLimit: false,"
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# M17 — fan-out 자체를 없앨다(broad 쿼리 하나만). LG 같은 팀은 14일에 절대 못 닿는다.
m17() {
  python3 - "$LIB" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old='  const queries = [`\ud504\ub85c\uc57c\uad6c ${fullName}`, ...BACKFILL_FANOUT_SUFFIXES.map((s) => `${fullName} ${s}`)];'
new='  const queries = [`\ud504\ub85c\uc57c\uad6c ${fullName}`];'
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# M18 — 창을 덮었는데도 fan-out 쿼리를 계속 돌린다. 네이버 호출을 낭비한다.
m18() {
  python3 - "$LIB" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old='''    if (result.coveredWindow) {
      covered = true;
      break; // \ucc3d\uc744 \ub36e\uc5c8\uc73c\uba74 \ub0a8\uc740 fan-out \ucffc\ub9ac\ub294 \ud638\ucd9c\ud558\uc9c0 \uc54a\ub294\ub2e4.
    }'''
new='''    if (result.coveredWindow) {
      covered = true;
    }'''
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# M19 — 네이버 HTTP 실패를 사럼삼킨다(res.ok 제거). 429/500 이 "그날 기사 0건" 으로 위장된다.
m19() {
  python3 - "$NAVER" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old='''  if (!res.ok) {
    throw new NaverNewsError(`naver search http ${res.status}`, "http", res.status);
  }'''
assert old in s
open(p,'w').write(s.replace(old,"",1))
PYEOF
}

# M20 — RPC hard timeout 제거. 멈췄 RPC 가 route 를 maxDuration 까지 끌고 간다.
m20() {
  python3 - "$INGEST" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
import re
old = re.search(r'    return await Promise\.race\(\[.*?\n    \]\);\n', s, re.S)
assert old, "Promise.race block not found"
new='''    // query-guard: bounded -- both callees are allowlisted bounded RPCs
    return await client.rpc(fn, { p_rows: rows });
'''
open(p,'w').write(s[:old.start()] + new + s[old.end():])
PYEOF
}

# M21 — raw sink 가 야구 관련성 가드를 건너뛴다. 여자골프 기사가 RAG 근거로 들어간다.
m21() {
  python3 - "$LIB" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old='      return isTeamBaseballRelevant(item.title, item.description, mascot);'
new='      return true;'
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# M23 — 호출 간격 게이트를 제거. 동시 호출이 몰려 초당 제한(429)에 걸린다 — 2026-08-07 실측.
m23() {
  python3 - "$NAVER" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old="    await acquireNaverSlot();"
new="    // gate removed"
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# M24 — 429 재시도를 제거. 일시적 초당 제한 한 번에 그 팀 수집이 통째로 죽는다.
m24() {
  python3 - "$NAVER" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old="    if (res.status === 429 && attempt < NAVER_RATE_LIMIT_RETRIES) {"
new="    if (false) {"
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# M25 — 백필을 다시 병렬화. 실측에서 동시성 3은 첫 팀부터 429 였다.
m25() {
  python3 - "$BACKFILL" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old="const TEAM_CONCURRENCY = 1;"
new="const TEAM_CONCURRENCY = 3;"
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# M26 — 백필 scanQuery 에서 relevance 가드를 제거. 여자골프·증시 기사가 원장에 들어간다.
#       일일 sink 만 고치고 백필을 놓치던 실제 결함(삼순 NO-GO).
m26() {
  python3 - "$LIB" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old='      if (!isTeamBaseballRelevant(item.title, item.description, mascot)) continue;'
assert old in s
open(p,'w').write(s.replace(old,"",1))
PYEOF
}

# M27 — 페이지 종료 판정을 필터 후 개수로 되돌린다. 비네이버 1건 탈락에 과거를 통째로 놓친다.
m27() {
  python3 - "$LIB" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old="    if (rawCount < 100) break;"
new="    if (items.length < 100) break;"
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# M28 — 관측 날짜 추적을 제거. sparse fan-out 이 건너뛴 날짜가 'ok/0건' 으로 위장된다.
m28() {
  python3 - "$LIB" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old="      observedDays.add(day);"
assert old in s
open(p,'w').write(s.replace(old,"",1))
PYEOF
}

# M29 — 200 `{}` 를 빈 성공으로 되돌린다. 게이트웨이 응답이 "그날 기사 0건" 으로 둔갑한다.
m29() {
  python3 - "$NAVER" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old="  if (!Array.isArray(data.items)) {"
new="  if (data.items !== undefined && !Array.isArray(data.items)) {"
assert old in s
s=s.replace(old,new,1)
old2="  const raw = data.items as NaverNewsRawItem[];"
new2="  const raw = (data.items as NaverNewsRawItem[]) || [];"
assert old2 in s
open(p,'w').write(s.replace(old2,new2,1))
PYEOF
}

# M30 — RPC 타임아웃을 일반 실패로 접는다. 재시도가 필요한 상태인지 원장으로 모른다.
m30() {
  python3 - "$INGEST" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old="      const timedOut = e instanceof NewsRpcTimeoutError;"
new="      const timedOut = false;"
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# ⚠️ M31(팀 시작 전 deadline 검사 제거)는 **등가변이**가 되어 삭제했다.
#    페이지 루프 안(M32)에 같은 예산 검사가 들어가면서, 팀 시작 전 검사는 순수 최적화가 됐다.
#    지워도 첫 페이지에서 즉시 걸리므로 관측 가능한 행동 차이가 없다 — 검출 실패가 아니라
#    "검출할 것이 없음"이다. 실제 방어는 M32 가 증명한다.
m31_removed() {
  python3 - "$BACKFILL" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old="    if (Date.now() >= collectDeadline) {"
new="    if (false) {"
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# M32 — deadline 을 페이지 루프에서 빼고 팀 시작 전에만 남긴다.
#       한 팀이 일단 들어가면 7쿼리×10페이지를 끝까지 돌아 route maxDuration 을 넘긴다.
#       (정규식 검사만 하던 앞판 M31 은 이 결함을 통과시켰다 — 삼순 NO-GO)
m32() {
  python3 - "$LIB" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old='    if (Date.now() >= deadlineAt) return { pages, coveredWindow, oldest, deadlineHit: true };'
assert old in s
open(p,'w').write(s.replace(old,"",1))
PYEOF
}

# M33 — 회차 판정에서 collect_failed 칸을 무시한다(apiUnreached 만 셈).
#       수집이 통째로 실패한 팀이 있어도 ok:true + range_covered 가 나온다.
m33() {
  python3 - "$OUTCOME" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old='  const failedCells = cells.filter((c) => c.error).length;'
new='  const failedCells = 0;'
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# M34 — 적재 실패(행 실패/예산초과/커버리지 미기록)를 성공 판정에서 뺀다.
m34() {
  python3 - "$OUTCOME" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old='''  const ingestFailed =
    ingest.failedRows > 0 || ingest.timedOut || ingest.coverageWritten < cells.length;'''
new='  const ingestFailed = false;'
assert old in s
open(p,'w').write(s.replace(old,new,1))
PYEOF
}

# M35 — route 가 공용 판정을 버리고 상시 성공으로 응답한다(게이트-실물 판정 분기).
m35() {
  python3 - "$BACKFILL" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old="    ok: coverage.ok,"
new="    ok: true,"
assert old in s
s=s.replace(old,new,1)
old2="  }, { status: coverage.ok ? 200 : 207 });"
new2="  }, { status: 200 });"
assert old2 in s
open(p,'w').write(s.replace(old2,new2,1))
PYEOF
}

# M36 — deadlineHit 을 칸(error)에 안 박고 팀 리포트에만 남긴다.
#       회차 판정은 collections 만 보므로, 예산에 끓긴 부분 수집이 range_covered 로 나간다.
m36() {
  python3 - "$OUTCOME" <<'PY36'
import sys
p=sys.argv[1]; s=open(p).read()
old = """  const partial = result.deadlineHit
    ? (deadlineDetail?.trim() || DEFAULT_BACKFILL_DEADLINE_DETAIL)
    : undefined;"""
new = "  const partial = undefined;"
assert old in s, "M36 anchor not found"
open(p,'w').write(s.replace(old,new,1))
PY36
}

# M37 — route 가 빈 deadlineDetail 을 넘긴다(결속은 살아있지만 마커가 falsy → 판정에서 사라짐).
# M37 — 빈/공백 사유 문구에 대한 fail-close 를 제거해, 사유 텍스트가 결속 마커를 겸하게 만든다.
#       호출측이 빈 문구를 넘기면 부분 수집이 조용히 완주(range_covered)로 위장된다.
#       ⚠️ 첫 판(route 가 빈 문구 전달)은 GREEN 이었다 — 게이트가 자기 문구만 태워서
#          route 의 빈 값을 못 봤다. 그래서 방어를 함수 안으로 옮기고 변이도 그쪽을 찌른다.
m37() {
  python3 - "$OUTCOME" <<'PY37'
import sys
p=sys.argv[1]; s=open(p).read()
old = """  const partial = result.deadlineHit
    ? (deadlineDetail?.trim() || DEFAULT_BACKFILL_DEADLINE_DETAIL)
    : undefined;"""
new = "  const partial = result.deadlineHit ? deadlineDetail : undefined;"
assert old in s, "M37 anchor not found"
open(p,'w').write(s.replace(old,new,1))
PY37
}

# M38 — coveredCells 를 차감식으로 되돌린다. error 와 apiUnreached 가 겹치면 두 번 빼서
#       음수(-13 실측)가 나온다. ok/label 만 보는 게이트는 이걸 통과시킨다(삼순 NO-GO).
m38() {
  python3 - "$OUTCOME" <<'PY38'
import sys
p=sys.argv[1]; s=open(p).read()
old = "  const coveredCells = cells.filter((c) => !c.apiUnreached && !c.error).length;"
new = "  const coveredCells = cells.length - unobservedCells - failedCells;"
assert old in s, "M38 anchor not found"
open(p,'w').write(s.replace(old,new,1))
PY38
}

# M22 — 서빙 뷰 ACL 차단을 제거. security-definer 뷰라 RLS 를 우회해 유저가 직접 읽는다.
m22() {
  python3 - "$MIGRATION" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p).read()
old='''REVOKE ALL ON public.genius_news_serving_articles FROM PUBLIC;
REVOKE ALL ON public.genius_news_serving_articles FROM anon, authenticated;
GRANT SELECT ON public.genius_news_serving_articles TO service_role;'''
assert old in s
open(p,'w').write(s.replace(old,"",1))
PYEOF
}

echo "=== baseball-news-rag mutation RED 증명 ==="
run_mutation "M1  sink 를 사진/타팀 필터 뒤로 이동 (종합기사 근거 소실)" m1
run_mutation "M2  적재를 발송 앞으로 이동 (발송 지연/차단)" m2
run_mutation "M3  적재 실패 rethrow (발송 route 사망)" m3
run_mutation "M4  예산 체크 제거 (무한 지연)" m4
run_mutation "M5  team_ids 덮어쓰기 (한쪽 팀 근거 소실)" m5
run_mutation "M6  임베딩 CAS 제거 (새 본문에 옛 벡터)" m6
run_mutation "M7  수집 실패를 ok 로 기록 (0건과 혼동)" m7
run_mutation "M8  배치 내 중복 병합 제거 (배치 전체 실패)" m8
run_mutation "M9  본문 변경 시 임베딩 무효화 제거" m9
run_mutation "M10 커버리지 원장 write 제거" m10
run_mutation "M11 배치 상한 제거" m11
run_mutation "M12 페이지 절단 신호 상시 false" m12
run_mutation "M13 백필이 발송 빌더 재사용 (과거 쪽지 발송)" m13
run_mutation "M14 백필을 cron 에 등록 (매일 전량 재수집)" m14
run_mutation "M15 커버리지를 팀 단위로 축소 (날짜별 근거량 소실)" m15
run_mutation "M16 API 깊이 한계 신호 제거 (미커버를 커버로 오인)" m16
run_mutation "M7b API미도달을 ok 로 접음 (못가져온 날짜↔근거없는 날짜)" m7b
run_mutation "M7c 증명 컬럼 DB 미보존 (범위 확보 증명 불가)" m7c
run_mutation "M17 fan-out 제거 (LG 14일 미도달)" m17
run_mutation "M18 창 덮은 뒤에도 fan-out 계속 (호출 낭비)" m18
run_mutation "M19 네이버 res.ok 제거 (429/500을 0건으로 위장)" m19
run_mutation "M20 RPC hard timeout 제거 (멈췄 RPC 가 route 를 끌고감)" m20
run_mutation "M21 sink 가 야구 관련성 가드 우회 (여자골프 근거 오염)" m21
run_mutation "M22 서빙 뷰 ACL 차단 제거 (RLS 우회 직접 조회)" m22
run_mutation "M23 호출 간격 게이트 제거 (429로 부분 수집)" m23
run_mutation "M24 429 재시도 제거 (일시 제한에 수집 전멸)" m24
run_mutation "M25 백필 팀 병렬화 (동시성 3 = 첫 팀부터 429)" m25
run_mutation "M26 백필 relevance 가드 제거 (백필 경로 근거 오염)" m26
run_mutation "M27 페이지 종료를 필터후 개수로 (비네이버 1건에 조기종료)" m27
run_mutation "M28 관측날짜 추적 제거 (미관측을 0건으로 위장)" m28
run_mutation "M29 200 빈바디를 빈 성공으로 (게이트웨이 응답→0건)" m29
run_mutation "M30 RPC 타임아웃을 일반실패로 접음" m30
run_mutation "M32 deadline 을 팀 시작 전에만 (한 팀이 route 를 잡아먹음)" m32
run_mutation "M33 판정이 collect_failed 무시 (실패해도 range_covered)" m33
run_mutation "M34 판정이 적재실패 무시 (미적재를 성공으로)" m34
run_mutation "M35 route 가 판정 무시하고 상시 ok:true" m35
run_mutation "M36 deadlineHit 을 칸에 미결속 (부분수집→range_covered)" m36
run_mutation "M37 route 가 빈 deadlineDetail 전달 (마커 falsy)" m37
run_mutation "M38 coveredCells 차감식 (겹친 칸 이중차감→음수)" m38

# 원본 복원 상태에서 게이트가 다시 GREEN 인지 확인 — 복원 누락으로 인한 오판 방지.
restore
# 해시 대조 — 게이트 GREEN 만 보면 "복원된 것처럼" 보이는 잔존 변이를 놓친다.
if [ "$(snapshot_hashes)" != "$BASELINE_HASHES" ]; then
  echo "RESTORE-FAIL 파일 해시가 초기값과 다르다 — 변이가 워킹트리에 남았다"
  diff <(echo "$BASELINE_HASHES") <(snapshot_hashes) || true
  FAILED=1
fi
if npm run --silent qa:baseball-news-rag >/dev/null 2>&1; then
  echo "RESTORE-OK 원본 복원 후 게이트 GREEN"
else
  echo "RESTORE-FAIL 원본 복원 후에도 게이트가 RED — 복원이 깨졌다"
  FAILED=1
fi

exit "$FAILED"
