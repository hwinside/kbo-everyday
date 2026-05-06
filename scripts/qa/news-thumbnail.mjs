#!/usr/bin/env node
/**
 * News thumbnail (og:image) fill-rate gate.
 *
 * Calls /api/news?team=<shortName> for all 10 KBO teams, measures
 * thumbnailUrl fill rate per team, and reports per-host success/failure counts
 * for the og:image extractor.
 *
 * Env:
 *   QA_BASE_URL   default: http://localhost:3000
 *   MIN_FILL_RATE default: 0.6 (60% — merge gate)
 *   FETCH_LIMIT   default: 12 (matches THUMBNAIL_FETCH_LIMIT in route.ts)
 *
 * Output:
 *   stdout: per-team table + overall fill rate + per-host breakdown
 *   e2e/screenshots/news-thumbnail-report.json
 *
 * Exit:
 *   0 if overall fill rate >= MIN_FILL_RATE
 *   1 otherwise
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.QA_BASE_URL || "http://localhost:3000";
const MIN_FILL_RATE = Number(process.env.MIN_FILL_RATE || "0.6");
const FETCH_LIMIT = Number(process.env.FETCH_LIMIT || "12");

const TEAMS = ["LG", "두산", "KT", "SSG", "NC", "KIA", "롯데", "삼성", "한화", "키움"];

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = resolve(__dirname, "../../e2e/screenshots/news-thumbnail-report.json");

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "(invalid)";
  }
}

async function fetchTeam(team) {
  const url = `${BASE}/api/news?team=${encodeURIComponent(team)}`;
  const t0 = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": "kbo-qa/news-thumbnail" } });
  const elapsed = Date.now() - t0;
  if (!res.ok) {
    return { team, ok: false, status: res.status, elapsed, items: [], error: `HTTP ${res.status}` };
  }
  const json = await res.json();
  const items = Array.isArray(json.items) ? json.items : [];
  return { team, ok: true, elapsed, items };
}

function summarize(result) {
  const target = result.items.slice(0, FETCH_LIMIT);
  const filled = target.filter((it) => it.thumbnailUrl);
  const fillRate = target.length === 0 ? 0 : filled.length / target.length;

  const perHost = new Map();
  for (const it of target) {
    const host = hostOf(it.link);
    const e = perHost.get(host) || { host, success: 0, fail: 0 };
    if (it.thumbnailUrl) e.success++;
    else e.fail++;
    perHost.set(host, e);
  }

  return {
    team: result.team,
    ok: result.ok,
    elapsed: result.elapsed,
    total: result.items.length,
    sampled: target.length,
    filled: filled.length,
    fillRate,
    perHost: [...perHost.values()],
  };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main() {
  console.log(`[news-thumbnail] BASE=${BASE} MIN_FILL_RATE=${MIN_FILL_RATE} FETCH_LIMIT=${FETCH_LIMIT}`);
  console.log(`[news-thumbnail] checking ${TEAMS.length} teams...`);

  const results = [];
  for (const team of TEAMS) {
    try {
      const r = await fetchTeam(team);
      const s = summarize(r);
      results.push(s);
      const rate = (s.fillRate * 100).toFixed(0);
      const tag = s.fillRate >= MIN_FILL_RATE ? "PASS" : "FAIL";
      console.log(
        `  ${pad(s.team, 4)}  ${pad(`${s.filled}/${s.sampled}`, 6)}  ${pad(`${rate}%`, 5)}  ${pad(`${s.elapsed}ms`, 7)}  ${tag}`,
      );
    } catch (e) {
      console.log(`  ${pad(team, 4)}  ERROR  ${e.message}`);
      results.push({ team, ok: false, error: e.message });
    }
  }

  // Aggregate
  const totalSampled = results.reduce((a, r) => a + (r.sampled || 0), 0);
  const totalFilled = results.reduce((a, r) => a + (r.filled || 0), 0);
  const overallRate = totalSampled === 0 ? 0 : totalFilled / totalSampled;

  // Per-host aggregation
  const hostAgg = new Map();
  for (const r of results) {
    if (!r.perHost) continue;
    for (const h of r.perHost) {
      const e = hostAgg.get(h.host) || { host: h.host, success: 0, fail: 0 };
      e.success += h.success;
      e.fail += h.fail;
      hostAgg.set(h.host, e);
    }
  }
  const hosts = [...hostAgg.values()].sort((a, b) => (b.success + b.fail) - (a.success + a.fail));

  console.log("");
  console.log(`[news-thumbnail] overall: ${totalFilled}/${totalSampled} = ${(overallRate * 100).toFixed(1)}%`);
  console.log(`[news-thumbnail] gate: ${overallRate >= MIN_FILL_RATE ? "PASS" : "FAIL"} (min ${(MIN_FILL_RATE * 100).toFixed(0)}%)`);
  console.log("");
  console.log("[news-thumbnail] per-host (top 15):");
  for (const h of hosts.slice(0, 15)) {
    const total = h.success + h.fail;
    const rate = total === 0 ? 0 : h.success / total;
    console.log(`  ${pad(h.host, 30)}  ${pad(`${h.success}/${total}`, 7)}  ${(rate * 100).toFixed(0)}%`);
  }

  const report = {
    base: BASE,
    minFillRate: MIN_FILL_RATE,
    fetchLimit: FETCH_LIMIT,
    timestamp: new Date().toISOString(),
    overall: { totalFilled, totalSampled, overallRate, pass: overallRate >= MIN_FILL_RATE },
    teams: results,
    hosts,
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`[news-thumbnail] report → ${REPORT_PATH}`);

  process.exit(overallRate >= MIN_FILL_RATE ? 0 : 1);
}

main().catch((e) => {
  console.error("[news-thumbnail] fatal:", e);
  process.exit(2);
});
