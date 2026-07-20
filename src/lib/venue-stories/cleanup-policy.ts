// 직관 라이브 — cleanup orphan 삭제 순수 판정(단위 테스트 가능).
// timestamp 불명(누락/파싱 실패) 객체는 절대 삭제하지 않는다(fail-open 방지, 삼순 NO-GO #2).

export function shouldDeleteOrphanFile(opts: {
  isFolder: boolean; // storage list 항목이 폴더면 id === null
  isReferenced: boolean; // 어떤 venue_stories 행이 참조 중인가
  createdAt: string | null | undefined;
  cutoffMs: number; // 이보다 오래된 것만 정리
}): boolean {
  const { isFolder, isReferenced, createdAt, cutoffMs } = opts;
  if (isFolder) return false; // 폴더는 대상 아님
  if (isReferenced) return false; // 참조 중이면 보존
  const parsed = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(parsed)) return false; // timestamp 불명 → 보존(삭제 금지)
  if (parsed > cutoffMs) return false; // 아직 최근이면 다음 실행에
  return true;
}
