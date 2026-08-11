#!/usr/bin/env node
/**
 * 자체 집계 DAU/WAU/MAU 계약 게이트 (정적, DB 불필요 — prebuild에서 상시 실행).
 *
 * PR #1155 (#cs 2026-08-11 DAU 집계 차이): /admin 개요 KPI·추이를 GA4에서
 * 자체 텔레메트리(앱+웹 전역 DISTINCT visitor_id)로 전환하며 삼순 리뷰가 요구한
 * 회귀 축을 소스 계약으로 고정한다:
 *   [C1] 집계 경계 — 7d/30d는 "완료된 날"만(당일 제외), KST 기준
 *   [C2] 중복 제거 — 전 구간 전역 DISTINCT (플랫폼별/일별 UV 합산 금지)
 *   [C3] 누적은 365일 보존 롤업(admin_traffic_daily_visitors) 의존 금지 —
 *        영구 원장(admin_visitor_first_seen / admin_traffic_daily_stats)만
 *   [C4] KPI/추이의 GA4 폴백 금지 — 실패는 fail-close로 표기
 *   [C5] RPC 권한 — service_role 전용 (REVOKE + GRANT)
 *
 * 검증력: 각 조항은 실제 배포 소스(마이그레이션 SQL·route·page)를 파싱해
 * 확인한다. 조항 위반 결함 주입 시 RED가 되는지는 커밋 전 수동 확인함
 * (예: cumulative 분기에서 first_seen→daily_visitors로 바꾸면 C3 FAIL).
 */
import { readFileSync } from "node:fs";

const MIGRATION = "supabase/migrations/20260811230000_admin_active_visitors.sql";
const ROUTE = "src/app/api/admin/active-users/route.ts";
const PAGE = "src/app/admin/page.tsx";

const failures = [];
const passes = [];
function check(id, desc, ok, detail = "") {
  if (ok) passes.push(`  PASS [${id}] ${desc}`);
  else failures.push(`  FAIL [${id}] ${desc}${detail ? ` — ${detail}` : ""}`);
}

const sql = readFileSync(MIGRATION, "utf8");
const route = readFileSync(ROUTE, "utf8");
const page = readFileSync(PAGE, "utf8");

/* ── [C1] 집계 경계 ── */
{
  // 7d/30d 분기: 어제까지(당일 제외) — `< v_today` 상한이 존재해야 한다.
  const daily = sql.match(/ELSIF p_period IN \('7d', '30d'\)[\s\S]*?ORDER BY d\.day_kst;/);
  check("C1", "7d/30d 분기 존재", !!daily);
  check(
    "C1",
    "7d/30d는 당일 제외 상한(day_kst < v_today) 강제",
    !!daily && /day_kst\s*<\s*v_today/.test(daily[0]),
  );
  // KST 기준: 모든 날짜 경계가 Asia/Seoul 변환을 지난다.
  check(
    "C1",
    "KST 기준 경계 (Asia/Seoul 변환)",
    (sql.match(/AT TIME ZONE 'Asia\/Seoul'/g) ?? []).length >= 4,
  );
  // today 분기는 raw + celebration 제외 predicate (partial index 정합).
  const today = sql.match(/IF p_period = 'today'[\s\S]*?ORDER BY 1;/);
  check(
    "C1",
    "today 분기는 raw admin_page_views + /_celeb 제외",
    !!today && /admin_page_views/.test(today[0]) && /starts_with\(v\.path, '\/_celeb'\)/.test(today[0]),
  );
}

/* ── [C2] 중복 제거 — 전역 DISTINCT, 플랫폼별/일별 합산 금지 ── */
{
  const kpiFn = sql.match(/CREATE OR REPLACE FUNCTION admin_active_visitors\(\)[\s\S]*?\$\$;/);
  check("C2", "admin_active_visitors 정의 존재", !!kpiFn);
  check(
    "C2",
    "KPI dau/wau/mau는 count(DISTINCT visitor_id)",
    !!kpiFn && (kpiFn[0].match(/count\(DISTINCT visitor_id\)/g) ?? []).length === 3,
  );
  check(
    "C2",
    "KPI에 플랫폼별 분해/합산 없음 (GROUP BY platform 금지)",
    !!kpiFn && !/GROUP BY\s+platform/i.test(kpiFn[0]) && !/sum\(\s*uv\s*\)/i.test(kpiFn[0]),
  );
  const trendFn = sql.match(/CREATE OR REPLACE FUNCTION admin_traffic_trend[\s\S]*?END;\s*\$\$;/);
  check(
    "C2",
    "추이 today/일별도 전역 count(DISTINCT ...visitor_id)",
    !!trendFn && (trendFn[0].match(/count\(DISTINCT [a-z]+\.visitor_id\)/g) ?? []).length >= 2,
  );
}

