#!/usr/bin/env python3
"""advisor ②단계-A migration 생성기 — RLS initplan 67건 (initplan ONLY).

입력(SSOT): scripts/qa/fixtures/rls-policies-baseline-20260813.json
  (production pg_policies 2026-08-13 22:3x KST 기계 추출 — 손으로 만든 fixture 금지)

출력:
  supabase/migrations/20260813_advisor_step2_rls_initplan.sql  (정방향)
  scripts/db/rollback-advisor-step2-rls-initplan.sql           (역방향, chain 밖)

사용:
  python3 generate-advisor-step2-migration.py           # 재생성
  python3 generate-advisor-step2-migration.py --check   # committed 출력과 일치 검증(exit 1 = 불일치)

삼순 1차 NO-GO 반영 (exact ec8131505): 2A 분리 · full fingerprint fail-close · 실행형 rollback
삼순 2차 NO-GO 반영 (exact d422e3d98):
  ① forward: policy 부재 CONTINUE 제거 — table 부재만 clean-chain skip, 테이블이 있는데
     정책이 없으면 EXCEPTION (부분 성공 차단).
  ② rollback: 무가드 ALTER → 단일 원자 DO 블록 + post-migration full fingerprint
     선검증(래핑 unwrap 후 baseline과 비교) + missing/drift 전건 EXCEPTION.
  ③ --check 모드: 정방향/rollback committed 출력이 생성기 재실행 결과와 byte 일치하는지
     검증 — 게이트가 이 모드를 실행해 SSOT를 고정한다.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / "scripts/qa/fixtures/rls-policies-baseline-20260813.json"
OUT_FWD = ROOT / "supabase/migrations/20260813_advisor_step2_rls_initplan.sql"
OUT_RB = ROOT / "scripts/db/rollback-advisor-step2-rls-initplan.sql"

BARE_AUTH = re.compile(r"(?<![Tt] )auth\.(uid|role|jwt|email)\(\)")
# 래핑된 'SELECT auth.<fn>()' 은 직전이 'T '/'t ' — 그 발생부는 치환하지 않는다


def wrap(expr: str) -> str:
    return BARE_AUTH.sub(lambda m: f"(select auth.{m.group(1)}())", expr)


def has_bare(expr: str) -> bool:
    return bool(BARE_AUTH.search(expr or ""))


def fingerprint(p: dict) -> str:
    raw = "|".join([
        p["cmd"] or "", p["permissive"] or "", p["roles"] or "",
        p["qual"] or "", p["with_check"] or "",
    ])
    return hashlib.md5(raw.encode()).hexdigest()


def dq(s: str, tag: str) -> str:
    assert f"${tag}$" not in s
    return f"${tag}$" + s + f"${tag}$"


policies = json.loads(BASELINE.read_text())
targets = [p for p in policies if has_bare(p["qual"]) or has_bare(p["with_check"])]
assert len(targets) == 67, f"initplan 대상 수 불일치: {len(targets)} (기대 67)"

# ---- 정방향 migration ------------------------------------------------------
L = []
A = L.append
A("-- Supabase advisor 2단계-A — RLS initplan 67건 (initplan ONLY)")
A("-- 2026-08-13 하린아빠 착수 승인 + 삼순 1·2차 NO-GO 반영 (#infra 1786505729.677579)")
A("-- 생성기: scripts/db/generate-advisor-step2-migration.py (수동 편집 금지 — --check로 결속)")
A("-- baseline: scripts/qa/fixtures/rls-policies-baseline-20260813.json (production 기계 추출)")
A("-- rollback: scripts/db/rollback-advisor-step2-rls-initplan.sql (가드형 역방향, chain 밖)")
A("--")
A("-- 가드(fail-closed): full fingerprint(cmd|permissive|roles|qual|check) md5 일치 시에만")
A("-- ALTER. 불일치·정책 부재(테이블 존재) → EXCEPTION. 테이블 부재만 skip (clean chain).")
A("-- 단일 DO 블록 = 원자 적용 (부분 성공 없음).")
A("")
A("SET lock_timeout = '5s';")
A("")
A("DO $mig$")
A("DECLARE r record; cur_fp text;")
A("BEGIN")
A("  FOR r IN SELECT * FROM (VALUES")
vals = []
for i, p in enumerate(targets):
    tbl, pol = p["tablename"], p["policyname"]
    u = dq(wrap(p["qual"]), f"u{i}") if p["qual"] else "NULL"
    c = dq(wrap(p["with_check"]), f"c{i}") if p["with_check"] else "NULL"
    vals.append(f"    ('{tbl}', {dq(pol, f'p{i}')}, '{fingerprint(p)}', {u}, {c})")
A(",\n".join(vals))
A("  ) AS t(tbl, pol, expected_fp, new_using, new_check)")
A("  LOOP")
A("    IF to_regclass('public.' || r.tbl) IS NULL THEN CONTINUE; END IF; -- clean chain: 테이블 자체가 없음")
A("    SELECT md5(coalesce(cmd,'') || '|' || coalesce(permissive,'') || '|' ||")
A("               coalesce(roles::text,'') || '|' || coalesce(qual,'') || '|' || coalesce(with_check,''))")
A("      INTO cur_fp FROM pg_policies")
A("     WHERE schemaname='public' AND tablename=r.tbl AND policyname=r.pol;")
A("    IF cur_fp IS NULL THEN")
A("      RAISE EXCEPTION 'advisor_step2a: policy %.% missing while table exists — refusing (drift)', r.tbl, r.pol;")
A("    END IF;")
A("    IF cur_fp <> r.expected_fp THEN")
A("      RAISE EXCEPTION 'advisor_step2a: policy fingerprint drift on %.% — refusing (변조/이중적용/드리프트)', r.tbl, r.pol;")
A("    END IF;")
A("    EXECUTE format('ALTER POLICY %I ON public.%I %s %s', r.pol, r.tbl,")
A("      CASE WHEN r.new_using IS NOT NULL THEN 'USING (' || r.new_using || ')' ELSE '' END,")
A("      CASE WHEN r.new_check IS NOT NULL THEN 'WITH CHECK (' || r.new_check || ')' ELSE '' END);")
A("  END LOOP;")
A("END $mig$;")
forward_text = "\n".join(L) + "\n"

# ---- 역방향 rollback (가드형 단일 원자 DO 블록, chain 밖) --------------------
# 선검증: 현재 정책이 "정확히 migration이 만든 post-migration 상태"인지 확인 —
# 래핑 발생부('( SELECT auth.<fn>() AS <alias>)' deparse 형태)를 bare 호출로 unwrap한
# fingerprint가 baseline과 일치해야 한다. missing/불일치 전건 EXCEPTION.
R = []
B = R.append
B("-- advisor 2단계-A rollback — initplan 67건을 baseline 원문 qual/with_check로 복원")
B("-- 생성기: scripts/db/generate-advisor-step2-migration.py (수동 편집 금지 — --check로 결속)")
B("-- 적용된 DB에서만 실행. migration chain 밖 파일 — supabase/migrations에 넣지 말 것.")
B("--")
B("-- 가드(fail-closed): 현재 상태가 정확히 post-migration 상태(unwrap 시 baseline과")
B("-- full fingerprint 일치)일 때만 복원. missing·drift 전건 EXCEPTION. 단일 원자 블록.")
B("")
B("SET lock_timeout = '5s';")
B("")
B("DO $rb$")
B("DECLARE r record; cur_unwrapped_fp text;")
B("BEGIN")
B("  FOR r IN SELECT * FROM (VALUES")
rvals = []
for i, p in enumerate(targets):
    tbl, pol = p["tablename"], p["policyname"]
    u = dq(p["qual"], f"u{i}") if p["qual"] else "NULL"
    c = dq(p["with_check"], f"c{i}") if p["with_check"] else "NULL"
    rvals.append(f"    ('{tbl}', {dq(pol, f'p{i}')}, '{fingerprint(p)}', {u}, {c})")
B(",\n".join(rvals))
B("  ) AS t(tbl, pol, baseline_fp, old_using, old_check)")
B("  LOOP")
B("    IF to_regclass('public.' || r.tbl) IS NULL THEN")
B("      RAISE EXCEPTION 'advisor_step2a_rollback: table % missing — rollback은 적용된 DB 전제', r.tbl;")
B("    END IF;")
B("    SELECT md5(coalesce(cmd,'') || '|' || coalesce(permissive,'') || '|' || coalesce(roles::text,'') || '|' ||")
B("           regexp_replace(coalesce(qual,''),")
B("             '\\( SELECT auth\\.(uid|role|jwt|email)\\(\\) AS [a-z]+\\)', 'auth.\\1()', 'g') || '|' ||")
B("           regexp_replace(coalesce(with_check,''),")
B("             '\\( SELECT auth\\.(uid|role|jwt|email)\\(\\) AS [a-z]+\\)', 'auth.\\1()', 'g'))")
B("      INTO cur_unwrapped_fp FROM pg_policies")
B("     WHERE schemaname='public' AND tablename=r.tbl AND policyname=r.pol;")
B("    IF cur_unwrapped_fp IS NULL THEN")
B("      RAISE EXCEPTION 'advisor_step2a_rollback: policy %.% missing — refusing', r.tbl, r.pol;")
B("    END IF;")
B("    IF cur_unwrapped_fp <> r.baseline_fp THEN")
B("      RAISE EXCEPTION 'advisor_step2a_rollback: %.% is not in post-migration state — refusing (drift)', r.tbl, r.pol;")
B("    END IF;")
B("    EXECUTE format('ALTER POLICY %I ON public.%I %s %s', r.pol, r.tbl,")
B("      CASE WHEN r.old_using IS NOT NULL THEN 'USING (' || r.old_using || ')' ELSE '' END,")
B("      CASE WHEN r.old_check IS NOT NULL THEN 'WITH CHECK (' || r.old_check || ')' ELSE '' END);")
B("  END LOOP;")
B("END $rb$;")
rollback_text = "\n".join(R) + "\n"

# ---- 출력 / --check --------------------------------------------------------
if "--check" in sys.argv:
    ok = True
    for path, expected in ((OUT_FWD, forward_text), (OUT_RB, rollback_text)):
        actual = path.read_text() if path.exists() else ""
        if actual != expected:
            ok = False
            print(f"CHECK FAIL: {path.relative_to(ROOT)} — committed 출력이 생성기 결과와 다름")
    if ok:
        print(f"CHECK OK: forward({len(targets)})·rollback({len(targets)}) committed 출력 일치")
    sys.exit(0 if ok else 1)

OUT_FWD.write_text(forward_text)
OUT_RB.write_text(rollback_text)
print(f"forward: {OUT_FWD.name} targets={len(targets)} bytes={OUT_FWD.stat().st_size}")
print(f"rollback: {OUT_RB.name} stmts={len(targets)} bytes={OUT_RB.stat().st_size}")
