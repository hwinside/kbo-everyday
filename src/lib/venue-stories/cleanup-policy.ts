// 직관 라이브 — cleanup orphan 삭제 순수 판정(단위 테스트 가능).
// timestamp 불명(누락/파싱 실패) 객체는 절대 삭제하지 않는다(fail-open 방지, 삼순 NO-GO #2).

import { VENUE_STORY_ARCHIVE_BUCKET } from "./types";

/** referenced 집합 페이저 한 페이지. rows 는 id 오름차순 정렬 계약. null = fault. */
export interface RefPageRow {
  id: number;
  /**
   * 행 상태. `archiving`(private 이동 중간상태)만 참조 합성에 쓰인다.
   * 하위호환: 미지정(레거시 회귀 등)은 archiving 아님으로 취급 → 합성 없음.
   */
  status?: string | null;
  media_bucket: string | null;
  media_path: string | null;
  thumb_bucket: string | null;
  thumb_path: string | null;
}

/**
 * 전 행의 참조 경로를 **keyset pagination**(id > lastId, id 오름차순)으로 수집(삼순 09:44 #3).
 * offset(.range) 방식은 동시 insert/update 시 행이 밀려 참조가 누락되고 orphan 오삭제로
 * 이어질 수 있다 → 단조 증가 PK 기준 keyset 으로 안정화. 페이지 fault 시 null(오탐 방지).
 *
 * ⚠️ archiving 사본 보호(삼순 재리뷰 Blocker 1 수정 A): status='archiving' 행은 media/thumb_bucket 이
 * 아직 videos/photos(공개 원본)을 가리키지만, byte 검증된 private 사본은 **같은 path 의 venue-archive**
 * 버킷에 존재한다. DB 의 exact bucket:path 만 참조로 수집하면 그 private 사본이 참조 0인 orphan 으로
 * 판정돼 96h 뒤 삭제되고, 이후 finalize 가 archive_verified_at 을 믿고 public 제거→archived 로 넘어가
 * DB 는 private key 를 가리키나 객체가 없는 **데이터 유실**이 된다. 그래서 archiving 행에 대해서는
 * 원본(source) 참조에 더해 destination(venue-archive:같은 path)도 참조집합에 합성해 사본을 보호한다.
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
      // archiving 중간상태: 공개 원본과 동일 path 의 private 사본을 함께 보호(orphan 오삭제 금지).
      if (p.status === "archiving") {
        if (p.media_path) referenced.add(`${VENUE_STORY_ARCHIVE_BUCKET}:${p.media_path}`);
        if (p.thumb_path) referenced.add(`${VENUE_STORY_ARCHIVE_BUCKET}:${p.thumb_path}`);
      }
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
