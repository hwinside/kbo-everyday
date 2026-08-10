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
 * 2026-07-18 확장(로스터 변동 정정 스펙 — "에셋을 미리 준비하고 모든 선수 노출"):
 * stats 기반 후보에 더해 KBO 공식 등록명단(Player/Register.aspx)도 후보 소스로 쓴다.
 * 콜업 직후 선수는 아직 stats 에 안 잡혀도 등록명단엔 있으므로, 새벽 크롤이 선수 상세
 * 링크용 에셋(로스터 SSOT→사진)을 능동적으로 준비해 둔다. 파서는 PR #684의
 * src/lib/roster-moves/parse.ts 를 tsx tsImport 로 그대로 재사용(복제 금지, 실측 확인).
 * 등록명단 fetch/파싱 실패는 경고만 남기고 기존 stats 경로만으로 정상 완주한다
 * (기존 기능 침범 금지 — 하위호환 유지).
 *
 * 외국인 canonical(FP/AQ)은 foreign-id-map 경유라 여기서 건드리지 않는다
 * (등록명단의 외국인 숫자 alias는 skip+로그만).
 * roster/identity 검증은 그대로 게이트로 남아 최종 안전망 역할을 한다.
 *
 * Usage: node scripts/reconcile-roster-from-stats.mjs [--dry-run] [--verbose]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNewlyOnboardedPhotoManifest,
  classifyForeign,
  mergePendingReport,
  resolveTeamRegisterParser,
} from "./lib/foreign-onboard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ROSTER_PATH = path.join(ROOT, "src/lib/constants/players-roster.json");
// 입단 정보는 roster 와 분리 보관한다(크롤 재조립·census 해시 격리 — backfill-roster-draft.mjs 참조).
const DRAFT_PATH = path.join(ROOT, "src/lib/constants/players-draft.json");
const BATTERS_PATH = path.join(ROOT, "src/lib/constants/stats-2026-batters.json");
const PITCHERS_PATH = path.join(ROOT, "src/lib/constants/stats-2026-pitchers.json");
const FOREIGN_MAP_PATH = path.join(ROOT, "src/lib/constants/foreign-id-map.ts");
const NATIONALITY_PATH = path.join(ROOT, "src/lib/constants/player-nationality.json");
const FOREIGN_PENDING_PATH = path.join(ROOT, "src/lib/constants/foreign-nationality-pending.json");
// P0 사진 게이트 인계 파일 — 외국인 휴리스틱과 무관하게 이번 실행에서 신규 온보딩된 숫자 id 전원.
// tmp/ 는 gitignore 대상이라 자동 PR diff에 노출되지 않음 — 같은 CI job 내 다음 스텝(qa:foreign-onboard-photo-gate)만 소비.
const NEW_FOREIGN_PHOTO_MANIFEST_PATH = path.join(ROOT, "tmp/reconcile-newly-onboarded-foreign.json");

function writeNewForeignPhotoManifest(entries) {
  fs.mkdirSync(path.dirname(NEW_FOREIGN_PHOTO_MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(NEW_FOREIGN_PHOTO_MANIFEST_PATH, JSON.stringify(entries, null, 2) + "\n");
}

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const verbose = argv.includes("--verbose");

// team(한글 약칭) → teamId (roster SSOT 실측 기준)
const TEAM_TO_ID = {
  LG: 1, 두산: 2, KT: 3, SSG: 4, NC: 5, KIA: 6, 롯데: 7, 삼성: 8, 한화: 9, 키움: 10,
};
const ID_TO_TEAM = Object.fromEntries(Object.entries(TEAM_TO_ID).map(([t, id]) => [id, t]));

// KBO 팀 코드 → teamId (kbo-api.ts TEAM_CODE_MAP과 동일 기준)
const KBO_CODE_TO_ID = {
  LG: 1, OB: 2, KT: 3, SK: 4, NC: 5, HT: 6, LT: 7, SS: 8, HH: 9, WO: 10,
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
      // 입단 정보 — 외국인 신규 영입은 "자유선발"로 표기된다(실측: 세베리노/아빌라/페덱/디아즈).
      draft: extractLabel(html, "lblDraft"),
    };
  }
  return null;
}

