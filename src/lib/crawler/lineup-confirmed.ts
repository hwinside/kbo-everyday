/**
 * KBO 라인업 확정 신호(LINEUP_CK) 조회 — 라인업 확정 알림 트리거.
 * game-detail 의 GetLineUpAnalysis 응답 data[0][0].LINEUP_CK 를 그대로 읽는다.
 * true=확정 / false=미확정(또는 fallback 라인업) / null=신호 못 얻음(네트워크/파싱 실패).
 */
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
  // srId=0(정규) 먼저, 신호 못 얻으면 srId=1(시범) 재시도. game-detail 과 동일.
  for (const srId of ["0", "1"]) {
    const body = `leId=1&srId=${srId}&seasonId=${sid}&gameId=${gameId}`;
    try {
      const res = await fetch(`${KBO_BASE}/GetLineUpAnalysis`, {
        method: "POST",
        headers: HEADERS,
        body,
        signal: opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
      });
      if (!res.ok) continue;
      const data = await res.json();
      const ck = parseLineupCk(data);
      if (ck !== null) return ck;
    } catch {
      // 다음 srId 시도
    }
  }
  return null;
}
