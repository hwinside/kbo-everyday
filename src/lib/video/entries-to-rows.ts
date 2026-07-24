/**
 * RSS/playlistItems 응답을 videos upsert 행으로 정규화 — videos 크론의 수집
 * 경로 SSOT. route에서 분리해 수집→조회 통합 회귀(QA smoke)가 실제 team_id
 * 배정 로직을 그대로 검증할 수 있게 한다 (2026-07-24 삼순 라운드4).
 */

import { OFFICIAL_CHANNEL_IDS, type PoolChannel } from "@/lib/video/team-channels";
import type { RssVideoEntry } from "@/lib/video/rss-parser";
import { extractNoiseFlags, isShortCandidate } from "@/lib/video/noise-flags";
import type { VideoUpsertRow } from "@/lib/video/videos-repo";
import { matchPlayers, type PlayerAlias } from "@/lib/video/player-tagger";
import { detectTeamFromTitle } from "@/lib/video/team-detector";

/**
 * Normalize fetched entries (RSS or playlistItems) into upsert rows.
 * Source-agnostic: both fetchers return the same `RssVideoEntry` shape.
 */
export function entriesToRows(
  entries: RssVideoEntry[],
  ch: PoolChannel,
  playerAliases: PlayerAlias[],
): VideoUpsertRow[] {
  const isOfficial = OFFICIAL_CHANNEL_IDS.has(ch.channel_id);
  const channelTeam = ch.team_affinity?.[0] ?? null;

  return entries.map((e) => {
    const noiseFlags = extractNoiseFlags(e.title, e.channel);
    const isShort = isShortCandidate({ title: e.title });
    // Precision 매칭: 공식 채널은 channelTeam, T1은 선수명 only 허용, T2+는 팀명+선수명 필수
    const playerIds = matchPlayers(
      e.title,
      playerAliases,
      isOfficial ? channelTeam : null,
      isOfficial ? null : ch.tier,
    );
    // team_id: 채널 팀 > 매칭된 선수의 소속팀 > 제목 감지 > ETC
    // 선수 소속팀 우선 → 대전 영상에서 상대팀으로 잘못 잡히는 것 방지
    // 비-LG affinity 채널의 명시적 LG 야구 제목(운영 케이스 79W-OwErIEA)은
    // 이 계약을 유지한 채 shorts-feed의 다중 팀 노출 경로로 LG 피드에 포함된다.
    let teamId = channelTeam;
    if (!teamId && playerIds.length > 0) {
      const firstPlayer = playerAliases.find((p) => p.kbo_id === playerIds[0]);
      teamId = firstPlayer?.team ?? null;
    }
    // 검증 야구채널(tier 1 방송사/공식급) 신호를 LG 야구 문맥 긍정 근거로 전달
    // (2026-07-24 삼순 라운드3 A안 — TVING `한화 vs LG`류 recall 보존).
    // team_affinity 보유 채널은 위 channelTeam 경로로 이미 확정되어 여기 안 온다.
    if (!teamId) teamId = detectTeamFromTitle(e.title, { trustedChannel: ch.tier === 1 });

    const sourceType: VideoUpsertRow["source_type"] = isOfficial
      ? isShort ? "official_short" : "official_long"
      : isShort ? "community_short" : "community_long";

    return {
      video_id: e.video_id,
      team_id: teamId,
      player_id: playerIds[0] ?? null,
      player_ids: playerIds,
      title: e.title,
      channel: e.channel,
      channel_id: e.channel_id,
      thumbnail: e.thumbnail,
      published_at: e.published_at,
      source_type: sourceType,
      is_short_candidate: isShort,
      noise_flags: noiseFlags,
    };
  });
}
