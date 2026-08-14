import type { VideoUpsertRow } from "@/lib/video/videos-repo";
import type { PlayerAlias } from "@/lib/video/player-tagger";
import type { KboRawGame } from "@/types/api";

// 최애선수 수훈선수 인터뷰 알림 (2026-08-14 하린아빠 요청).
// videos cron(RSS 수집)이 이번 run에서 정규화한 행을 그대로 넘겨받아,
// 구단 공식 채널의 "수훈(선수) 인터뷰" 영상을 감지 → 태깅된 선수를 최애로 둔
// 유저에게 발송하고 당일 경기페이지(/games/{gameId})로 딥링크한다.
//
// 안전장치:
//  - 감지는 공식 채널(source_type official_*)만 — 커뮤니티 채널 제목 낚시 차단.
//  - 제목에 "수훈" + "인터뷰" 둘 다 있어야 함(정밀도 우선, fail-close).
//  - freshness 컷오프(INTERVIEW_FRESH_MS): RSS는 채널당 최신 ~15개를 매 run 재반환하므로
//    배포/활성화 직후 과거 영상 backlog 일괄발송 위험(#274 패턴)을 시간창으로 차단.
//  - dedup = notified_score_events 재사용, event_id = `interview#{videoId}#{kboId}`
//    (video_id×선수 단위 멱등 claim → cron 재실행에도 1회만 발송).
//  - 경기 매칭 실패 시 발송 skip(fail-close) — 딥링크 목적지 없는 알림은 보내지 않는다.
//  - alias 소속팀 ≠ 영상 팀이면 skip(오태깅 방어).
//
// DB/FCM 의존은 전부 InterviewDeps로 주입 — 이 모듈 자체는 순수해서 QA smoke가
// 실제 발송 오케스트레이션 경로(claim→audience→send→unclaim)를 그대로 태울 수 있다.

/** 발행 후 이 시간 안의 영상만 알림 대상. videos cron 주기(2h) × 여유 배수. */
export const INTERVIEW_FRESH_MS = 6 * 60 * 60 * 1000;
/** 한 영상에서 알림 낼 최대 선수 수 — 제목 다인 태깅 시 스팸 방지. */
export const MAX_PLAYERS_PER_VIDEO = 2;
/** 공식 채널 source_type만 감지 대상. */
const OFFICIAL_SOURCE_TYPES = new Set<string>(["official_long", "official_short"]);
/** 알림 토글 키 (prefs.ts PREF_KEYS와 동일 문자열). */
export const INTERVIEW_PREF_KEY = "fav_player_interview" as const;

export interface InterviewCandidate {
  videoId: string;
  title: string;
  teamShortName: string;
  playerIds: string[];
  publishedAtMs: number;
}

/** 이번 run 행에서 수훈선수 인터뷰 후보 추출. */
export function detectInterviewCandidates(
  rows: VideoUpsertRow[],
  nowMs: number,
): InterviewCandidate[] {
  const seen = new Set<string>();
  const out: InterviewCandidate[] = [];
  for (const row of rows) {
    if (seen.has(row.video_id)) continue;
    if (!OFFICIAL_SOURCE_TYPES.has(row.source_type)) continue;
    const title = row.title ?? "";
    if (!title.includes("수훈") || !title.includes("인터뷰")) continue;
    const playerIds = (row.player_ids ?? []).slice(0, MAX_PLAYERS_PER_VIDEO);
    if (playerIds.length === 0) continue;
    if (!row.team_id) continue;
    const publishedAtMs = Date.parse(row.published_at);
    if (!Number.isFinite(publishedAtMs)) continue;
    // 미래 timestamp(시계 skew 5분 허용) 또는 freshness 창 밖은 제외.
    if (publishedAtMs > nowMs + 5 * 60 * 1000) continue;
    if (nowMs - publishedAtMs > INTERVIEW_FRESH_MS) continue;
    seen.add(row.video_id);
    out.push({ videoId: row.video_id, title, teamShortName: row.team_id, playerIds, publishedAtMs });
  }
  return out;
}

