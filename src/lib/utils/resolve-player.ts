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
 *   - 이름 매칭은 exact → exact+team → partial+team → partial 순서로 fallback.
 *     (partial = suffix "웰스"←"라클란 웰스" | prefix+토큰경계 "스기모토"←"스기모토 고우키")
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

export type PlayerQuery =
  | string
  | {
      /** 선수명. 외국인 선수는 짧은 등록명("에레디아") 또는 풀네임 모두 허용. */
      name?: string | null;
      /** 로스터 기준 canonical kboId 또는 KBO 공식 숫자 ID. */
      kboId?: string | number | null;
      /** 외부 API/스탯에서 들어오는 playerId. 외국인은 숫자 ID일 수 있다. */
      playerId?: string | number | null;
      /** 일부 UI 모델이 id라는 이름으로 들고 있는 선수 ID. */
      id?: string | number | null;
      team?: string | null;
      teamId?: number | string | null;
      /**
       * 같은 팀 동명이인(예: 삼성 김태훈 — 투수 62360 · 야수 65040) 분리용 역할 힌트.
       * 호출부가 슬롯의 역할을 아는 경우(투수 자리/타석)에만 넘긴다.
       * "투수" = position === "투수"만, "야수" = position !== "투수"만.
       * 힌트로도 유일하게 좁혀지지 않으면 기존대로 null(fail-close).
       */
      positionHint?: "투수" | "야수" | null;
    };

/**
 * `resolvePlayer` 추가 옵션.
 * - `context`를 넘기면 매칭 실패 시 `console.warn`을 발생시켜
 *   시즌 중 신규 외국인 등록 등으로 매핑이 누락되는 상황을 조기 감지하게 한다.
 * 내부 쿼리(유저 입력 ID 검증 등)에서는 context를 비워 노이즈를 피한다.
 */
export interface ResolveOptions {
  context?: string;
}

/* 외부 표기 변형 alias — 라이브/스탯 피드가 로스터 등록명과 다른 로마자 표기를 쓰는 케이스.
 * (예: 戸田 → 로스터/등록명 "토다 나츠키" vs 일부 레거시 표기 "도다"[외래어표기법] — suffix/prefix 어느 쪽에도 안 걸림)
 * 오매칭 방지를 위해 팀 가드 필수: 쿼리의 team/teamId가 대상 선수의 로스터 팀과 일치할 때만 적용. */
const NAME_ALIASES: Record<string, string> = {
  도다: "AQ006", // NC 토다 나츠키 — KBO/NC 공식 등록명은 "토다", 레거시 "도다" 표기 구제 (2026-07-21 CS 정정)
  교야마: "56548", // 롯데 쿄야마 — KBO 등록명 "쿄야마", 레거시/외래어표기 "교야마" 구제 (2026-07-21 중복 항목 통합)
};

/* 로스터에서 제거된 레거시 합성 ID → 현행 숫자 ID.
 * DB(최애선수 favorite_players·게시판 board_id)·캐시·알림 payload 등에 구 ID가
 * 잔존해도 카드/상세/href가 깨지지 않도록 구제(forward-only 이관 마이그레이션과 이중 방어). */
export const LEGACY_RETIRED_IDS: Record<string, string> = {
  AQ008: "56548", // 교야마 마사야(구 합성 ID) → 쿄야마 (2026-07-21 중복 항목 통합)
};

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
 * 이름 부분 매칭. 외부 중계/순위 텍스트는 외국인 선수를 짧은 표기로 쓴다 —
 *   - 서양 선수: 성이 뒤 → suffix ("웰스" ← "라클란 웰스")
 *   - 일본 선수: 성이 앞 → prefix ("스기모토" ← "스기모토 고우키")
 * prefix는 토큰 경계(공백)를 강제해 부분 문자열 오매칭을 막는다. 한국 선수는
 * 이름에 공백이 없어 prefix 경로에 아예 걸리지 않는다 (기존 suffix 의미론 불변).
 */
function nameLooseMatch(rosterName: string, q: string): boolean {
  return rosterName.endsWith(q) || rosterName.startsWith(q + " ");
}

/**
 * 선수를 찾아 표준화된 {@link ResolvedPlayer}를 반환한다. 매칭 실패 시 `null`.
 *
 * 허용 입력:
 *   - string: canonical kboId("AQ002"), 숫자 kboId("55348"), 레거시 pN("p1"),
 *             혹은 이름("웰스" / "라클란 웰스")
 *   - object: `{ name?, kboId?, playerId?, id?, team?, teamId? }`
 *             — ID 우선 매칭 후 이름+팀으로 보강 (동명이인 대응)
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

/**
 * 이름이 로스터에 *정확히 하나*일 때만 resolve. 동명이인(2+)이면 null.
 * exact 0건이면 부분 매칭(suffix/prefix)으로 한 번 더 — 역시 유일할 때만
 * (외국인 중계 표기 "디아즈"/"스기모토" → 로스터 풀네임 "르윈 디아즈"/
 * "스기모토 고우키" 구제, resolvePlayer partial fallback과 동일 의미론을
 * 유일성 게이트 하에 적용).
 * 팀으로 동명이인을 분리할 수 없는 경로(예: 올스타전 — 게임 팀이 나눔/드림이라
 * 선수의 실제 소속으로 좁힐 수 없음) 전용. 오매칭(엉뚱한 동명이인) 방지가 목적.
 */
