// 공용 Naver preview 라인업 어댑터 — KBO GetLineUpAnalysis 전면 열화(204/빈응답/타임아웃) 시
// 4개 소비 경로가 재사용하는 단일 폴백 소스(삼순 PR#988 P0-1/P0-2):
//   ① 경기상세 라인업 탭(game-detail/route.ts)
//   ② 라인업 확정알림 watchdog(lineup-confirmed.ts → lineup-watchdog)
//   ③ 라인업 AI 전일비교(lineup-analysis/route.ts 의 이전 경기 라인업)
//   ④ 경기 AI preview(game-preview/route.ts 의 오늘/이전 라인업)
//
// previewData.{away,home}TeamLineUp.fullLineUp 은 [선발투수, 타순1..9] 순서로 내려오고
// 라인업 미확정 경기는 빈 배열이다(2026-07-30 당일 5경기 실측 — 확정 10+10 / 익일 0+0).
// 스냅샷은 side 별 "선발투수 정확히 1 + 타자 정확히 9" 검증을 통과한 **완전 라인업**일 때만
// 존재한다(confirmed=true). 부분 응답·조회 실패는 null — 확정알림 오발송 방지 fail-close.

import { naverGameId } from "@/lib/crawler/naver-record";

const NAVER_API = "https://api-gw.sports.naver.com/schedule/games";

/** Naver positionName(한글) → 영문 축약. 미지 포지션은 원문 유지(호출측 표기 규약과 동일). */
const NAVER_POS_MAP: Record<string, string> = {
  "투수": "P", "포수": "C", "1루수": "1B", "2루수": "2B",
  "3루수": "3B", "유격수": "SS", "좌익수": "LF", "중견수": "CF",
  "우익수": "RF", "지명타자": "DH",
};

export interface NaverLineupBatter {
  order: number; // 타순 1~9 (fullLineUp 등장 순서)
  position: string; // 영문 축약 (P/C/1B/…)
  positionKr: string; // Naver 원문 positionName
  name: string;
}

export interface NaverLineupSide {
  /** 선발투수 이름 — 정확히 1명 검증 통과분. */
  starter: string;
  /** 타자 정확히 9명(타순 1~9). */
  batters: NaverLineupBatter[];
}

export interface NaverLineupSnapshot {
  away: NaverLineupSide;
  home: NaverLineupSide;
  /**
   * 완전 라인업(양팀 각 선발1+타자9) 검증 통과 시에만 스냅샷이 생성되므로 항상 true.
   * 확정알림(lineup-confirmed)이 이 존재 자체를 확정 근거로 사용한다.
   */
  confirmed: true;
}

export interface NaverPreviewStarters {
  away: string;
  home: string;
}

function previewStarterName(previewData: Record<string, unknown>, side: "away" | "home"): string {
  const direct = (
    previewData[`${side}Starter`] as { playerInfo?: { name?: unknown } } | undefined
  )?.playerInfo?.name;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const full = (
    previewData[`${side}TeamLineUp`] as { fullLineUp?: unknown } | undefined
  )?.fullLineUp;
  if (!Array.isArray(full)) return "";
  const starter = (full as Record<string, unknown>[]).find(
    (player) => player.positionName === "선발투수",
  );
  return typeof starter?.playerName === "string" ? starter.playerName.trim() : "";
}

/**
 * Naver preview의 경기 식별자를 KBO gameId와 대조한 뒤 발표된 선발만 추출한다.
 * 라인업 확정 전(fullLineUp 1명)에도 awayStarter/homeStarter는 제공되므로,
 * 완전 라인업 계약(parseNaverPreviewLineup)을 느슨하게 만들지 않고 별도 파싱한다.
 */