/** epoch ms → KST 날짜 "YYYYMMDD" (KBO GetKboGameList date 포맷). */
export function kstDateStr(ms: number): string {
  const kst = new Date(ms + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}${mo}${d}`;
}

/**
 * 스코어보드에서 해당 팀 경기 gameId 선택.
 * 더블헤더 등 복수 매칭이면 후행 경기를 쓴다 — 수훈 인터뷰는 마지막 경기 종료 후 올라온다.
 */
export function pickGameIdForTeam(games: KboRawGame[], teamShortName: string): string | null {
  let picked: string | null = null;
  for (const g of games) {
    if (g.AWAY_NM === teamShortName || g.HOME_NM === teamShortName) {
      if (g.G_ID) picked = g.G_ID;
    }
  }
  return picked;
}

export interface InterviewDeps {
  /** event_id 멱등 선점 — 첫 발송만 true. */
  claimEvent: (eventId: string, gameId: string) => Promise<boolean>;
  /** 인프라 실패 시 선점 해제 → 다음 cron 재시도. */
  unclaimEvent: (eventId: string) => Promise<void>;
  /** KST 날짜의 KBO 스코어보드. 실패는 null(정상 "경기 0"과 구분). */
  fetchGamesByDate: (date: string) => Promise<KboRawGame[] | null>;
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
  candidates: number;
  sent: number;
  skippedNoGame: number;
  skippedClaimed: number;
  skippedAliasMismatch: number;
  skippedNoAudience: number;
  failed: number;
}

/** 이번 run의 수집 행에서 수훈 인터뷰를 감지해 최애선수 팬에게 발송. */
export async function notifyFavPlayerInterviews(
  rows: VideoUpsertRow[],
  playerAliases: PlayerAlias[],
  deps: InterviewDeps,
  nowMs = Date.now(),
): Promise<InterviewNotifySummary> {
  const summary: InterviewNotifySummary = {
    candidates: 0, sent: 0, skippedNoGame: 0, skippedClaimed: 0,
    skippedAliasMismatch: 0, skippedNoAudience: 0, failed: 0,
  };
  const candidates = detectInterviewCandidates(rows, nowMs);
  summary.candidates = candidates.length;
  if (candidates.length === 0) return summary;

  const aliasById = new Map(playerAliases.map((p) => [p.kbo_id, p]));
  // 같은 run에서 날짜별 스코어보드 fetch 1회만 (후보 여러 건이 같은 날짜를 공유).
  const gamesByDate = new Map<string, KboRawGame[] | null>();
  const loadGames = async (date: string): Promise<KboRawGame[] | null> => {
    if (gamesByDate.has(date)) return gamesByDate.get(date) ?? null;
    const games = await deps.fetchGamesByDate(date);
    gamesByDate.set(date, games);
    return games;
  };

  for (const cand of candidates) {
    // 경기 매칭: 발행일(KST) → 없으면 전일(자정 넘겨 업로드된 인터뷰 커버).
    let gameId: string | null = null;
    for (const dayOffset of [0, 1]) {
      const date = kstDateStr(cand.publishedAtMs - dayOffset * 86_400_000);
      const games = await loadGames(date);
      if (!games) continue; // fetch 실패는 claim 없이 넘겨 다음 cron이 재시도
      gameId = pickGameIdForTeam(games, cand.teamShortName);
      if (gameId) break;
    }
    if (!gameId) {
      summary.skippedNoGame++;
      continue;
    }

    for (const kboId of cand.playerIds) {
      const alias = aliasById.get(kboId);
      // alias 소실 또는 영상 팀과 소속 불일치(오태깅 방어) → 발송 안 함.
      if (!alias || alias.team !== cand.teamShortName) {
        summary.skippedAliasMismatch++;
        continue;
      }
      const eventId = `interview#${cand.videoId}#${kboId}`;
      if (!(await deps.claimEvent(eventId, gameId))) {
        summary.skippedClaimed++;
        continue;
      }
      const userIds = await deps.fetchFavoritePlayerFanIds(kboId);
      if (userIds.length === 0) {
        // 대상 0 = 정상 종결. claim 유지(재조회해도 결과 동일).
        summary.skippedNoAudience++;
        continue;
      }
      const result = await deps.sendPush(
        userIds,
        {
          title: `⭐ ${alias.name} 수훈선수 인터뷰가 올라왔어요`,
          body: cand.title,
          url: `/games/${gameId}`,
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
