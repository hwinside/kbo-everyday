import { useState, useEffect } from "react";
import { TEAMS } from "@/lib/constants/teams";
import { getFavoritePlayers } from "@/lib/store/favorites";

interface NewsItem {
  title: string;
  link: string;
  pubDate: string;
  _label?: string;
}

export interface HomeNewsItem {
  id: number;
  title: string;
  link: string;
  pubDate: string;
  label: string;
  source: string;
  sourceUrl: string;
  thumbnailUrl: null;
  timeAgo: string;
  teamId: number | null;
  type: "news";
}

export function useHomeNews(myTeamId: number | null) {
  const [realNews, setRealNews] = useState<HomeNewsItem[]>([]);

  useEffect(() => {
    const team = myTeamId ? TEAMS.find(t => t.id === myTeamId)?.shortName : "";
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

    // 팀 뉴스 + 최애선수 뉴스 병렬 호출
    const queries = [
      team
        ? fetch(`/api/news?q=${encodeURIComponent(`프로야구 ${team}`)}`).then(r => r.json()).then(d => ({
            items: (d.items || []).map((item: NewsItem) => ({ ...item, _label: team })),
          }))
        : Promise.resolve({ items: [] }),
      ...favPlayers.map(p => {
        const pTeam = TEAMS.find(t => t.id === p.teamId);
        const pTeamName = pTeam ? `${pTeam.shortName} ${pTeam.name}` : "";
        return fetch(`/api/news?q=${encodeURIComponent(`${pTeamName} ${p.name}`)}`).then(r => r.json()).then(d => ({
          items: (d.items || []).map((item: NewsItem) => ({ ...item, _label: p.name })),
        }));
      })
    ];

    Promise.all(queries).then(results => {
      const teamItems = results[0]?.items || [];
      const playerResults = results.slice(1);

      // 선수별 균등 분배 (각 2개씩 먼저, 남은 슬롯은 라운드로빈)
      const seen = new Set();
      const dedupArr = (items: NewsItem[]) => items.filter((item: NewsItem) => {
        if (seen.has(item.link)) return false;
        seen.add(item.link);
        return true;
      });

      // 선수별 각 2개씩
      const perPlayer = playerResults.map(d => dedupArr((d.items || []).slice(0, 3)));
      const playerNews = perPlayer.flat();

      // 팀 기사로 나머지 채우기
      const uniqueTeam = dedupArr(teamItems).slice(0, Math.max(10 - playerNews.length, 2));
      const unique = [...playerNews, ...uniqueTeam];

      // 최신순 정렬
      unique.sort((a: NewsItem, b: NewsItem) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());

      if (unique.length) {
        setRealNews(unique.map((item: NewsItem, i: number) => ({
          id: 1000 + i,
          title: item.title,
          link: item.link,
          pubDate: item.pubDate,
          label: item._label || "",
          source: (() => { try { return new URL(item.link).hostname.replace("www.", "").replace("m.", ""); } catch { return "뉴스"; } })(),
          sourceUrl: item.link,
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
        })));
      }
    }).catch(console.error);
  }, [myTeamId]);

  return realNews;
}
