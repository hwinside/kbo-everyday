#!/usr/bin/env python3
"""advisor ②단계 migration 생성기 — RLS initplan 67건 + 중복 permissive 정책 26건.

입력(SSOT): scripts/qa/fixtures/rls-policies-baseline-20260813.json
  (production pg_policies 2026-08-13 22:3x KST 기계 추출 — 손으로 만든 fixture 금지)

출력: supabase/migrations/20260813_advisor_step2_rls_initplan.sql

설계:
- Part B (정책 재구성, 8 DROP → 6 CREATE):
  * service write 정책 3개(announcements/channel_pool/videos)를 TO service_role로 스코핑
    → anon/authenticated의 action별 permissive 정책 수 1로 감소 (동작 동일: 해당
    role에서 qual이 항상 false였음)
  * highlights_write(qual=true, TO public)를 TO service_role로 스코핑 — 코드 실측:
    highlights 쓰기는 전부 서버 service-role 클라이언트(RLS 우회)이며 클라이언트
    쓰기 경로 0. (기존 정책은 사실상 public write 허용이었음 — 리뷰 포인트)
  * comments/posts의 DELETE 정책 쌍(작성자/운영자)을 OR 병합 단일 정책으로
    (permissive 정책은 OR 결합이므로 의미 보존; anon은 양쪽 다 false로 동일)
- Part A (initplan, 나머지 60건): ALTER POLICY로 qual/with_check의 bare
  auth.<fn>()를 (select auth.<fn>())로 래핑. 표현식 구조는 불변.
- 가드(2-tier fail-close):
  * md5(qual|with_check)가 baseline과 일치 → 실행 (확실히 안전)
  * bare auth 호출이 이미 없음 → skip (재실행/이미 반영 — advisor도 미검출 상태)
  * 그 외 drift → EXCEPTION (fail-close)
  * 테이블/정책 부재 → skip (clean chain 안전)
"""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / "scripts/qa/fixtures/rls-policies-baseline-20260813.json"
OUT = ROOT / "supabase/migrations/20260813_advisor_step2_rls_initplan.sql"

BARE_AUTH = re.compile(r"(?<![Tt] )auth\.(uid|role|jwt|email)\(\)")
# "SELECT auth.uid()" / "select auth.uid()" 형태(이미 래핑)는 앞이 "T " 또는 "t "로 끝남

def wrap(expr: str) -> str:
    return BARE_AUTH.sub(lambda m: f"(select auth.{m.group(1)}())", expr)


def has_bare(expr: str) -> bool:
    return bool(BARE_AUTH.search(expr or ""))


def md5(qual, check) -> str:
    return hashlib.md5(f"{qual or ''}|{check or ''}".encode()).hexdigest()


def dq(s: str, tag: str) -> str:
    """dollar-quote, 태그 충돌 방지"""
    assert f"${tag}$" not in s
    return f"${tag}$" + s + f"${tag}$"


policies = json.loads(BASELINE.read_text())
by_key = {(p["tablename"], p["policyname"]): p for p in policies}

# ---- Part B 구성 ---------------------------------------------------------
SERVICE_SCOPE = [  # (table, policy) → TO service_role 재생성
    ("announcements", "Service role full access on announcements"),
    ("channel_pool", "channel_pool_service_write"),
    ("videos", "videos_service_write"),
    ("highlights", "highlights_write"),
]
MERGE_DELETE = [  # (table, author_policy, operator_policy, new_name)
    ("comments", "Authors delete own comments", "Operators delete any comments",
     "comments_delete_author_or_operator"),
    ("posts", "Authors delete own posts", "Operators delete any posts",
     "posts_delete_author_or_operator"),
]

part_b_drops = []  # (table, policy, md5, already_migrated_check)
part_b_creates = []  # (table, name, create_sql_body)

for tbl, pol in SERVICE_SCOPE:
    p = by_key[(tbl, pol)]
    # 멱등: 재실행 시 이미 {service_role}로 스코핑된 상태면 skip
    part_b_drops.append((tbl, pol, md5(p["qual"], p["with_check"]), "service_scoped"))
    using = wrap(p["qual"]) if p["qual"] else None
    check = wrap(p["with_check"]) if p["with_check"] else None
    body = f"FOR ALL TO service_role USING ({using})"
    if check:
        body += f" WITH CHECK ({check})"
    part_b_creates.append((tbl, pol, body))

