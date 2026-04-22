/**
 * 선수 매칭 단일 진입점 (SSOT for player matching).
 *
 * 배경: KBO 외부 데이터는 선수를 다양한 방식으로 표현한다 —
 *   - 숫자 ID (55348) — 박스스코어 API, 공식 사이트 스크래핑 URL
 *   - 영문 ID (AQ002, FP020) — 로스터 기준 canonical
 *   - 성만 표기 ("웰스") — 순위 페이지
 *   - 풀네임 ("라클란 웰스") — 로스터
 *   - 레거시 pN ("p1", "p2" ...) — 구 공유 링크
 *
 * 이전에는 route/component마다 제각각 매칭 로직을 복붙했기 때문에 새 경로가
 * 추가될 때마다 외국인 선수 매칭 버그가 재발했다. 모든 호출자가 `resolvePlayer`
 * 하나만 사용하면 매칭 버그 발생 지점이 이 파일 1개로 한정된다.
 *
 * 규칙:
 *   - 가능한 한 canonical kboId(로스터 기준)를 반환한다.
 *   - KBO 공식 사이트 스크래핑용 `numericId`도 같이 제공한다 (외국인은 역매핑).
 *   - 이름 매칭은 exact → exact+team → suffix+team → suffix 순서로 fallback.
 *   - 동명이인은 team을 우선 기준으로 분리한다.
 */

import playersRoster from "@/lib/constants/players-roster.json";
import {
  FOREIGN_NUMERIC_TO_ALPHA,
  FOREIGN_ALPHA_TO_NUMERIC,
} from "@/lib/constants/foreign-id-map";
import type { RosterPlayer } from "@/types/api";

/** 레거시 pN 단축 링크 (구 공유 URL 호환). 신규 코드는 kboId를 직접 사용한다. */
const LEGACY_P_MAP: Record<string, string> = {
  p1: "67430",
  p2: "77162",
  p3: "62404",
  p4: "69650",
  p5: "68571",
  p6: "64643",
  p7: "63905",
  p8: "61478",
  p9: "75003",
  p10: "67100",
  p11: "55500",
  p12: "68300",
  p13: "69200",
  p14: "67800",
  p15: "65400",
};

export interface ResolvedPlayer {
  /** 로스터 JSON 기준 canonical kboId (외국인은 영문 AQ/FP, 한국 선수는 숫자) */
  kboId: string;
  /** KBO 공식 사이트가 인식하는 숫자 ID (외국인은 alpha→numeric 역매핑) */
  numericId: string;
  name: string;
  team: string;
  teamId: number;
  position: string;
  backNo: string;
}

export type PlayerQuery = string | { name: string; team?: string };

/**
 * `resolvePlayer` 추가 옵션.
 * - `context`를 넘기면 매칭 실패 시 `console.warn`을 발생시켜
 *   시즌 중 신규 외국인 등록 등으로 매핑이 누락되는 상황을 조기 감지하게 한다.
 * 내부 쿼리(유저 입력 ID 검증 등)에서는 context를 비워 노이즈를 피한다.
 */
export interface ResolveOptions {
  context?: string;
}

const DEFAULT_ROSTER = playersRoster as RosterPlayer[];

function toResolved(p: RosterPlayer): ResolvedPlayer {
  const numericId = FOREIGN_ALPHA_TO_NUMERIC[p.kboId] || p.kboId;
  return {
    kboId: p.kboId,
    numericId,
    name: p.name,
    team: p.team,
    teamId: p.teamId,
    position: p.position,
    backNo: p.backNo,
  };
}

/**
 * 선수를 찾아 표준화된 {@link ResolvedPlayer}를 반환한다. 매칭 실패 시 `null`.
 *
 * 허용 입력:
 *   - string: canonical kboId("AQ002"), 숫자 kboId("55348"), 레거시 pN("p1"),
 *             혹은 이름("웰스" / "라클란 웰스")
 *   - object: `{ name, team? }` — 이름 매칭 + team 우선 분리 (동명이인 대응)
 *
 * @example
 *   resolvePlayer("AQ002")              // 라클란 웰스 (LG)
 *   resolvePlayer("55348")              // 같은 선수 (숫자→영문 변환)
 *   resolvePlayer({ name: "웰스", team: "LG" })  // suffix 매칭
 *   resolvePlayer("화이트")             // 주의: 동명이인 존재. team 필수.
 */
export function resolvePlayer(
  query: PlayerQuery,
  roster: RosterPlayer[] = DEFAULT_ROSTER,
  options?: ResolveOptions
): ResolvedPlayer | null {
  const result = resolveInternal(query, roster);
  if (!result && options?.context) {
    const q = typeof query === "string" ? query : JSON.stringify(query);
    console.warn(`[${options.context}] player lookup miss: ${q}`);
  }
  return result;
}

function resolveInternal(
  query: PlayerQuery,
  roster: RosterPlayer[]
): ResolvedPlayer | null {
  if (typeof query === "string") {
    const q = query.trim();
    if (!q) return null;

    // 1. 레거시 pN → 숫자 kboId 변환
    const normalized = LEGACY_P_MAP[q] ?? q;

    // 2. roster canonical kboId로 직접 매칭
    const exact = roster.find((p) => p.kboId === normalized);
    if (exact) return toResolved(exact);

    // 3. 숫자 외국인 ID(55348) → 영문(AQ002) 역변환 후 재시도
    const alpha = FOREIGN_NUMERIC_TO_ALPHA[normalized];
    if (alpha) {
      const byAlpha = roster.find((p) => p.kboId === alpha);
      if (byAlpha) return toResolved(byAlpha);
    }

    // 4. 이름으로 fallback (team 없으면 첫 일치)
    const byName =
      roster.find((p) => p.name === q) ||
      roster.find((p) => p.name.endsWith(q));
    return byName ? toResolved(byName) : null;
  }

  // Object query: { name, team? }
  const { name, team } = query;
  if (!name) return null;

  const found =
    (team && roster.find((p) => p.name === name && p.team === team)) ||
    roster.find((p) => p.name === name) ||
    (team && roster.find((p) => p.name.endsWith(name) && p.team === team)) ||
    roster.find((p) => p.name.endsWith(name));

  return found ? toResolved(found) : null;
}
