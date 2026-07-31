/**
 * 로스터 변동 항목 "준비 완료" 판정 (2026-07-18 하린아빠 스펙 + 삼순 P0 2차 반영).
 *
 * 계약(삼순 P0 정정): "에셋 준비 → 공개" 순서 보장.
 * - 등록(register): readiness **전체 통과 후에만** published로 승격되어 노출된다.
 *   공개된 등록 항목은 예외 없이 클릭 가능(href 보장) — href=null 등록 노출 금지.
 * - 말소(deregister): 항상 노출(즉시 published), readiness는 링크 유무만 결정.
 *
 * readiness 체크 항목:
 *   ① canonical identity resolve 성공 (resolvePlayer — 외국인 숫자→FP/AQ canonical 변환 포함).
 *      resolve 실패면 어떤 경우에도 published 불가(raw-ID 링크 생성 금지).
 *   ② 프로필 사진 매핑 존재 (getPlayerPhotoByKboId — 동기 SSOT)
 *   ③ 히어로컷 allowlist 존재 (hero-approved-kboids.json — PlayerHero와 동일 기준)
 *   그리고 승격(publish) 게이트는 아래 ①~③에 더해 **실측 HTTP**까지 요구한다:
 *   ④ prod 프로필 JPG 실측 HTTP 200 + image/* content-type
 *   ⑤ prod 히어로 WEBP 실측 HTTP 200 + image/* content-type
 *   ⑥ 선수 상세 존재를 **서버 신호**로 확인 — /api/widget/player-card?id=canonical 이
 *      미존재 선수엔 404를 반환한다(실측: 99999999=404). 클라 상세페이지 GET은 미존재도
 *      200 shell이라 게이트로 못 쓴다(삼순 P0). 서버 API 404/200으로 실존을 구분한다.
 *
 * ①~③은 동기(빌드 시 번들된 SSOT), ④~⑥은 비동기(HTTP)라 분리:
 *   - checkMoveReadiness: ①~③ — API 조회 시 말소 링크 판정용(동기)
 *   - checkPublishReadiness: ①~③ + ④~⑥ — cron pending→published 승격 판정용(비동기, 실측)
 */

import { resolvePlayer } from "@/lib/utils/resolve-player";
import { getPlayerPhotoByKboId } from "@/lib/constants/player-photos";
import heroApprovedList from "@/lib/constants/hero-approved-kboids.json";
import { runBeforeDeadline } from "@/lib/async-deadline";

const HERO_APPROVED = new Set<string>(heroApprovedList as string[]);

// prod 공개 도메인 (widget/player-card와 동일 패턴 — VERCEL_URL은 배포 보호에 막힘).
const PUBLIC_BASE = process.env.NEXT_PUBLIC_APP_URL || "https://keubo.fan";

/** readiness 미충족 항목 — pending 추적/알림용 (silent omission 금지). */
export type MissingCheck =
  | "roster"
  | "photo"
  | "hero"
  | "profile-asset"
  | "hero-asset"
  | "player-page"
  | "readiness-unverified";

/** 준비 완료 판정 순수 코어 — 로스터 && 프로필 사진 && 히어로컷. 스모크 테스트 대상. */
export function evaluateReadiness(inRoster: boolean, hasPhoto: boolean, hasHero: boolean): boolean {
  return inRoster && hasPhoto && hasHero;
}

export interface MoveReadiness {
  ready: boolean;
  /** 준비된 경우 선수 상세 링크에 쓸 canonical kboId. 아니면 null. */
  canonicalId: string | null;
  missing: MissingCheck[];
}

/**
 * KBO playerId 기준 동기 readiness 판정 (①roster ②photo ③hero).
 * ready면 링크용 canonical kboId를, 아니면 null을 반환한다.
 * 프로필 사진의 실제 경로(prod 실측용)도 함께 돌려준다.
 */
export function checkMoveReadiness(kboPlayerId: string): MoveReadiness & { photoPath: string | null } {
  const resolved = resolvePlayer(kboPlayerId);
  const inRoster = resolved !== null;
  const canonical = resolved?.kboId ?? null;
  const photoPath = getPlayerPhotoByKboId(kboPlayerId);
  const hasPhoto = photoPath !== null;
  // 히어로 allowlist는 canonical kboId 기준(외국인 FP/AQ 포함). 숫자 ID fallback도 확인.
  const hasHero =
    (canonical ? HERO_APPROVED.has(canonical) : false) ||
    (resolved?.numericId ? HERO_APPROVED.has(resolved.numericId) : false);
  const missing: MissingCheck[] = [];
  if (!inRoster) missing.push("roster");
  if (!hasPhoto) missing.push("photo");
  if (!hasHero) missing.push("hero");
  // canonical resolve가 실패하면(①) ready는 무조건 false — raw-ID 링크 생성 금지.
  const ready = inRoster && hasPhoto && hasHero && canonical !== null;
  return { ready, canonicalId: ready ? canonical : null, missing, photoPath };
}

