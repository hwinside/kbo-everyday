#!/usr/bin/env node
/**
 * 자체 집계 DAU/WAU/MAU 불변식 검증 (DB 실측, 읽기 전용 SELECT만).
 *
 * PR #1155 회귀 축 중 "집계 경계·중복 제거"를 실제 Production 데이터로 검증.
 * SUPABASE_MANAGEMENT_TOKEN 필요 (없으면 fail-close exit 2 — 수동/배포 후 QA용,
 * prebuild에는 정적 게이트 active-users-contract.mjs가 들어간다).
 *
 * 불변식:
 *   [I1] dau ≤ wau ≤ mau ≤ total (window 포함 관계)
 *   [I2] 중복 제거 증명 — Σ(일별 distinct) ≥ window 전역 distinct ≥ max(일별)
 *        (등호가 아니라는 것 자체가 "일별 합산 ≠ 전역 distinct"의 실측 증거)
 *   [I3] 당일 경계 — 7d/30d 시리즈에 오늘 날짜 미포함, 정확히 어제까지
 *   [I4] 누적 무결성 — running sum 단조증가 & 최종값 == 전역 distinct(어제까지)
 *        를 서로 다른 두 경로(최초등장일 집계 vs 직접 COUNT DISTINCT)로 교차 대조
 *   [I5] 시간대 경계 — 오늘 시간대별 Σusers ≥ 오늘 전역 distinct ≥ max(시간대)
 */
import { readFileSync } from "node:fs";

const PROJECT = "lbmbdjgsnenqjwjotoei";

function loadToken() {
  if (process.env.SUPABASE_MANAGEMENT_TOKEN) return process.env.SUPABASE_MANAGEMENT_TOKEN;
  try {
    const env = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
    const line = env.split("\n").find((l) => l.startsWith("SUPABASE_MANAGEMENT_TOKEN="));
    if (line) return line.slice(line.indexOf("=") + 1).trim().replace(/^"|"$/g, "");
  } catch {}
  return null;
}

const token = loadToken();
if (!token) {
  console.error("FAIL-CLOSE: SUPABASE_MANAGEMENT_TOKEN 없음 — 검증 불가를 통과로 착각하지 않도록 exit 2");
  process.exit(2);
}

async function q(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`query ${res.status}: ${await res.text()}`);
  return res.json();
}

const failures = [];
function check(id, desc, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"} [${id}] ${desc}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(id);
}

console.log("=== 자체 집계 DAU/WAU/MAU 불변식 (Production 읽기 전용) ===");

// KPI (함수 본문과 동일 정의 — 함수 미생성 시점에도 검증 가능하게 인라인)
const [kpi] = await q(`SELECT
  (SELECT count(DISTINCT visitor_id) FROM admin_traffic_daily_visitors WHERE day_kst = (now() AT TIME ZONE 'Asia/Seoul')::date) AS dau,
  (SELECT count(DISTINCT visitor_id) FROM admin_traffic_daily_visitors WHERE day_kst >= (now() AT TIME ZONE 'Asia/Seoul')::date - 6) AS wau,
  (SELECT count(DISTINCT visitor_id) FROM admin_traffic_daily_visitors WHERE day_kst >= (now() AT TIME ZONE 'Asia/Seoul')::date - 29) AS mau,
  (SELECT count(DISTINCT visitor_id) FROM admin_traffic_daily_visitors) AS total`);
check("I1", `dau(${kpi.dau}) ≤ wau(${kpi.wau}) ≤ mau(${kpi.mau}) ≤ total(${kpi.total})`,
  kpi.dau <= kpi.wau && kpi.wau <= kpi.mau && kpi.mau <= kpi.total);

// I2: 7일 window 중복 제거
const daily7 = await q(`SELECT day_kst, count(DISTINCT visitor_id)::int AS users
  FROM admin_traffic_daily_visitors
  WHERE day_kst >= (now() AT TIME ZONE 'Asia/Seoul')::date - 6
  GROUP BY day_kst ORDER BY day_kst`);
const sum7 = daily7.reduce((s, r) => s + r.users, 0);
const max7 = Math.max(...daily7.map((r) => r.users));
check("I2", `Σ일별(${sum7}) ≥ 7일 전역 distinct(${kpi.wau}) ≥ max일별(${max7})`,
  sum7 >= kpi.wau && kpi.wau >= max7);
