"use client";

import { useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { getFavoritePlayers } from "@/lib/store/favorites";
import { TEAMS } from "@/lib/constants/teams";
import ReelViewer from "@/components/home/ReelViewer";
import { getShortsScope, getShortsVisible, setShortsScope, SHORTS_PREF_EVENT } from "@/lib/store/shorts-pref";
import type { ShortsScope } from "@/lib/video/shorts-feed-scope";
import { LatestOnlyGate, nextShortsScopeOnTap, resolveInitialShortsScope } from "@/lib/video/shorts-scope-ui";

const SCOPE_CHIPS: { value: ShortsScope; label: string }[] = [
  { value: "favorite_players", label: "최애선수" },
  { value: "my_team", label: "마이팀" },
  { value: "all", label: "전체" },
];

/** team shortName lookup by various keys */
const TEAM_LABEL: Record<string, string> = {};
for (const t of TEAMS) {
  TEAM_LABEL[String(t.id)] = t.shortName;
  TEAM_LABEL[t.shortName] = t.shortName;
  TEAM_LABEL[t.slug] = t.shortName;
}

interface VideoItem {
  id: string;
  title: string;
  thumbnail: string;
  channel: string;
  publishedAt: string;
  playerIds: string[];
  teamId: string | null;
  isPlayerMatch: boolean;
  hasPlayerTag: boolean;
  label: string;
}

// /api/shorts-feed 원본 아이템 (map 입력)
interface ShortsFeedItem {
  id: string;
  title: string;
  thumbnail: string;
  channel: string;
  publishedAt: string;
  playerIds?: string[];
  teamId?: string | null;
  playerId?: string | null;
  playerName?: string | null;
}

interface HomeHighlightsProps {
  team: string | null;
  /** Pull-to-refresh 트리거. 값이 바뀌면 숏츠 피드를 재페치한다. */
  refreshNonce?: number;
}

export default function HomeHighlights({ team, refreshNonce = 0 }: HomeHighlightsProps) {
  const [reelIndex, setReelIndex] = useState<number | null>(null);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [shortsVisible, setShortsVisible] = useState(true);
  // scope 칩 (최애선수 | 마이팀 | 전체). 항상 정확히 1개 활성 — 무선택/혼합 상태 없음.
  // null은 localStorage 읽기 전 초기화 단계에만 존재(렌더/페치 스킵).
  const [scope, setScope] = useState<ShortsScope | null>(null);
  const [fetchError, setFetchError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [hasFavPlayers, setHasFavPlayers] = useState(false);
  // 늦게 도착한 이전 scope 응답이 현재 결과를 덮어쓰지 않게 하는 latest-only 게이트
  const gateRef = useRef(new LatestOnlyGate());

  useEffect(() => {
    const favCount = getFavoritePlayers().length;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasFavPlayers(favCount > 0);
    // 저장값이 불가능하면(최애선수 미지정 등) 기본값 폴백: 최애 있음→최애선수, 없음→마이팀
    setScope(resolveInitialShortsScope(getShortsScope(), favCount));
  }, []);

  const selectScope = (tapped: ShortsScope) => {
    if (scope === null) return;
    const next = nextShortsScopeOnTap(scope, tapped);
    if (next === scope) return; // active 재탭 = no-op
    setScope(next);
    setShortsScope(next);
    // 전환 즉시 이전 scope 카드 숨김 — 새 응답 전까지 로딩 상태만 노출
    setVideos([]);
    setFetchError(false);
    setLoading(true);
  };

  // 마이페이지 '숏츠 표시' 토글 반영 (기기 로컬 설정, 변경 즉시 반영)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShortsVisible(getShortsVisible());
    const onChange = () => setShortsVisible(getShortsVisible());
    window.addEventListener(SHORTS_PREF_EVENT, onChange);
    return () => window.removeEventListener(SHORTS_PREF_EVENT, onChange);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!team) { setLoading(false); return; }
    if (scope === null) return; // 초기 scope 결정 전 — 페치 보류

    const token = gateRef.current.begin();
    const controller = new AbortController();
    setLoading(true);
    setFetchError(false);

    const favPlayers = getFavoritePlayers().slice(0, 5);
    const favPlayerMap = new Map(favPlayers.map(p => [p.playerId, p.name]));
    // 마이팀 scope는 순수 팀 피드 — 최애선수 병합 쿼리 방지 위해 player_ids 미전송.
    // 전체 scope는 마이팀+최애선수 병합(2026-08-13 재정의)이므로 player_ids 전송.
    const playerIdsParam = (scope === "favorite_players" || scope === "all") && favPlayers.length > 0
      ? `&player_ids=${encodeURIComponent(favPlayers.map(p => p.playerId).join(","))}`
      : "";

    fetch(`/api/shorts-feed?team=${encodeURIComponent(team)}${playerIdsParam}&scope=${scope}`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`shorts-feed HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!gateRef.current.isCurrent(token)) return; // 늦은 이전 요청 — 버림
        const items: VideoItem[] = ((data.items ?? []) as ShortsFeedItem[]).map((v) => {
          // Label: 최애선수명 > 태깅된 선수명 > 팀명 > 없음
          // 최애 판별도 scalar playerId ∪ playerIds union — 서버 쿼리/필터와 동일 계약
          // (scalar 단일 태깅 최애가 일반 선수(amber)로 보이던 결손, 삼순 2차 NO-GO #3)
          const matchedPlayer =
            v.playerId && favPlayerMap.has(v.playerId)
              ? v.playerId
              : (v.playerIds ?? []).find((id: string) => favPlayerMap.has(id));
          const teamLabel = v.teamId ? (TEAM_LABEL[v.teamId] ?? null) : null;
          const label = matchedPlayer
            ? favPlayerMap.get(matchedPlayer)!
            : v.playerName ?? teamLabel ?? "";
          const isPlayerMatch = !!matchedPlayer;
          const hasPlayerTag = !matchedPlayer && !!v.playerName;

          return {
            id: v.id,
            title: v.title,
            thumbnail: v.thumbnail,
            channel: v.channel,
            publishedAt: v.publishedAt,
            playerIds: v.playerIds ?? [],
            teamId: v.teamId ?? null,
            isPlayerMatch,
            hasPlayerTag,
            label,
          };
        });
        setVideos(items.slice(0, 30));
        setLoading(false);
      }).catch(() => {
        // abort(언마운트/전환)된 요청은 오류 표시 대상 아님
        if (controller.signal.aborted || !gateRef.current.isCurrent(token)) return;
        // 실패 시 stale 타 scope 데이터 노출 금지 — 목록 비우고 명시적 오류 + 재시도
        setVideos([]);
        setFetchError(true);
        setLoading(false);
      });

    return () => controller.abort();
  }, [team, refreshNonce, scope, retryNonce]);

  if (!team || scope === null || !shortsVisible) return null;

  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold leading-[26px] text-text-primary mb-3">🎬 내 팀, 최애선수 숏츠</h2>
      <div className="flex gap-1.5 mb-3">
        {SCOPE_CHIPS.map((chip) => {
          const disabled = chip.value === "favorite_players" && !hasFavPlayers;
          const active = scope === chip.value;
          return (
            <button
              key={chip.value}
              type="button"
              disabled={disabled}
              onClick={() => selectScope(chip.value)}
              className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                active
                  ? "bg-text-primary text-bg-primary"
                  : disabled
                    ? "bg-bg-secondary text-text-tertiary opacity-50"
                    : "bg-bg-secondary text-text-secondary"
              }`}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
      {loading ? (
        <p className="text-sm text-text-tertiary py-4">불러오는 중…</p>
      ) : fetchError ? (
        <p className="text-sm text-text-tertiary py-4">
          숏츠를 불러오지 못했어요.{" "}
          <button
            type="button"
            className="underline text-text-secondary"
            onClick={() => setRetryNonce(n => n + 1)}
          >
            다시 시도
          </button>
        </p>
      ) : videos.length === 0 ? (
        <p className="text-sm text-text-tertiary py-4">해당하는 숏츠가 아직 없어요.</p>
      ) : (
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide" style={{ scrollSnapType: "x mandatory" }}>
        {videos.slice(0, 15).map((v, i) => (
          <div
            key={v.id}
            className="flex-shrink-0 cursor-pointer"
            style={{ width: "105px", scrollSnapAlign: "start" }}
            onClick={() => setReelIndex(i)}
          >
            <div className="relative rounded-xl overflow-hidden" style={{ aspectRatio: "9/16", width: "105px" }}>
              <img src={v.thumbnail} alt={v.title} className="w-full h-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/40 dark:from-black/60 via-transparent to-transparent" />
              <div className="absolute inset-0 flex items-center justify-center">
                <Play size={28} className="text-white fill-white opacity-80" />
              </div>
              {v.label && (
                <span className={`absolute top-2 left-2 px-1.5 py-0.5 rounded-full text-xs font-semibold text-white ${
                  v.isPlayerMatch ? "bg-rose-500/80" : v.hasPlayerTag ? "bg-amber-500/80" : "bg-blue-500/80"
                }`}>
                  {v.label}
                </span>
              )}
              <p className="absolute bottom-2 left-2 right-2 text-xs leading-[18px] text-white font-medium line-clamp-2">
                {v.title}
              </p>
            </div>
          </div>
        ))}
      </div>
      )}

      {reelIndex !== null && (
        <ReelViewer
          videos={videos}
          startIndex={reelIndex}
          onClose={() => setReelIndex(null)}
        />
      )}
    </section>
  );
}