/** HTTP 프로브 결과 — 실측 검증용(테스트 주입 가능). */
export interface ProbeResult {
  status: number;
  contentType: string | null;
}
export type AssetProbe = (url: string, signal?: AbortSignal) => Promise<ProbeResult>;

/** 기본 프로브 — GET 후 status/content-type만 읽는다(no-store). 실패=상태 0. */
export const defaultProbe: AssetProbe = async (url, signal) => {
  try {
    const res = await fetch(url, { method: "GET", cache: "no-store", signal });
    return { status: res.status, contentType: res.headers.get("content-type") };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: 0, contentType: null };
  }
};

function isImage(ct: string | null): boolean {
  return ct !== null && ct.toLowerCase().startsWith("image/");
}

/**
 * pending → published 승격 판정 (①~③ 동기 + ④⑤⑥ 실측 HTTP).
 * ④~⑥은 ①~③ 통과 시에만 호출(미준비 선수에 불필요한 HTTP 낭비 금지).
 * probe는 테스트에서 주입 가능(기본은 실 fetch).
 */
export async function checkPublishReadiness(
  kboPlayerId: string,
  probe: AssetProbe = defaultProbe,
  deadlineAtMs?: number,
): Promise<MoveReadiness> {
  const sync = checkMoveReadiness(kboPlayerId);
  if (!sync.ready || !sync.canonicalId || !sync.photoPath) {
    return { ready: sync.ready, canonicalId: sync.canonicalId, missing: sync.missing };
  }
  const canonical = sync.canonicalId;

  const signal = deadlineAtMs == null
    ? undefined
    : AbortSignal.timeout(Math.max(1, deadlineAtMs - Date.now()));
  const [profile, hero, page] = await runBeforeDeadline(
    () => Promise.all([
      probe(`${PUBLIC_BASE}${sync.photoPath}`, signal),
      probe(`${PUBLIC_BASE}/players-hero/${canonical}.webp`, signal),
      // 서버 신호: 미존재 선수는 404, 실존 선수는 200 (클라 상세페이지는 미존재도 200 shell이라 부적합).
      probe(`${PUBLIC_BASE}/api/widget/player-card?id=${encodeURIComponent(canonical)}`, signal),
    ]),
    deadlineAtMs,
  );

  const missing: MissingCheck[] = [];
  if (!(profile.status === 200 && isImage(profile.contentType))) missing.push("profile-asset");
  if (!(hero.status === 200 && isImage(hero.contentType))) missing.push("hero-asset");
  if (page.status !== 200) missing.push("player-page");

  if (missing.length > 0) {
    return { ready: false, canonicalId: null, missing };
  }
  return { ready: true, canonicalId: canonical, missing: [] };
}

/**
 * 말소 항목 링크 계약: 미준비(canonicalId null) = 링크 생략(null) — 링크 없는 텍스트 렌더.
 * (등록 항목은 published만 노출되므로 이 함수가 아닌 publishedRegisterHref로 href를 보장한다.)
 */
export function moveHref(readiness: Pick<MoveReadiness, "canonicalId">): string | null {
  return readiness.canonicalId ? `/community/players/${readiness.canonicalId}` : null;
}

/**
 * published 등록 링크 불변식 (삼순 P0 3차: raw id 재resolve 의존 제거).
 *
 * 입력은 승격(publish) 시점에 검증되어 roster_moves.canonical_id에 저장된 canonical kboId다.
 * 조회 시점에 raw kboId를 다시 resolve하지 않는다 — 롤백/roster SSOT 변경으로 resolve가 달라져
 * status=published인데 href=null이 되는 계약 위반을 제거한다.
 *
 * - storedCanonicalId가 있고(저장됨) 여전히 자기 자신으로 resolve되면 → non-null href.
 * - null(미저장=비정상) 또는 resolve 불일치(canonical이 SSOT에서 사라짐 등)면 → null.
 *   호출측(API)은 이 null을 fail-closed 신호로 써서 사용자에게 렌더하지 않고 운영 알림한다
 *   (링크 없는 published 등록 렌더 경로 완전 제거).
 */
export function publishedRegisterHref(storedCanonicalId: string | null): string | null {
  if (!storedCanonicalId) return null;
  // 저장된 canonical이 여전히 자기 자신으로 resolve될 때만 유효(불일치 = 비정상 → null).
  const resolved = resolvePlayer(storedCanonicalId);
  if (resolved?.kboId !== storedCanonicalId) return null;
  return `/community/players/${storedCanonicalId}`;
}

/**
 * API 노출 필터 (P0 공개 게이트): 등록은 published만, 말소는 전부.
 * pending 등록은 반환 자체를 하지 않는다(에셋 준비 전 노출 금지).
 */