/* ── [C3] 누적의 영구 원장 분리 ── */
{
  const cum = sql.match(/ELSIF p_period = 'cumulative'[\s\S]*?ORDER BY days\.day;/);
  check("C3", "cumulative 분기 존재", !!cum);
  check(
    "C3",
    "cumulative는 영구 원장(admin_visitor_first_seen/daily_stats)만 사용",
    !!cum &&
      /admin_visitor_first_seen/.test(cum[0]) &&
      /admin_traffic_daily_stats/.test(cum[0]) &&
      !/admin_traffic_daily_visitors/.test(cum[0]),
    "365일 보존 롤업 의존 금지 (삼순 리뷰)",
  );
  check(
    "C3",
    "누적 총계(total)도 영구 원장에서",
    /FROM admin_visitor_first_seen\) AS total/.test(sql),
  );
  check(
    "C3",
    "영구 원장 트리거 유지 (first_seen DO NOTHING + daily_stats pv 증분)",
    /INSERT INTO admin_visitor_first_seen[\s\S]*?ON CONFLICT \(visitor_id\) DO NOTHING/.test(sql) &&
      /INSERT INTO admin_traffic_daily_stats[\s\S]*?SET pv = admin_traffic_daily_stats\.pv \+ 1/.test(sql),
  );
  check(
    "C3",
    "백필은 쓰기 잠금(SHARE ROW EXCLUSIVE) 아래 수행",
    /LOCK TABLE admin_page_views IN SHARE ROW EXCLUSIVE MODE/.test(sql),
  );
}

/* ── [C4] GA4 폴백 금지 (fail-close) ── */
{
  // 주석 설명문("GA4가 아닌")은 허용 — 실제 사용(GA4 API 호출·키·analytics route 위임)만 금지.
  check(
    "C4",
    "route는 GA4 API/키/analytics 위임을 사용하지 않음",
    !/analyticsdata\.googleapis|GOOGLE_SERVICE_ACCOUNT|GA4_PROPERTY_ID|\/api\/admin\/analytics/.test(route),
  );
  check(
    "C4",
    "page KPI는 자체 집계 단일 소스 (ga4Dau 폴백 제거)",
    !/ga4Dau/.test(page),
    "activeUsers ?? ga4Dau 패턴 금지",
  );
  check(
    "C4",
    "page에 fail-close 실패 상태 문구 존재",
    (page.match(/GA4로 대체하지 않습니다/g) ?? []).length >= 2,
    "KPI + 추이 각각 실패 표기",
  );
  check(
    "C4",
    "추이 카드는 자체 API(/api/admin/active-users?period=)를 조회",
    /\/api\/admin\/active-users\?period=\$\{period\}/.test(page) &&
      !/\/api\/admin\/analytics\?type=trend/.test(page),
  );
}

/* ── [C5] 권한 ── */
{
  check(
    "C5",
    "두 RPC 모두 REVOKE(public/anon/authenticated) + GRANT service_role",
    /REVOKE EXECUTE ON FUNCTION admin_active_visitors\(\) FROM public, anon, authenticated/.test(sql) &&
      /GRANT EXECUTE ON FUNCTION admin_active_visitors\(\) TO service_role/.test(sql) &&
      /REVOKE EXECUTE ON FUNCTION admin_traffic_trend\(text\) FROM public, anon, authenticated/.test(sql) &&
      /GRANT EXECUTE ON FUNCTION admin_traffic_trend\(text\) TO service_role/.test(sql),
  );
  check(
    "C5",
    "신규 원장 테이블 RLS 활성 (deny-all)",
    /ALTER TABLE admin_visitor_first_seen ENABLE ROW LEVEL SECURITY/.test(sql) &&
      /ALTER TABLE admin_traffic_daily_stats ENABLE ROW LEVEL SECURITY/.test(sql),
  );
}

console.log("=== 자체 집계 DAU/WAU/MAU 계약 게이트 ===");
for (const p of passes) console.log(p);
for (const f of failures) console.log(f);
console.log(`\n결과: ${failures.length === 0 ? "PASS" : `FAIL (${failures.length}건)`}`);
process.exit(failures.length === 0 ? 0 : 1);
