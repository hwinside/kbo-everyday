/**
 * 투타 통산 맞대결 V2 — 캡처 파이프라인 (Slice 1).
 *
 * 네이버 문자중계 relay 최상위 `pitcherVsBatterCareerStats`(전 시즌 누적 통산)를
 * 현재 타석 (투수 pcode, 타자 pcode) 기준으로 `pitcher_batter_matchup`에 upsert한다.
 * 값이 누적이라 *최신 스냅샷*만 유지하면 완전한 통산값이 된다(forward-only).
 *
 * 호스트 = game-events-warmup cron(매분 라이브게임). 캡처 실패가 warmup 본 기능
 * (알림)에 영향 주지 않도록 호출부에서 try/catch로 격리한다.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveRosterPlayer } from "@/lib/utils/player-roster";
import { TEAM_ID_TO_CODE } from "@/lib/game-logs/ingest";

const NAVER_RELAY_BASE = "https://api-gw.sports.naver.com/schedule/games";

// KBO 팀코드 → teamId (TEAM_ID_TO_CODE 역맵)
const CODE_TO_TEAM_ID: Record<string, number> = Object.fromEntries(
  Object.entries(TEAM_ID_TO_CODE).map(([id, code]) => [code, Number(id)]),
);

export interface CareerParsed {
  ab: number;
  hits: number;
  hr: number;
  avg: number;
}

/**
 * "3타수 1안타 1홈런 .333" / "1타수 0안타 0홈런 0.000" → 파싱.
 * "첫 맞대결" 등 미매칭 → null (저장 스킵).
 */
export function parseCareerLine(raw: string | null | undefined): CareerParsed | null {
  if (!raw) return null;
  const m = raw.match(/(\d+)\s*타수\s*(\d+)\s*안타\s*(\d+)\s*홈런\s*([0-9]?\.\d{1,3})/);
  if (!m) return null;
  return { ab: +m[1], hits: +m[2], hr: +m[3], avg: parseFloat(m[4]) };
}

interface RelayPerson { pcode?: string | number; name?: string }
interface RelaySide { batter?: RelayPerson[]; pitcher?: RelayPerson[] }
interface RelayTextData {
  currentGameState?: { pitcher?: string | number; batter?: string | number };
  pitcherVsBatterCareerStats?: string;
  homeLineup?: RelaySide;
  awayLineup?: RelaySide;
  homeEntry?: RelaySide;
  awayEntry?: RelaySide;
}

/** G_ID(예: "20260624HTWO0") → 네이버 gameId(연도 suffix 추가). */
function toNaverGameId(gid: string): string {
  return `${gid}${gid.slice(0, 4)}`;
}

/** G_ID에서 away/home 팀코드 추출. */
function parseTeamCodes(gid: string): { away: string; home: string } | null {
  const m = gid.match(/^\d{8}([A-Z]{2})([A-Z]{2})\d$/);
  return m ? { away: m[1], home: m[2] } : null;
}

/**
 * relay의 모든 인물 배열(lineup/entry × batter/pitcher × home/away)을 스캔해
 * pcode → {name, side} 통합 맵 구성. 현재 투수가 entry가 아닌 lineup.pitcher에만
 * 있는 경우(교체/계투)도 포착하기 위해 전 배열을 본다.
 */
function buildPersonMap(trd: RelayTextData): Map<string, { name: string; side: "home" | "away" }> {
  const map = new Map<string, { name: string; side: "home" | "away" }>();
  const add = (side: "home" | "away", arr: RelayPerson[] | undefined) => {
    for (const p of arr ?? []) {
      const pc = p.pcode != null ? String(p.pcode) : "";
      if (pc && p.name && !map.has(pc)) map.set(pc, { name: p.name, side });
    }
  };
  add("home", trd.homeLineup?.batter);
  add("home", trd.homeLineup?.pitcher);
  add("home", trd.homeEntry?.batter);
  add("home", trd.homeEntry?.pitcher);
  add("away", trd.awayLineup?.batter);
  add("away", trd.awayLineup?.pitcher);
  add("away", trd.awayEntry?.batter);
  add("away", trd.awayEntry?.pitcher);
  return map;
}

interface ResolvedSide { kboId: string; name: string }
function resolveKboId(
  person: { name: string; side: "home" | "away" },
  codes: { away: string; home: string },
): ResolvedSide | null {
  const code = person.side === "home" ? codes.home : codes.away;
  const teamId = CODE_TO_TEAM_ID[code];
  if (!teamId) return null;
  const roster = resolveRosterPlayer({ name: person.name, teamId });
  if (!roster) return null;
  return { kboId: roster.kboId, name: roster.name };
}

export interface CaptureResult {
  polled: number;
  captured: number;
  skipped: number;
  failed: number;
}

/**
 * 라이브 게임들에서 현재 타석 통산 맞대결을 1회씩 캡처해 upsert.
 * @param liveGameIds KBO G_ID 배열(라이브만).
 */
export async function captureMatchups(liveGameIds: string[]): Promise<CaptureResult> {
  const result: CaptureResult = { polled: liveGameIds.length, captured: 0, skipped: 0, failed: 0 };

  await Promise.all(
    liveGameIds.map(async (gid) => {
      try {
        const codes = parseTeamCodes(gid);
        if (!codes) {
          result.skipped++;
          return;
        }
        const res = await fetch(`${NAVER_RELAY_BASE}/${toNaverGameId(gid)}/relay?inning=1`, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)" },
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          result.failed++;
          return;
        }
        const json = (await res.json()) as { result?: { textRelayData?: RelayTextData } };
        const trd = json.result?.textRelayData;
        const gs = trd?.currentGameState;
        const pitcherPcode = gs?.pitcher != null ? String(gs.pitcher) : "";
        const batterPcode = gs?.batter != null ? String(gs.batter) : "";
        const career = parseCareerLine(trd?.pitcherVsBatterCareerStats);
        if (!trd || !pitcherPcode || !batterPcode || !career) {
          result.skipped++;
          return;
        }

        const personMap = buildPersonMap(trd);
        const pitcherPerson = personMap.get(pitcherPcode);
        const batterPerson = personMap.get(batterPcode);
        if (!pitcherPerson || !batterPerson) {
          result.skipped++;
          return;
        }

        const pitcher = resolveKboId(pitcherPerson, codes);
        const batter = resolveKboId(batterPerson, codes);
        if (!pitcher || !batter) {
          result.skipped++;
          return;
        }

        const { error } = await supabaseAdmin.from("pitcher_batter_matchup").upsert(
          {
            pitcher_kbo_id: pitcher.kboId,
            batter_kbo_id: batter.kboId,
            pitcher_name: pitcher.name,
            batter_name: batter.name,
            ab: career.ab,
            hits: career.hits,
            hr: career.hr,
            avg: career.avg,
            raw_line: trd.pitcherVsBatterCareerStats!.trim(),
            last_game_id: gid,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "pitcher_kbo_id,batter_kbo_id" },
        );
        if (error) {
          result.failed++;
          return;
        }
        result.captured++;
      } catch {
        result.failed++;
      }
    }),
  );

  return result;
}