export function filterVisibleMoves<T extends { moveType: string; status: string }>(
  rows: T[],
): T[] {
  return rows.filter((r) => r.moveType === "deregister" || r.status === "published");
}

/**
 * 홈 팀카드 로스터 변동 표시 계약(삼순 합의): 최신 N건만 카드에 노출,
 * 초과분은 "외 M건 더보기 → 팀 페이지"로 오버플로우. 순수 함수(경계 회귀 테스트용).
 *   - overflowCount = max(0, total - limit)  (0/limit 이하면 더보기 숨김)
 */
export function computeRosterMovesDisplay<T>(
  moves: T[],
  limit = 3,
): { visible: T[]; overflowCount: number } {
  const n = Math.max(0, limit);
  return { visible: moves.slice(0, n), overflowCount: Math.max(0, moves.length - n) };
}

export interface RosterMoveDateGroup<T> {
  date: string;
  moves: T[];
}

/**
 * 같은 KST 달력일 변동을 한 그룹으로 묶는다(홈 세로공간 절약 — 하린아빠 2026-07-20).
 * Map 삽입 순서 보존 → 입력이 최신순이면 그룹도 최신순(비연속 동일날짜도 하나로 병합).
 */
export function groupRosterMovesByDate<T extends { moveDate: string }>(
  moves: T[],
): RosterMoveDateGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const m of moves) {
    const arr = map.get(m.moveDate);
    if (arr) arr.push(m);
    else map.set(m.moveDate, [m]);
  }
  return Array.from(map, ([date, ms]) => ({ date, moves: ms }));
}

export interface RosterMoveVisibleGroup<T> {
  date: string;
  /** 한 줄 안 인라인으로 표시할 변동(inlineLimit까지) */
  moves: T[];
  /** 같은 날 인라인 상한 초과분(줄 안 "외 N명"으로 축약, 클릭은 팀홈) */
  hiddenInGroup: number;
}

/**
 * 홈 팀카드 로스터 변동 표시 계약(날짜 그룹 + 한 줄 강제 버전 — 삼순 NO-GO 반영):
 * 같은 날은 무조건 한 줄. 줄바꿈(flex-wrap) 금지 — 바쁘 날을 위해 같은 날 인라인은
 * inlineLimit개까지만 노출하고 초과분은 그 줄 안 "외 N명"(팀홈)으로 축약해 행 높이 1줄 보장.
 *   - visibleGroups = 최신 limit개 날짜 그룹(각각 inlineLimit개 인라인 + hiddenInGroup)
 *   - overflowCount = 숨긴 날짜 그룹들의 변동 건수 합 = max(0, total - 보이는날짜그룹 전체건수)
 *     → "외 M건 더보기"(그룹 아래 별도 줄, 팀홈). 같은 날 축약분(hiddenInGroup)은 여기 미포함.
 * 순수 함수(경계 회귀 테스트용).
 */
export function computeRosterMovesGroupedDisplay<T extends { moveDate: string }>(
  moves: T[],
  limit = 3,
  inlineLimit = 2,
): { visibleGroups: RosterMoveVisibleGroup<T>[]; overflowCount: number } {
  const groups = groupRosterMovesByDate(moves);
  const n = Math.max(0, limit);
  const inl = Math.max(0, inlineLimit);
  const visibleDateGroups = groups.slice(0, n);
  const visibleGroups: RosterMoveVisibleGroup<T>[] = visibleDateGroups.map((g) => ({
    date: g.date,
    moves: g.moves.slice(0, inl),
    hiddenInGroup: Math.max(0, g.moves.length - inl),
  }));
  const shownDatesTotal = visibleDateGroups.reduce((s, g) => s + g.moves.length, 0);
  return { visibleGroups, overflowCount: Math.max(0, moves.length - shownDatesTotal) };
}

/**
 * 홈 팀카드 로스터 변동 행 클릭 계약(삼순 #726 NO-GO 2차): 중첩 anchor 없이 목적지 분리.
 *   - 행 배경/날짜/상태/chevron·외 N건·정상 0건 영역 → 팀홈(teamHomeHref)
 *   - 선수명 → 선수상세(move.href). 미해결(null)이면 링크 없이 텍스트.
 * 순수 함수(4클릭 회귀 단일 SSOT).
 */
export function teamHomeHref(teamSlug: string): string {
  return `/teams/${teamSlug}`;
}

export function rosterMovesCardTargets(
  teamSlug: string,
  move: { href: string | null } | null,
): { rowHref: string; nameHref: string | null; overflowHref: string; emptyHref: string } {
  const home = teamHomeHref(teamSlug);
  return { rowHref: home, nameHref: move ? move.href : null, overflowHref: home, emptyHref: home };
}
