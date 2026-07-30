/**
 * KBO 라인업 확정 신호(LINEUP_CK) 조회 — 라인업 확정 알림 트리거.
 * game-detail 의 GetLineUpAnalysis 응답 data[0][0].LINEUP_CK 를 그대로 읽는다.
 * true=확정 / false=미확정(또는 fallback 라인업) / null=신호 못 얻음(네트워크/파싱 실패).
 *
 * KBO 가 신호를 못 주는 전면 열화(204/빈응답/타임아웃)에서는 Naver preview 완전 라인업
 * 스냅샷(양팀 각 선발1+타자9)의 존재를 확정 근거로 사용한다(삼순 PR#988 P0-2 ②).
 * Naver 조회 실패/부분 데이터는 null 유지(fail-close) — 확정알림 오발송 방지.
 * KBO 가 명시적으로 false(미확정)를 주면 Naver 를 보지 않고 그대로 존중한다.
 */
import { fetchNaverLineup } from "@/lib/crawler/naver-lineup";

const KBO_BASE = "https://www.koreabaseball.com/ws/Schedule.asmx";
// 2026-05-20: KBO가 Referer 미지정 요청을 IE 에러 페이지로 막음 → LineUp Referer 고정.
const HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
  Referer: "https://www.koreabaseball.com/Schedule/LineUp.aspx",
};

/** 응답 배열에서 LINEUP_CK 를 추출. 형태 불명이면 null. */
export function parseLineupCk(data: unknown): boolean | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const ckArr = data[0];
  if (!Array.isArray(ckArr) || ckArr.length === 0) return null;
  const first = ckArr[0] as Record<string, unknown> | null;
  if (!first || !("LINEUP_CK" in first)) return null;
  return !!first.LINEUP_CK;
}

export async function fetchLineupConfirmed(
  gameId: string,
  opts?: { seasonId?: string; timeoutMs?: number },
): Promise<boolean | null> {
  const sid = opts?.seasonId || gameId.slice(0, 4);
  // timeoutMs 는 srId 0/1 재시도를 포함한 **전체 절대 예산**이다(삼순 #952 4차 blocker1):
  // 이전엔 srId 마다 timeoutMs 를 새로 셬 40ms 예산이 actual 82ms 가 됐다. 경과를 차감해
  // 두 fetch 가 합치면 timeoutMs 를 넘지 않게 하고(watchdog 의 absolute deadline 결속 유지),
  // 잔여 예산이 소진되면 두번째 srId 는 시도하지 않고 null(신호 못 얻음) 반환.
  const startMs = Date.now();
  for (const srId of ["0", "1"]) {
    let signal: AbortSignal | undefined;
    if (opts?.timeoutMs != null) {
      const remaining = opts.timeoutMs - (Date.now() - startMs);
      if (remaining <= 0) break;
      signal = AbortSignal.timeout(remaining);
    }
    const body = `leId=1&srId=${srId}&seasonId=${sid}&gameId=${gameId}`;
    try {
      const res = await fetch(`${KBO_BASE}/GetLineUpAnalysis`, {
        method: "POST",
        headers: HEADERS,
        body,
        signal,
      });
      if (!res.ok) continue;
      const data = await res.json();
      const ck = parseLineupCk(data);
      if (ck !== null) return ck;
    } catch {
      // 다음 srId 시도(단 잔여 예산 소진 시 위 remaining 체크로 break)
    }
  }
  // KBO 신호 부재 → Naver 폴백. 잔여 예산 안에서만 시도(watchdog absolute deadline 결속 유지).
  if (opts?.timeoutMs != null) {
    const remaining = opts.timeoutMs - (Date.now() - startMs);
    if (remaining <= 0) return null;
    const snap = await fetchNaverLineup(gameId, { timeoutMs: remaining });
    return snap ? true : null;
  }
  const snap = await fetchNaverLineup(gameId);
  return snap ? true : null;
}
