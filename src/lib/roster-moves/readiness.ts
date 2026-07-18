/**
 * 로스터 변동 항목 "준비 완료" 판정 (2026-07-18 하린아빠 스펙, 같은 날 정정 반영).
 *
 * 정정된 계약: 등록/말소 항목은 **전부 항상 노출**한다 — 숨김 게이트 없음.
 * readiness는 선수 상세 **링크 유무만** 결정한다(미준비 = 링크 없는 텍스트, 말소 처리와 동일 패턴).
 * 신규 콜업 선수 에셋은 새벽 크롤 자동 온보딩(reconcile-roster-from-stats.mjs, 등록명단 기반)이
 * 능동으로 준비하므로, 별도 상태 컬럼 없이 조회 시점에 동적으로 판정한다 —
 *   준비 완료 = 로스터 SSOT 등록됨(resolvePlayer 매칭) && 프로필/히어로 에셋 존재.
 * 에셋이 준비되면 자동으로 링크가 살아나는 단순 구조(Simplicity First).
 */

import { resolvePlayer } from "@/lib/utils/resolve-player";
import { getPlayerPhotoByKboId } from "@/lib/constants/player-photos";

/** 준비 완료 판정 순수 코어 — 로스터 등록 && 에셋 존재. 스모크 테스트 대상. */
export function evaluateReadiness(inRoster: boolean, hasAsset: boolean): boolean {
  return inRoster && hasAsset;
}

export interface MoveReadiness {
  ready: boolean;
  /** 준비된 경우 선수 상세 링크에 쓸 canonical kboId. 아니면 null. */
  canonicalId: string | null;
}

/**
 * KBO playerId(숫자) 기준 준비 완료 판정.
 * - inRoster: resolvePlayer로 로스터 SSOT 매칭(외국인 숫자→영문 canonical 변환 포함)
 * - hasAsset: getPlayerPhotoByKboId로 프로필/히어로 사진 존재 확인
 * ready면 링크용 canonical kboId를, 아니면 null을 반환한다.
 */
export function checkMoveReadiness(kboPlayerId: string): MoveReadiness {
  const resolved = resolvePlayer(kboPlayerId);
  const inRoster = resolved !== null;
  const hasAsset = getPlayerPhotoByKboId(kboPlayerId) !== null;
  const ready = evaluateReadiness(inRoster, hasAsset);
  return { ready, canonicalId: ready ? (resolved?.kboId ?? kboPlayerId) : null };
}

/**
 * 노출 계약(2026-07-18 정정): 항목은 항상 노출, readiness는 링크 유무만 결정.
 * 미준비(canonicalId null) = 링크 생략(null) — 링크 없는 텍스트로 렌더된다.
 */
export function moveHref(readiness: MoveReadiness): string | null {
  return readiness.canonicalId ? `/community/players/${readiness.canonicalId}` : null;
}
