/**
 * 팀별 1군 등록명단 파싱 + 스냅샷 diff (순수 함수).
 *
 * 데이터 소스: KBO 공식 "선수 등록 현황" /Player/Register.aspx (구단별 1군 등록명단 HTML).
 * 페이지는 감독/코치/투수/포수/내야수/외야수 섹션 테이블(class="tNData")로 구성되며,
 * 각 테이블 thead의 2번째 <th>가 섹션명이다. 선수 섹션(투수/포수/내야수/외야수)만 추출하고
 * 감독/코치와 하단 등록/말소 변경표(헤더가 "선수명")는 제외한다.
 *
 * HTTP 호출은 여기 두지 않는다 — KBO 외부 호출은 src/lib/crawler/kbo-api.ts 한 곳에 모은다
 * (외부 API 호출 분산 금지, 팀 룰). 이 모듈은 HTML→구조화 + diff 순수 로직만 담당한다.
 */

export interface RosterEntry {
  /** KBO playerId (숫자 문자열). 선수 링크 href의 playerId= 값. */
  kboId: string;
  name: string;
  backNo: string;
  /** 투수 | 포수 | 내야수 | 외야수 */
  position: string;
}

export type MoveType = "register" | "deregister";

export interface RosterMove {
  kboPlayerId: string;
  playerName: string;
  moveType: MoveType;
}

// 선수 섹션 헤더(2번째 th). 감독/코치는 제외, 하단 등록/말소 변경표("선수명")도 제외.
const PLAYER_SECTIONS = new Set(["투수", "포수", "내야수", "외야수"]);

/** 한 구단 Register.aspx HTML → 1군 등록 선수 목록 (감독/코치 제외). */
export function parseTeamRegister(html: string): RosterEntry[] {
  const entries: RosterEntry[] = [];
  const tableRe = /<table class="tNData"[^>]*>([\s\S]*?)<\/table>/g;
  let t: RegExpExecArray | null;
  while ((t = tableRe.exec(html)) !== null) {
    const seg = t[1];
    const thead = seg.match(/<thead>([\s\S]*?)<\/thead>/);
    if (!thead) continue;
    const ths = [...thead[1].matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1].trim());
    // ths[0] = "등번호", ths[1] = 섹션명(감독/코치/투수/...) 또는 "선수명"(변경표)
    if (ths.length < 2 || !PLAYER_SECTIONS.has(ths[1])) continue;
    const position = ths[1];
    const tbody = seg.match(/<tbody>([\s\S]*?)<\/tbody>/);
    if (!tbody) continue;
    for (const tr of tbody[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      if (tds.length < 2) continue;
      const backNo = tds[0].replace(/<[^>]+>/g, "").trim();
      const a = tds[1].match(/playerId=(\d+)[^>]*>([^<]+)<\/a>/);
      if (!a) continue; // 링크 없는 행(비고/공지 등) 스킵
      entries.push({ kboId: a[1], name: a[2].trim(), backNo, position });
    }
  }
  return entries;
}

/**
 * 직전 스냅샷(prev) 대비 현재 스냅샷(curr) diff.
 * - prev에 없고 curr에 있으면 등록(register)
 * - prev에 있고 curr에 없으면 말소(deregister)
 * - prev가 null(직전 스냅샷 없음 = 첫 실행)이면 baseline만 기록 → 이벤트 0 (대량 오탐 방지)
 * kboId 기준으로 판정하므로 등번호/포지션 변경만으로는 이벤트가 생기지 않는다.
 */
export function diffRoster(prev: RosterEntry[] | null, curr: RosterEntry[]): RosterMove[] {
  if (prev === null) return [];
  const prevIds = new Set(prev.map((p) => p.kboId));
  const currIds = new Set(curr.map((c) => c.kboId));
  const moves: RosterMove[] = [];
  for (const c of curr) {
    if (!prevIds.has(c.kboId)) {
      moves.push({ kboPlayerId: c.kboId, playerName: c.name, moveType: "register" });
    }
  }
  for (const p of prev) {
    if (!currIds.has(p.kboId)) {
      moves.push({ kboPlayerId: p.kboId, playerName: p.name, moveType: "deregister" });
    }
  }
  return moves;
}

export type MoveStatus = "pending" | "published";

export interface PlannedMove extends RosterMove {
  status: MoveStatus;
}

/**
 * 하루 기준 무브 계획 (2026-07-18 삼순 P0/P1 반영).
 *
 * 기준점은 항상 **직전 일자 스냅샷**(prevDay) — 같은 날 N번째 실행도 동일 기준으로
 * 오늘의 이벤트 집합을 전체 재계산한다. 호출측(cron)은 이 결과로 오늘의 스냅샷과
 * 무브를 **원자적으로 교체**(upsert 후 stale 삭제)해야 한다:
 *   - 오전 [A,B] → 저녁 [A]: 오늘 스냅샷에서 B 제거 → 다음 날 중복 말소 방지 (P1)
 *   - 당일 등록 후 당일 말소(왕복): 저녁 재계산 집합에 없으므로 오전 등록 이벤트 제거
 *     — 일 단위 계약(하린아빠 "1일 기준" 스펙)상 순변동 0이 정답
 * status 정책(P0 공개 게이트): 등록은 pending으로 생성(승격은 readiness 통과 후),
 * 말소는 즉시 published. 이미 저장된 동일 동일키 row의 status는 upsert
 * ignoreDuplicates로 보존된다(published → pending 강등 금지).
 */
export function planTeamMoves(prevDay: RosterEntry[] | null, curr: RosterEntry[]): PlannedMove[] {
  return diffRoster(prevDay, curr).map((m) => ({
    ...m,
    status: m.moveType === "register" ? ("pending" as const) : ("published" as const),
  }));
}
