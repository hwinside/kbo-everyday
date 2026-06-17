/**
 * 개막 ~ 4/14 일별 순위 스냅샷 백필 (1회성).
 *
 * daily_standings_snapshot은 2026-04-15부터 cron으로 적재됨. 그 이전 구간은
 * KBO가 "특정 날짜 순위"를 직접 주지 않으므로, 개막일부터 매일 전체 경기결과를
 * 순서대로 replay해 누적 W/L/D → 순위·게임차·연승연패를 재구성해 채운다.
 *
 * 안전장치:
 *   - 기본 dry-run (출력만). 실제 적재는 `--apply`.
 *   - 4/15(적재 시작일)까지 replay해 stored 스냅샷과 rank를 대조 검증(--apply 전 필수 확인).
 *   - 쓰기 대상은 date <= 2026-04-14 (기존 4/15+ 스냅샷 미변경).
 *
 * 실행:
 *   npx tsx --env-file=.env.local scripts/backfill-standings-snapshot.ts           # dry-run + 검증
 *   npx tsx --env-file=.env.local scripts/backfill-standings-snapshot.ts --apply   # prod 적재
 */
import { fetchGames } from "@/lib/crawler/kbo-api";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { TEAMS } from "@/lib/constants/teams";

const SEASON_START = "20260328"; // 2026 정규시즌 개막일(확인: 3/20=시범경기, 3/28=정규경기). 시범경기는 같은 srId라 date로 컷.
const BACKFILL_END = "20260414"; // 적재 시작(4/15) 직전까지만 write
const VALIDATE_DATE = "20260415"; // 여기까지 replay해 stored와 대조
const APPLY = process.argv.includes("--apply");

interface Rec {
  w: number;
  l: number;
  d: number;
  seq: ("W" | "L" | "D")[];
}

interface SnapRow {
  date: string; // YYYY-MM-DD
  team_id: number;
  rank: number;
  wins: number;
  losses: number;
  draws: number;
  win_rate: number;
  games_behind: number;
  streak: string | null;
}

