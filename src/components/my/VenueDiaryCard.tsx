"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, Play, Plus, RefreshCw, Trophy } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { getTeamById } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getSafeSession } from "@/lib/supabase/client";
import type {
  VenueAttendanceSummary,
  VenueDiaryItem,
} from "@/lib/venue-attendance/summary";
import {
  buildDiaryHomeGames,
  mergeVenueSummaries,
  type DiaryAttendanceInput,
  type DiaryHomeGame,
  type DiaryMediaGroupInput,
} from "@/lib/venue-diary/view";
import VenueDiaryAddGameSheet from "@/components/my/VenueDiaryAddGameSheet";
import VenueDiaryUploader, {
  type DiaryUploadGame,
} from "@/components/my/VenueDiaryUploader";
import VenueDiaryViewer, {
  type DiaryViewerHeader,
} from "@/components/my/VenueDiaryViewer";

interface AttendanceResponse {
  season: number;
  summary: VenueAttendanceSummary;
  diaryGameCount: number;
  games: VenueDiaryItem[];
}

interface MediaListResponse {
  season: number;
  games: DiaryMediaGroupInput[];
}

/** 세그먼트: 최신 시즌 · 직전 시즌 · 전체(두 시즌 합산). */
const CURRENT_SEASON = 2026;
const PREV_SEASON = 2025;
type SeasonKey = typeof CURRENT_SEASON | typeof PREV_SEASON | "all";

function teamShort(team: { id: number; name: string } | null): string {
  if (!team) return "";
  return getTeamById(team.id)?.shortName ?? team.name;
}

function formatGameDate(date: string | null): string {
  if (!date) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  })
    .format(new Date(`${date}T12:00:00+09:00`))
    .replace(/\. /g, ".")
    .replace(/\.$/, "");
}

function matchLabel(game: DiaryHomeGame): string {
  const away = teamShort(game.awayTeam);
  const home = teamShort(game.homeTeam);
  if (!away || !home) return "경기 정보 확인 중";
  const as = game.awayTeam?.score;
  const hs = game.homeTeam?.score;
  if (as != null && hs != null) return `${away} ${as} : ${hs} ${home}`;
  return `${away} vs ${home}`;
}

async function fetchSeason(
  token: string,
  season: number,
): Promise<{ attendance: AttendanceResponse; media: MediaListResponse } | null> {
  const [aRes, mRes] = await Promise.all([
    fetch(`/api/me/venue-attendance?season=${season}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }),
    fetch(`/api/me/venue-diary/media?season=${season}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }),
  ]);
  if (!aRes.ok || !mRes.ok) return null;
  return { attendance: await aRes.json(), media: await mRes.json() };
}