export function resolveUniquePlayerByName(
  name: string,
  roster: RosterPlayer[] = DEFAULT_ROSTER,
): ResolvedPlayer | null {
  const q = name?.trim();
  if (!q) return null;
  const exact = roster.filter((p) => p.name === q);
  if (exact.length === 1) return toResolved(exact[0]);
  if (exact.length > 1) return null; // 동명이인 — 특정 불가, 오발송 방지
  const partial = roster.filter((p) => nameLooseMatch(p.name, q));
  return partial.length === 1 ? toResolved(partial[0]) : null;
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

    // 2.5 로스터에서 제거된 레거시 합성 ID → 현행 숫자 ID 구제 (AQ008→쿄야마)
    const legacy = LEGACY_RETIRED_IDS[normalized];
    if (legacy) {
      const byLegacy = roster.find((p) => p.kboId === legacy);
      if (byLegacy) return toResolved(byLegacy);
    }

    // 3. 숫자 외국인 ID(55348) → 영문(AQ002) 역변환 후 재시도
    const alpha = FOREIGN_NUMERIC_TO_ALPHA[normalized];
    if (alpha) {
      const byAlpha = roster.find((p) => p.kboId === alpha);
      if (byAlpha) return toResolved(byAlpha);
    }

    // 4. 이름으로 fallback — exact/suffix는 기존 first-match 의미론 유지,
    //    prefix는 유일할 때만 (team 정보가 없어 동명 첫 토큰 "맷" 오매칭 방지)
    const byName =
      roster.find((p) => p.name === q) ||
      roster.find((p) => p.name.endsWith(q));
    if (byName) return toResolved(byName);
    const byPrefix = roster.filter((p) => p.name.startsWith(q + " "));
    return byPrefix.length === 1 ? toResolved(byPrefix[0]) : null;
  }

  // Object query: ID/token 우선 → 이름+팀 → unique name/suffix 순서.
  const { name, team, teamId, positionHint } = query;
  const rawId = query.kboId ?? query.playerId ?? query.id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim()) {
    const byId = resolveInternal(String(rawId), roster);
    if (byId) return byId;
  }

  const cleanName = name?.trim();
  if (!cleanName) return null;

  const cleanTeam = team?.trim();
  const numericTeamId =
    teamId !== undefined && teamId !== null && String(teamId).trim()
      ? Number(teamId)
      : null;

  /* ⚠︎ 이름+팀으로 둘 이상이 걸리면 **고르지 않는다**(2026-08-08).
   *
   * 예전엔 `.find()` 로 배열에서 먼저 만나는 사람을 돌려줘다. 그러면 답이 **배열 순서**에
   * 달려서, 크롤 순서가 바뀌는 날 조용히 다른 선수가 된다. 실측(#1130): 삼성 김태훈은
   * 투수 62360 과 야수 65040 둘인데 roster 인덱스가 밀리면서 선발 ERA 가 3.65 → null 로 바뀜다.
   * 틀린 숫자는 유저가 알아채지 못하므로, 모호하면 빈 값이 낫다 — fail-close.
   *
   * 역할로 좁힐 수 있는 호출자(예: 선발 ERA → 투수 기록 보유자)는
   * `resolveRosterCandidates` 로 후보를 받아 직접 확정한다. */
  const teamMatches = (p: RosterPlayer) =>
    (numericTeamId !== null && Number(p.teamId) === numericTeamId) ||
    Boolean(cleanTeam && p.team === cleanTeam);

  /* positionHint 좁히기: 같은 팀 동명이인이라도 호출부가 슬롯 역할을 안다면
   * (투수 자리 → 투수만, 타석/주자/야수 슬롯 → 비투수만) 유일하면 확정한다.
   * 힌트로도 2+명이면 여전히 null — 배열 순서로 찍는 경로는 만들지 않는다. */
  const narrowByHint = (matches: RosterPlayer[]): ResolvedPlayer | null => {
    if (matches.length === 1) return toResolved(matches[0]);
    if (matches.length > 1 && (positionHint === "투수" || positionHint === "야수")) {
      const hinted = matches.filter((p) =>
        positionHint === "투수" ? p.position === "투수" : p.position !== "투수",
      );
      if (hinted.length === 1) return toResolved(hinted[0]);
    }
    return null; // 동명이인 특정 불가 — fail-close
  };

  const exactAndTeam = roster.filter((p) => p.name === cleanName && teamMatches(p));
  if (exactAndTeam.length > 0) return narrowByHint(exactAndTeam);

  const partialAndTeam = roster.filter((p) => nameLooseMatch(p.name, cleanName) && teamMatches(p));
  if (partialAndTeam.length > 0) return narrowByHint(partialAndTeam);

  // 표기 변형 alias — 팀 가드 일치 시에만 적용(팀 정보 없는 쿼리엔 미적용 → 오매칭 방지)
  const aliasId = NAME_ALIASES[cleanName];
  if (aliasId) {
    const target = roster.find((p) => p.kboId === aliasId);
    if (
      target &&
      ((numericTeamId !== null && Number(target.teamId) === numericTeamId) ||
        (cleanTeam && target.team === cleanTeam))
    ) {
      return toResolved(target);
    }
  }

  const exactMatches = roster.filter((p) => p.name === cleanName);
  if (exactMatches.length === 1) return toResolved(exactMatches[0]);

  const partialMatches = roster.filter((p) => nameLooseMatch(p.name, cleanName));
  if (partialMatches.length === 1) return toResolved(partialMatches[0]);

  return null;
}

