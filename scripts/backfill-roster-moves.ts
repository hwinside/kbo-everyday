/**
 * 로스터 등록/말소 백필 (2026 시즌 개막 3/28 ~ 2026-07-17).
 *
 * 소스: KBO 공식 Register.aspx 달력 — 과거 임의 날짜의 "당일 1군 등록/말소" 표를 직접 조회
 *       (스냅샷 diff 불필요, 날짜별 이벤트가 페이지에 그대로 있음). 우리가 매일 쓰는 그 페이지.
 *
 * 파싱 계약 (2026-07-19 삼순 NO-GO P0 재작업):
 *  Register.aspx 페이지는 두 개의 상이한 영역으로 구성된다.
 *   (A) "<팀> 선수등록명단" — 감독/코치/투수/포수/내야수/외야수 섹션별 전체 로스터 표
 *       (thead 2번째 <th>가 섹션명). ← 백필 대상 아님. 절대 긁지 않는다.
 *   (B) "<팀> 등/말소 현황" — 당일 등록/말소 "이벤트" 표. h5.bul_sub("등록"/"말소") 헤더가
 *       각 표를 라벨링하고, 각 행에 "포지션" 컬럼(투수/포수/내야수/외야수/코치/공백)이 있다.
 *  파서는 (B) 섹션만 슬라이스한 뒤, h5 헤더 텍스트로 등록/말소 표를 매칭한다
 *  (tbs 인덱스 추측 금지 — 한쪽만 있거나 순서가 바뀌어도 안전). 각 행의 포지션이
 *  선수 포지션 allowlist(투수/포수/내야수/외야수)에 없으면(코치·감독·공백·미지) 제외한다.
 *  → 코칭스태프 등/말소·포지션 공백 행이 roster_moves에 유입되지 않는다.
 *
 * 삽입 계약(라이브 cron과 동일 게이트):
 *  - 등록(register): checkPublishReadiness(①~③ 동기 + ④⑤⑥ HTTP 실측) 통과 시 status=published
 *    + canonical_id 저장(publishedRegisterHref 불변식). 미통과(방출/은퇴 등 resolve 실패)면 status=pending.
 *  - 말소(deregister): status=published, canonical_id=null(조회 시점 checkMoveReadiness로 링크 결정).
 *  - roster_moves UNIQUE(team_id,kbo_player_id,move_type,move_date) → 재실행 멱등(ON CONFLICT DO NOTHING).
 *  - 서버 diff/크론/스냅샷 로직 무변경. roster_moves 행만 소급 삽입.
 *
 * 사용:
 *   tsx scripts/backfill-roster-moves.ts               # dry-run: KBO 재수집 후 검증 리포트 (DB 미변경, readiness 미조회)
 *   tsx scripts/backfill-roster-moves.ts --cache <p>    # 재수집 대신 <p>의 원시 이벤트 JSON 재사용 (오프라인/디버그용)
 *   tsx scripts/backfill-roster-moves.ts --readiness    # dry-run + register readiness 실측 → published/pending 분해
 *   tsx scripts/backfill-roster-moves.ts --commit       # 프로덕션 삽입 (service_role, 멱등, readiness 포함)
 */
import fs from "fs";
import { pathToFileURL } from "url";
import { checkPublishReadiness } from "@/lib/roster-moves/readiness";

const KBO = "https://www.koreabaseball.com";
const PAGE = KBO + "/Player/Register.aspx";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const H = { "User-Agent": UA, Referer: PAGE, Accept: "text/html" };
const TARGET = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$btnCalendarSelect";
const TEAMF = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchTeam";
const DATEF = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchDate";
const TEAM_CODE_MAP: Record<string, number> = { LG: 1, OB: 2, KT: 3, SK: 4, NC: 5, HT: 6, LT: 7, SS: 8, HH: 9, WO: 10 };
const TEAMS = Object.keys(TEAM_CODE_MAP);
const SEASON_START = "2026-03-28";
const BACKFILL_END = "2026-07-17"; // 7/18은 baseline 스냅샷일이라 라이브 cron이 담당.

// 등/말소 현황 표의 포지션 컬럼 allowlist. 이 집합 밖(코치/감독/공백/미지)은 선수 이벤트가 아니므로 제외.
// src/lib/roster-moves/parse.ts의 PLAYER_SECTIONS와 동일 기준(선수 섹션만).
const PLAYER_POSITIONS = new Set(["투수", "포수", "내야수", "외야수"]);

