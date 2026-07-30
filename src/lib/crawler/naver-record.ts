// Naver record API 기반 linescore fallback — game-detail 과 game-summary 공용.
//
// KBO GetScoreBoard 가 이닝을 '-' 로 내려주면 parseGameLinescoreResponse 가 이닝 값이 전부
// null(또는 null 자체)인 linescore 를 만든다. 그러면 요약 canonical 게이트가 이닝표를 못 얻어
// canonical-not-settled(409) 로 생성을 거부한다(2026-07-28 종료경기 AI요약 전면 중단).
// game-detail 은 이 경우 이미 Naver record API 의 scoreBoard 로 fallback 한다 — 그 소스를 공용화한다.

import { isAllStarGameId } from "@/lib/constants/teams";
import type {
  BoxScoreBatterRecord,
  BoxScorePitcherRecord,
  BoxScoreResult,
  GameLinescoreSide,
} from "@/lib/crawler/kbo-api";

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

// ===== BoxScore fallback (KBO GetBoxScore 하드실패 시 Naver record 로 대체) =====
// game-detail 라우트가 이미 recordData.battersBoxscore/pitchersBoxscore 를 같은 필드로 소비한다.
// 그 매핑을 kbo-api 의 BoxScoreResult 계약으로 공용화해 summary·daily 공용 fetchBoxScore 가 재사용한다.

interface NaverBoxBatter {
  batOrder?: number | string; pos?: string; name?: string;
  ab?: number | string; hit?: number | string; run?: number | string; rbi?: number | string;
  hr?: number | string; bb?: number | string; kk?: number | string; sb?: number | string; hra?: string;
}
interface NaverBoxPitcher {
  name?: string; inn?: string; wls?: string;
  hit?: number | string; r?: number | string; hr?: number | string;
  kk?: number | string; bb?: number | string; er?: number | string; era?: string;
}
interface NaverBoxRecordData {
  battersBoxscore?: { away?: NaverBoxBatter[]; home?: NaverBoxBatter[] };
  pitchersBoxscore?: { away?: NaverBoxPitcher[]; home?: NaverBoxPitcher[] };
}

function naverInt(v: unknown): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Naver 이닝 표기 → KBO GetBoxScore 표기로 정규화.
 * KBO 는 "3 2/3" / "2/3"(정수부 0 은 생략) / "1" 형식, Naver 는 유니코드 분수 "3 ⅔" / "0 ⅔" 를 쓴다.
 * 유니코드 ⅓/⅔ → "1/3"/"2/3" 로 바꾸고 선행 "0 " 를 제거해 KBO 문자열과 정확히 일치시킨다.
 * (downstream parseIP 가 KBO 표기 기준이라 표기를 맞춰야 동일 동작을 보장)
 */
export function normalizeNaverInnings(inn: string | undefined): string {
  const s = String(inn ?? "").replace(/⅓/g, "1/3").replace(/⅔/g, "2/3").trim();
  // "0 2/3" → "2/3" (KBO 는 정수부 0 을 표기하지 않음)
  return s.replace(/^0\s+(\d\/\d)$/, "$1");
}

/**
 * Naver record 응답의 recordData 를 kbo-api BoxScoreResult 로 매핑하는 순수 함수.
 * battersBoxscore/pitchersBoxscore 결측이거나 양팀 모두 빈 배열이면 null(fail-close) — 부실 부분데이터 표시 금지.
 */
export function parseNaverBoxScore(recordData: NaverBoxRecordData | null | undefined): BoxScoreResult | null {
  const bb = recordData?.battersBoxscore;
  const pb = recordData?.pitchersBoxscore;
  if (!bb || !pb) return null;

  function toBatter(b: NaverBoxBatter, prevOrder: number): BoxScoreBatterRecord {
    const order = naverInt(b.batOrder);
    const pos = String(b.pos ?? "");
    // KBO parseBoxScore 와 동일한 교체선수 판정: 타순 중복 or 대타/대주(타·주·대) 포지션.
    const isSubstitute = order === prevOrder || pos.startsWith("타") || pos.startsWith("주") || pos.startsWith("대");
    return {
      order,
      position: pos, // KBO GetBoxScore 원본도 "지"/"二" 단문자 표기라 Naver pos 를 그대로 사용(포맷 일치).
      name: String(b.name ?? ""),
      atBats: naverInt(b.ab),
      hits: naverInt(b.hit),
      runs: naverInt(b.run),
      rbi: naverInt(b.rbi),
      hr: naverInt(b.hr),
      bb: naverInt(b.bb),
      so: naverInt(b.kk),
      sb: naverInt(b.sb),
      avg: String(b.hra ?? "") || ".000", // KBO avg 도 "0.302" 형식이라 그대로 일치.
      isSubstitute,
    };
  }

  function toBatters(arr: NaverBoxBatter[] | undefined): BoxScoreBatterRecord[] {
    let prevOrder = -1;
    return (arr ?? [])
      .map((b) => {
        const rec = toBatter(b, prevOrder);
        prevOrder = rec.order;
        return rec;
      })
      .filter((b) => b.name !== "");
  }

  function toPitchers(arr: NaverBoxPitcher[] | undefined): BoxScorePitcherRecord[] {
    return (arr ?? [])
      .map((p) => ({
        name: String(p.name ?? ""),
        inningsPitched: normalizeNaverInnings(p.inn),
        decision: String(p.wls ?? ""), // Naver wls 는 이미 KBO 와 동일한 "승/패/세/홀" 토큰.
        pitchCount: 0, // Naver record 는 투구수 미제공(bf/pa 는 상대타자/타석수라 위장 매핑 금지) → 0 degrade.
        hits: naverInt(p.hit),
        runs: naverInt(p.r),
        hr: naverInt(p.hr),
        strikeouts: naverInt(p.kk),
        walks: naverInt(p.bb),
        earnedRuns: naverInt(p.er),
        era: String(p.era ?? "") || "0.00",
      }))
      .filter((p) => p.name !== "");
  }

  const result: BoxScoreResult = {
    awayBatters: toBatters(bb.away),
    homeBatters: toBatters(bb.home),
    awayPitchers: toPitchers(pb.away),
    homePitchers: toPitchers(pb.home),
  };

  // fail-close: 양팀 투수/타자 모두 비면 부실 데이터로 간주하고 null.
  const empty =
    result.awayPitchers.length === 0 && result.homePitchers.length === 0 &&
    result.awayBatters.length === 0 && result.homeBatters.length === 0;
  return empty ? null : result;
}

/**
 * Naver record API 에서 BoxScore 를 조회. KBO GetBoxScore 하드실패 시 fetchBoxScore 가 동적 import 로 호출.
 * fetchNaverLinescore 와 동일한 엔드포인트/헤더 계약을 재사용한다.
 */
export async function fetchNaverBoxScore(kboGameId: string): Promise<BoxScoreResult | null> {
  try {
    const nId = naverGameId(kboGameId);
    const res = await fetch(`${NAVER_API}/${nId}/record`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)" },
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return parseNaverBoxScore(json?.result?.recordData);
  } catch {
    return null;
  }
}
