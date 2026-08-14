import { useState, useEffect, useRef } from "react";
import { TEAMS } from "@/lib/constants/teams";
import { getFavoritePlayers } from "@/lib/store/favorites";

interface NewsItem {
  title: string;
  link: string;
  originalLink?: string;
  pubDate: string;
  _label?: string;
  viewToken?: string;
}

export interface HomeNewsItem {
  id: number;
  title: string;
  link: string;
  pubDate: string;
  label: string;
  source: string;
  sourceUrl: string;
  ogUrl: string;
  thumbnailUrl: null;
  timeAgo: string;
  teamId: number | null;
  type: "news";
  /** 조회수 서명(/api/news 발급). */
  viewToken?: string;
}

// v4: non-Naver link 기사를 API에서 노출 제외하도록 바뀌어, 옛 캐시(언론사 link 섞인 v3)를
// 무효화해야 배포 직후에도 "무조건 네이버" 보장됨
const NEWS_CACHE_KEY = "kbo-home-news-v4";
const NEWS_CACHE_TTL = 30 * 60 * 1000; // 30분

function toHomeNewsItems(items: NewsItem[], myTeamId: number | null): HomeNewsItem[] {
  return items.map((item, i) => ({
    id: 1000 + i,
    title: item.title,
    link: item.link,
    pubDate: item.pubDate,
    label: item._label || "",
    source: (() => {
      // 출처 표기는 언론사 원문(originalLink) host 기준 — 계산만, 클릭은 네이버
      try { return new URL(item.originalLink || item.link).hostname.replace("www.", "").replace("m.", ""); }
      catch { return "뉴스"; }
    })(),
    // 클릭 타깃은 네이버 뉴스 URL(link) — '무조건 네이버' 보장
    sourceUrl: item.link,
    // 썸네일/OG 추출은 언론사 원문(originalLink) 기준 — 네이버보다 OG 이미지 품질 안정적
    ogUrl: item.originalLink || item.link,
    timeAgo: (() => {
      const diff = Date.now() - new Date(item.pubDate).getTime();
      const hours = Math.floor(diff / (1000 * 60 * 60));
      if (hours < 1) return "방금";
      if (hours < 24) return `${hours}시간 전`;
      const days = Math.floor(hours / 24);
      return `${days}일 전`;
    })(),
    thumbnailUrl: null,
    type: "news" as const,
    teamId: myTeamId || null,
    viewToken: item.viewToken,
  }));
}

function loadCachedNews(myTeamId: number | null): HomeNewsItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(NEWS_CACHE_KEY);
    if (!raw) return [];
    const { items, ts, teamId } = JSON.parse(raw);
    // 캐시 팀이 다르면 무효
    if (teamId !== myTeamId) return [];
    // TTL 체크는 느슨하게 — 일단 보여주고 백그라운드에서 갱신
    if (Date.now() - ts > 24 * 60 * 60 * 1000) return []; // 24시간 넘으면 무효
    return toHomeNewsItems(items, myTeamId);
  } catch {
    return [];
  }
}

function saveCachedNews(items: NewsItem[], myTeamId: number | null) {
  try {
    localStorage.setItem(NEWS_CACHE_KEY, JSON.stringify({
      items,
      ts: Date.now(),
      teamId: myTeamId,
    }));
  } catch { /* quota exceeded 등 무시 */ }
}

function shouldRefresh(): boolean {
  try {
    const raw = localStorage.getItem(NEWS_CACHE_KEY);
    if (!raw) return true;
    const { ts } = JSON.parse(raw);
    return Date.now() - ts > NEWS_CACHE_TTL;
  } catch {
    return true;
  }
}

