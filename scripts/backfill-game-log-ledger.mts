/**
 * 직관 다이어리 통계 S1a — 2026 정규시즌 boxscore 재수집 + 완료 증거 ledger backfill.
 * spec: Notion "[기획] 직관 다이어리 통계 v1" rev5 §11
 *   "기존 2026 데이터는 boxscore 재수집 backfill로 ledger를 생성하며,
 *    미생성 게임은 heuristic fallback 없이 incomplete다."
 *
 * 사용:
 *   npx tsx scripts/backfill-game-log-ledger.mts                 # dry-run (DB 쓰기 X, 판정 미리보기)
 *   npx tsx scripts/backfill-game-log-ledger.mts --limit 5       # 최근 5경기만 (검증용)
 *   npx tsx scripts/backfill-game-log-ledger.mts --apply         # 실제 rows+ledger upsert
 *   npx tsx scripts/backfill-game-log-ledger.mts --apply --season 2026
 *
 * 멱등: player_game_logs UNIQUE(kbo_id,player_type,game_id) + ledger PK(game_id) upsert. 재실행 안전.
 * (구 scripts/backfill-game-logs.mts는 결측→0 강등(lenient) 경로라 ledger를 만들지 않는다 —
 *  완료 증거가 필요한 backfill은 이 스크립트를 쓴다.)
 */
import { createClient } from "@supabase/supabase-js";
import { getSeasonGames } from "@/lib/crawler/season-games-cache";
import { fetchGameBoxscore } from "@/lib/game-logs/ingest";
import { buildGameIngestion, canonicalPayloadHash } from "@/lib/game-logs/completeness";
import { ingestGameWithLedger } from "@/lib/game-logs/ledger-ingest";

const APPLY = process.argv.includes("--apply");
const seasonArg = process.argv.indexOf("--season");
const SEASON = seasonArg >= 0 ? Number(process.argv[seasonArg + 1]) : 2026;
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : 0;
const CONCURRENCY = 4;

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return out;
}

async function main() {
  console.log(`[ledger-backfill] season=${SEASON} mode=${APPLY ? "APPLY" : "DRY-RUN"}${LIMIT ? ` limit=${LIMIT}` : ""}`);

  // 정규시즌만. srId 근거는 scripts/backfill-game-logs.mts와 동일 (삼순 리뷰 PR #178 실측).
  const REGULAR_SEASON_SR_ID = "0";
  const all = await getSeasonGames(SEASON, REGULAR_SEASON_SR_ID);
  const finals = all.filter((g) => g.status === "final");
  const targets = LIMIT > 0 ? finals.slice(-LIMIT) : finals;
  console.log(`[ledger-backfill] games: ${all.length} total, ${finals.length} final, ${targets.length} target`);

  if (!APPLY) {
    // dry-run: 페치+strict 빌드까지만 수행해 판정을 미리 본다 (DB 검증 단계는 apply에서만).
    let ok = 0;
    const problems: string[] = [];
    await mapPool(targets, CONCURRENCY, async (g) => {
      const box = await fetchGameBoxscore(g.gameId);
      if (!box) {
        problems.push(`${g.gameId}: boxscore_unavailable`);
        return;
      }
      const build = buildGameIngestion(g, box);
      if (build.missingFields.length > 0) {
        problems.push(`${g.gameId}: missing_required_field (${build.missingFields.length}필드)`);
      } else if (build.unresolved.length > 0) {
        problems.push(`${g.gameId}: unresolved_player [${build.unresolved.map((u) => u.name).join(",")}]`);
      } else if (build.rawRowCount !== build.resolvedRowCount || build.resolvedRowCount !== build.rows.length) {
        problems.push(`${g.gameId}: row_count_mismatch raw=${build.rawRowCount} resolved=${build.resolvedRowCount} rows=${build.rows.length}`);
      } else {
        ok++;
        if (ok <= 3) {
          console.log(`  sample ${g.gameId}: rows=${build.rows.length} hash=${canonicalPayloadHash(build.rows).slice(0, 12)}…`);
        }
      }
    });
    console.log(`\n[ledger-backfill] DRY-RUN 요약: complete 후보 ${ok} / 문제 ${problems.length}`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log(`(dry-run — ledger/rows 미기록. --apply로 실제 backfill)`);
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요");
  const client = createClient(url, key, { auth: { persistSession: false } });

  let complete = 0;
  const incompletes: string[] = [];
  let done = 0;
  await mapPool(targets, CONCURRENCY, async (g) => {
    const r = await ingestGameWithLedger(client, g);
    done++;
    if (r.status === "complete") complete++;
    else incompletes.push(`${r.gameId}: ${r.failureReason}`);
    if (done % 50 === 0) console.log(`[ledger-backfill] ${done}/${targets.length}…`);
  });

  console.log(`\n[ledger-backfill] === 요약 ===`);
  console.log(`대상 ${targets.length} | complete ${complete} | incomplete ${incompletes.length}`);
  // 기계 판독용 단일 행. 위 사람용 요약을 CI 가 직접 파싱하다
  // `incomplete 0` 안의 `complete 0` 을 집어 complete=0 으로 오독했다
  // (run 30679031813: 실제 5경기 성공인데 apply 가드가 실패 판정).
  // 산문을 정규식으로 긁는 대신 고정 key=value 를 내보낸다.
  console.log(
    `[ledger-backfill] RESULT target=${targets.length} complete=${complete} incomplete=${incompletes.length}`,
  );
  for (const p of incompletes) console.log(`  ✗ ${p}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
