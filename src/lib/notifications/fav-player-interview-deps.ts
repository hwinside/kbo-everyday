import { claimEvent, unclaimEvent } from "@/lib/notifications/game-score";
import { fetchFavoritePlayerFanIds } from "@/lib/notifications/audience";
import { sendFcmToUsers } from "@/lib/notifications/fcm";
import type { InterviewDeps } from "@/lib/notifications/fav-player-interview";

/**
 * 수훈 인터뷰 알림의 실 인프라 배선 (DB·FCM).
 * 판정/오케스트레이션은 fav-player-interview.ts에 있고 여기는 어댑터만 —
 * 그래야 QA smoke가 env 없이 실제 발송 경로를 태울 수 있다.
 */
export function createInterviewDeps(): InterviewDeps {
  return {
    claimEvent,
    unclaimEvent,
    fetchFavoritePlayerFanIds: (kboId) => fetchFavoritePlayerFanIds(kboId),
    // prefKey 전달 = 토글 off 유저 필터링(sendFcmToUsers 내부 notification_prefs 조회).
    sendPush: async (userIds, payload, prefKey) => {
      const result = await sendFcmToUsers(userIds, payload, prefKey);
      return { ok: result.ok };
    },
  };
}