/**
 * 이름+팀으로 걸리는 **모든** 로스터 후보를 순서 그대로 돌려준다.
 *
 * `resolvePlayer` 는 모호하면 `null` 로 fail-close 한다(배열 순서로 찍지 않기 위해서다).
 * 그런데 호출자가 역할을 알면 더 좁힐 수 있는 경우가 있다 — 예를 들어 "선발 투수의 ERA"
 * 라면 후보 중 **투수 기록을 가진 사람**이 답이다. 그런 호출자만 이 함수로 후보를 받아
 * 자기 도메인 지식으로 확정한다. 좁혀도 복수면 호출자도 fail-close 해야 한다.
 *
 * ⚠︎ 이 함수는 "아무나 하나" 를 주는 우회로가 아니다. 반환값에서 `[0]` 을 집으면
 * 예전의 순서 의존 버그가 그대로 돌아온다.
 */
export function resolveRosterCandidates(
  { name, teamId, team }: { name?: string | null; teamId?: number | string | null; team?: string | null },
  roster: RosterPlayer[] = DEFAULT_ROSTER,
): ResolvedPlayer[] {
  const cleanName = name?.trim();
  if (!cleanName) return [];

  const cleanTeam = team?.trim();
  const numericTeamId =
    teamId !== undefined && teamId !== null && String(teamId).trim() ? Number(teamId) : null;
  if (numericTeamId === null && !cleanTeam) return [];

  const teamMatches = (p: RosterPlayer) =>
    (numericTeamId !== null && Number(p.teamId) === numericTeamId) ||
    Boolean(cleanTeam && p.team === cleanTeam);

  // exact 가 하나라도 있으면 exact 집합만 본다(부분매칭이 섞여 후보가 번지지 않게).
  const exact = roster.filter((p) => p.name === cleanName && teamMatches(p));
  if (exact.length > 0) return exact.map(toResolved);
  return roster.filter((p) => nameLooseMatch(p.name, cleanName) && teamMatches(p)).map(toResolved);
}

/**
 * 이름(exact 우선, 없으면 느슨한 매칭)으로 로스터에 걸리는 선수 수.
 * 0 = 로스터 밖 이름(레거시/은퇴), 1 = 유일, 2+ = 동명이인.
 * 사진 등 name-only fallback 경로가 "동명이인이면 금지, 로스터 밖이면 허용"을
 * 구분하는 데 쓴다 (resolveUniquePlayerByName 은 둘 다 null 이라 구분 불가).
 */
export function rosterNameMatchCount(
  name: string,
  roster: RosterPlayer[] = DEFAULT_ROSTER,
): number {
  const q = name?.trim();
  if (!q) return 0;
  const exact = roster.filter((p) => p.name === q).length;
  if (exact > 0) return exact;
  return roster.filter((p) => nameLooseMatch(p.name, q)).length;
}

/** 명시적인 이름의 alias. 신규 코드에서는 이 이름을 우선 사용한다. */
export const resolvePlayerIdentity = resolvePlayer;

/**
 * 외국인 숫자 kboId(56251)를 로스터 기준 canonical 영문 ID(FP009)로 정규화.
 * 비외국인/빈값은 그대로 반환. (foreign-id-map 직접 import 금지 룰 — 정규화는 이 헬퍼 경유)
 */
export function canonicalKboId(id: string | number | undefined | null): string {
  const s = String(id ?? "");
  return FOREIGN_NUMERIC_TO_ALPHA[s] ?? s;
}

export function getCanonicalPlayerId(query: PlayerQuery): string | null {
  return resolvePlayerIdentity(query)?.kboId ?? null;
}

export function getCanonicalPlayerHref(query: PlayerQuery): string | null {
  const canonicalId = getCanonicalPlayerId(query);
  return canonicalId ? `/community/players/${canonicalId}` : null;
}
