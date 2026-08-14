import { interviewPlayerLinks } from "@/lib/video/postgame-interviews-route-policy";

// 최애선수 수훈선수 인터뷰 알림 (2026-08-14 하린아빠 요청).
//
// 입력은 **기존 postgame-interviews 파이프라인이 이미 확정한 결과**다.
// 그 cron(#1001)이 경기 종료 후 30분~24시간 동안 승인 채널 16곳을 추적해
//   - 어느 경기인지(game_id)   — 제목 날짜·대진·스코어 대조 + 더블헤더 fail-close
//   - 누구 인터뷰인지(player_names) — 승리팀 박스스코어 선수명과 대조
// 를 고신뢰(confidence='high')로 매칭해 postgame_interviews에 저장한다.
// 이 모듈은 감지를 다시 하지 않는다 — 저장된 행을 최애선수 팬에게 보낼 뿐이다.
//
// ── 복구 설계 (삼순 NO-GO 4라운드 — 발송 모델 자체를 단순화) ─────────────────
// 이전 설계(선수별 claim + run-local dedupe)는 in-flight/완료 구분, unclaim 실패,
// run 사이 최애 변경까지 원장이 3개 필요했다. 삼순이 제안한 **영상당 union
// audience 1회 발송**으로 바꾸면 그 축들이 구조적으로 사라진다:
//
//  - 발송 단위 = 영상 1건 · 푸시 1회. 확정된 모든 선수의 팬을 합집합으로 모아
//    한 번에 보낸다 → 같은 유저가 같은 영상으로 2번 받을 경로 자체가 없다.
//    run 사이 최애 변경도 무관(재조회·과거 수신자 원장 불필요).
//  - 동시 실행 배제 = **row lease**(notify_state pending→processing + lease_until).
//    lease를 잡은 run만 발송한다. 다른 run은 in-flight 행을 아예 못 본다.
//    lease가 만료된 processing 행은 그 run이 죽은 것 → 재획득.
//  - best-effort 중복 방어 = **sent 마커**(notified_score_events,
//    `interview#{gameId}#{videoId}`). 발송 성공 직후 기록한다. markSent가 실패해 행이
//    processing으로 남으면 lease 만료 후 마커를 보고 재발송 없이 sent로 회복한다.
//    단, FCM 성공 직후 마커 기록 전 프로세스가 죽는 좁은 crash gap은 at-least-once
//    특성상 중복 1회가 가능하다. 하린아빠가 2026-08-15 B안(희소 중복 허용)을 명시
//    승인했다. collapse key를 idempotency로 오인하지 않는다. 유실보다 희소 중복을 택함.
//  - unclaim이라는 개념이 없다. 실패 복구는 전부 lease 해제(pending 복귀)로 한다.
//    해제 자체가 실패해도 lease 만료가 최종 안전망이라 은폐되는 실패가 없다.
//
// 상태 전이: pending ──lease──▶ processing ──성공/종결──▶ sent
//                             └─실패/불확실─▶ pending (또는 lease 만료로 재획득)
//
// 그 외 안전장치:
//  - kboId 확정은 interviewPlayerLinks(승리팀 로스터에서 이름이 유일할 때만) 재사용.
//    UI 선수 링크와 같은 함수라 화면과 알림 대상이 어긋나지 않는다. 미확정 선수는
//    발송에서 빠지고, 확정 선수가 0명이면 그 행은 보낼 수 없으므로 sent로 종결.
//  - 토글 fav_player_interview(기본 on)는 sendPush 구현의 prefKey 필터가 적용.
//
// DB/FCM 의존은 전부 InterviewDeps로 주입 — QA smoke가 lease→마커→발송→상태전이
// 종단 경로를 그대로 태울 수 있게.

/** 알림 토글 키 (prefs.ts PREF_KEYS와 동일 문자열). */
export const INTERVIEW_PREF_KEY = "fav_player_interview" as const;

/** sent 마커 조회 결과. error를 absent로 오독하면 이중발송 위험이 있어 3분기. */
export type SentMarkerState = "present" | "absent" | "error";

/** lease를 획득한 미발송 행. */
export interface PendingInterview {
  /** postgame_interviews.id (PK) — 상태 전이는 반드시 이 값으로 한다. */
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
  /**
   * pending(또는 lease 만료된 processing) 행에 lease를 걸고 반환.
   * 원자적 UPDATE라 두 run이 같은 행을 동시에 잡을 수 없다.
   */
  leasePendingInterviews: () => Promise<PendingInterview[]>;
  /** 발송 종결 표시 (성공·대상0·선수 미확정). row id 기준. */
  markSent: (rowIds: string[]) => Promise<void>;
  /** lease 해제 → pending 복귀. 실패해도 lease 만료가 안전망. */
  releaseLease: (rowIds: string[]) => Promise<void>;
  /** 이 경기+영상이 이미 발송됐는지(sent 마커). */
  hasSentMarker: (gameId: string, videoId: string) => Promise<SentMarkerState>;
  /** 발송 성공 직후 복합키 마커 기록. false = 기록 실패(행 상태가 1차 방어). */
  insertSentMarker: (gameId: string, videoId: string) => Promise<boolean>;
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
  leased: number;
  sent: number;
  /** sent 마커로 회복(직전 run이 발송 후 markSent 전에 죽은 행). */
  recoveredFromMarker: number;
  settledUnresolved: number;
  settledNoAudience: number;
  /** 실패/불확실 → lease 해제, 다음 run 재시도. */
  released: number;
  /** 마커 기록 실패(발송은 성공, 행 상태로만 방어 중) — 관측용. */
  markerWriteFailures: number;
}

