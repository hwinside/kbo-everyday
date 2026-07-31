/**
 * 영상 인코딩 프로필 + 순수 판정 헬퍼.
 *
 * transcode-videos.mjs 에서 분리한 이유: 그 파일은 최상위에서 @supabase/supabase-js 와
 * .env.local 을 로드하므로 import 만으로 DB 클라이언트가 생성된다. 회귀 스모크가 인코딩
 * 파라미터를 검증하려면 순수 모듈이어야 한다(venue-transcode-job.mjs 와 같은 분리 패턴).
 */
import { createHash } from "crypto";
import { basename } from "path";

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
 * 커뮤니티 프로필 세대 번호. video_transcode_jobs.profile_version 과 비교해
 * "이 job 이 현재 프로필로 처리됐는가"를 판정하는 영속 마커의 기준값이다.
 *   0 = 마이그레이션 default(구 프로필 crf27/1280/128k 로 처리된 기존 done 건)
 *   2 = 현재 프로필(crf30/720/64k mono)
 * 프로필을 또 바꾸면 이 값을 올린다 → 전체 job 이 다시 백필 대상이 된다.
 * (1을 건너뛴 이유: 경로 버전 규약과 숫자를 맞춰 v2 이상만 경로에 버전을 넣는다 — optimizedPath 주석 참조)
 */
export const COMMUNITY_PROFILE_VERSION = 2;

/**
 * 재인코딩 백필 대상 판정(순수).
 * status=done 이면서 아직 현재 프로필로 처리되지 않은(profile_version < 현재) job 만 대상.
 * profile_version 이 null/undefined 인 행(마이그레이션 직후 경합 등)은 0 으로 간주 → 대상 포함.
 */
export function needsReencode(job, targetVersion = COMMUNITY_PROFILE_VERSION) {
  if (!job || job.status !== "done") return false;
  return (job.profile_version ?? 0) < targetVersion;
}

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

/**
 * 재인코딩 백필 배치 대상 선택(순수) — reencode / reencode-probe 공용.
 * DB 쿼리(`status=done AND profile_version < N ORDER BY optimized_bytes DESC, id`)의
 * 동치 구현이라 선택 규칙 자체를 ffmpeg/DB 없이 회귀 검증할 수 있다.
 * 정렬: 절감 기대치 큰 순(optimized_bytes DESC) → id ASC(결정적 tiebreak).
 */
export function pickReencodeTargets(jobs, limit, targetVersion = COMMUNITY_PROFILE_VERSION) {
  return (jobs ?? [])
    .filter((job) => needsReencode(job, targetVersion))
    .sort((a, b) => (b.optimized_bytes ?? 0) - (a.optimized_bytes ?? 0) || a.id - b.id)
    .slice(0, limit);
}

/**
 * 재인코딩 1건 결과 → video_transcode_jobs 갱신 필드(순수).
 *
 * 전진성(progress) 계약:
 *  - "replaced"(교체함) / "kept"(절감 미미해 유지) 둘 다 profile_version 을 마킹한다.
 *    keep 를 마킹하지 않으면 다음 배치에서 같은 행이 다시 선택돼 슬롯을 점유 → 백필이 영원히 안 끝난다.
 *  - "failed" 는 null — 마킹하지 않아 다음 실행에서 재시도된다.
 */
export function reencodeJobFields(outcome, values = {}, targetVersion = COMMUNITY_PROFILE_VERSION) {
  if (outcome === "replaced") {
    return {
      optimized_url: values.optimizedUrl,
      original_bytes: values.originalBytes,
      optimized_bytes: values.optimizedBytes,
      profile_version: targetVersion,
      error: null,
    };
  }
  if (outcome === "kept") return { profile_version: targetVersion };
  return null;
}

/**
 * Supabase 에러가 "profile_version 컬럼 없음"인지 판정(순수).
 * 마이그레이션이 아직 적용되지 않은 환경에서 **읽기 전용 probe** 를 돌릴 수 있게 하려는 용도다.
 * (쓰기 경로는 이 상태면 아예 중단한다 — 마킹이 불가능해 전진성이 성립하지 않기 때문.)
 */
export function isMissingProfileVersionColumn(error) {
  if (!error) return false;
  if (error.code === "42703") return true; // postgres undefined_column
  return /profile_version/.test(`${error.message ?? ""}`) && /does not exist|column/i.test(`${error.message ?? ""}`);
}

/**
 * Storage upload 에러가 "객체 이미 존재"인지 판정(순수).
 * 재인코딩은 버전된 경로에 upsert:false 로 올린다 — 이미 존재 = 이전 실행이 썼다는 뜻이므로
 * 바이트를 덮어쓰지 않고(=CDN 에 이미 캐시된 객체의 내용이 바뀌는 일 없음) 스왝/마킹만 이어간다.
 */
export function isDuplicateUploadError(error) {
  if (!error) return false;
  const status = String(error.statusCode ?? error.status ?? "");
  if (status === "409") return true;
  const text = `${error.error ?? ""} ${error.message ?? ""}`.toLowerCase();
  return text.includes("duplicate") || text.includes("already exists");
}

/**
 * 원본 path → 최적화본 path (같은 버킷, transcoded/ 프리픽스, .mp4 강제)
 *
 * 확장자만 다른 동명 파일(same.mp4/same.mov)이 .mp4 로 고정되며 충돌하지 않도록
 * 원본 path 해시를 파일명에 포함한다. 같은 원본+같은 프로필은 항상 같은 path.
 *
 * **버전 수용(CDN 안전)**: 운영 응답이 `Cache-Control: max-age=3600` + Cloudflare HIT 라
 * 같은 public URL 에 다른 바이트를 올리면 stale/mixed 응답이 생는다.
 * → 프로필 v2 이상은 path 에 `-v{N}` 을 붙여 **새 객체/새 URL** 로 발행하고 posts.video_urls 를 교체한다.
 * v0/v1(기존 발행본)은 경로 불변 — 이미 서빙 중인 URL 이 깨지면 안 된다.
 */
export function optimizedPath(origPath, profileVersion = 0) {
  const name = basename(origPath).replace(/\.[^.]+$/, "");
  const dir = origPath.slice(0, origPath.length - basename(origPath).length);
  const h = createHash("sha1").update(origPath).digest("hex").slice(0, 8);
  const suffix = profileVersion >= 2 ? `-v${profileVersion}` : "";
  return `transcoded/${dir}${name}-${h}${suffix}.mp4`;
}
