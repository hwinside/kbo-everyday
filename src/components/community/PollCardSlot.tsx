"use client";

import PollCardBody from "@/components/community/PollCardBody";
import type { PollSummary } from "@/lib/community/poll-client";

/**
 * 목록 카드의 투표 슬롯 (spec §6, S3 — 삼순 5차 P1: terminal 상태/재시도 UI).
 *
 * 세 가지 상태를 명시적으로 분리한다:
 *   - summary 있음        → PollCardBody 렌더
 *   - loaded && summary 없음 → **terminal**(배치 요약 조회는 끝났는데 요약이 없음 = 실패/불가)
 *                              → '투표를 불러오지 못했어요' + 다시 시도(영구 '불러오는 중…' 방지)
 *   - 그 외                → 로딩 중
 *
 * 이전에는 summary 없으면 무조건 '투표 불러오는 중…'이라, 배치 fetch 가 실패한 카드는
 * pollIdsKey 가 바뀔 때까지 영구 로딩에 갇혔다(삼순 5차 P1). loaded 로 terminal 을 구분한다.
 */
export default function PollCardSlot({
  summary,
  loaded,
  onRetry,
}: {
  summary: PollSummary | null | undefined;
  /** 배치 요약 조회가 이 poll id 에 대해 응답을 받았는지. 응답 받았는데 summary 없으면 terminal. */
  loaded: boolean;
  onRetry: () => void;
}) {
  if (summary) return <PollCardBody summary={summary} />;

  if (loaded) {
    // 카드가 Link/onPress 안에 있을 수 있으므로 재시도 클릭이 상세 이동으로 새지 않게 차단.
    return (
      <div className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-border p-3">
        <span className="text-xs text-text-tertiary">투표를 불러오지 못했어요</span>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRetry();
          }}
          className="rounded-md px-2 py-1 text-xs font-semibold text-accent hover:bg-accent/10 active:opacity-70"
        >
          다시 시도
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-xl border border-border p-3 text-xs text-text-tertiary">투표 불러오는 중…</div>
  );
}
