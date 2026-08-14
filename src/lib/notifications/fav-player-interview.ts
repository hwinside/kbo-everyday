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
// 재조회도 없다. 저장된 행을 받아 kboId로 바꾸고 최애선수 팬에게 보낼 뿐이다.
//
// durable retry (삼순 NO-GO 반영):
//  대상은 "이번 run에 새로 insert된 행"이 아니라 **notified_at IS NULL인 행**이다.
//  새 insert만 보면 발송이 실패했을 때 다음 run에는 이미 저장된 행이라 재입력되지
//  않아 영구 유실된다. 미발송 원장을 매 run 다시 집어와야 재시도가 성립한다.
//  한 행의 처리가 끝나면(전부 발송 성공 or 발송할 대상이 없음) notified_at을 찍는다.
//  하나라도 인프라 실패가 남으면 notified_at을 찍지 않아 다음 run이 다시 집어온다.
//
// 안전장치:
//  - kboId 확정은 interviewPlayerLinks(승리팀 로스터에서 이름이 유일할 때만) 재사용.
//    UI가 선수 링크를 만드는 것과 같은 함수라 화면과 알림 대상이 어긋나지 않는다.
//    kboId가 null(동명이인·로스터 부재)이면 발송하지 않는다 — 오발송 방어.
//  - **video×user 중복 방지**: 한 영상에 2명이 잡히고 유저가 둘 다 최애면 같은
//    영상으로 푸시가 두 번 간다. 영상 단위로 이미 보낸 유저를 제외한다.
//  - dedup = notified_score_events, event_id = `interview#{videoId}#{kboId}`.
//    notified_at 원장과 별개로 선수 단위 멱등도 유지(부분 실패 후 재시도 시
//    성공했던 선수는 다시 안 나감).
//  - audience 조회/발송이 **throw**해도 claim을 반드시 해제한다(잔류 시 영구 유실).
//
// DB/FCM 의존은 전부 InterviewDeps로 주입 — QA smoke가 claim→대상조회→발송→
// unclaim/원장기록 종단 경로를 그대로 태울 수 있게.

/** 알림 토글 키 (prefs.ts PREF_KEYS와 동일 문자열). */
export const INTERVIEW_PREF_KEY = "fav_player_interview" as const;

/** postgame_interviews의 미발송 행. */
export interface PendingInterview {
  gameId: string;
  videoId: string;
  title: string;
  /** 승리팀 박스스코어와 대조해 확정된 선수명. */
  playerNames: string[];
  /** 해당 경기 승리팀 — 동명이인 분리에 사용. */
  winnerTeamId: number | null;
}

export interface InterviewDeps {
  /** notified_at IS NULL + confidence=high 인 행. */
  fetchPendingInterviews: () => Promise<PendingInterview[]>;
  /** 처리 완료 표시 — 이후 run에서 다시 집어오지 않는다. */
  markNotified: (videoIds: string[]) => Promise<void>;
  /** event_id 멱등 선점 — 첫 발송만 true. */
  claimEvent: (eventId: string, gameId: string) => Promise<boolean>;
  /** 인프라 실패 시 선점 해제 → 다음 run 재시도. */
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
  pending: number;
  sent: number;
  skippedUnresolved: number;
  skippedClaimed: number;
  skippedNoAudience: number;
  skippedDuplicateUser: number;
  failed: number;
  settled: number;
}

/**
 * 미발송 수훈 인터뷰를 최애선수 팬에게 발송.
 * postgame-interviews cron에서 저장 직후 호출한다(같은 run에 저장된 행도 포함).
 */
export async function notifyFavPlayerInterviews(
  deps: InterviewDeps,
): Promise<InterviewNotifySummary> {
  const summary: InterviewNotifySummary = {
    pending: 0, sent: 0, skippedUnresolved: 0, skippedClaimed: 0,
    skippedNoAudience: 0, skippedDuplicateUser: 0, failed: 0, settled: 0,
  };

  const pending = await deps.fetchPendingInterviews();
  summary.pending = pending.length;
  if (pending.length === 0) return summary;

  const settledVideoIds: string[] = [];

  for (const interview of pending) {
    // UI의 선수 링크와 같은 경로로 kboId 확정 — 승리팀 로스터에서 이름이 유일할 때만.
    const links = interviewPlayerLinks(interview.playerNames, interview.winnerTeamId);
    // 같은 영상으로 같은 유저에게 두 번 보내지 않기 위한 영상 단위 집합.
    const notifiedUsers = new Set<string>();
    let hadInfraFailure = false;

    for (const link of links) {
      if (!link.kboId) {
        // 동명이인이거나 로스터에 없음 → 누구인지 확정 못 하므로 보내지 않는다.
        // (재시도해도 결과가 같으므로 인프라 실패로 치지 않는다.)
        summary.skippedUnresolved++;
        continue;
      }
      const eventId = `interview#${interview.videoId}#${link.kboId}`;
      let claimed = false;
      try {
        claimed = await deps.claimEvent(eventId, interview.gameId);
      } catch {
        hadInfraFailure = true;
        continue;
      }
      if (!claimed) {
        summary.skippedClaimed++;
        continue;
      }

      // claim 이후의 모든 실패 경로는 반드시 unclaim 한다 — 잔류하면 그 선수는
      // 다음 run에서도 claim=false로 걸러져 영구 유실된다(삼순 NO-GO).
      try {
        const userIds = await deps.fetchFavoritePlayerFanIds(link.kboId);
        const targets = userIds.filter((id) => !notifiedUsers.has(id));
        summary.skippedDuplicateUser += userIds.length - targets.length;
        if (targets.length === 0) {
          // 대상 0(또는 전부 이 영상에서 이미 수신) = 정상 종결. claim 유지.
          summary.skippedNoAudience++;
          continue;
        }
        const result = await deps.sendPush(
          targets,
          {
            title: `⭐ ${link.name} 수훈선수 인터뷰가 올라왔어요`,
            body: interview.title,
            url: `/games/${interview.gameId}`,
          },
          INTERVIEW_PREF_KEY,
        );
        if (!result.ok) {
          await deps.unclaimEvent(eventId);
          hadInfraFailure = true;
          summary.failed++;
          continue;
        }
        for (const id of targets) notifiedUsers.add(id);
        summary.sent++;
      } catch {
        // throw(네트워크·DB 예외)도 동일하게 선점 해제 — 예외 경로에서 claim이
        // 남는 것이 가장 위험하다.
        await deps.unclaimEvent(eventId).catch(() => {});
        hadInfraFailure = true;
        summary.failed++;
      }
    }

    // 인프라 실패가 하나도 없을 때만 처리완료로 확정한다.
    // 실패가 있으면 notified_at을 비워둬 다음 run이 이 행을 다시 집어온다.
    if (!hadInfraFailure) settledVideoIds.push(interview.videoId);
  }

  if (settledVideoIds.length > 0) {
    await deps.markNotified(settledVideoIds);
    summary.settled = settledVideoIds.length;
  }
  return summary;
}
