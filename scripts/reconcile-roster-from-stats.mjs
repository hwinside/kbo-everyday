#!/usr/bin/env node
/**
 * Reconcile roster from crawled stats (self-heal onboarding).
 *
 * 재발 방지용 패스. 반복 사고의 근본 원인:
 *   시즌 중 상무 전역 복귀/콜업 선수가 stats 크롤엔 나타나지만 roster 에 없어
 *   validate-player-identity 가 hard-fail → 자동 PR 이 red → 머지 적체 → 스탯 동결.
 *   (6/18~ 4명, 7/9 정은원, 7/14 정대선·이준서 — 매번 수동 온보딩으로 대응)
 *
 * 이 스크립트는 crawl-stats 직후 실행되어, 크롤된 batter/pitcher stats 에는 있으나
 * roster 로 resolve 되지 않는 KBO 숫자 id 선수를 공식 KBO 선수상세에서 보강해
 * roster 에 자동 추가한다. 사진은 후속 update-player-photos 스텝이 roster 기준으로
 * 자동 재생성/다운로드하므로 여기서는 roster 만 온보딩한다.
 *
 * 외국인 canonical(FP/AQ)은 foreign-id-map 경유라 여기서 건드리지 않는다.
 * roster/identity 검증은 그대로 게이트로 남아 최종 안전망 역할을 한다.
 *
 * Usage: node scripts/reconcile-roster-from-stats.mjs [--dry-run] [--verbose]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ROSTER_PATH = path.join(ROOT, "src/lib/constants/players-roster.json");
const BATTERS_PATH = path.join(ROOT, "src/lib/constants/stats-2026-batters.json");
const PITCHERS_PATH = path.join(ROOT, "src/lib/constants/stats-2026-pitchers.json");
const FOREIGN_MAP_PATH = path.join(ROOT, "src/lib/constants/foreign-id-map.ts");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const verbose = argv.includes("--verbose");

// team(한글 약칭) → teamId (roster SSOT 실측 기준)
const TEAM_TO_ID = {
  LG: 1, 두산: 2, KT: 3, SSG: 4, NC: 5, KIA: 6, 롯데: 7, 삼성: 8, 한화: 9, 키움: 10,
};

const KBO_HITTER = "https://www.koreabaseball.com/Record/Player/HitterDetail/Basic.aspx?playerId=";
const KBO_PITCHER = "https://www.koreabaseball.com/Record/Player/PitcherDetail/Basic.aspx?playerId=";
const KBO_HEADERS = {
  "User-Agent": "Mozilla/5.0",
  Referer: "https://www.koreabaseball.com/Player/Search.aspx",
};

function loadForeignNumericToAlpha() {
  const source = fs.readFileSync(FOREIGN_MAP_PATH, "utf8");
  return Object.fromEntries(
    [...source.matchAll(/"(\d+)":\s*"((?:FP|AQ)\d+)"/g)].map((m) => [m[1], m[2]]),
  );
}

function parseKboBirthday(txt) {
  const m = (txt || "").match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

function parsePosition(txt, fallbackIsPitcher) {
  const m = (txt || "").match(/(투수|포수|내야수|외야수)/);
  if (m) return m[1];
  return fallbackIsPitcher ? "투수" : "내야수";
}

function extractLabel(html, label) {
  const re = new RegExp(`playerProfile_${label}"[^>]*>([^<]*)`);
  const m = html.match(re);
  return m ? m[1].trim() : "";
}

async function fetchText(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: KBO_HEADERS });
      if (res.ok) return await res.text();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  return null;
}

// KBO 선수상세에서 등번호/생일/포지션 보강. 타자/투수 상세 구조 동일, 둘 다 시도.
async function fetchPlayerDetail(playerId, isPitcher) {
  const urls = isPitcher
    ? [KBO_PITCHER + playerId, KBO_HITTER + playerId]
    : [KBO_HITTER + playerId, KBO_PITCHER + playerId];
  for (const url of urls) {
    const html = await fetchText(url);
    if (!html) continue;
    const name = extractLabel(html, "lblName");
    if (!name) continue;
    return {
      name,
      backNo: extractLabel(html, "lblBackNo"),
      birthDate: parseKboBirthday(extractLabel(html, "lblBirthday")),
      position: parsePosition(extractLabel(html, "lblPosition"), isPitcher),
    };
  }
  return null;
}

async function main() {
  const roster = JSON.parse(fs.readFileSync(ROSTER_PATH, "utf8"));
  const rosterRaw = fs.readFileSync(ROSTER_PATH, "utf8");
  const hadTrailingNL = rosterRaw.endsWith("\n");
  const batters = JSON.parse(fs.readFileSync(BATTERS_PATH, "utf8"));
  const pitchers = JSON.parse(fs.readFileSync(PITCHERS_PATH, "utf8"));
  const foreignNumericToAlpha = loadForeignNumericToAlpha();

  const byId = new Map(roster.map((p) => [String(p.kboId), p]));

  // stats 에 나타난 선수 토큰 수집 (kboId 기준 dedup, 투수 여부 기록)
  const statPlayers = new Map(); // kboId -> {name, team, isPitcher}
  for (const b of batters) {
    const id = String(b.kboId ?? b.playerId ?? "").trim();
    if (id) statPlayers.set(id, { name: b.name, team: b.team, isPitcher: false });
  }
  for (const p of pitchers) {
    const id = String(p.kboId ?? p.playerId ?? "").trim();
    if (id && !statPlayers.has(id)) statPlayers.set(id, { name: p.name, team: p.team, isPitcher: true });
  }

  function resolves(id, name, team) {
    if (byId.has(id)) return true;
    const alpha = foreignNumericToAlpha[id];
    if (alpha && byId.has(alpha)) return true;
    // name+team 로도 이미 있으면 resolve 로 간주(중복 추가 방지)
    return roster.some((p) => (p.name === name || p.name.endsWith(name)) &&
      (p.team === team || p.teamId === TEAM_TO_ID[team]));
  }

  const missing = [];
  for (const [id, info] of statPlayers) {
    if (!/^\d+$/.test(id)) continue; // 외국인 canonical(FP/AQ)은 foreign-id-map 경유
    if (foreignNumericToAlpha[id]) continue; // 외국인 숫자 alias
    if (resolves(id, info.name, info.team)) continue;
    missing.push({ kboId: id, ...info });
  }

  if (missing.length === 0) {
    console.log("✅ reconcile: stats 의 모든 선수가 roster 로 resolve 됨 — 온보딩 불필요");
    return;
  }

  console.log(`🔧 reconcile: roster 미등록 stats 선수 ${missing.length}명 발견 → KBO 상세 보강 시도`);
  const onboarded = [];
  const failed = [];
  for (const m of missing) {
    const teamId = TEAM_TO_ID[m.team];
    if (!teamId) { failed.push({ ...m, reason: `unknown team ${m.team}` }); continue; }
    const detail = await fetchPlayerDetail(m.kboId, m.isPitcher);
    if (!detail) { failed.push({ ...m, reason: "KBO 상세 fetch 실패" }); continue; }
    const entry = {
      name: detail.name || m.name,
      kboId: m.kboId,
      teamId,
      position: detail.position,
      backNo: detail.backNo || "",
      team: m.team,
      birthDate: detail.birthDate || null,
    };
    onboarded.push(entry);
    if (verbose) console.log(`  + ${entry.name} (${entry.kboId}, ${entry.team}, ${entry.position}, No.${entry.backNo}, ${entry.birthDate})`);
  }

  for (const f of failed) {
    console.warn(`  ⚠️ 온보딩 실패: ${f.name} (${f.kboId}, ${f.team}) — ${f.reason}`);
  }

  if (onboarded.length === 0) {
    console.log("reconcile: 온보딩 가능한 선수 없음 (fetch 실패만 존재)");
    if (failed.length > 0) process.exitCode = 0; // 게이트는 validator 가 담당 — 여기선 실패시 조용히 넘김
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] roster 에 ${onboarded.length}명 추가 예정:`, onboarded.map((e) => `${e.name}(${e.kboId})`).join(", "));
    return;
  }

  const next = [...roster, ...onboarded];
  fs.writeFileSync(ROSTER_PATH, JSON.stringify(next, null, 2) + (hadTrailingNL ? "\n" : ""));
  console.log(`✅ reconcile: roster 에 ${onboarded.length}명 온보딩 완료 (${roster.length} → ${next.length})`);
  console.log(`   ${onboarded.map((e) => `${e.name}(${e.kboId})`).join(", ")}`);
  console.log("   사진은 후속 update-player-photos 스텝이 자동 다운로드/맵 재생성합니다.");
}

main().catch((e) => { console.error("reconcile 실패:", e); process.exit(1); });
