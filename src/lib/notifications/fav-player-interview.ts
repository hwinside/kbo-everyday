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
// ── 복구 계약 (삼순 NO-GO 3라운드 반영) ───────────────────────────────────
// (1) durable retry: 대상은 "이번 run 새 insert"가 아니라 **notified_at IS NULL 행**.
//     새 insert만 보면 발송 실패 시 다음 run에는 이미 저장된 행이라 재입력되지 않아
//     영구 유실된다.
// (2) claim은 **tri-state**다. 공용 claimEvent는 중복과 DB 오류를 모두 false로
//     뭉개는데, 그 false를 "정상 skip"으로 보고 행을 완료 처리하면 DB 오류 한 번에
//     그 인터뷰가 영구 유실된다. error는 실패로 취급해 행을 미완료로 남긴다.
// (3) video×user 중복 방지는 **run 경계를 넘어야 한다**. 2인 영상에서 A 성공·B 실패
//     후 다음 run에 B만 재시도하면, run-local Set은 비어 있어 A로 이미 받은 유저에게
//     또 간다. 그래서 claim=duplicate(=이전 run에서 이미 발송됨)인 선수도 audience를
//     조회해 **수신자 제외 집합에만 넣고 발송하지 않는다** — 원장이 곧 dedupe 근거다.
// (4) 완료 표시는 **row id**로 한다. postgame_interviews의 unique key는
//     (game_id, video_id)라 video_id 단독 update는 다른 경기의 같은 영상까지 건드린다.
//
// 그 외 안전장치:
//  - kboId 확정은 interviewPlayerLinks(승리팀 로스터에서 이름이 유일할 때만) 재사용.
//    UI가 선수 링크를 만드는 것과 같은 함수라 화면과 알림 대상이 어긋나지 않는다.
//    kboId가 null(동명이인·로스터 부재)이면 발송하지 않는다 — 오발송 방어.
//  - claim 이후 모든 실패 경로(반환 false·throw)는 반드시 unclaim. 잔류하면 그 선수는
//    다음 run에서도 duplicate로 걸러져 영구 유실된다.
//
// DB/FCM 의존은 전부 InterviewDeps로 주입 — QA smoke가 claim→대상조회→발송→
// unclaim/원장기록 종단 경로를 그대로 태울 수 있게.

/** 알림 토글 키 (prefs.ts PREF_KEYS와 동일 문자열). */
export const INTERVIEW_PREF_KEY = "fav_player_interview" as const;

/**
 * claim 결과 3분기.
 *  - claimed   : 이번에 선점 성공 → 발송 대상
 *  - duplicate : 이미 발송됨(이전 run 또는 동시 run) → 발송 안 하되 수신자는 제외 집합에
 *  - error     : DB/인프라 오류 → 완료 처리 금지, 다음 run 재시도
 */
export type ClaimResult = "claimed" | "duplicate" | "error";

/** postgame_interviews의 미발송 행. */
export interface PendingInterview {
  /** postgame_interviews.id (PK) — 완료 표시는 반드시 이 값으로 한다. */
  id: string;
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
  /** 처리 완료 표시 — postgame_interviews.id 기준. */
  markNotified: (rowIds: string[]) => Promise<void>;
  /** event_id 선점. 중복과 오류를 구분해 반환한다. */
  claimEvent: (eventId: string, gameId: string) => Promise<ClaimResult>;
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

  const settledRowIds: string[] = [];

  for (const interview of pending) {
    // UI의 선수 링크와 같은 경로로 kboId 확정 — 승리팀 로스터에서 이름이 유일할 때만.
    const links = interviewPlayerLinks(interview.playerNames, interview.winnerTeamId);
    // 이 영상으로 이미 푸시를 받은 유저. duplicate 선수의 audience도 여기 합쳐지므로
    // run 경계를 넘어 중복이 막힌다(삼순 NO-GO ②).
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

      let claim: ClaimResult;
      try {
        claim = await deps.claimEvent(eventId, interview.gameId);
      } catch {
        claim = "error";
      }

      if (claim === "error") {
        // DB 오류를 "이미 보냈음"으로 오독하면 그 인터뷰가 영구 유실된다(삼순 NO-GO ①).
        hadInfraFailure = true;
        continue;
      }

      if (claim === "duplicate") {
        // 이전(또는 동시) run에서 이미 발송된 선수. 그 수신자들을 제외 집합에 넣어
        // 같은 영상의 다른 선수가 같은 유저에게 두 번 보내지 않게 한다.
        summary.skippedClaimed++;
        try {
          for (const id of await deps.fetchFavoritePlayerFanIds(link.kboId)) {
            notifiedUsers.add(id);
          }
        } catch {
          // 제외 집합을 못 만들면 중복 발송 위험이 있으므로 이 행을 완료 처리하지 않는다.
          hadInfraFailure = true;
        }
        continue;
      }

      // claim 이후의 모든 실패 경로는 반드시 unclaim 한다 — 잔류하면 그 선수는
      // 다음 run에서도 duplicate로 걸러져 영구 유실된다.
      try {
        const userIds = await deps.fetchFavoritePlayerFanIds(link.kboId);
        const targets = userIds.filter((id) => !notifiedUsers.has(id));
        summary.skippedDuplicateUser += userIds.length - targets.length;
        if (targets.length === 0) {
          // 대상 0(또는 전부 이 영상에서 이미 수신) = 정상 종결. claim 유지.
          summary.skippedNoAudience++;
          for (const id of userIds) notifiedUsers.add(id);
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
    if (!hadInfraFailure) settledRowIds.push(interview.id);
  }

  if (settledRowIds.length > 0) {
    await deps.markNotified(settledRowIds);
    summary.settled = settledRowIds.length;
  }
  return summary;
}
