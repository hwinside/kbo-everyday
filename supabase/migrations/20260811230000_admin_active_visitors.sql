-- 메인 대시보드 DAU/WAU/MAU를 자체 집계(앱+웹)로 전환 (#cs 2026-08-11).
--
-- 지금까지 /admin 개요의 DAU/WAU/MAU는 GA4 activeUsers(외부 계측·engaged 기준·
-- 차단 손실 포함)였고, /admin/traffic의 "일별 앱 활성 기기수"는 자체 텔레메트리
-- (admin_page_views → admin_traffic_daily_visitors rollup)라 두 수치가 다르게
-- 보였다. 이 함수는 자체 rollup에서 전 플랫폼(web + ios_native + android_native
-- + native + unknown)을 합쳐 KST 기준 window별 DISTINCT visitor_id를 센다.
--
-- - rollup은 insert 트리거로 실시간 유지되고 /_celeb 텔레메트리는 이미 제외됨
--   (20260721_admin_traffic_page_view_rollup.sql). 보존기간 365일이라 30일
--   window가 raw 보존(30일)에 걸리지 않는다.
-- - 플랫폼을 넘나드는 동일인(웹 쿠키 vs 앱 기기 id)은 식별 불가라 각각 1로
--   센다 — 기기/브라우저 단위 활성 수라는 뜻이며 traffic 대시보드와 동일 기준.
-- - idx_admin_traffic_daily_visitors_day_covering (day_kst) INCLUDE
--   (platform, visitor_id, pv) 커버링 인덱스로 index-only scan.
CREATE OR REPLACE FUNCTION admin_active_visitors()
RETURNS TABLE(dau bigint, wau bigint, mau bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (SELECT count(DISTINCT visitor_id)
       FROM admin_traffic_daily_visitors
      WHERE day_kst = (now() AT TIME ZONE 'Asia/Seoul')::date) AS dau,
    (SELECT count(DISTINCT visitor_id)
       FROM admin_traffic_daily_visitors
      WHERE day_kst >= (now() AT TIME ZONE 'Asia/Seoul')::date - 6) AS wau,
    (SELECT count(DISTINCT visitor_id)
       FROM admin_traffic_daily_visitors
      WHERE day_kst >= (now() AT TIME ZONE 'Asia/Seoul')::date - 29) AS mau;
$$;

REVOKE EXECUTE ON FUNCTION admin_active_visitors() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_active_visitors() TO service_role;