export function parseNaverPreviewStarters(
  json: unknown,
  kboGameId: string,
): NaverPreviewStarters | null {
  const payload = json as {
    code?: unknown;
    success?: unknown;
    result?: { previewData?: Record<string, unknown> };
  };
  const previewData = payload.result?.previewData;
  if (payload.code !== 200 || payload.success !== true || !previewData) return null;

  const gameInfo = previewData.gameInfo as {
    gdate?: unknown;
    aCode?: unknown;
    hCode?: unknown;
  } | undefined;
  const expectedDate = kboGameId.slice(0, 8);
  const expectedAway = kboGameId.slice(8, 10);
  const expectedHome = kboGameId.slice(10, 12);
  if (
    String(gameInfo?.gdate ?? "") !== expectedDate
    || gameInfo?.aCode !== expectedAway
    || gameInfo?.hCode !== expectedHome
  ) {
    return null;
  }

  const away = previewStarterName(previewData, "away");
  const home = previewStarterName(previewData, "home");
  if (!away || !home) return null;
  return { away, home };
}

/** side 하나를 검증-파싱: 선발투수 정확히 1(이름 필수) + 타자 정확히 9 아니면 null. */
function parseSide(side: unknown): NaverLineupSide | null {
  const full = (side as { fullLineUp?: unknown })?.fullLineUp;
  if (!Array.isArray(full)) return null;
  let starter = "";
  let starterCount = 0;
  const batters: NaverLineupBatter[] = [];
  for (const p of full as Record<string, unknown>[]) {
    const posKr = typeof p?.positionName === "string" ? p.positionName.trim() : "";
    const name = typeof p?.playerName === "string" ? p.playerName.trim() : "";
    if (!name) return null; // 이름 결측 엔트리 = 부분 데이터 → fail-close
    if (posKr === "선발투수") {
      starterCount++;
      starter = name;
      continue;
    }
    batters.push({
      order: batters.length + 1,
      position: NAVER_POS_MAP[posKr] || posKr,
      positionKr: posKr,
      name,
    });
  }
  if (starterCount !== 1 || batters.length !== 9) return null;
  return { starter, batters };
}

/** Naver preview 응답 → 완전 라인업 스냅샷. 부분/이형 데이터는 null (순수 파서, 테스트용 export). */
export function parseNaverPreviewLineup(json: unknown): NaverLineupSnapshot | null {
  const pd = (json as { result?: { previewData?: Record<string, unknown> } })?.result?.previewData;
  if (!pd) return null;
  const away = parseSide(pd.awayTeamLineUp);
  const home = parseSide(pd.homeTeamLineUp);
  if (!away || !home) return null;
  return { away, home, confirmed: true };
}

/**
 * Naver preview API 에서 완전 라인업 스냅샷 조회. 실패/부분 데이터는 null(fail-close).
 * revalidate 60s 캐시로 폴백 fanout 을 억제한다(경기별 gameId 조회라 stale 교차 오염 없음).
 */
export async function fetchNaverLineup(
  kboGameId: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<NaverLineupSnapshot | null> {
  try {
    const nId = naverGameId(kboGameId);
    const signal =
      opts?.signal ?? (opts?.timeoutMs != null ? AbortSignal.timeout(opts.timeoutMs) : undefined);
    const res = await fetch(`${NAVER_API}/${nId}/preview`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)" },
      next: { revalidate: 60 },
      signal,
    });
    if (!res.ok) return null;
    return parseNaverPreviewLineup(await res.json());
  } catch {
    return null;
  }
}

/**
 * Naver preview에서 발표된 선발투수만 조회한다.
 * 라인업 전체가 아직 확정되지 않아도 경기 식별자 검증을 통과한 이름만 반환한다.
 */
export async function fetchNaverPreviewStarters(
  kboGameId: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<NaverPreviewStarters | null> {
  try {
    const nId = naverGameId(kboGameId);
    const signal =
      opts?.signal ?? (opts?.timeoutMs != null ? AbortSignal.timeout(opts.timeoutMs) : undefined);
    const res = await fetch(`${NAVER_API}/${nId}/preview`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)" },
      next: { revalidate: 60 },
      signal,
    });
    if (!res.ok) return null;
    return parseNaverPreviewStarters(await res.json(), kboGameId);
  } catch {
    return null;
  }
}
