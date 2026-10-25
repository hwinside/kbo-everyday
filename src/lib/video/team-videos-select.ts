/**
 * team-videos 라우트의 순수 선택 로직.
 *
 * uploads(플레이리스트에서 가져온 short/long 미구분 목록)를 duration 기준으로
 * short/long 필터 → targetCount 만큼 잘라 응답 아이템으로 매핑한다.
 * 라우트에서 분리해 회귀 테스트가 가능하게 한다(search→playlistItems 전환 검증).
 */

export interface UploadEntry {
  video_id: string;
  title: string;
  thumbnail?: string | null;
  published_at: string;
}

export interface TeamVideoItem {
  id: string;
  title: string;
  thumbnail: string | undefined;
  publishedAt: string;
  durationSeconds: number;
}

export function decodeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/** duration(≤70s) 또는 shorts/숏츠 힌트가 제목에 있으면 short로 판정. duration 0이면 미판정(long 취급). */
export function isTeamShortVideo(title: string, durationSeconds: number): boolean {
  const normalized = title.toLowerCase();
  return (
    durationSeconds > 0 &&
    (durationSeconds <= 70 ||
      normalized.includes("#shorts") ||
      normalized.includes("shorts") ||
      title.includes("숏츠") ||
      title.includes("쇼츠"))
  );
}

/**
 * uploads 를 type(short|long)으로 필터 후 targetCount 만큼 잘라 매핑.
 * duration 미상(detailMap 없음)인 항목은 제외(short/long 판정 불가).
 */
export function selectTeamVideoItems(
  uploads: UploadEntry[],
  detailMap: Map<string, { durationSeconds: number }>,
  type: "short" | "long",
  targetCount: number,
): TeamVideoItem[] {
  return uploads
    .filter((it) => {
      const detail = detailMap.get(it.video_id);
      if (!detail) return false;
      const short = isTeamShortVideo(decodeHtml(it.title), detail.durationSeconds);
      return type === "short" ? short : !short;
    })
    .slice(0, targetCount)
    .map((it) => ({
      id: it.video_id,
      title: decodeHtml(it.title),
      thumbnail: it.thumbnail || undefined,
      publishedAt: it.published_at,
      durationSeconds: detailMap.get(it.video_id)?.durationSeconds ?? 0,
    }));
}