for tbl, author_pol, op_pol, new_name in MERGE_DELETE:
    a = by_key[(tbl, author_pol)]
    o = by_key[(tbl, op_pol)]
    part_b_drops.append((tbl, author_pol, md5(a["qual"], a["with_check"]), None))
    part_b_drops.append((tbl, op_pol, md5(o["qual"], o["with_check"]), None))
    merged = f"({wrap(a['qual'])}) OR ({wrap(o['qual'])})"
    part_b_creates.append((tbl, new_name, f"FOR DELETE TO public USING ({merged})"))

part_b_keys = {(t, p) for t, p, _, _ in part_b_drops}

# ---- Part A 구성 ---------------------------------------------------------
part_a = []  # (table, policy, md5, new_using|None, new_check|None)
for p in policies:
    key = (p["tablename"], p["policyname"])
    if key in part_b_keys:
        continue
    if not (has_bare(p["qual"]) or has_bare(p["with_check"])):
        continue
    part_a.append((
        p["tablename"], p["policyname"], md5(p["qual"], p["with_check"]),
        wrap(p["qual"]) if p["qual"] else None,
        wrap(p["with_check"]) if p["with_check"] else None,
    ))

assert len(part_a) + len(part_b_keys) - 1 == 67, (
    # -1: highlights_write는 initplan 67에 포함되지 않음(qual=true, auth 호출 없음)
    f"initplan 대상 수 불일치: part_a={len(part_a)} part_b={len(part_b_keys)}"
)

# ---- SQL 생성 ------------------------------------------------------------
lines = []
A = lines.append
A("-- Supabase advisor 2단계 — RLS initplan 67건 + 중복 permissive 정책 26건")
A("-- 2026-08-13 하린아빠 착수 승인 (#infra 1786505729.677579)")
A("-- 생성기: scripts/db/generate-advisor-step2-migration.py (수동 편집 금지)")
A("-- baseline: scripts/qa/fixtures/rls-policies-baseline-20260813.json (production 기계 추출)")
A("--")
A("-- 가드: baseline md5 일치 → 실행 / bare auth 없음 → skip(멱등) / 그 외 drift → EXCEPTION")
A("--       테이블·정책 부재 → skip (clean chain 안전)")
A("-- rollback: 이 파일 하단 주석의 역방향 SQL 전문 참조")
A("")
A("SET lock_timeout = '5s';")
A("")
A("-- 공용 가드 함수 (마이그레이션 안에서만 사용, 종료 시 DROP)")
A("CREATE OR REPLACE FUNCTION pg_temp._adv2_policy_md5(p_tbl text, p_pol text)")
A("RETURNS text LANGUAGE sql AS $fn$")
A("  SELECT md5(coalesce(qual,'') || '|' || coalesce(with_check,''))")
A("  FROM pg_policies WHERE schemaname='public' AND tablename=p_tbl AND policyname=p_pol")
A("$fn$;")
A("-- bare auth 호출 검출: 래핑된 'SELECT auth.<fn>()' 발생부를 제거한 뒤 잔여 호출을 본다")
A("-- (PG POSIX 정규식은 lookbehind 미지원)")
A("CREATE OR REPLACE FUNCTION pg_temp._adv2_has_bare_auth(p_tbl text, p_pol text)")
A("RETURNS boolean LANGUAGE sql AS $fn$")
A("  SELECT regexp_replace(")
A("           coalesce(qual,'') || ' ' || coalesce(with_check,''),")
A("           '[Ss][Ee][Ll][Ee][Cc][Tt] auth\\.(uid|role|jwt|email)\\(\\)', '', 'g')")
A("         ~ 'auth\\.(uid|role|jwt|email)\\(\\)'")
A("  FROM pg_policies WHERE schemaname='public' AND tablename=p_tbl AND policyname=p_pol")
A("$fn$;")
A("")

