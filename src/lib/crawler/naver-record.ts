// Naver record API 기반 linescore fallback — game-detail 과 game-summary 공용.
//
// KBO GetScoreBoard 가 이닝을 '-' 로 내려주면 parseGameLinescoreResponse 가 이닝 값이 전부
// null(또는 null 자체)인 linescore 를 만든다. 그러면 요약 canonical 게이트가 이닝표를 못 얻어
// canonical-not-settled(409) 로 생성을 거부한다(2026-07-28 종료경기 AI요약 전면 중단).
// game-detail 은 이 경우 이미 Naver record API 의 scoreBoard 로 fallback 한다 — 그 소스를 공용화한다.

import { isAllStarGameId } from "@/lib/constants/teams";
import type { GameLinescoreSide } from "@/lib/crawler/kbo-api";

const NAVER_API = "https://api-gw.sports.naver.com/schedule/games";

/** KBO gameId → Naver gameId (연도 접미). 올스타는 앞 4자리를 9999 로 서비스. */
export function naverGameId(kboGameId: string): string {
  const year = kboGameId.slice(0, 4);
  const base = isAllStarGameId(kboGameId) ? `9999${kboGameId.slice(4)}` : kboGameId;
  return `${base}${year}`;
}

interface NaverScoreBoard {
  inn?: { away?: (number | null)[]; home?: (number | null)[] };
  rheb?: {
    away?: { r?: number; h?: number; e?: number };
    home?: { r?: number; h?: number; e?: number };
  };
}

/** Naver record 응답의 scoreBoard 에서 이닝별 득점 + RHE 를 뽑는 순수 파서. */
export function parseNaverScoreBoardLinescore(
  sb: NaverScoreBoard | null | undefined,
): { away: GameLinescoreSide; home: GameLinescoreSide } | null {
  if (!sb?.inn || !sb?.rheb) return null;
  return {
    away: {
      innings: (sb.inn.away || []).map((v) => v),
      R: sb.rheb.away?.r ?? 0,
      H: sb.rheb.away?.h ?? 0,
      E: sb.rheb.away?.e ?? 0,
    },
    home: {
      innings: (sb.inn.home || []).map((v) => v),
      R: sb.rheb.home?.r ?? 0,
      H: sb.rheb.home?.h ?? 0,
      E: sb.rheb.home?.e ?? 0,
    },
  };
}

/**
 * Naver record API 에서 linescore(이닝표 + RHE)만 조회. KBO linescore 가 null/이닝 부재일 때 fallback.
 * status 는 호출측(경기목록 canonical.status)이 판단하므로 여기서는 innings/RHE 만 반환한다.
 */
export async function fetchNaverLinescore(
  kboGameId: string,
): Promise<{ away: GameLinescoreSide; home: GameLinescoreSide } | null> {
  try {
    const nId = naverGameId(kboGameId);
    const res = await fetch(`${NAVER_API}/${nId}/record`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)" },
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const parsed = parseNaverScoreBoardLinescore(json?.result?.recordData?.scoreBoard);
    // fail-close: 이닝값이 하나도 없으면(sb.inn 객체는 있어도 전부 null) 빈 이닝표를 반환하지 않는다.
    // canonicalGate 는 score exact 만 보고 빈 innings 도 fingerprint 로 통과시키므로, 여기서 막아
    // 이닝 타임라인 없는 부실 요약 생성을 차단한다.
    return hasInningBreakdown(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 이닝별 값이 하나라도 있는지(전부 null 이면 이닝표 부재로 간주). GameLinescore·Naver 파싱 결과 공용. */
export function hasInningBreakdown(
  ls: { away: { innings: (number | null)[] }; home: { innings: (number | null)[] } } | null | undefined,
): boolean {
  return (
    !!ls &&
    (ls.away.innings.some((v) => v !== null) || ls.home.innings.some((v) => v !== null))
  );
}
