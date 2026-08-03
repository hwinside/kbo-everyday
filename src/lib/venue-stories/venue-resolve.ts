// 직관 라이브 — gameId 로 실제 경기/구장/시간대를 서버에서 독립 검증 (fail-closed)
// (server 전용: kbo-api crawler 사용)

import { fetchGames } from "@/lib/crawler/kbo-api";
import { resolveStadiumByName, type StadiumCoord } from "./stadiums";
import { evaluateUploadWindow, type UploadGateKind } from "./geofence";
import {
  VENUE_UPLOAD_WINDOW_BEFORE_MIN,
  VENUE_UPLOAD_WINDOW_AFTER_HOURS,
} from "./types";
import { safetyCapExpiryIso } from "./expiry-policy";

export interface ResolvedVenue {
  exists: boolean;
  status: "scheduled" | "live" | "final" | "cancelled" | null;
  gameDate: string | null; // YYYY-MM-DD
  stadiumName: string | null;
  awayTeamId: number | null;
  homeTeamId: number | null;
  coord: StadiumCoord | null;
  startMs: number | null;
  uploadOpen: boolean;
  reason: string | null;
  expiresAtMs: number | null;
  // 취소 경기 여부 — 관리자 QA도 취소 경기는 fail-closed(시간창만 우회 허용). 삼순 #832 범위.
  cancelled: boolean;
  // 업로드 차단 사유 종류 — 관리자 우회를 시간창만으로 좁히기 위해 클라/서버가 공유(삼순 #832 왕복3).
  gateKind: UploadGateKind;
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
    status: null,
    gameDate: null,
    stadiumName: null,
    awayTeamId: null,
    homeTeamId: null,
    coord: null,
    startMs: null,
    uploadOpen: false,
    reason,
    expiresAtMs: null,
    cancelled: false,
    gateKind: "no-time", // 경기 미확인/미존재 — 관리자도 fail-closed(시간창 사유 아님)
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
  // 업로드 시점 expires_at 은 **안전상한(시작+72h, 장애 정책·관제용)** — 정상 만료 조건이 아니다.
  // 정상 만료(종료+24h)는 finalize cron 이 terminal CAS 성공 후에만 확정한다(삼순 09:44 #2).
  const expiresAtMs = startMs != null ? Date.parse(safetyCapExpiryIso(startMs)) : null;

  const cancelled = game.status === "cancelled";
  const { uploadOpen, reason, gateKind } = evaluateUploadWindow({
    cancelled,
    hasCoord: !!coord,
    startMs,
    now: Date.now(),
    beforeMin: VENUE_UPLOAD_WINDOW_BEFORE_MIN,
    afterHours: VENUE_UPLOAD_WINDOW_AFTER_HOURS,
  });

  return {
    exists: true,
    status: game.status,
    gameDate: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
    stadiumName: game.stadium ?? null,
    awayTeamId: game.awayTeamId,
    homeTeamId: game.homeTeamId,
    coord,
    startMs,
    uploadOpen,
    reason,
    expiresAtMs,
    cancelled,
    gateKind,
  };
}
