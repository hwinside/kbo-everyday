/**
 * 시리즈 스냅샷 계산 유틸
 *
 * 목적: AI 카피 생성 시 "원점으로 돌렸다 / 무승부로 마무리 / 스윕" 같은
 *       문구 분기를 정확하게 하기 위한 메타데이터를 산출한다.
 *
 * 규칙 (2026-04-19 삼식이·삼순이·하린아빠 합의):
 *  - seriesStatus: in_progress | completed | completed_with_cancellation
 *  - completed: 모든 편성 경기 소화 완료
 *  - completed_with_cancellation: 취소 발생 + 남은 편성 경기 없음
 *  - in_progress: 남은 편성 경기 있음
 *  - 문구 우선순위: 시리즈 결과 > 취소 사실 보조설명
 *  - "원점/추격/리드 굳힘" 같은 진행형은 in_progress 에서만 허용
 */

import { fetchGames, type KboGame } from "@/lib/crawler/kbo-api";

export type SeriesStatus = "in_progress" | "completed" | "completed_with_cancellation";

export interface SeriesSnapshot {
  /** 편성된 시리즈 총 경기 수 (연속 편성 블록 기준) */
  seriesScheduled: number;
  /** 실제 성사된(결과가 나온) 경기 수 */
  seriesPlayed: number;
  /** 취소(우천 등)로 무산된 경기 수 */
  seriesCanceledCount: number;
  /** 취소 경기 날짜 목록 (포맷: "M/D") */
  seriesCanceledDates: string[];
  /** 남은 편성 경기 수 = scheduled - played - canceled */
  seriesRemaining: number;
  /** 시리즈 상태 */
  seriesStatus: SeriesStatus;
  /**
   * 각 팀 승수 (teamId 키). 실제 성사된 경기만 집계.
   * 예: { "1": 1, "8": 1 } → LG 1승, 삼성 1승
   */
  seriesRecord: Record<string, number>;
  /** 이전(또는 같은) 시리즈 경기 결과 요약 */
  results: Array<{
    date: string; // YYYYMMDD
    displayDate: string; // M/D
    awayName: string;
    homeName: string;
    awayScore: number;
    homeScore: number;
    winnerTeamId: number | null; // null = draw (무승부)
    status: "final" | "cancelled";
  }>;
}