# Part B
A("-- ---- Part B: 정책 재구성 (중복 permissive 해소) --------------------------")
A("DO $mig$")
A("DECLARE cur_md5 text;")
A("BEGIN")
A("  -- (drop 대상) md5 일치 → DROP / 이미 service_role 스코핑(멱등 재실행) → skip / 그 외 drift → 거부")
for tbl, pol, m, migrated_check in part_b_drops:
    A(f"  IF to_regclass('public.{tbl}') IS NOT NULL THEN")
    A(f"    cur_md5 := pg_temp._adv2_policy_md5('{tbl}', {dq(pol, 'p')});")
    A("    IF cur_md5 IS NOT NULL THEN")
    A(f"      IF cur_md5 = '{m}' THEN")
    A(f"        EXECUTE format('DROP POLICY %I ON public.%I', {dq(pol, 'p')}, '{tbl}');")
    if migrated_check == "service_scoped":
        A("      ELSIF (SELECT roles::text FROM pg_policies WHERE schemaname='public'")
        A(f"             AND tablename='{tbl}' AND policyname={dq(pol, 'p')}) = '{{service_role}}' THEN")
        A("        NULL; -- 이미 스코핑된 재실행 — skip")
    A("      ELSE")
    A(f"        RAISE EXCEPTION 'advisor_step2: policy drift on %.% — refusing', '{tbl}', {dq(pol, 'p')};")
    A("      END IF;")
    A("    END IF;")
    A("  END IF;")
for tbl, name, body in part_b_creates:
    create_stmt = 'CREATE POLICY "' + name + '" ON public.' + tbl + ' ' + body
    A(f"  IF to_regclass('public.{tbl}') IS NOT NULL AND NOT EXISTS (")
    A(f"    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='{tbl}' AND policyname={dq(name, 'p')})")
    A("  THEN")
    A(f"    EXECUTE {dq(create_stmt, 'c')};")
    A("  END IF;")
A("END $mig$;")
A("")

# Part A
A("-- ---- Part A: initplan 래핑 (표현식 구조 불변) ----------------------------")
A("DO $mig$")
A("DECLARE r record; cur_md5 text;")
A("BEGIN")
A("  FOR r IN SELECT * FROM (VALUES")
rows = []
for i, (tbl, pol, m, using, check) in enumerate(part_a):
    u = dq(using, f"u{i}") if using else "NULL"
    c = dq(check, f"c{i}") if check else "NULL"
    rows.append(f"    ('{tbl}', {dq(pol, f'p{i}')}, '{m}', {u}, {c})")
A(",\n".join(rows))
A("  ) AS t(tbl, pol, expected_md5, new_using, new_check)")
A("  LOOP")
A("    IF to_regclass('public.' || r.tbl) IS NULL THEN CONTINUE; END IF;")
A("    cur_md5 := pg_temp._adv2_policy_md5(r.tbl, r.pol);")
A("    IF cur_md5 IS NULL THEN CONTINUE; END IF; -- 정책 부재 (clean chain)")
A("    IF cur_md5 <> r.expected_md5 THEN")
A("      IF NOT pg_temp._adv2_has_bare_auth(r.tbl, r.pol) THEN")
A("        CONTINUE; -- 이미 래핑됨 (멱등 재실행)")
A("      END IF;")
A("      RAISE EXCEPTION 'advisor_step2: policy drift on %.% — refusing', r.tbl, r.pol;")
A("    END IF;")
A("    EXECUTE format('ALTER POLICY %I ON public.%I %s %s', r.pol, r.tbl,")
A("      CASE WHEN r.new_using IS NOT NULL THEN 'USING (' || r.new_using || ')' ELSE '' END,")
A("      CASE WHEN r.new_check IS NOT NULL THEN 'WITH CHECK (' || r.new_check || ')' ELSE '' END);")
A("  END LOOP;")
A("END $mig$;")
A("")
A("DROP FUNCTION IF EXISTS pg_temp._adv2_policy_md5(text, text);")
A("DROP FUNCTION IF EXISTS pg_temp._adv2_has_bare_auth(text, text);")

OUT.write_text("\n".join(lines) + "\n")
print(f"generated {OUT.name}: part_a={len(part_a)} part_b_drops={len(part_b_drops)} part_b_creates={len(part_b_creates)}")
print(f"bytes={OUT.stat().st_size}")
