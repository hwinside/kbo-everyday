-- Design V2 Migration — Feature Flag 기반 테이블
-- Spec: specs/design-v2-migration.md (v0.5)
-- Tasks: T1.3.1
-- 생성: 2026-04-19 삼식이

-- 1. profiles 테이블에 design_version 컬럼 추가
alter table public.profiles
  add column if not exists design_version text default 'v1'
  check (design_version in ('v1', 'v2'));

-- 2. index (Phase 5 cohort 조회 최적화)
create index if not exists idx_profiles_design_version
  on public.profiles (design_version);

-- 3. 옵트아웃 추적 컬럼 (Plan §6.3 실험군 편향 방지)
alter table public.profiles
  add column if not exists v2_optout_at timestamptz,
  add column if not exists v2_optout_reason text;

-- 4. 기본값 해석 정책
-- - v1 = V1 디자인 (현행). 명시적 업데이트 전까지 유지.
-- - v2 = V2 디자인 (새). Admin cohort UI로만 업데이트.
--
-- ⚠️ User Exposure Lockdown (T1.3.5):
-- Design Freeze Gate 통과 전까지 middleware에서 DB의 'v2'도 V1으로 강제 fallback.
-- 실제 노출은 Phase 4 종료 후 Admin 해제 시점부터.

-- 5. RLS 정책 (기존 profiles 정책 유지, design_version은 select만 본인 허용)
-- profiles 테이블의 기존 RLS에 의해 자동 커버됨 (본인 profile select/update)
