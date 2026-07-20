// 직관 라이브 — gameId 로 실제 경기/구장/시간대를 서버에서 독립 검증 (fail-closed)
// (server 전용: kbo-api crawler 사용)

import { fetchGames } from "@/lib/crawler/kbo-api";
import { resolveStadiumByName, type StadiumCoord } from "./stadiums";
import { evaluateUploadWindow } from "./geofence";
import {
  VENUE_UPLOAD_WINDOW_BEFORE_MIN,
  VENUE_UPLOAD_WINDOW_AFTER_HOURS,
  VENUE_STORY_EXPIRY_HOURS_AFTER_START,
} from "./types";

export interface ResolvedVenue {
  exists: boolean;
  stadiumName: string | null;
  coord: StadiumCoord | null;
  startMs: number | null;
  uploadOpen: boolean;
  reason: string | null;
  expiresAtMs: number | null;
}

function gameDateFromId(gameId: string): string | null {
  const m = /^(\d{8})/.exec(gameId);
  return m ? m[1] : null;
}

/** dateYmd="20260718", timeStr="18:30" | "1830" → KST epoch ms */
function parseStartMs(dateYmd: string, timeStr: string): number | null {
  const digits = (timeStr || "").replace(/\D/g, "");
  if (digits.length < 3) return null;
  const hh = parseInt(digits.slice(0, digits.length - 2), 10);
  const mm = parseInt(digits.slice(-2), 10);
  if (Number.isNaN(hh) || Number.isNaN(mm) || hh > 23 || mm > 59) return null;
  const y = dateYmd.slice(0, 4);
  const mo = dateYmd.slice(4, 6);
  const d = dateYmd.slice(6, 8);
  const iso = `${y}-${mo}-${d}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * gameId → 실제 경기 존재·구장 좌표·업로드 가능 시간대·만료시각을 해석.
 * 없는 경기/미매핑 구장/시간대 밖은 fail-closed(uploadOpen=false).
 */
export async function resolveGameVenue(gameId: string): Promise<ResolvedVenue> {
  const fail = (reason: string): ResolvedVenue => ({
    exists: false,
    stadiumName: null,
    coord: null,
    startMs: null,
    uploadOpen: false,
    reason,
    expiresAtMs: null,
  });

  const date = gameDateFromId(gameId);
  if (!date) return fail("경기를 확인할 수 없어요");

  let games;
  try {
    games = await fetchGames(date);
  } catch {
    return fail("경기 정보를 불러오지 못했어요");
  }

  const game = games.find((g) => g.gameId === gameId);
  if (!game) return fail("경기를 확인할 수 없어요");

  const coord = resolveStadiumByName(game.stadium);
  const startMs = parseStartMs(date, game.time);
  const expiresAtMs =
    startMs != null ? startMs + VENUE_STORY_EXPIRY_HOURS_AFTER_START * 3600_000 : null;

  const { uploadOpen, reason } = evaluateUploadWindow({
    cancelled: game.status === "cancelled",
    hasCoord: !!coord,
    startMs,
    now: Date.now(),
    beforeMin: VENUE_UPLOAD_WINDOW_BEFORE_MIN,
    afterHours: VENUE_UPLOAD_WINDOW_AFTER_HOURS,
  });

  return {
    exists: true,
    stadiumName: game.stadium ?? null,
    coord,
    startMs,
    uploadOpen,
    reason,
    expiresAtMs,
  };
}
