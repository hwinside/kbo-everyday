#!/usr/bin/env python3
"""advisor ②단계-A migration 생성기 — RLS initplan 67건 (initplan ONLY).

입력(SSOT): scripts/qa/fixtures/rls-policies-baseline-20260813.json
  (production pg_policies 2026-08-13 22:3x KST 기계 추출 — 손으로 만든 fixture 금지)

출력:
  supabase/migrations/20260813_advisor_step2_rls_initplan.sql  (정방향)
  scripts/db/rollback-advisor-step2-rls-initplan.sql           (역방향, chain 밖)

삼순 1차 NO-GO 반영 (exact ec8131505):
  1. 2A/2B 분리 — 이 파일은 initplan 67건 ALTER만. 정책 병합·role 축소(2B)는 별도 PR.
  2. fail-closed 가드 강화 — full policy fingerprint(cmd|permissive|roles|qual|check)
     md5가 baseline과 일치할 때만 ALTER. 불일치는 전건 EXCEPTION (bare-auth skip 없음
     → USING(true) 변조도 거부). 정책/테이블 부재만 skip (clean chain).
     단일 DO 블록 = 단일 트랜잭션이라 부분 적용 상태가 없고, 이미 적용된 DB에
     재실행하면 전건 fingerprint 불일치로 거부된다(이중 적용 방지 — 게이트 A8).
  3. 실행형 rollback — 67건 전부 원본 qual/with_check로 되돌리는 ALTER POLICY SQL을
     별도 파일로 생성(migration chain 밖). 게이트가 replay→rollback roundtrip으로
     fingerprint 완전 복원을 검증한다.
"""
import hashlib
import json
import re
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

rows_fwd = []   # (tbl, pol, fp, new_using, new_check)
rows_rb = []    # (tbl, pol, old_using, old_check)
for p in targets:
    rows_fwd.append((
        p["tablename"], p["policyname"], fingerprint(p),
        wrap(p["qual"]) if p["qual"] else None,
        wrap(p["with_check"]) if p["with_check"] else None,
    ))
    rows_rb.append((p["tablename"], p["policyname"], p["qual"], p["with_check"]))

# ---- 정방향 migration ------------------------------------------------------
L = []
A = L.append
A("-- Supabase advisor 2단계-A — RLS initplan 67건 (initplan ONLY)")
A("-- 2026-08-13 하린아빠 착수 승인 + 삼순 1차 NO-GO 반영 (#infra 1786505729.677579)")
A("-- 생성기: scripts/db/generate-advisor-step2-migration.py (수동 편집 금지)")
A("-- baseline: scripts/qa/fixtures/rls-policies-baseline-20260813.json (production 기계 추출)")
A("-- rollback: scripts/db/rollback-advisor-step2-rls-initplan.sql (실행형 역방향 전문)")
A("--")
A("-- 가드(fail-closed): full fingerprint(cmd|permissive|roles|qual|check) md5가")
A("-- baseline과 일치할 때만 ALTER. 불일치 → EXCEPTION (변조·drift·이중 적용 전부 거부).")
A("-- 정책·테이블 부재 → skip (clean chain). 단일 DO 블록 = 원자 적용.")
A("")
A("SET lock_timeout = '5s';")
A("")
A("DO $mig$")
A("DECLARE r record; cur_fp text;")
A("BEGIN")
A("  FOR r IN SELECT * FROM (VALUES")
vals = []
for i, (tbl, pol, fp, using, check) in enumerate(rows_fwd):
    u = dq(using, f"u{i}") if using else "NULL"
    c = dq(check, f"c{i}") if check else "NULL"
    vals.append(f"    ('{tbl}', {dq(pol, f'p{i}')}, '{fp}', {u}, {c})")
A(",\n".join(vals))
A("  ) AS t(tbl, pol, expected_fp, new_using, new_check)")
A("  LOOP")
A("    IF to_regclass('public.' || r.tbl) IS NULL THEN CONTINUE; END IF;")
A("    SELECT md5(coalesce(cmd,'') || '|' || coalesce(permissive,'') || '|' ||")
A("               coalesce(roles::text,'') || '|' || coalesce(qual,'') || '|' || coalesce(with_check,''))")
A("      INTO cur_fp FROM pg_policies")
A("     WHERE schemaname='public' AND tablename=r.tbl AND policyname=r.pol;")
A("    IF cur_fp IS NULL THEN CONTINUE; END IF; -- 정책 부재 (clean chain)")
A("    IF cur_fp <> r.expected_fp THEN")
A("      RAISE EXCEPTION 'advisor_step2a: policy fingerprint drift on %.% — refusing (baseline과 다름: 변조/이중적용/드리프트)', r.tbl, r.pol;")
A("    END IF;")
A("    EXECUTE format('ALTER POLICY %I ON public.%I %s %s', r.pol, r.tbl,")
A("      CASE WHEN r.new_using IS NOT NULL THEN 'USING (' || r.new_using || ')' ELSE '' END,")
A("      CASE WHEN r.new_check IS NOT NULL THEN 'WITH CHECK (' || r.new_check || ')' ELSE '' END);")
A("  END LOOP;")
A("END $mig$;")
OUT_FWD.write_text("\n".join(L) + "\n")

# ---- 역방향 rollback (실행형 전문, chain 밖) --------------------------------
R = []
B = R.append
B("-- advisor 2단계-A rollback — initplan 67건을 baseline 원문 qual/with_check로 복원")
B("-- 생성기: scripts/db/generate-advisor-step2-migration.py (수동 편집 금지)")
B("-- 적용된 DB에서만 실행. migration chain 밖 파일 — supabase/migrations에 넣지 말 것.")
B("")
B("SET lock_timeout = '5s';")
B("")
for i, (tbl, pol, old_using, old_check) in enumerate(rows_rb):
    parts = [f'ALTER POLICY "{pol}" ON public.{tbl}']
    if old_using:
        parts.append(f"USING ({old_using})")
    if old_check:
        parts.append(f"WITH CHECK ({old_check})")
    B(" ".join(parts) + ";")
OUT_RB.write_text("\n".join(R) + "\n")

print(f"forward: {OUT_FWD.name} targets={len(rows_fwd)} bytes={OUT_FWD.stat().st_size}")
print(f"rollback: {OUT_RB.name} stmts={len(rows_rb)} bytes={OUT_RB.stat().st_size}")
