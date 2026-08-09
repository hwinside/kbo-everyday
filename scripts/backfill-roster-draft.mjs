#!/usr/bin/env node
/**
 * 로스터 **입단 정보** 백필 (재실행 안전)
 *
 * KBO 공식 선수 상세의 `lblDraft`(예 `11 LG 1라운드 2순위`)를 읽어
 * `players-roster.json` 각 선수에 `draft` 원문을 채운다.
 *
 * ⚠️ 파싱은 **여기서 하지 않는다.** 원문만 저장하고 연도·구단 해석은
 *   `src/lib/baseball-qa/roster/draft.ts` 한 곳에서만 한다 — 파싱이 두 곳에 있으면
 *   한쪽만 고쳐져 값이 갈린다(SSOT 단일화).
 *
 * - 로스터 membership/순서는 건드리지 않는다 — `draft` 필드만 추가/갱신.
 * - 이미 `draft` 가 있는 선수는 skip (재실행 시 이어서). `--force` 로 전체 갱신.
 * - 공식 페이지가 빈 문자열을 주는 선수(외국인·육성 등)는 `""` 로 확정 저장한다.
 *   `null` 과 구분해야 "아직 안 긁음"과 "긁었는데 공식에 없음"이 갈린다.
 *
 * Usage:
 *   node scripts/backfill-roster-draft.mjs [--force] [--limit N]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROSTER_PATH = join(__dirname, "..", "src/lib/constants/players-roster.json");
// ⚠️ 입단 정보는 **별도 파일**이다. roster JSON 에 얹으면 상시 크롤(crawl-roster-v2)이
//   고정 필드 목록으로 재조립할 때 통째로 날아간다(실측). roster 해시가 corpus census
//   지문에 묶여 있는 것도 이유다 — 무관한 필드 추가가 그 게이트를 깨뜨린다.
const DRAFT_PATH = join(__dirname, "..", "src/lib/constants/players-draft.json");

const FORCE = process.argv.includes("--force");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;
const CONCURRENCY = Number(process.env.DRAFT_CONCURRENCY || 4);

/** 공식 상세 페이지에서 label 하나를 뽑는다. */
function extractLabel(html, id) {
  const m = new RegExp(`${id}">([^<]*)<`).exec(html);
  return m ? m[1].trim() : null;
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.koreabaseball.com/" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * 투수/타자 상세 두 경로를 모두 시도한다 — 포지션 표기가 실제 페이지 종류와
 * 어긋나는 경우가 있어(전향·등록 변경) 한쪽만 보면 누락된다.
 */
async function fetchDraft(kboId, position) {
  const order = position === "투수" ? ["Pitcher", "Hitter"] : ["Hitter", "Pitcher"];
  for (const kind of order) {
    const html = await fetchText(
      `https://www.koreabaseball.com/Record/Player/${kind}Detail/Basic.aspx?playerId=${kboId}`,
    );
    if (!html) continue;
    // 이름이 안 잡히면 그 페이지 종류가 아니다 — 다음 경로로.
    if (!extractLabel(html, "lblName")) continue;
    // ⚠️ markup drift fail-close (삼순 2026-08-09): lblName 은 잡히는데 lblDraft selector 가
    //   안 잡히면 그건 "공식에 빈값"이 아니라 **마크업이 바뀐 것**이다. `?? ""` 로 미등록
    //   확정하면 마크업 변경 하루 만에 전 로스터가 "등록 없음" 거짓 진술이 된다.
    //   실제 빈 span(`<span id=..lblDraft></span>`)만 "" 이고, selector 미검출은 실패·재시도다.
    const draft = extractLabel(html, "lblDraft");
    return draft === null ? { kind: "markup_drift" } : { kind: "ok", draft };
  }
  return null; // 두 경로 모두 실패 = 조회 불가(다음 실행에서 재시도)
}

async function main() {
  const roster = JSON.parse(readFileSync(ROSTER_PATH, "utf8"));
  let draftMap = {};
  try { draftMap = JSON.parse(readFileSync(DRAFT_PATH, "utf8")); } catch { draftMap = {}; }
  const targets = roster.filter((p) => {
    if (!/^\d+$/.test(String(p.kboId))) return false; // 외국인 FP/AQ 는 상세 id 체계가 다르다
    return FORCE || draftMap[p.kboId] === undefined;
  }).slice(0, LIMIT);

  console.log(`대상 ${targets.length}명 / 전체 ${roster.length}명 (concurrency ${CONCURRENCY})`);
  let done = 0, filled = 0, empty = 0, failed = 0, drifted = 0;

  const queue = [...targets];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const player = queue.shift();
        if (!player) return;
        const result = await fetchDraft(player.kboId, player.position);
        if (result === null || result.kind === "markup_drift") {
          failed += 1;
          if (result?.kind === "markup_drift") drifted += 1;
        } else {
          draftMap[player.kboId] = result.draft;
          if (result.draft.length > 0) filled += 1;
          else empty += 1;
        }
        done += 1;
        if (done % 50 === 0) console.log(`  ${done}/${targets.length} (값 ${filled} · 공백 ${empty} · 실패 ${failed})`);
      }
    }),
  );

  // roster 는 **건드리지 않는다**. 입단 정보 파일만 쓴다.
  const sorted = Object.fromEntries(Object.keys(draftMap).sort().map((k) => [k, draftMap[k]]));
  writeFileSync(DRAFT_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`완료 — 값 ${filled} · 공백 ${empty} · 실패 ${failed} (markup drift ${drifted})`);
  // ⚠️ 부분 실패를 조용한 성공으로 만들지 않는다 — 성공분은 저장했으니 재실행이 이어받고,
  //   exact key-set 게이트가 미수집 키를 잡는다. drift 는 마크업 대응 전까지 매회 실패다.
  if (failed > 0) {
    console.error(`❌ ${failed}명 조회 실패 — 저장은 완료, 재실행 필요${drifted > 0 ? ` (markup drift ${drifted}건: lblDraft selector 확인 필요)` : ""}`);
    process.exit(1);
  }
  console.log("✅ 전원 수집 완료");
}

main().catch((error) => {
  console.error("❌ backfill-roster-draft 실패:", error);
  process.exit(1);
});
