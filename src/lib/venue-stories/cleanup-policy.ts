// 직관 라이브 — cleanup orphan 삭제 순수 판정(단위 테스트 가능).
// timestamp 불명(누락/파싱 실패) 객체는 절대 삭제하지 않는다(fail-open 방지, 삼순 NO-GO #2).

/** referenced 집합 페이저 한 페이지. rows 는 id 오름차순 정렬 계약. null = fault. */
export interface RefPageRow {
  id: number;
  media_bucket: string | null;
  media_path: string | null;
  thumb_bucket: string | null;
  thumb_path: string | null;
}

/**
 * 전 행의 참조 경로를 **keyset pagination**(id > lastId, id 오름차순)으로 수집(삼순 09:44 #3).
 * offset(.range) 방식은 동시 insert/update 시 행이 밀려 참조가 누락되고 orphan 오삭제로
 * 이어질 수 있다 → 단조 증가 PK 기준 keyset 으로 안정화. 페이지 fault 시 null(오탐 방지).
 */
export async function collectReferencedPaths(
  fetchPage: (afterId: number, limit: number) => Promise<RefPageRow[] | null>,
  pageSize: number,
): Promise<Set<string> | null> {
  const referenced = new Set<string>();
  let afterId = 0;
  for (;;) {
    const page = await fetchPage(afterId, pageSize);
    if (page == null) return null; // fault → 호출부가 orphan 스캔 중단(오탐 삭제 방지)
    for (const p of page) {
      if (p.media_bucket && p.media_path) referenced.add(`${p.media_bucket}:${p.media_path}`);
      if (p.thumb_bucket && p.thumb_path) referenced.add(`${p.thumb_bucket}:${p.thumb_path}`);
    }
    if (page.length < pageSize) break;
    afterId = page[page.length - 1].id;
  }
  return referenced;
}

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