interface ParsedMove { kboId: string; name: string; backNo: string; position: string; }
interface ExcludedMove { kboId: string; name: string; position: string; section: "register" | "deregister"; }
interface MoveTablesResult { reg: ParsedMove[]; der: ParsedMove[]; excluded: ExcludedMove[]; sectionFound: boolean; headerCount: number; }

interface RawEvent {
  date: string; teamId: number; teamCode: string;
  kboId: string; name: string; backNo: string; position: string;
  moveType: "register" | "deregister";
}

const grab = (html: string, id: string) => { const m = html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`)); return m ? m[1] : ""; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 한 구단 Register.aspx HTML → 당일 등록/말소 선수 이벤트.
 * (A) "등/말소 현황" 섹션만 슬라이스 → (B) h5.bul_sub 헤더로 등록/말소 표 매칭 →
 * (C) 각 행 포지션 allowlist 필터(코치/감독/공백 제외). 순수 함수(HTTP 없음) → fixture 테스트 대상.
 */
export function parseMoveTables(html: string): MoveTablesResult {
  const reg: ParsedMove[] = [];
  const der: ParsedMove[] = [];
  const excluded: ExcludedMove[] = [];

  // (A) "등/말소 현황" 섹션만 슬라이스 — 상단 "선수등록명단" role 표(감독/코치 포함)는 물리적으로 배제.
  const histIdx = html.indexOf("등/말소 현황");
  if (histIdx < 0) return { reg, der, excluded, sectionFound: false, headerCount: 0 };
  let endIdx = html.indexOf('id="cphContents_cphContents_cphContents_hfSearchTeam"', histIdx);
  if (endIdx < 0) endIdx = html.length;
  const section = html.slice(histIdx, endIdx);

  // (B) h5.bul_sub("등록"/"말소") 헤더 텍스트로 각 표를 매칭 — tbs 인덱스 추측 금지.
  const headerRe = /<h5 class="bul_sub"[^>]*>([^<]+)<\/h5>/g;
  let h: RegExpExecArray | null;
  let headerCount = 0;
  while ((h = headerRe.exec(section)) !== null) {
    const label = h[1].trim();
    const moveType: "register" | "deregister" | null =
      label === "등록" ? "register" : label === "말소" ? "deregister" : null;
    if (!moveType) continue;
    headerCount++;

    // 이 헤더 다음 첫 tNData 표.
    const tblRe = /<table class="tNData"[^>]*>([\s\S]*?)<\/table>/g;
    tblRe.lastIndex = h.index;
    const t = tblRe.exec(section);
    if (!t) continue;

    // "선수명" 헤더 표인지 + "포지션" 컬럼 위치 확인(가드).
    const thead = (t[1].match(/<thead>([\s\S]*?)<\/thead>/) || [])[1] || "";
    const ths = [...thead.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1].trim());
    if (ths[1] !== "선수명") continue;
    const posCol = ths.indexOf("포지션");
    if (posCol < 0) continue;

    const body = (t[1].match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || "";
    for (const trm of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const tds = [...trm[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      if (tds.length <= posCol) continue; // placeholder("선수가 없습니다" colspan) 행 스킵
      const a = tds[1].match(/playerId=(\d+)[^>]*>([^<]+)<\/a>/);
      if (!a) continue; // 링크 없는 공지/비고 행 스킵
      const backNo = tds[0].replace(/<[^>]+>/g, "").trim();
      const position = tds[posCol].replace(/<[^>]+>/g, "").trim();
      const entry: ParsedMove = { kboId: a[1], name: a[2].trim(), backNo, position };
      if (!PLAYER_POSITIONS.has(position)) {
        // 코치/감독/공백/미지 포지션 = 선수 이벤트 아님 → 제외(가시 로깅용 수집).
        excluded.push({ kboId: entry.kboId, name: entry.name, position, section: moveType });
        continue;
      }
      (moveType === "register" ? reg : der).push(entry);
    }
  }
  return { reg, der, excluded, sectionFound: true, headerCount };
}

async function getTokens() {
  const res = await fetch(PAGE, { headers: H });
  const html = await res.text();
  return { vs: grab(html, "__VIEWSTATE"), vg: grab(html, "__VIEWSTATEGENERATOR"), ev: grab(html, "__EVENTVALIDATION") };
}

function dateRange(startISO: string, endISO: string): string[] {
  const out: string[] = [];
  const d = new Date(startISO + "T00:00:00Z"); const end = new Date(endISO + "T00:00:00Z");
  while (d <= end) { out.push(d.toISOString().slice(0, 10).replace(/-/g, "")); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

/**
 * fail-closed 수집(삼순 P0-1): 각 날짜×팀 셀마다 (a)HTTP 200 (b)반환 hfSearchDate==요청일
 * (c)반환 hfSearchTeam==요청팀 (d)"등/말소 현황" 섹션 렌더+등록·말소 헤더 2개 모두 존재를
 * 검증한다. 하나라도 어긋나면 토큰 갱신 후 재시도하고, 재시도 소진 시 **throw**(빈 결과로
 * 확정 금지). 마지막에 coverage(성공 셀 수)==기대치(날짜×팀) 아니면 throw → partial scan 차단.
 */
async function scanAll(onExcluded: (e: ExcludedMove & { date: string; teamCode: string }) => void): Promise<{ events: RawEvent[]; cells: number; expected: number }> {
  const dates = dateRange(SEASON_START, BACKFILL_END);
  const expected = dates.length * TEAMS.length;
  let tok = await getTokens();
  const events: RawEvent[] = [];
  let cells = 0;
  const MAX_ATTEMPTS = 5;
  for (let di = 0; di < dates.length; di++) {
    const date = dates[di];
    if (di > 0 && di % 10 === 0) tok = await getTokens();
    for (const team of TEAMS) {
      let ok = false;
      let lastErr = "";
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !ok; attempt++) {
        try {
          const body = new URLSearchParams({ __EVENTTARGET: TARGET, __EVENTARGUMENT: "", __VIEWSTATE: tok.vs, __VIEWSTATEGENERATOR: tok.vg, __EVENTVALIDATION: tok.ev, [TEAMF]: team, [DATEF]: date });
          const res = await fetch(PAGE, { method: "POST", headers: { ...H, "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const html = await res.text();
          const retDate = grab(html, "cphContents_cphContents_cphContents_hfSearchDate");
          const retTeam = grab(html, "cphContents_cphContents_cphContents_hfSearchTeam");
          if (retDate !== date) throw new Error(`date mismatch got=${retDate} want=${date}`);
          if (retTeam !== team) throw new Error(`team mismatch got=${retTeam} want=${team}`);
          const parsed = parseMoveTables(html);
          if (!parsed.sectionFound || parsed.headerCount < 2) throw new Error(`section incomplete (found=${parsed.sectionFound} headers=${parsed.headerCount})`);
          for (const p of parsed.reg) events.push({ date, teamId: TEAM_CODE_MAP[team], teamCode: team, ...p, moveType: "register" });
          for (const p of parsed.der) events.push({ date, teamId: TEAM_CODE_MAP[team], teamCode: team, ...p, moveType: "deregister" });
          for (const x of parsed.excluded) onExcluded({ ...x, date, teamCode: team });
          ok = true;
          cells++;
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
          await sleep(600);
          tok = await getTokens();
        }
      }
      if (!ok) throw new Error(`[scan fail-closed] ${date} ${team} ${MAX_ATTEMPTS}회 재시도 소진: ${lastErr}`);
      await sleep(120);
    }
    if (di % 10 === 0) console.error(`  ...${date} (events ${events.length}, cells ${cells}/${expected})`);
  }
  if (cells !== expected) throw new Error(`[coverage] ${cells}/${expected} 셀만 성공 — partial scan, 미완`);
  return { events, cells, expected };
}

/**
 * 하드 검증 게이트(삼순 P0-2): 위반이 하나라도 있으면 throw → readiness/commit 전 종료.
 * 출력만 하던 리포트와 달리 이 함수가 실제로 커밋을 막는다. cache 입력도 이 게이트를 통과해야 한다.
 */
function assertClean(events: RawEvent[], cells: number, expected: number): void {
  const coach = events.filter((e) => e.position === "코치").length;
  const blank = events.filter((e) => !e.position || !e.position.trim()).length;
  const nonPlayer = events.filter((e) => !PLAYER_POSITIONS.has(e.position)).length;
  const seen = new Map<string, number>();
  for (const e of events) { const k = `${e.teamId}|${e.kboId}|${e.moveType}|${e.date}`; seen.set(k, (seen.get(k) || 0) + 1); }
  const dup = [...seen.values()].filter((n) => n > 1).length;
  const early = events.filter((e) => e.date === "20260328" || e.date === "20260329").length;
  const errs: string[] = [];
  if (coach) errs.push(`코치 ${coach}`);
  if (blank) errs.push(`포지션공백 ${blank}`);
  if (nonPlayer) errs.push(`비선수 ${nonPlayer}`);
  if (dup) errs.push(`중복키 ${dup}`);
  if (early) errs.push(`개막이전(3/28~29) ${early}`);
  if (cells !== expected) errs.push(`coverage ${cells}/${expected}`);
  if (errs.length) throw new Error(`[VALIDATION FAILED] ${errs.join(" / ")} — readiness/commit 차단(fail-closed)`);
}

interface Row { team_id: number; kbo_player_id: string; player_name: string; move_type: string; move_date: string; status: string; canonical_id: string | null; }

function isoDate(yyyymmdd: string) { return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`; }