/* ===== (2026-07-18) KBO 공식 등록명단(Register.aspx) 후보 소스 =====
 * HTTP postback 계약(GET 1 + hfSearchTeam postback 10회)은 src/lib/crawler/kbo-api.ts
 * fetchRegisterRosters 와 동일 실측 기준. TS 모듈은 앱 의존(@ alias·모니터링)을
 * 끌고 와 plain node 로 못 불러오므로 HTTP 흐름만 여기 미러링하고,
 * HTML 파서는 parse.ts 를 tsx tsImport 로 그대로 재사용한다(복제 금지 — 실측 확인).
 */
const REGISTER_URL = "https://www.koreabaseball.com/Player/Register.aspx";
const REGISTER_POSTBACK_TARGET = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$btnCalendarSelect";
const REGISTER_TEAM_FIELD = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchTeam";
const REGISTER_DATE_FIELD = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchDate";

function extractRegisterHidden(html, id) {
  const m = html.match(new RegExp(`id="${id}" value="([^"]*)"`));
  return m ? m[1] : "";
}

/** 10개 구단 1군 등록명단 → flat 선수 목록 [{kboId,name,backNo,position,teamId,team}] */
async function fetchRegisterEntries() {
  const { tsImport } = await import("tsx/esm/api");
  const rosterMoveModule = await tsImport("../src/lib/roster-moves/parse.ts", import.meta.url);
  const parseTeamRegister = resolveTeamRegisterParser(rosterMoveModule);

  const initRes = await fetch(REGISTER_URL, { headers: { ...KBO_HEADERS, Referer: REGISTER_URL } });
  if (!initRes.ok) throw new Error(`Register.aspx GET HTTP ${initRes.status}`);
  const initHtml = await initRes.text();
  const viewState = extractRegisterHidden(initHtml, "__VIEWSTATE");
  const eventValidation = extractRegisterHidden(initHtml, "__EVENTVALIDATION");
  if (!viewState || !eventValidation) throw new Error("Register.aspx 폼 토큰 추출 실패");
  const viewStateGen = extractRegisterHidden(initHtml, "__VIEWSTATEGENERATOR");
  const date = extractRegisterHidden(initHtml, "cphContents_cphContents_cphContents_hfSearchDate");

  const entries = [];
  for (const [code, teamId] of Object.entries(KBO_CODE_TO_ID)) {
    const body = new URLSearchParams({
      __EVENTTARGET: REGISTER_POSTBACK_TARGET,
      __EVENTARGUMENT: "",
      __VIEWSTATE: viewState,
      __VIEWSTATEGENERATOR: viewStateGen,
      __EVENTVALIDATION: eventValidation,
      [REGISTER_TEAM_FIELD]: code,
      [REGISTER_DATE_FIELD]: date,
    });
    const res = await fetch(REGISTER_URL, {
      method: "POST",
      headers: { ...KBO_HEADERS, Referer: REGISTER_URL, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`Register.aspx ${code} POST HTTP ${res.status}`);
    const html = await res.text();
    const team = ID_TO_TEAM[teamId];
    for (const e of parseTeamRegister(html)) entries.push({ ...e, teamId, team });
  }
  return entries;
}

async function main() {
  const roster = JSON.parse(fs.readFileSync(ROSTER_PATH, "utf8"));
  const rosterRaw = fs.readFileSync(ROSTER_PATH, "utf8");
  const hadTrailingNL = rosterRaw.endsWith("\n");
  const batters = JSON.parse(fs.readFileSync(BATTERS_PATH, "utf8"));
  const pitchers = JSON.parse(fs.readFileSync(PITCHERS_PATH, "utf8"));
  const foreignNumericToAlpha = loadForeignNumericToAlpha();
  const nationalityMap = (() => {
    try { return JSON.parse(fs.readFileSync(NATIONALITY_PATH, "utf8")); }
    catch { return {}; }
  })();

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

  // (2026-07-18) 등록명단 기반 후보 추가 — 콜업 직후 stats 미반영 선수도 능동 온보딩.
  // 수집 실패는 경고 후 skip — 기존 stats 경로만으로 정상 완주(하위호환, 기존 기능 침범 금지).
  try {
    const entries = await fetchRegisterEntries();
    const before = missing.length;
    for (const e of entries) {
      if (!/^\d+$/.test(e.kboId)) continue;
      if (foreignNumericToAlpha[e.kboId]) {
        // 외국인 canonical(FP/AQ)은 foreign-id-map 경유 — 여기서 건드리지 않음(skip+로그만)
        if (verbose) console.log(`  · 등록명단 외국인 alias skip: ${e.name}(${e.kboId})`);
        continue;
      }
      if (statPlayers.has(e.kboId)) continue; // stats 경로에서 이미 판정됨
      if (resolves(e.kboId, e.name, e.team)) continue;
      missing.push({ kboId: e.kboId, name: e.name, team: e.team, isPitcher: e.position === "투수", source: "register" });
    }
    console.log(`📋 등록명단 ${entries.length}명 수집 → 신규 온보딩 후보 ${missing.length - before}명`);
  } catch (err) {
    console.warn(`⚠️ 등록명단 수집 실패 — stats 경로만으로 진행: ${err?.message ?? err}`);
  }

  if (missing.length === 0) {
    console.log("✅ reconcile: stats/등록명단의 모든 선수가 roster 로 resolve 됨 — 온보딩 불필요");
    if (!dryRun) {
      writeNewForeignPhotoManifest([]);
      await updateForeignPending([], nationalityMap);
    }
    return;
  }

  console.log(`🔧 reconcile: roster 미등록 선수 ${missing.length}명 발견(stats+등록명단) → KBO 상세 보강 시도`);
  const onboarded = [];
  const failed = [];
  const draftAdditions = {}; // 신규 온보딩 선수의 lblDraft 원문 — players-draft.json 에 병합
  const foreignPendingNew = []; // 신규 외국인(숫자 직결 온보딩) 중 국적 미등록 — 알림 대상
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
    // 입단 정보 지속 결속(삼순 2026-08-09): 신규 온보딩 선수의 lblDraft 를 draft 파일에도
    // 기록한다. 기록하지 않으면 exact key-set 게이트(genius-draft-year-smoke)가 RED 를 내고,
    // 그 전까지 이 선수의 입단 질문은 "아직 확인 못 함"으로 남는다.
    // detail.draft === null(조회 실패)이면 쓰지 않는다 — workflow 의 backfill 스텝이 재시도한다.
    if (detail.draft !== null && detail.draft !== undefined) {
      draftAdditions[String(m.kboId)] = detail.draft.trim();
    }
    if (verbose) console.log(`  + ${entry.name} (${entry.kboId}, ${entry.team}, ${entry.position}, No.${entry.backNo}, ${entry.birthDate})`);

    // A안: 신규 외국인은 숫자 id로 그대로 온보딩(페이지·사진 자동). 단 국적(국기)은
    // 자동 소스가 없어 사람 큐레이션이 필요 → "국적 미등록 외인"만 알림 대상으로 수집한다.
    // (분류 오판은 알림 노이즈/누락일 뿐 온보딩 자체엔 영향 없음 — foreign-onboard.mjs 참고)
    if (classifyForeign(detail)) {
      if (!Object.prototype.hasOwnProperty.call(nationalityMap, String(m.kboId))) {
        foreignPendingNew.push({ kboId: String(m.kboId), name: entry.name, team: entry.team, draft: detail.draft || "" });
      }
    }
  }

  for (const f of failed) {
    console.warn(`  ⚠️ 온보딩 실패: ${f.name} (${f.kboId}, ${f.team}) — ${f.reason}`);
  }

  if (onboarded.length === 0) {
    console.log("reconcile: 온보딩 가능한 선수 없음 (fetch 실패/외국인 skip만 존재)");
    if (failed.length > 0) process.exitCode = 0; // 게이트는 validator 가 담당 — 여기선 실패시 조용히 넘김
    if (!dryRun) {
      writeNewForeignPhotoManifest([]);
      await updateForeignPending([], nationalityMap);
    }
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] roster 에 ${onboarded.length}명 추가 예정:`, onboarded.map((e) => `${e.name}(${e.kboId})`).join(", "));
    if (foreignPendingNew.length > 0) {
      console.log(`[dry-run] 국적 미등록 외인 후보 ${foreignPendingNew.length}명:`, foreignPendingNew.map((p) => `${p.name}(${p.kboId})`).join(", "));
    }
    return;
  }

  const next = [...roster, ...onboarded];
  fs.writeFileSync(ROSTER_PATH, JSON.stringify(next, null, 2) + (hadTrailingNL ? "\n" : ""));
  // 입단 정보 병합 저장 — 기존 키는 건드리지 않고 신규만 더한다(재실행 안전).
  if (Object.keys(draftAdditions).length > 0) {
    let draftMap = {};
    try { draftMap = JSON.parse(fs.readFileSync(DRAFT_PATH, "utf8")); } catch { draftMap = {}; }
    for (const [kboId, draft] of Object.entries(draftAdditions)) {
      if (!Object.prototype.hasOwnProperty.call(draftMap, kboId)) draftMap[kboId] = draft;
    }
    const sortedDraft = Object.fromEntries(Object.keys(draftMap).sort().map((k) => [k, draftMap[k]]));
    fs.writeFileSync(DRAFT_PATH, JSON.stringify(sortedDraft, null, 2) + "\n");
    console.log(`  ↳ players-draft.json 에 신규 ${Object.keys(draftAdditions).length}명 입단 정보 병합`);
  }
  console.log(`✅ reconcile: roster 에 ${onboarded.length}명 온보딩 완료 (${roster.length} → ${next.length})`);
  console.log(`   ${onboarded.map((e) => `${e.name}(${e.kboId})`).join(", ")}`);
  console.log("   사진은 후속 update-player-photos 스텝이 자동 다운로드/맵 재생성합니다.");

  writeNewForeignPhotoManifest(buildNewlyOnboardedPhotoManifest(onboarded));
  await updateForeignPending(foreignPendingNew, nationalityMap);
}

/**
 * 신규 외국인 국적 미등록 리포트 갱신 + 알림(A안 슬라이스 1).
 * - foreign-nationality-pending.json: SSOT(사람이 국적 넣으면 다음 실행에 자동 소멸). 자동PR diff에 노출.
 * - GitHub Actions ::warning:: 어노테이션 + STEP_SUMMARY로 크롤 실행 가시화.
 * - FOREIGN_ONBOARD_WEBHOOK 설정 시 Slack best-effort POST(미설정이면 no-op).
 */
async function updateForeignPending(foreignPendingNew, nationalityMap) {
  const existing = (() => {
    try { return JSON.parse(fs.readFileSync(FOREIGN_PENDING_PATH, "utf8")); }
    catch { return {}; }
  })();
  const merged = mergePendingReport(existing, foreignPendingNew, nationalityMap, new Date().toISOString());

  // 정렬된 키로 안정적 직렬화(자동PR diff 노이즈 최소화)
  const sorted = {};
  for (const k of Object.keys(merged).sort()) sorted[k] = merged[k];
  const nextJson = JSON.stringify(sorted, null, 2) + "\n";
  const prevJson = (() => { try { return fs.readFileSync(FOREIGN_PENDING_PATH, "utf8"); } catch { return ""; } })();
  if (nextJson !== prevJson) fs.writeFileSync(FOREIGN_PENDING_PATH, nextJson);

  if (foreignPendingNew.length === 0) return;

  const lines = foreignPendingNew.map((p) => `${p.name}(${p.kboId}, ${p.team})`);
  console.log(`\n🚩 신규 외국인 ${foreignPendingNew.length}명 온보딩 — 국적(국기) 미등록, 사람 확인 필요:`);
  for (const l of lines) console.log(`   • ${l}  → player-nationality.json 에 ISO alpha-2 추가`);

  // GitHub Actions 어노테이션(크롤 실행/PR 체크에 노출)
  for (const p of foreignPendingNew) {
    console.log(`::warning title=신규 외국인 국적 미등록::${p.name}(${p.kboId}, ${p.team}) — player-nationality.json 국적 추가 필요`);
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      fs.appendFileSync(summaryPath, `\n### 🚩 신규 외국인 국적 미등록 ${foreignPendingNew.length}명\n` +
        foreignPendingNew.map((p) => `- ${p.name} (\`${p.kboId}\`, ${p.team})`).join("\n") + "\n");
    } catch { /* ignore */ }
  }

  // Slack webhook(best-effort, 미설정이면 no-op) — cron/CI에서 직접 HTTP POST이라 메시지 툴 제약 무관.
  const webhook = process.env.FOREIGN_ONBOARD_WEBHOOK;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `🚩 신규 외국인 ${foreignPendingNew.length}명 자동 온보딩(페이지·사진 OK) — 국적 미등록:\n` +
            lines.map((l) => `• ${l}`).join("\n") + `\nplayer-nationality.json 에 ISO alpha-2 추가하면 국기 표시됩니다.`,
        }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      console.warn(`  ⚠️ Slack 알림 실패(무시 가능): ${err?.message ?? err}`);
    }
  }
}

main().catch((e) => { console.error("reconcile 실패:", e); process.exit(1); });