export default function VenueDiaryCard() {
  const { user, profile } = useAuth();
  const [season, setSeason] = useState<SeasonKey>(CURRENT_SEASON);
  const [loaded, setLoaded] = useState<{
    key: string;
    summary: VenueAttendanceSummary;
    diaryGameCount: number;
    attendanceGames: DiaryAttendanceInput[];
    mediaGroups: DiaryMediaGroupInput[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [uploadGame, setUploadGame] = useState<DiaryUploadGame | null>(null);
  const [viewer, setViewer] = useState<{ gameId: string; header: DiaryViewerHeader } | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    const key = `${user.id}:${season}`;
    setLoading(true);
    setFailed(false);
    try {
      const session = await getSafeSession();
      const token = session?.access_token;
      if (!token) throw new Error("missing session");
      const seasons = season === "all" ? [CURRENT_SEASON, PREV_SEASON] : [season];
      const results = await Promise.all(seasons.map((s) => fetchSeason(token, s)));
      if (results.some((r) => r == null)) throw new Error("request failed");
      const ok = results.filter((r): r is NonNullable<typeof r> => r != null);

      const summary = mergeVenueSummaries(ok.map((r) => r.attendance.summary));
      const diaryGameCount = ok.reduce((sum, r) => sum + r.attendance.diaryGameCount, 0);
      const attendanceGames = ok.flatMap((r) =>
        r.attendance.games.map((g) => ({
          gameId: g.gameId,
          result: g.result,
          awayTeam: g.awayTeam,
          homeTeam: g.homeTeam,
        })),
      );
      const mediaGroups = ok.flatMap((r) => r.media.games);
      setLoaded({ key, summary, diaryGameCount, attendanceGames, mediaGroups });
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [user, season]);

  useEffect(() => {
    if (user) void load();
  }, [load, user]);

  const homeGames = useMemo(
    () =>
      loaded
        ? buildDiaryHomeGames({
            mediaGroups: loaded.mediaGroups,
            attendanceGames: loaded.attendanceGames,
          })
        : [],
    [loaded],
  );

  const countsByGame = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of loaded?.mediaGroups ?? []) map.set(g.gameId, g.counts.total);
    return map;
  }, [loaded]);

  const favoriteTeamId = profile?.team_id ?? null;

  if (!user) return null;

  const data = loaded?.key === `${user.id}:${season}` ? loaded : null;
  const summary = data?.summary;

  return (
    <>
      <GlassCard className="mt-3 p-0 overflow-hidden">
        <div className="p-5">
          <div className="flex items-center gap-2">
            <CalendarDays size={19} className="text-accent" />
            <h2 className="text-lg font-bold text-text-primary">직관 다이어리</h2>
          </div>
          <p className="mt-1 text-xs text-text-tertiary">내가 직관한 경기의 기록과 사진·영상</p>

          {/* 나만 보기 안내(1회) */}
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-blue-500/25 bg-blue-500/10 px-3 py-2.5 text-[12px] font-semibold text-blue-300">
            🔒 여기 사진·영상은 <b className="text-blue-200">나만 보기</b> — 공개 피드엔 올라가지 않아요
          </div>

          {/* 시즌 세그먼트 */}
          <div className="mt-3 flex gap-1.5 rounded-xl bg-bg-tertiary p-1">
            {([CURRENT_SEASON, PREV_SEASON, "all"] as const).map((key) => (
              <button
                key={String(key)}
                onClick={() => setSeason(key)}
                className={`flex-1 rounded-lg py-2 text-[13px] font-bold ${
                  season === key ? "bg-brand-primary text-white" : "text-text-tertiary"
                }`}
              >
                {key === "all" ? "전체" : key}
              </button>
            ))}
          </div>

          {loading && !data ? (
            <div className="mt-4 h-32 animate-pulse rounded-2xl bg-bg-tertiary" />
          ) : failed && !data ? (
            <button
              type="button"
              onClick={() => void load()}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-bg-tertiary py-4 text-sm text-text-secondary"
            >
              <RefreshCw size={15} /> 기록을 불러오지 못했어요 · 다시 시도
            </button>
          ) : data && summary ? (
            <>
              {/* GPS 인증 요약 카드 */}
              <div className="mt-3.5 rounded-2xl border border-[#33202a] bg-gradient-to-br from-[#20141b] to-[#141417] p-4">
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-extrabold text-emerald-400">
                  ✓ GPS 인증 직관
                </span>
                <div className="mt-3.5 flex items-end gap-5">
                  <div>
                    <p className="text-3xl font-extrabold tracking-tight text-text-primary">
                      {summary.attendanceCount}
                    </p>
                    <p className="text-[11px] font-semibold text-text-tertiary">인증 직관</p>
                  </div>
                  <div>
                    <p className="text-3xl font-extrabold tracking-tight text-amber-400">
                      {summary.winRate == null ? "–" : `${(summary.winRate * 100).toFixed(1)}%`}
                    </p>
                    <p className="text-[11px] font-semibold text-text-tertiary">승률</p>
                  </div>
                </div>
                <div className="mt-3 flex gap-3 border-t border-[#2c1f27] pt-3 text-[13px] font-bold">
                  <span className="text-blue-400">{summary.wins}승</span>
                  <span className="text-accent">{summary.losses}패</span>
                  <span className="text-text-secondary">{summary.draws}무</span>
                </div>
              </div>

              {/* 다이어리 기록 경기수(직접 추가 포함) */}
              <div className="mt-2.5 flex items-center justify-between rounded-2xl border border-border bg-bg-tertiary px-4 py-3">
                <span className="text-[12.5px] text-text-secondary">
                  📔 다이어리 기록 경기수{" "}
                  <span className="text-text-tertiary">(직접 추가 포함)</span>
                </span>
                <span className="text-[15px] font-extrabold text-text-primary">
                  {data.diaryGameCount}경기
                </span>
              </div>

              {/* 지난 경기 추가하기 */}
              <button
                onClick={() => setAddOpen(true)}
                className="mt-3.5 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-primary py-3.5 text-[14.5px] font-extrabold text-white shadow-lg shadow-brand-primary/30"
              >
                <Plus size={18} /> 지난 경기 추가하기
              </button>
            </>
          ) : null}
        </div>

        {/* 경기별 기록 */}
        {data && (
          <div className="px-5 pb-5">
            <p className="mb-2 mt-1 px-1 text-[13px] font-extrabold text-text-secondary">경기별 기록</p>
            {homeGames.length === 0 ? (
              <div className="rounded-2xl border border-border py-8 text-center">
                <Trophy size={22} className="mx-auto text-text-tertiary" />
                <p className="mt-2 text-sm font-medium text-text-secondary">아직 기록이 없어요</p>
                <p className="mt-1 text-xs text-text-tertiary">
                  직관 스토리를 올리거나 지난 경기를 추가해보세요
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {homeGames.map((game) => (
                  <button
                    key={game.gameId}
                    onClick={() =>
                      setViewer({
                        gameId: game.gameId,
                        header: {
                          matchLabel: matchLabel(game),
                          dateLabel: `${formatGameDate(game.gameDate)}${game.stadiumName ? ` · ${game.stadiumName}` : ""}`,
                          result: game.result,
                        },
                      })
                    }
                    className="rounded-2xl border border-border bg-bg-tertiary p-3 text-left active:opacity-90"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[11.5px] font-bold text-text-tertiary">
                          {formatGameDate(game.gameDate)}
                          {game.stadiumName ? ` · ${game.stadiumName}` : ""}
                        </p>
                        <p className="mt-0.5 flex items-center gap-1.5 text-[15px] font-extrabold text-text-primary">
                          {matchLabel(game)}
                          <span
                            className={`rounded-md px-1.5 py-0.5 text-[10.5px] font-extrabold ${
                              game.label.kind === "gps"
                                ? "bg-emerald-500/15 text-emerald-400"
                                : "bg-white/10 text-text-secondary"
                            }`}
                          >
                            {game.label.text}
                          </span>
                        </p>
                      </div>
                      {game.result && (
                        <span
                          className={`shrink-0 rounded-lg px-2 py-0.5 text-[11px] font-extrabold ${
                            game.result === "W"
                              ? "bg-blue-500/15 text-blue-400"
                              : game.result === "L"
                                ? "bg-accent/15 text-accent"
                                : "bg-gray-500/15 text-text-secondary"
                          }`}
                        >
                          {game.result === "W" ? "승" : game.result === "L" ? "패" : "무"}
                        </span>
                      )}
                    </div>

                    {game.thumbnails.length > 0 && (
                      <div className="mt-3 grid grid-cols-4 gap-1.5">
                        {game.thumbnails.map((t) => (
                          <div
                            key={t.id}
                            className="relative aspect-square overflow-hidden rounded-lg bg-bg-secondary"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={t.thumbUrl} alt="" className="h-full w-full object-cover" />
                            {t.mediaType === "video" && (
                              <span className="absolute inset-0 flex items-center justify-center text-white">
                                <Play size={14} fill="currentColor" />
                              </span>
                            )}
                          </div>
                        ))}
                        {game.extraCount > 0 && (
                          <div className="flex aspect-square items-center justify-center rounded-lg bg-bg-secondary text-sm font-extrabold text-text-secondary">
                            +{game.extraCount}
                          </div>
                        )}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </GlassCard>

      <VenueDiaryAddGameSheet
        isOpen={addOpen}
        favoriteTeamId={favoriteTeamId}
        countsByGame={countsByGame}
        onBack={() => setAddOpen(false)}
        onClose={() => setAddOpen(false)}
        onPick={(game) => {
          setAddOpen(false);
          setUploadGame(game);
        }}
      />

      {uploadGame && (
        <VenueDiaryUploader
          game={uploadGame}
          isOpen={uploadGame != null}
          onBack={() => {
            setUploadGame(null);
            setAddOpen(true);
          }}
          onClose={() => setUploadGame(null)}
          onUploaded={() => void load()}
        />
      )}

      {viewer && (
        <VenueDiaryViewer
          gameId={viewer.gameId}
          header={viewer.header}
          isOpen={viewer != null}
          onClose={() => setViewer(null)}
          onChanged={() => void load()}
        />
      )}
    </>
  );
}