async function buildRows(events: RawEvent[]): Promise<Row[]> {
  // 등록 선수 readiness 캐시(유니크 kboId 1회 프로브).
  const cache = new Map<string, { ready: boolean; canonicalId: string | null }>();
  const regIds = [...new Set(events.filter((e) => e.moveType === "register").map((e) => e.kboId))];
  let done = 0;
  for (const id of regIds) {
    const r = await checkPublishReadiness(id);
    cache.set(id, { ready: r.ready, canonicalId: r.canonicalId });
    if (++done % 50 === 0) console.error(`  readiness ${done}/${regIds.length}`);
  }
  const rows: Row[] = [];
  for (const e of events) {
    if (e.moveType === "register") {
      const r = cache.get(e.kboId)!;
      rows.push({ team_id: e.teamId, kbo_player_id: e.kboId, player_name: e.name, move_type: "register", move_date: isoDate(e.date), status: r.ready ? "published" : "pending", canonical_id: r.ready ? r.canonicalId : null });
    } else {
      rows.push({ team_id: e.teamId, kbo_player_id: e.kboId, player_name: e.name, move_type: "deregister", move_date: isoDate(e.date), status: "published", canonical_id: null });
    }
  }
  return rows;
}

function readEnv(k: string): string {
  const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

async function insertRows(rows: Row[]) {
  const url = readEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  const endpoint = `${url}/rest/v1/roster_moves`;
  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(batch),
    });
    if (!res.ok) { const t = await res.text(); throw new Error(`insert batch ${i} HTTP ${res.status}: ${t.slice(0, 300)}`); }
    inserted += batch.length;
    console.error(`  inserted batch → ${inserted}/${rows.length}`);
  }
}