/**
 * 미발송 수훈 인터뷰를 최애선수 팬에게 발송.
 * postgame-interviews cron에서 저장 직후 호출한다(같은 run에 저장된 행도 포함).
 */
export async function notifyFavPlayerInterviews(
  deps: InterviewDeps,
): Promise<InterviewNotifySummary> {
  const summary: InterviewNotifySummary = {
    leased: 0, sent: 0, recoveredFromMarker: 0, settledUnresolved: 0,
    settledNoAudience: 0, released: 0, markerWriteFailures: 0,
  };

  const leased = await deps.leasePendingInterviews();
  summary.leased = leased.length;
  if (leased.length === 0) return summary;

  const sentRowIds: string[] = [];
  const releaseRowIds: string[] = [];

  for (const interview of leased) {
    // 1. 이중발송 방어 — 직전 run이 발송 후 markSent 전에 죽었으면 마커가 남아 있다.
    let marker: SentMarkerState;
    try {
      marker = await deps.hasSentMarker(interview.gameId, interview.videoId);
    } catch {
      marker = "error";
    }
    if (marker === "present") {
      sentRowIds.push(interview.id);
      summary.recoveredFromMarker++;
      continue;
    }
    if (marker === "error") {
      // 조회 실패를 "미발송"으로 단정하면 이중발송 위험 → 이번 run은 건드리지 않는다.
      releaseRowIds.push(interview.id);
      summary.released++;
      continue;
    }

    // 2. kboId 확정 — UI 선수 링크와 같은 경로. 미확정 선수는 발송 대상에서 제외.
    const links = interviewPlayerLinks(interview.playerNames, interview.winnerTeamId)
      .filter((link): link is typeof link & { kboId: string } => link.kboId !== null);
    if (links.length === 0) {
      // 보낼 수 있는 선수가 없다 — 재시도해도 결과가 같으므로 종결.
      sentRowIds.push(interview.id);
      summary.settledUnresolved++;
      continue;
    }

    // 3. union audience — 확정된 모든 선수의 팬 합집합. 영상당 푸시는 1회뿐이라
    //    같은 유저가 같은 영상으로 중복 수신할 경로가 없다.
    let targets: string[];
    try {
      const union = new Set<string>();
      for (const link of links) {
        for (const id of await deps.fetchFavoritePlayerFanIds(link.kboId)) union.add(id);
      }
      targets = [...union];
    } catch {
      releaseRowIds.push(interview.id);
      summary.released++;
      continue;
    }
    if (targets.length === 0) {
      sentRowIds.push(interview.id);
      summary.settledNoAudience++;
      continue;
    }

    // 4. 발송 1회 → 성공 시 마커 기록 후 종결. 실패/예외는 lease 해제(다음 run 재시도).
    try {
      const names = links.map((link) => link.name).join("·");
      const result = await deps.sendPush(
        targets,
        {
          title: `⭐ ${names} 수훈선수 인터뷰가 올라왔어요`,
          body: interview.title,
          url: `/games/${interview.gameId}`,
        },
        INTERVIEW_PREF_KEY,
      );
      if (!result.ok) {
        releaseRowIds.push(interview.id);
        summary.released++;
        continue;
      }
      if (!(await deps.insertSentMarker(interview.gameId, interview.videoId).catch(() => false))) {
        summary.markerWriteFailures++;
      }
      sentRowIds.push(interview.id);
      summary.sent++;
    } catch {
      releaseRowIds.push(interview.id);
      summary.released++;
    }
  }

  // 상태 전이는 마지막에 일괄 적용. markSent가 실패하면 행은 processing으로 남지만
  // lease 만료 + sent 마커 경로가 재발송 없이 회복한다.
  if (sentRowIds.length > 0) await deps.markSent(sentRowIds);
  if (releaseRowIds.length > 0) {
    // release 실패는 호출자/cron 응답에 드러나야 한다. lease 만료가 복구 안전망이지만
    // 실패를 성공처럼 반환하지 않는다(삼순 5차 NO-GO).
    await deps.releaseLease(releaseRowIds);
  }
  return summary;
}