check("I2", "일별 합산과 전역 distinct가 실제로 다름 (재방문 존재 증명)", sum7 > kpi.wau,
  `차이 ${sum7 - kpi.wau}명 = window 내 재방문자`);

// I3: 추이 7d 시리즈 경계 (함수 본문과 동일 정의)
const series7 = await q(`SELECT to_char(day_kst,'YYYY-MM-DD') AS day
  FROM admin_traffic_daily_visitors
  WHERE day_kst >= (now() AT TIME ZONE 'Asia/Seoul')::date - 7
    AND day_kst < (now() AT TIME ZONE 'Asia/Seoul')::date
  GROUP BY day_kst ORDER BY day_kst`);
const [{ today, yesterday }] = await q(
  `SELECT ((now() AT TIME ZONE 'Asia/Seoul')::date)::text AS today, ((now() AT TIME ZONE 'Asia/Seoul')::date - 1)::text AS yesterday`,
);
check("I3", `7d 시리즈에 오늘(${today}) 미포함`, !series7.some((r) => r.day === today));
check("I3", `7d 시리즈 마지막 = 어제(${yesterday}), 길이 ${series7.length} ≤ 7`,
  series7.at(-1)?.day === yesterday && series7.length <= 7);

// I4: 누적 교차 대조 — 최초등장일 running 최종값 vs 직접 전역 distinct (어제까지)
const [cum] = await q(`WITH firsts AS (
    SELECT visitor_id, min(day_kst) AS day FROM admin_traffic_daily_visitors GROUP BY visitor_id
  )
  SELECT
    (SELECT count(*) FROM firsts WHERE day < (now() AT TIME ZONE 'Asia/Seoul')::date) AS via_firsts,
    (SELECT count(DISTINCT visitor_id) FROM admin_traffic_daily_visitors
      WHERE day_kst < (now() AT TIME ZONE 'Asia/Seoul')::date) AS via_direct`);
check("I4", `누적(어제까지) 두 경로 일치: 최초등장일 ${cum.via_firsts} == 직접 distinct ${cum.via_direct}`,
  Number(cum.via_firsts) === Number(cum.via_direct));

// I4b: 영구 원장 존재 시 rollup과 정합 (마이그레이션 적용 후에만)
const ledger = await q(`SELECT to_regclass('public.admin_visitor_first_seen') IS NOT NULL AS exists`);
if (ledger[0].exists) {
  const [led] = await q(`SELECT
    (SELECT count(*) FROM admin_visitor_first_seen) AS ledger_total,
    (SELECT count(DISTINCT visitor_id) FROM admin_traffic_daily_visitors) AS rollup_total`);
  check("I4b", `영구 원장 total(${led.ledger_total}) ≥ rollup total(${led.rollup_total})`,
    Number(led.ledger_total) >= Number(led.rollup_total),
    "원장은 보존 삭제가 없어 rollup 이상이어야 함");
} else {
  console.log("  SKIP [I4b] 영구 원장 미생성 (마이그레이션 적용 전) — 적용 후 재실행 필수");
}

// I5: 오늘 시간대 경계
const hourly = await q(`SELECT count(DISTINCT visitor_id)::int AS users
  FROM admin_page_views
  WHERE created_at >= ((((now() AT TIME ZONE 'Asia/Seoul')::date)::text || 'T00:00:00+09:00')::timestamptz)
    AND NOT starts_with(path, '/_celeb')
  GROUP BY to_char(created_at AT TIME ZONE 'Asia/Seoul', 'HH24')`);
const sumH = hourly.reduce((s, r) => s + r.users, 0);
const maxH = Math.max(...hourly.map((r) => r.users));
check("I5", `Σ시간대(${sumH}) ≥ 오늘 전역 distinct(${kpi.dau}) ≥ max시간대(${maxH})`,
  sumH >= kpi.dau && kpi.dau >= maxH);

console.log(`\n결과: ${failures.length === 0 ? "PASS" : `FAIL (${failures.join(", ")})`}`);
process.exit(failures.length === 0 ? 0 : 1);
