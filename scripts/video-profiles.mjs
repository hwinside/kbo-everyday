/**
 * 영상 인코딩 프로필 + 순수 판정 헬퍼.
 *
 * transcode-videos.mjs 에서 분리한 이유: 그 파일은 최상위에서 @supabase/supabase-js 와
 * .env.local 을 로드하므로 import 만으로 DB 클라이언트가 생성된다. 회귀 스모크가 인코딩
 * 파라미터를 검증하려면 순수 모듈이어야 한다(venue-transcode-job.mjs 와 같은 분리 패턴).
 */

// ── 인코딩 프로필 ──
// community: 짤콜렉터/커뮤니티 영상 — storage egress 지배 요인(운영 실측 2026-07-31:
//   영상 392개 1,416MB = 전체 용량의 88%, 상위 파일 15~17MB). 모바일 피드에서 720px 이상
//   필요 없고 오디오 비중도 낮다.
// venue: 직관 라이브 스토리 — 유저 본인 현장 영상(≤15초, 운영 평균 714kB)이라 용량 기여가
//   미미하고 화질 체감이 더 중요 → 기존 파라미터 유지(이번 변경 범위 밖).
export const VIDEO_PROFILES = {
  community: { maxDim: 720, crf: 30, preset: "medium", audioBitrate: "64k", audioChannels: 1 },
  venue: { maxDim: 1280, crf: 27, preset: "veryfast", audioBitrate: "128k", audioChannels: null },
};

/**
 * ffmpeg 인자 조립(순수).
 * 긴 변을 maxDim 박스에 맞춰 축소(확대 안 함) 후 짝수 보정(libx264 yuv420p 요구).
 */
export function buildTranscodeArgs(input, output, profile) {
  const p = profile ?? VIDEO_PROFILES.community;
  const args = [
    "-y", "-i", input,
    "-vf", `scale='min(${p.maxDim},iw)':'min(${p.maxDim},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    "-c:v", "libx264", "-profile:v", "high", "-preset", p.preset, "-crf", String(p.crf),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", p.audioBitrate,
  ];
  if (p.audioChannels) args.push("-ac", String(p.audioChannels));
  args.push("-movflags", "+faststart", output);
  return args;
}

/**
 * 재인코딩 결과로 기존 서빙본을 교체할지 판정(순수).
 * 새 결과가 현재 서빙본보다 유의미하게 작을 때만 교체한다(기본 5% 이상 감소).
 * 현재 서빙본 크기를 모르면(null) 원본 대비로 판정하고, baseline 자체가 없으면
 * 판단 불가로 보아 교체하지 않는다(fail-closed — 커지는 재업로드 방지).
 */
export function shouldReplaceWithReencode(newBytes, currentServedBytes, originalBytes, minGain = 0.05) {
  const baseline = currentServedBytes ?? originalBytes;
  if (!baseline || baseline <= 0) return false;
  return newBytes <= baseline * (1 - minGain);
}