/** 검증 리포트: 오염(코치/공백) 0·중복키 0·3-28~3-29 0·날짜별 표본 대조. */
function printValidationReport(events: RawEvent[], excluded: (ExcludedMove & { date: string; teamCode: string })[]) {
  const reg = events.filter((e) => e.moveType === "register");
  const der = events.filter((e) => e.moveType === "deregister");
  const coach = events.filter((e) => e.position === "코치");
  const blank = events.filter((e) => !e.position || e.position.trim() === "");
  const nonPlayer = events.filter((e) => !PLAYER_POSITIONS.has(e.position));
  // 중복키(team_id,kbo_player_id,move_type,move_date).
  const seen = new Map<string, number>();
  for (const e of events) { const k = `${e.teamId}|${e.kboId}|${e.moveType}|${e.date}`; seen.set(k, (seen.get(k) || 0) + 1); }
  const dupKeys = [...seen.entries()].filter(([, n]) => n > 1);
  // 3/28~3/29.
  const early = events.filter((e) => e.date === "20260328" || e.date === "20260329");
  const dates = events.map((e) => e.date).sort();

  console.log("=== BACKFILL VALIDATION (clean re-scan, dry-run) ===");
  console.log(`total events : ${events.length}  (register ${reg.length}, deregister ${der.length})`);
  console.log(`position=코치 : ${coach.length}   (기대 0)`);
  console.log(`position 공백 : ${blank.length}   (기대 0)`);
  console.log(`non-player pos: ${nonPlayer.length}   (기대 0 — allowlist 밖 전부)`);
  console.log(`중복키(team,player,type,date): ${dupKeys.length}   (기대 0)`);
  if (dupKeys.length) for (const [k, n] of dupKeys.slice(0, 20)) console.log(`   DUP ${k} ×${n}`);
  console.log(`move_date 3/28~3/29: ${early.length}   (기대 0 — KBO 무브 미표기)`);
  console.log(`date span    : ${dates[0]} ~ ${dates[dates.length - 1]}`);

  // 파서가 제외한 오염 행(코치/감독/공백) — 가시성.
  console.log(`\n--- 파서 제외 행(코치/감독/공백/미지 포지션) : ${excluded.length}건 ---`);
  const byPos = new Map<string, number>();
  for (const x of excluded) byPos.set(x.position || "(공백)", (byPos.get(x.position || "(공백)") || 0) + 1);
  for (const [p, n] of byPos) console.log(`   제외 포지션 "${p}": ${n}건`);
  for (const x of excluded.slice(0, 12)) console.log(`   - ${x.date} ${x.teamCode} ${x.section} ${x.name} pos="${x.position}" (${x.kboId})`);

  // 날짜별 원표 표본 대조(3개 날짜).
  const sampleDates = ["20260401", "20260415", "20260426"];
  console.log(`\n--- 날짜별 원표 표본 대조 ---`);
  for (const d of sampleDates) {
    const evs = events.filter((e) => e.date === d);
    console.log(`   [${isoDate(d)}] ${evs.length}건`);
    for (const e of evs.slice(0, 12)) console.log(`      ${e.teamCode} ${e.moveType} ${e.name} pos="${e.position}" (${e.kboId})`);
  }
}

