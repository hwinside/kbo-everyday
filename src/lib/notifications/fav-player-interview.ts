import { interviewPlayerLinks } from "@/lib/video/postgame-interviews-route-policy";

// 최애선수 수훈선수 인터뷰 알림 (2026-08-14 하린아빠 요청).
//
// 입력은 **기존 postgame-interviews 파이프라인이 이미 확정한 결과**다.
// 그 cron(#1001)이 경기 종료 후 30분~24시간 동안 승인 채널 16곳을 추적해
//   - 어느 경기인지(game_id)   — 제목 날짜·대진·스코어 대조 + 더블헤더 fail-close
//   - 누구 인터뷰인지(player_names) — 승리팀 박스스코어 선수명과 대조
// 를 이미 고신뢰(confidence='high')로 매칭해 postgame_interviews에 저장한다.
// 경기 상세의 "수훈선수 인터뷰" 섹션이 그 테이블을 그대로 읽는다.
//
// 따라서 이 모듈은 **감지를 다시 하지 않는다**. 제목 문자열 파싱도, 스코어보드
// 재조회도 없다. 그 cron이 이번 run에 새로 insert한 행만 받아서
// player_names → kboId로 바꾸고 최애선수 팬에게 보낼 뿐이다.
// (초기 구현은 videos cron에서 제목을 따로 분석했는데, 이미 있는 SSOT를 못 찾고
//  중복 감지기를 만든 것이라 폐기했다.)
//
// 안전장치:
//  - kboId 확정은 interviewPlayerLinks(승리팀 로스터에서 이름이 유일할 때만) 재사용.
//    UI가 선수 링크를 만드는 것과 같은 함수라 화면과 알림 대상이 어긋나지 않는다.
//    kboId가 null(동명이인·로스터 부재)이면 발송하지 않는다 — 오발송 방어.
//  - dedup = notified_score_events 재사용, event_id = `interview#{videoId}#{kboId}`.
//    postgame_interviews upsert가 ignoreDuplicates라 새 행만 넘어오지만, 발송
//    자체는 별도 원장으로 한 번 더 막아 cron 재실행·부분 실패에도 1회만 나간다.
//  - 발송 인프라 실패 시 unclaim → 다음 cron 재시도.
//  - 토글 fav_player_interview(기본 on)는 sendPush 구현의 prefKey 필터가 적용.
//
// DB/FCM 의존은 전부 InterviewDeps로 주입 — QA smoke가 claim→대상조회→발송→
// unclaim 종단 경로를 그대로 태울 수 있게.

/** 알림 토글 키 (prefs.ts PREF_KEYS와 동일 문자열). */
export const INTERVIEW_PREF_KEY = "fav_player_interview" as const;

/** postgame-interviews cron이 이번 run에 새로 저장한 인터뷰 1건. */
export interface StoredInterview {
  gameId: string;
  videoId: string;
  title: string;
  /** 승리팀 박스스코어와 대조해 확정된 선수명. */
  playerNames: string[];
  /** 해당 경기 승리팀 — 동명이인 분리에 사용. */
  winnerTeamId: number | null;
}

export interface InterviewDeps {
  /** event_id 멱등 선점 — 첫 발송만 true. */
  claimEvent: (eventId: string, gameId: string) => Promise<boolean>;
  /** 인프라 실패 시 선점 해제 → 다음 cron 재시도. */
  unclaimEvent: (eventId: string) => Promise<void>;
  /** kboId를 최애선수로 둔 유저 id. */
  fetchFavoritePlayerFanIds: (kboId: string) => Promise<string[]>;
  /** 토글 필터는 sendPush 구현(sendFcmToUsers prefKey)이 수행. */
  sendPush: (
    userIds: string[],
    payload: { title: string; body: string; url: string },
    prefKey: typeof INTERVIEW_PREF_KEY,
  ) => Promise<{ ok: boolean }>;
}

export interface InterviewNotifySummary {
  interviews: number;
  sent: number;
  skippedUnresolved: number;
  skippedClaimed: number;
  skippedNoAudience: number;
  failed: number;
}

/**
 * 새로 저장된 수훈 인터뷰를 최애선수 팬에게 발송.
 * postgame-interviews cron에서 저장 직후 호출한다.
 */
export async function notifyFavPlayerInterviews(
  interviews: StoredInterview[],
  deps: InterviewDeps,
): Promise<InterviewNotifySummary> {
  const summary: InterviewNotifySummary = {
    interviews: interviews.length, sent: 0, skippedUnresolved: 0,
    skippedClaimed: 0, skippedNoAudience: 0, failed: 0,
  };

  for (const interview of interviews) {
    // UI의 선수 링크와 같은 경로로 kboId 확정 — 승리팀 로스터에서 이름이 유일할 때만.
    const links = interviewPlayerLinks(interview.playerNames, interview.winnerTeamId);
    for (const link of links) {
      if (!link.kboId) {
        // 동명이인이거나 로스터에 없음 → 누구인지 확정 못 하므로 보내지 않는다.
        summary.skippedUnresolved++;
        continue;
      }
      const eventId = `interview#${interview.videoId}#${link.kboId}`;
      if (!(await deps.claimEvent(eventId, interview.gameId))) {
        summary.skippedClaimed++;
        continue;
      }
      const userIds = await deps.fetchFavoritePlayerFanIds(link.kboId);
      if (userIds.length === 0) {
        // 대상 0 = 정상 종결. claim 유지(재조회해도 결과 동일).
        summary.skippedNoAudience++;
        continue;
      }
      const result = await deps.sendPush(
        userIds,
        {
          title: `⭐ ${link.name} 수훈선수 인터뷰가 올라왔어요`,
          body: interview.title,
          url: `/games/${interview.gameId}`,
        },
        INTERVIEW_PREF_KEY,
      );
      if (!result.ok) {
        // 인프라 실패 → 선점 해제해 다음 cron 재시도 (game-status unclaim과 동형)
        await deps.unclaimEvent(eventId);
        summary.failed++;
        continue;
      }
      summary.sent++;
    }
  }
  return summary;
}
