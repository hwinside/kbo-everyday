/**
 * 로스터 변동 항목 "준비 완료" 판정 (2026-07-18 하린아빠 스펙 + 삼순 P0 반영).
 *
 * 계약(삼순 P0 정정): "에셋 준비 → 공개" 순서 보장.
 * - 등록(register): readiness **전체 통과 후에만** published로 승격되어 노출된다.
 *   공개된 등록 항목은 예외 없이 클릭 가능(href 보장) — href=null 등록 노출 금지.
 * - 말소(deregister): 항상 노출(즉시 published), readiness는 링크 유무만 결정.
 *
 * readiness 체크 항목:
 *   ① roster SSOT 존재 (resolvePlayer 매칭 — 외국인 숫자→canonical 변환 포함)
 *   ② 프로필 사진 존재 (getPlayerPhotoByKboId)
 *   ③ 히어로컷 존재 (hero-approved-kboids.json allowlist — PlayerHero와 동일 기준.
 *      사진만 보던 기존 판정은 이준서/정대선/정은원/김성민 등 히어로 미생성 선수를 ready로 오판)
 *   ④ 선수 상세 페이지 prod 200 (승격 시점 실측 HTTP — checkPublishReadiness 전용)
 *
 * ①~③은 동기(빌드 시 번들된 SSOT), ④는 비동기(HTTP)라 분리:
 *   - checkMoveReadiness: ①~③ — API 조회 시 말소 링크 판정용
 *   - checkPublishReadiness: ①~③+④ — cron pending→published 승격 판정용
 */

import { resolvePlayer } from "@/lib/utils/resolve-player";
import { getPlayerPhotoByKboId } from "@/lib/constants/player-photos";
import heroApprovedList from "@/lib/constants/hero-approved-kboids.json";

const HERO_APPROVED = new Set<string>(heroApprovedList as string[]);

// prod 공개 도메인 (widget/player-card와 동일 패턴 — VERCEL_URL은 배포 보호에 막힘).
const PUBLIC_BASE = process.env.NEXT_PUBLIC_APP_URL || "https://keubo.fan";

/** 준비 완료 판정 순수 코어 — 로스터 && 프로필 사진 && 히어로컷. 스모크 테스트 대상. */
export function evaluateReadiness(inRoster: boolean, hasPhoto: boolean, hasHero: boolean): boolean {
  return inRoster && hasPhoto && hasHero;
}

export interface MoveReadiness {
  ready: boolean;
  /** 준비된 경우 선수 상세 링크에 쓸 canonical kboId. 아니면 null. */
  canonicalId: string | null;
  /** 미충족 체크 목록 — pending 추적/알림용 (silent omission 금지). */
  missing: ("roster" | "photo" | "hero" | "live-page")[];
}

/**
 * KBO playerId 기준 동기 readiness 판정 (①roster ②photo ③hero).
 * ready면 링크용 canonical kboId를, 아니면 null을 반환한다.
 */
export function checkMoveReadiness(kboPlayerId: string): MoveReadiness {
  const resolved = resolvePlayer(kboPlayerId);
  const canonical = resolved?.kboId ?? kboPlayerId;
  const inRoster = resolved !== null;
  const hasPhoto = getPlayerPhotoByKboId(kboPlayerId) !== null;
  // 히어로 allowlist는 canonical kboId 기준(외국인 FP/AQ 포함). 숫자 ID fallback도 확인.
  const hasHero =
    HERO_APPROVED.has(canonical) ||
    (resolved?.numericId ? HERO_APPROVED.has(resolved.numericId) : false);
  const missing: MoveReadiness["missing"] = [];
  if (!inRoster) missing.push("roster");
  if (!hasPhoto) missing.push("photo");
  if (!hasHero) missing.push("hero");
  const ready = evaluateReadiness(inRoster, hasPhoto, hasHero);
  return { ready, canonicalId: ready ? canonical : null, missing };
}

/** 선수 상세 페이지 prod 실측 200 검증 (승격 게이트 ④). fetch 실패 = false. */
export async function verifyPlayerPageLive(canonicalId: string): Promise<boolean> {
  try {
    const res = await fetch(`${PUBLIC_BASE}/community/players/${canonicalId}`, {
      method: "GET",
      cache: "no-store",
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * pending → published 승격 판정 (①~③ 동기 + ④ prod 상세 페이지 200).
 * ④는 ①~③ 통과 시에만 호출(미준비 선수에 불필요한 HTTP 낭비 금지).
 */
export async function checkPublishReadiness(kboPlayerId: string): Promise<MoveReadiness> {
  const sync = checkMoveReadiness(kboPlayerId);
  if (!sync.ready || !sync.canonicalId) return sync;
  const live = await verifyPlayerPageLive(sync.canonicalId);
  if (!live) {
    return { ready: false, canonicalId: null, missing: ["live-page"] };
  }
  return sync;
}

/**
 * 말소 항목 링크 계약: 미준비(canonicalId null) = 링크 생략(null) — 링크 없는 텍스트 렌더.
 * (등록 항목은 published만 노출되므로 이 함수가 아닌 publishedRegisterHref로 href를 보장한다.)
 */
export function moveHref(readiness: Pick<MoveReadiness, "canonicalId">): string | null {
  return readiness.canonicalId ? `/community/players/${readiness.canonicalId}` : null;
}

/**
 * published 등록 항목 href — **항상 non-null 보장** (삼순 P0: href=null 등록 반환 금지).
 * published = 승격 시점에 readiness 전체 통과가 검증된 상태. 조회 시점 재해석은
 * canonical 우선, 만일의 해석 실패 시에도 raw kboId 링크로 계약을 지킨다.
 */
export function publishedRegisterHref(kboPlayerId: string): string {
  const resolved = resolvePlayer(kboPlayerId);
  return `/community/players/${resolved?.kboId ?? kboPlayerId}`;
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
