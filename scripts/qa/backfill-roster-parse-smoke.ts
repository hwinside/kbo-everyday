/**
 * 백필 파서(parseMoveTables) 회귀 스모크 — 2026-07-19 삼순 NO-GO P0 재작업 검증.
 * 실행: npx tsx scripts/qa/backfill-roster-parse-smoke.ts  (npm run qa:backfill-roster-parse)
 *
 * 고정 fixture(실제 KBO Register.aspx HTML)로 아래를 강제한다:
 *   - "등/말소 현황" 섹션만 파싱, 상단 "선수등록명단" role 표(감독/코치 포함)는 무시
 *   - h5.bul_sub("등록"/"말소") 헤더로 표 매칭(인덱스 추측 금지)
 *   - 포지션 allowlist(투수/포수/내야수/외야수) 밖(코치/감독/공백)은 제외 + excluded로 수집
 * fixture 출처(캡처 날짜/팀)와 기대값은 KBO 원표에서 눈으로 대조해 하드코딩했다.
 */
import fs from "fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMoveTables, assertRunMode } from "../backfill-roster-moves";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(__dirname, "fixtures", "backfill-roster");
const read = (f: string) => fs.readFileSync(path.join(FX, f), "utf8");

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { console.log(`✓ ${name}`); pass++; }
  else { console.error(`✗ ${name}\n  got:  ${g}\n  want: ${w}`); fail++; }
}
const names = (arr: { name: string }[]) => arr.map((x) => x.name);

// 1) 정상 선수 등록/말소 (HH 2026-04-01) — 코치/공백 없음.
{
  const r = parseMoveTables(read("register-deregister-players.html"));
  check("HH0401 register names", names(r.reg), ["박재규", "박상원", "강건우", "류현진"]);
  check("HH0401 deregister names", names(r.der), ["엄상백", "화이트", "강재민", "최유빈"]);
  check("HH0401 all positions are player positions",
    r.reg.concat(r.der).every((e) => ["투수", "포수", "내야수", "외야수"].includes(e.position)), true);
  check("HH0401 excluded empty", r.excluded.length, 0);
}

// 2) 코치 전용 (LG 2026-04-15) — 등록 김용의(코치)/말소 송지만(코치) → 전부 제외.
{
  const r = parseMoveTables(read("coach-only.html"));
  check("LG0415 register empty (coach excluded)", r.reg.length, 0);
  check("LG0415 deregister empty (coach excluded)", r.der.length, 0);
  check("LG0415 excluded coach count", r.excluded.length, 2);
  check("LG0415 excluded names", names(r.excluded).sort(), ["김용의", "송지만"]);
  check("LG0415 excluded all 코치", r.excluded.every((e) => e.position === "코치"), true);
}

// 3) 공백 포지션 혼합 (WO 2026-04-26) — 등록: 박병호(공백,제외)+박준현(투수,유지) / 말소: 김성민(투수).
{
  const r = parseMoveTables(read("blank-position-mixed.html"));
  check("WO0426 register keeps only 박준현", names(r.reg), ["박준현"]);
  check("WO0426 deregister 김성민", names(r.der), ["김성민"]);
  check("WO0426 excluded 박병호 (blank)", names(r.excluded), ["박병호"]);
  check("WO0426 excluded position blank", r.excluded[0]?.position, "");
  check("WO0426 no blank position leaked",
    r.reg.concat(r.der).every((e) => e.position.trim() !== ""), true);
}

// 4) 무브 없음 (LG 2026-06-01) — 등록/말소 표 모두 "선수가 없습니다" placeholder → 전부 0.
{
  const r = parseMoveTables(read("empty-moves.html"));
  check("LG0601 register empty", r.reg.length, 0);
  check("LG0601 deregister empty", r.der.length, 0);
  check("LG0601 excluded empty", r.excluded.length, 0);
}

// 5) role 표(감독/코치/투수…)는 절대 유입 안 됨 — 코치 role 표가 있어도 코치 이벤트 0.
{
  for (const f of ["register-deregister-players.html", "coach-only.html", "blank-position-mixed.html", "empty-moves.html"]) {
    const r = parseMoveTables(read(f));
    const coachLeak = r.reg.concat(r.der).filter((e) => e.position === "코치" || e.position === "감독");
    check(`${f} no coach/manager in reg+der`, coachLeak.length, 0);
  }
}

// 6) 정상 fixture는 유효 표 2개(등록+말소) → validTables===2 (셀 성공 기준).
{
  for (const f of ["register-deregister-players.html", "coach-only.html", "blank-position-mixed.html", "empty-moves.html"]) {
    const r = parseMoveTables(read(f));
    check(`${f} validTables===2 (유효 표 2개)`, r.validTables, 2);
  }
}

// 7) [FAULT-INJECTION P0-1] 표가 깨진 HTML(tNData 클래스 변경)은 유효 표 미확보 → validTables<2.
//    삼순 재현: 헤더만 남고 표 파싱이 깨진 HTML도 이전엕 headers==2로 셀 성공 확정되던 버그 차단.
{
  const broken = read("register-deregister-players.html").replace(/class="tNData"/g, 'class="tXData"');
  const r = parseMoveTables(broken);
  check("broken tNData → validTables<2 (셀 실패 간주)", r.validTables < 2, true);
  check("broken tNData → reg/der 빈(실변동을 0건으로 확정 금지)", r.reg.length + r.der.length, 0);
}

// 8) [FAULT-INJECTION P0-2] --commit과 --cache 동시 사용은 assertRunMode가 throw(삽입 fresh 스캔 강제).
{
  let threw = false;
  try { assertRunMode(true, "backfill-raw.clean1.json"); } catch { threw = true; }
  check("assertRunMode(commit+cache) throws", threw, true);
  // 정상 조합은 통과.
  let ok = true;
  try { assertRunMode(true, null); assertRunMode(false, "x.json"); } catch { ok = false; }
  check("assertRunMode(commit-only / cache-only) ok", ok, true);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