export function useHomeNews(myTeamId: number | null) {
  const [news, setNews] = useState<HomeNewsItem[]>([]);
  const fetchedRef = useRef(false);

  // 즉시 캐시에서 로드
  useEffect(() => {
    const cached = loadCachedNews(myTeamId);
    if (cached.length > 0) {
      setNews(cached); // eslint-disable-line react-hooks/set-state-in-effect
    }
  }, [myTeamId]);

  // 백그라운드에서 새 뉴스 fetch
  useEffect(() => {
    if (fetchedRef.current) return;
    if (myTeamId === null) return; // 팀 아직 안 로드됨

    // 캐시 있고 신선하면 skip
    const cached = loadCachedNews(myTeamId);
    if (cached.length > 0 && !shouldRefresh()) {
      fetchedRef.current = true;
      return;
    }

    fetchedRef.current = true;

    const team = TEAMS.find(t => t.id === myTeamId)?.shortName || "";
    let favPlayers = getFavoritePlayers().slice(0, 5);

    // 최애선수 미설정 시 팀의 대표 선수 3명으로 fallback
    if (favPlayers.length === 0 && team) {
      const defaultPlayers: Record<string, string[]> = {
        "LG": ["오스틴", "문보경", "홍창기"],
        "두산": ["양의지", "허경민", "곽빈"],
        "KT": ["강백호", "로하스", "소형준"],
        "SSG": ["최정", "추신수", "김광현"],
        "NC": ["손아섭", "박건우", "에릭"],
        "KIA": ["김도영", "나성범", "양현종"],
        "삼성": ["구자욱", "김영웅", "원태인"],
        "롯데": ["전준우", "레이예스", "윌커슨"],
        "한화": ["노시환", "이범호", "주현상"],
        "키움": ["이정후", "김하성", "송성문"],
      };
      const names = defaultPlayers[team] || [];
      const teamObj = TEAMS.find(t => t.shortName === team);
      favPlayers = names.map(name => ({ playerId: "", name, teamId: teamObj?.id || 0, position: "", number: 0 }));
    }

    // 단일 batch API 호출
    const players = favPlayers.map(p => {
      const pTeam = TEAMS.find(t => t.id === p.teamId);
      return {
        name: p.name,
        teamName: pTeam ? `${pTeam.shortName} ${pTeam.name}` : "",
      };
    });

    fetch("/api/news/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team: team ? `${team}` : "", players }),
    })
      .then(r => r.json())
      .then(data => {
        const items: NewsItem[] = data.items || [];
        if (items.length > 0) {
          saveCachedNews(items, myTeamId);
          setNews(toHomeNewsItems(items, myTeamId));
        }
      })
      .catch(() => {});
  }, [myTeamId]);

  return news;
}

/**
 * Standalone fetch for lazy import from HomeClientShell.
 * Returns cached news immediately, then fetches fresh in background.
 */
export async function fetchHomeNews(myTeamId: number | null): Promise<HomeNewsItem[]> {
  if (myTeamId === null) return [];

  // 1. Try cache first
  const cached = loadCachedNews(myTeamId);
  if (cached.length > 0 && !shouldRefresh()) {
    return cached;
  }

  // 2. Fetch fresh
  const team = TEAMS.find(t => t.id === myTeamId)?.shortName || "";
  let favPlayers = getFavoritePlayers().slice(0, 5);

  if (favPlayers.length === 0 && team) {
    const defaultPlayers: Record<string, string[]> = {
      "LG": ["오스틴", "문보경", "홍창기"],
      "두산": ["양의지", "허경민", "곽빈"],
      "KT": ["강백호", "로하스", "소형준"],
      "SSG": ["최정", "추신수", "김광현"],
      "NC": ["손아섭", "박건우", "에릭"],
      "KIA": ["김도영", "나성범", "양현종"],
      "삼성": ["구자욱", "김영웅", "원태인"],
      "롯데": ["전준우", "레이예스", "윌커슨"],
      "한화": ["노시환", "이범호", "주현상"],
      "키움": ["이정후", "김하성", "송성문"],
    };
    const names = defaultPlayers[team] || [];
    const teamObj = TEAMS.find(t => t.shortName === team);
    favPlayers = names.map(name => ({ playerId: "", name, teamId: teamObj?.id || 0, position: "", number: 0 }));
  }

  const players = favPlayers.map(p => {
    const pTeam = TEAMS.find(t => t.id === p.teamId);
    return { name: p.name, teamName: pTeam ? `${pTeam.shortName} ${pTeam.name}` : "" };
  });

  try {
    const res = await fetch("/api/news/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team: team ? `${team}` : "", players }),
    });
    const data = await res.json();
    const items: NewsItem[] = data.items || [];
    if (items.length > 0) {
      saveCachedNews(items, myTeamId);
      return toHomeNewsItems(items, myTeamId);
    }
  } catch { /* ignore */ }

  return cached.length > 0 ? cached : [];
}