async function main() {
  const commit = process.argv.includes("--commit");
  const withReadiness = commit || process.argv.includes("--readiness");
  const cacheFlagIdx = process.argv.indexOf("--cache");
  const cachePath = cacheFlagIdx >= 0 ? process.argv[cacheFlagIdx + 1] : null;
  const outFlagIdx = process.argv.indexOf("--out");
  const outName = outFlagIdx >= 0 ? process.argv[outFlagIdx + 1] : "backfill-raw.clean.json";

  const dates = dateRange(SEASON_START, BACKFILL_END);
  const expected = dates.length * TEAMS.length;
  const excludedAll: (ExcludedMove & { date: string; teamCode: string })[] = [];
  let events: RawEvent[];
  let cells: number;
  if (cachePath) {
    // cache도 동일 게이트 강제(삼순 P0-2): coverage 증빙 없는 bare 배열은 거부 → 전체 스캔 산출물만 허용.
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (Array.isArray(raw) || typeof raw.cells !== "number" || !Array.isArray(raw.events)) {
      throw new Error(`[cache] coverage 증빙 없는 입력 — {cells,expected,events} 형식의 완전 스캔 산출물(.clean.json)만 허용`);
    }
    events = raw.events; cells = raw.cells;
    console.error(`[cache] loaded ${events.length} events (coverage ${cells}/${expected}) from ${cachePath}`);
  } else {
    console.error("scanning KBO Register.aspx (3/28~7/17 × 10 teams, 등/말소 섹션만, fail-closed)...");
    const r = await scanAll((x) => excludedAll.push(x));
    events = r.events; cells = r.cells;
    const outPath = new URL(`../${outName}`, import.meta.url);
    fs.writeFileSync(outPath, JSON.stringify({ cells, expected, events }, null, 2));
    console.error(`[scan] wrote ${events.length} clean events (coverage ${cells}/${expected}) → ${outName}`);
  }

  // ★ 하드 게이트 — 위반 시 여기서 throw(readiness/insert 도달 전 종료).
  assertClean(events, cells, expected);
  printValidationReport(events, excludedAll);

  if (withReadiness) {
    console.error("\nprobing register readiness (published/pending 분해)...");
    const rows = await buildRows(events);
    const reg = rows.filter((r) => r.move_type === "register");
    const pubReg = reg.filter((r) => r.status === "published").length;
    console.log(`\nregister published: ${pubReg}, pending: ${reg.length - pubReg}`);
    console.log(`deregister published: ${rows.filter((r) => r.move_type === "deregister").length} (all)`);
    if (commit) {
      console.log("\n[COMMIT] inserting into roster_moves (ON CONFLICT DO NOTHING)...");
      await insertRows(rows);
      console.log("done.");
      return;
    }
  }
  if (!commit) console.log("\n[DRY-RUN] no DB write. add --commit to insert.");
}

// 직접 실행일 때만 CLI 구동 — import(fixture 테스트) 시 부작용 없음.
const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isDirectRun) {
  main().catch((e) => { console.error("FATAL", e); process.exit(1); });
}
