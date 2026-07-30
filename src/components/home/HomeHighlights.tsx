"use client";

import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { getFavoritePlayers } from "@/lib/store/favorites";
import { TEAMS } from "@/lib/constants/teams";
import ReelViewer from "@/components/home/ReelViewer";
import { getShortsScope, getShortsVisible, setShortsScope, SHORTS_PREF_EVENT } from "@/lib/store/shorts-pref";
import type { ShortsScope } from "@/lib/video/shorts-feed-scope";

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
  // scope 칩 (최애선수 | 마이팀 | 전체). null = 기존 혼합 피드 그대로.
  const [scope, setScope] = useState<ShortsScope | null>(null);
  const [hasFavPlayers, setHasFavPlayers] = useState(false);

  useEffect(() => {
    const favCount = getFavoritePlayers().length;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasFavPlayers(favCount > 0);
    const saved = getShortsScope();
    // 저장된 scope가 현재 상태에서 불가능하면(최애선수 미지정 등) 혼합 피드로 폴백
    if (saved === "favorite_players" && favCount === 0) return;
    setScope(saved);
  }, []);

  const selectScope = (next: ShortsScope) => {
    // 활성 칩 재탭 = 해제(기존 혼합 피드 복귀)
    const resolved = scope === next ? null : next;
    setScope(resolved);
    setShortsScope(resolved);
    // scope 있는 상태에서는 섹션을 유지한 채 "불러오는 중" 표시 (깜박임 방지)
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

    const favPlayers = getFavoritePlayers().slice(0, 5);
    const favPlayerMap = new Map(favPlayers.map(p => [p.playerId, p.name]));
    // 마이팀/전체 scope는 순수 팀/전체 피드 — 최애선수 병합 쿼리 방지 위해 player_ids 미전송
    const sendPlayerIds = scope === null || scope === "favorite_players";
    const playerIdsParam = sendPlayerIds && favPlayers.length > 0
      ? `&player_ids=${encodeURIComponent(favPlayers.map(p => p.playerId).join(","))}`
      : "";
    const scopeParam = scope ? `&scope=${scope}` : "";

    fetch(`/api/shorts-feed?team=${encodeURIComponent(team)}${playerIdsParam}${scopeParam}`)
      .then(r => r.json())
      .then((data) => {
        const items: VideoItem[] = ((data.items ?? []) as ShortsFeedItem[]).map((v) => {
          // Label: 최애선수명 > 태깅된 선수명 > 팀명 > 없음
          const matchedPlayer = (v.playerIds ?? []).find((id: string) => favPlayerMap.has(id));
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
      }).catch(() => setLoading(false));
  }, [team, refreshNonce, scope]);

  // scope 선택 상태에서는 빈 결과여도 칩을 유지해 다른 scope로 돌아갈 수 있게 한다.
  // (칩 전환 재페치 중에는 이전 목록을 그대로 보여 섹션 깜박임을 막는다)
  if ((loading && scope === null) || (videos.length === 0 && scope === null) || !shortsVisible) return null;

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
      {videos.length === 0 ? (
        <p className="text-sm text-text-tertiary py-4">
          {loading ? "불러오는 중…" : "해당하는 숏츠가 아직 없어요."}
        </p>
      ) : (
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide" style={{ scrollSnapType: "x mandatory" }}>
        {videos.slice(0, 15).map((v, i) => (
          <div
            key={v.id}
            className="flex-shrink-0 cursor-pointer"
            style={{ width: "140px", scrollSnapAlign: "start" }}
            onClick={() => setReelIndex(i)}
          >
            <div className="relative rounded-xl overflow-hidden" style={{ aspectRatio: "9/16", width: "140px" }}>
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
