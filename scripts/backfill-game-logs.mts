/**
 * player_game_logs 백필 (선수 스탯 보강 V1 — 빌드 1).
 * spec: specs/stats/player-stats-v1.md
 *
 * 사용:
 *   npx tsx scripts/backfill-game-logs.mts                 # dry-run (DB 쓰기 X, 요약만)
 *   npx tsx scripts/backfill-game-logs.mts --limit 5       # 최근 5경기만 (검증용)
 *   npx tsx scripts/backfill-game-logs.mts --apply         # 2026 시즌 전체 실제 upsert
 *   npx tsx scripts/backfill-game-logs.mts --apply --season 2026
 *
 * 멱등: UNIQUE(kbo_id, player_type, game_id) upsert. 재실행 안전.
 *
 * ⚠️ 직관 통계 S1a 이후 주의: 이 스크립트는 lenient 파싱(결측→0 강등)이며 완료 증거
 *    ledger(player_game_log_ingestions)를 기록하지 않는다. 완료 증거가 필요한 backfill은
 *    scripts/backfill-game-log-ledger.mts 사용 (Notion 직관 통계 v1 rev5 §11·§12).
 */
import { createClient } from "@supabase/supabase-js";
import { getSeasonGames } from "@/lib/crawler/season-games-cache";
import { ingestGameRows, type PlayerGameLogRow } from "@/lib/game-logs/ingest";

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

function fmtIp(outs: number): string {
  return `${Math.floor(outs / 3)}.${outs % 3}`;
}

async function main() {
  console.log(`[backfill] season=${SEASON} mode=${APPLY ? "APPLY" : "DRY-RUN"}${LIMIT ? ` limit=${LIMIT}` : ""}`);

  // 정규시즌만. KBO srId: 0=정규시즌 / 1=시범경기 / 3·4·5·7=포스트시즌 / 9=올스타.
  // getSeasonGames 기본 srId은 전부 포함하므로, 시즌 누적 AVG/ERA 오염 방지를 위해 정규시즌으로 한정.
  // (삼순 리뷰 PR #178. srId 값은 실측 확인 — 6/6 정규경기=srId 0, 3/15 시범경기=srId 1)
  const REGULAR_SEASON_SR_ID = "0";
  const all = await getSeasonGames(SEASON, REGULAR_SEASON_SR_ID);
  const finals = all.filter((g) => g.status === "final");
  const targets = LIMIT > 0 ? finals.slice(-LIMIT) : finals;
  console.log(`[backfill] games: ${all.length} total, ${finals.length} final, ${targets.length} target`);

  let totalRows = 0;
  let gamesNoBox = 0;
  let gamesOk = 0;
  let upserted = 0;
  const sample: PlayerGameLogRow[] = [];

  const perGame = await mapPool(targets, CONCURRENCY, async (g) => {
    const rows = await ingestGameRows(g);
    if (rows == null) {
      gamesNoBox++;
      return null;
    }
    gamesOk++;
    totalRows += rows.length;
    if (sample.length < 8 && rows.length) sample.push(...rows.slice(0, 2));
    return { gameId: g.gameId, rows };
  });

  if (APPLY) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요");
    const client = createClient(url, key, { auth: { persistSession: false } });
    const flat = perGame.filter((x): x is { gameId: string; rows: PlayerGameLogRow[] } => x != null).flatMap((x) => x.rows);
    for (let i = 0; i < flat.length; i += 500) {
      const chunk = flat.slice(i, i + 500);
      const { error } = await client.from("player_game_logs").upsert(chunk, { onConflict: "kbo_id,player_type,game_id" });
      if (error) throw new Error(`upsert 실패 @${i}: ${error.message}`);
      upserted += chunk.length;
      console.log(`[backfill] upserted ${upserted}/${flat.length}`);
    }
  }

  console.log(`\n[backfill] === 요약 ===`);
  console.log(`final 경기 ${finals.length} | 대상 ${targets.length} | 박스 OK ${gamesOk} | 박스 없음(취소 등) ${gamesNoBox}`);
  console.log(`생성 행 ${totalRows}${APPLY ? ` | upsert ${upserted}` : " (dry-run, 미적용)"}`);
  console.log(`샘플:`);
  for (const r of sample) {
    if (r.player_type === "batter") {
      console.log(`  ${r.game_date} ${r.team_code} vs#${r.opponent_team_id} ${r.kbo_id} 타자 ${r.ab}타수 ${r.h}안타 ${r.hr}HR ${r.rbi}타점 (${r.result})`);
    } else {
      console.log(`  ${r.game_date} ${r.team_code} vs#${r.opponent_team_id} ${r.kbo_id} 투수 ${fmtIp(r.ip_outs)}IP ${r.er}ER ${r.k}K ${r.bb_allowed}BB (${r.result})`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