function shiftDate(dateStr: string, days: number): string {
  const y = parseInt(dateStr.slice(0, 4));
  const m = parseInt(dateStr.slice(4, 6)) - 1;
  const d = parseInt(dateStr.slice(6, 8));
  const dt = new Date(y, m, d + days);
  return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}${String(dt.getDate()).padStart(2, "0")}`;
}

function toDisplayDate(dateStr: string): string {
  const m = parseInt(dateStr.slice(4, 6));
  const d = parseInt(dateStr.slice(6, 8));
  return `${m}/${d}`;
}

function isMatchingPair(game: KboGame, aId: number, bId: number): boolean {
  return (
    (game.awayTeamId === aId && game.homeTeamId === bId) ||
    (game.awayTeamId === bId && game.homeTeamId === aId)
  );
}

/**
 * 두 팀이 붙는 시리즈 스냅샷을 산출한다.
 *
 * 시리즈 경계 정의: `gameId`를 기준으로 ±N일 범위에서 두 팀이 **연속 편성된 블록**.
 *   - 대상 gameId 포함
 *   - 날짜 정렬 후 gap=1일 초과하는 순간 블록 종료
 *   - cancelled 경기도 블록에 포함 (편성이므로)
 */
export async function computeSeriesSnapshot(
  gameId: string,
  teamAId: number,
  teamBId: number,
  windowDays: number = 4
): Promise<SeriesSnapshot | null> {
  const baseDate = gameId.slice(0, 8);
  const dates: string[] = [];
  for (let d = -windowDays; d <= windowDays; d++) {
    dates.push(shiftDate(baseDate, d));
  }

  const allGames = await Promise.all(dates.map(d => fetchGames(d).catch(() => [] as KboGame[])));
  const flat = allGames.flat();

  // 두 팀 매치업만 필터링
  const matches = flat.filter(g => isMatchingPair(g, teamAId, teamBId));
  if (matches.length === 0) return null;

  // 날짜 오름차순 정렬 (중복 gameId 제거)
  const byId = new Map<string, KboGame>();
  for (const g of matches) byId.set(g.gameId, g);
  const sorted = Array.from(byId.values()).sort((a, b) => a.date.localeCompare(b.date));

  // 대상 gameId가 포함된 연속 편성 블록 식별
  const targetIdx = sorted.findIndex(g => g.gameId === gameId);
  if (targetIdx === -1) return null;

  // 블록 확장 (앞뒤로 gap이 1일 이내인 것까지)
  const block: KboGame[] = [sorted[targetIdx]];
  // 앞쪽 확장
  for (let i = targetIdx - 1; i >= 0; i--) {
    const prev = sorted[i];
    const next = block[0];
    if (dayGap(prev.date, next.date) <= 1) block.unshift(prev);
    else break;
  }
  // 뒤쪽 확장
  for (let i = targetIdx + 1; i < sorted.length; i++) {
    const next = sorted[i];
    const prev = block[block.length - 1];
    if (dayGap(prev.date, next.date) <= 1) block.push(next);
    else break;
  }

  const seriesScheduled = block.length;
  const seriesCanceled = block.filter(g => g.status === "cancelled");
  const seriesFinal = block.filter(g => g.status === "final");
  const seriesUnplayed = block.filter(g => g.status === "scheduled" || g.status === "live");
  const seriesPlayed = seriesFinal.length;
  const seriesCanceledCount = seriesCanceled.length;
  const seriesRemaining = seriesUnplayed.length;

  // 대상 경기 자체가 live/scheduled인 경우 seriesRemaining에 포함됨.
  // 하지만 "완료/미완료"는 대상 경기의 status 를 기준으로 판단.
  const target = sorted[targetIdx];
  const isTargetFinal = target.status === "final";

  let seriesStatus: SeriesStatus;
  if (seriesRemaining > 0) {
    seriesStatus = "in_progress";
  } else if (seriesCanceledCount > 0) {
    seriesStatus = "completed_with_cancellation";
  } else {
    seriesStatus = "completed";
  }

  // 대상 경기가 아직 끝나지 않았다면 항상 in_progress 로 간주
  // (seriesRemaining 계산에 포함되므로 위 분기에서 이미 in_progress)
  void isTargetFinal;

  // 승수 집계
  const record: Record<string, number> = { [String(teamAId)]: 0, [String(teamBId)]: 0 };
  const results: SeriesSnapshot["results"] = [];
  for (const g of block) {
    if (g.status === "cancelled") {
      results.push({
        date: g.date,
        displayDate: toDisplayDate(g.date),
        awayName: g.awayName,
        homeName: g.homeName,
        awayScore: 0,
        homeScore: 0,
        winnerTeamId: null,
        status: "cancelled",
      });
      continue;
    }
    if (g.status !== "final") continue; // scheduled/live 는 집계 skip

    const aScore = g.awayScore ?? 0;
    const hScore = g.homeScore ?? 0;
    let winner: number | null = null;
    if (aScore > hScore) winner = g.awayTeamId;
    else if (hScore > aScore) winner = g.homeTeamId;

    if (winner !== null) {
      record[String(winner)] = (record[String(winner)] ?? 0) + 1;
    }

    results.push({
      date: g.date,
      displayDate: toDisplayDate(g.date),
      awayName: g.awayName,
      homeName: g.homeName,
      awayScore: aScore,
      homeScore: hScore,
      winnerTeamId: winner,
      status: "final",
    });
  }

  return {
    seriesScheduled,
    seriesPlayed,
    seriesCanceledCount,
    seriesCanceledDates: seriesCanceled.map(g => toDisplayDate(g.date)),
    seriesRemaining,
    seriesStatus,
    seriesRecord: record,
    results,
  };
}

function dayGap(a: string, b: string): number {
  const ay = parseInt(a.slice(0, 4)), am = parseInt(a.slice(4, 6)) - 1, ad = parseInt(a.slice(6, 8));
  const by = parseInt(b.slice(0, 4)), bm = parseInt(b.slice(4, 6)) - 1, bd = parseInt(b.slice(6, 8));
  const aDt = new Date(ay, am, ad).getTime();
  const bDt = new Date(by, bm, bd).getTime();
  return Math.abs(Math.round((bDt - aDt) / (1000 * 60 * 60 * 24)));
}

/**
 * 스냅샷을 LLM 프롬프트용 컨텍스트 문자열로 직렬화.
 * AI 가 이 값만 근거로 삼도록 분기 가이드도 함께 포함.
 */
export function serializeSeriesSnapshot(
  snap: SeriesSnapshot,
  teamAId: number,
  teamAShort: string,
  teamBId: number,
  teamBShort: string
): string {
  const aWins = snap.seriesRecord[String(teamAId)] ?? 0;
  const bWins = snap.seriesRecord[String(teamBId)] ?? 0;
  const isTie = aWins === bWins;

  const lines: string[] = [];
  lines.push(`## 시리즈 스냅샷 (사실 — 이 값만 근거로 사용)`);
  lines.push(`- 편성: ${snap.seriesScheduled}경기 / 소화: ${snap.seriesPlayed}경기 / 취소: ${snap.seriesCanceledCount}경기 / 남은 경기: ${snap.seriesRemaining}경기`);
  if (snap.seriesCanceledDates.length > 0) {
    lines.push(`- 취소 날짜: ${snap.seriesCanceledDates.join(", ")} (우천 등)`);
  }
  lines.push(`- 성적: ${teamAShort} ${aWins}승, ${teamBShort} ${bWins}승`);
  lines.push(`- 상태: ${snap.seriesStatus}`);
  if (snap.results.length > 0) {
    lines.push(`- 경기 결과:`);
    for (const r of snap.results) {
      if (r.status === "cancelled") {
        lines.push(`  * ${r.displayDate}: ${r.awayName} vs ${r.homeName} (우천 취소)`);
      } else {
        lines.push(`  * ${r.displayDate}: ${r.awayName} ${r.awayScore}-${r.homeScore} ${r.homeName}`);
      }
    }
  }

  // 분기 가이드
  lines.push(``);
  lines.push(`## 시리즈 문구 규칙 (반드시 준수)`);
  lines.push(`- 우선순위: 시리즈 결과 > 취소 사실 보조설명 (취소 언급은 필요할 때만 짧게).`);

  if (snap.seriesStatus === "in_progress") {
    lines.push(`- 상태 "in_progress": 남은 경기가 있으므로 "원점으로 돌렸다 / 추격의 발판 / 시리즈 리드 / 열세 만회 / 스윕 직전" 같은 진행형 표현 허용.`);
    if (isTie) {
      lines.push(`  * 현재 동률: "시리즈 전적을 원점으로 돌렸다" 같은 표현이 자연스러움.`);
    }
  } else if (snap.seriesStatus === "completed") {
    lines.push(`- 상태 "completed": 시리즈 종료. "원점 / 추격 / 리드 굳힘 / 발판" 같은 진행형 표현 금지.`);
    lines.push(`  * 확정형만 사용: "이번 시리즈를 ${Math.max(aWins, bWins)}승 ${Math.min(aWins, bWins)}패로 마쳤다" / "스윕으로 마감" 등.`);
  } else {
    // completed_with_cancellation
    lines.push(`- 상태 "completed_with_cancellation": 취소가 포함되어 실제 ${snap.seriesPlayed}경기로 축소된 채 시리즈가 종료됨. 진행형 표현 금지.`);
    if (isTie) {
      lines.push(`  * 동률 종료: 반드시 "무승부로 마무리" 템플릿 사용.`);
      lines.push(`  * 권장 문구 예시: "${snap.seriesCanceledDates[0] ?? ""} 우천 취소로 ${teamAShort}와 ${teamBShort}의 이번 시리즈는 ${aWins}승 ${bWins}패 무승부로 마무리됐다."`);
    } else {
      lines.push(`  * 승패 결정: 결과 중심으로 "이번 시리즈를 ${Math.max(aWins, bWins)}승 ${Math.min(aWins, bWins)}패로 마무리했다" 같이 표현. "N경기로 축소된 시리즈" 표현은 필요할 때만 보조로 붙임.`);
    }
  }
  lines.push(`- 취소 경기 언급은 seriesCanceledCount > 0 일 때만 허용. 현재 값: ${snap.seriesCanceledCount}.`);

  return lines.join("\n");
}
