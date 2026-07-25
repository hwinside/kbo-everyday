import type { VenueStory } from "./types";
import { mergePendingStories } from "./composer-helpers";

export function shouldApplyAutomaticStoryRefresh(input: {
  automatic: boolean;
  requestId: number;
  latestRequestId: number;
  blocked: boolean;
  hidden: boolean;
}): boolean {
  if (input.requestId !== input.latestRequestId) return false;
  if (!input.automatic) return true;
  return !input.blocked && !input.hidden;
}

/**
 * fetch 응답을 목록에 commit 할지 판정한다.
 * 비정상 응답(401/500 등)은 false → 호출부가 setStories 를 건너뛰어 마지막 정상 목록을 보존한다.
 * (삼순 왕복2: res.ok boolean 만으로는 non-2xx 보존이 회귀로 고정되지 않는다 → 이 정책을 순수화)
 */
export function shouldCommitStoryFetch(ok: boolean): boolean {
  return ok;
}

/**
 * apply 경로의 최종 목록을 구성한다(순수). 실패 카드를 선두에 유지하고 서버 active + 낙관 pending 을 병합.
 * 컴포넌트의 setStories 업데이터가 이 함수를 그대로 사용해, "200 신규 목록 반영 / 401·500 기존 목록 보존"
 * 계약을 harness 로 고정한다.
 */
export function buildCommittedStories(
  prev: VenueStory[],
  server: VenueStory[],
  failedIds: ReadonlySet<number>,
  pendingIds: ReadonlySet<number>,
): VenueStory[] {
  const failed = prev
    .filter((story) => failedIds.has(story.id))
    .map((story) => ({
      ...story,
      processing: false,
      stalled: false,
      failed: true,
    }));
  return [...failed, ...mergePendingStories(prev, server, pendingIds)];
}