function* dateRange(start: string, end: string): Generator<string> {
  const d = new Date(Date.UTC(+start.slice(0, 4), +start.slice(4, 6) - 1, +start.slice(6, 8)));
  const last = new Date(Date.UTC(+end.slice(0, 4), +end.slice(4, 6) - 1, +end.slice(6, 8)));
  while (d <= last) {
    yield d.toISOString().slice(0, 10).replace(/-/g, "");
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

// 스냅샷 date 규약: cron이 16시에 잡아 '전일 경기까지' 반영 → date=D 스냅샷은
// D-1 경기 종료 시점 순위. 그래서 X일 경기 적용 후 순위는 (X+1)일 라벨로 저장.
function nextDayYmd(yyyymmdd: string): string {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function streakOf(seq: ("W" | "L" | "D")[]): string | null {
  if (seq.length === 0) return null;
  const last = seq[seq.length - 1];
  let n = 0;
  for (let i = seq.length - 1; i >= 0 && seq[i] === last; i--) n++;
  return last === "W" ? `${n}연승` : last === "L" ? `${n}연패` : `${n}무`;
}

function computeStandings(yyyymmdd: string, recs: Map<number, Rec>): SnapRow[] {
  const iso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  const arr = [...recs.entries()]
    .map(([team_id, r]) => ({
      team_id,
      ...r,
      played: r.w + r.l,
      winRate: r.w + r.l > 0 ? r.w / (r.w + r.l) : 0,
    }))
    .filter((t) => t.w + t.l + t.d > 0); // 아직 경기 안 한 팀 제외
  arr.sort((a, b) => b.winRate - a.winRate || b.w - a.w);
  const leader = arr[0];
  return arr.map((t, i) => ({
    date: iso,
    team_id: t.team_id,
    rank: i + 1,
    wins: t.w,
    losses: t.l,
    draws: t.d,
    win_rate: Number(t.winRate.toFixed(3)),
    games_behind: ((leader.w - t.w) + (t.l - leader.l)) / 2,
    streak: streakOf(t.seq),
  }));
}

async function main() {
  const recs = new Map<number, Rec>();
  TEAMS.forEach((t) => recs.set(t.id, { w: 0, l: 0, d: 0, seq: [] }));

  const toWrite: SnapRow[] = [];
  let validateRows: SnapRow[] | null = null;
  let daysWithGames = 0;

  // 경기일 X(개막~4/14)를 처리하고, X 종료 시점 순위를 (X+1)일 라벨로 산출.
  for (const date of dateRange(SEASON_START, BACKFILL_END)) {
    // srId "0,1" = 정규시즌만 (시범경기는 같은 srId라 SEASON_START 날짜 컷으로 제외).
    const games = await fetchGames(date, "0,1").catch(() => []);
    const finals = games.filter(
      (g) => g.status === "final" && g.homeScore != null && g.awayScore != null,
    );
    for (const g of finals) {
      const h = recs.get(g.homeTeamId);
      const a = recs.get(g.awayTeamId);
      if (!h || !a) continue;
      const hs = g.homeScore as number;
      const as = g.awayScore as number;
      if (hs > as) { h.w++; h.seq.push("W"); a.l++; a.seq.push("L"); }
      else if (hs < as) { a.w++; a.seq.push("W"); h.l++; h.seq.push("L"); }
      else { h.d++; h.seq.push("D"); a.d++; a.seq.push("D"); }
    }
    if (finals.length === 0) continue;
    daysWithGames++;
    const outLabel = nextDayYmd(date); // 스냅샷 date 규약: 전일 경기까지 반영
    const rows = computeStandings(outLabel, recs);
    if (outLabel <= BACKFILL_END) toWrite.push(...rows);
    if (outLabel === VALIDATE_DATE) validateRows = rows;
  }

  console.log(`[backfill] 경기 있는 날: ${daysWithGames} | write 대상 행(≤${BACKFILL_END}): ${toWrite.length}`);

  // 검증: 4/15 replay vs stored
  if (validateRows) {
    const { data: stored } = await supabaseAdmin
      .from("daily_standings_snapshot")
      .select("team_id, rank, wins, losses")
      .eq("date", `${VALIDATE_DATE.slice(0, 4)}-${VALIDATE_DATE.slice(4, 6)}-${VALIDATE_DATE.slice(6, 8)}`);
    if (stored && stored.length) {
      const byTeam = new Map(stored.map((s) => [Number(s.team_id), s]));
      let rankMatch = 0, winMatch = 0;
      for (const r of validateRows) {
        const s = byTeam.get(r.team_id);
        if (!s) continue;
        if (Number(s.rank) === r.rank) rankMatch++;
        if (Number(s.wins) === r.wins && Number(s.losses) === r.losses) winMatch++;
      }
      console.log(`[validate] 4/15 대조 — rank 일치 ${rankMatch}/${validateRows.length}, W-L 일치 ${winMatch}/${validateRows.length}`);
      const team = (id: number) => TEAMS.find((t) => t.id === id)?.shortName ?? id;
      validateRows.forEach((r) => {
        const s = byTeam.get(r.team_id);
        if (s && (Number(s.rank) !== r.rank || Number(s.wins) !== r.wins || Number(s.losses) !== r.losses)) {
          console.log(`  ⚠️ ${team(r.team_id)}: replay rank${r.rank} ${r.wins}-${r.losses} vs stored rank${s.rank} ${s.wins}-${s.losses}`);
        }
      });
    } else {
      console.log("[validate] stored 4/15 스냅샷 없음 — 대조 불가");
    }
  }

  if (!APPLY) {
    console.log("[dry-run] --apply 없으면 write 안 함. 샘플:", JSON.stringify(toWrite.slice(0, 3)));
    return;
  }

  const { error } = await supabaseAdmin
    .from("daily_standings_snapshot")
    .upsert(toWrite, { onConflict: "date,team_id" });
  if (error) {
    console.error("[apply] upsert 실패:", error.message);
    process.exit(1);
  }
  console.log(`[apply] ✅ ${toWrite.length}행 적재 완료 (개막~${BACKFILL_END})`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
