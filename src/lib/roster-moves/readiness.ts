/**
 * 로스터 변동 항목 "준비 완료 게이트" (2026-07-18 하린아빠 스펙).
 *
 * 신규 콜업(등록) 선수는 자동 roster reconcile 파이프라인이 온보딩하기 전까지
 * 우리 로스터 SSOT/에셋에 없을 수 있다. 그 상태로 카드에 노출하면 선수 상세 링크가 깨진다.
 * 그래서 별도 상태 컬럼 없이 조회 시점에 동적으로 판정한다 —
 *   준비 완료 = 로스터 SSOT 등록됨(resolvePlayer 매칭) && 프로필/히어로 에셋 존재.
 * 에셋이 준비되면 자동으로 노출되는 단순 구조(Simplicity First).
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
