/**
 * 커뮤니티 영상 재인코딩 백필 1행 처리 단위 — 업로드→스왑→마킹 순서와 중간 실패 처리 포함.
 * deps={storage, runner, markJob, swapVideoUrl}를 주입받아 단독 테스트 가능.
 * 실사용: transcode-videos.mjs 의 reencode() 가 이 함수를 호출.
 * (venue-transcode-job.mjs 와 같은 분리 패턴 — 최상위 supabase 클라이언트 없이 테스트하려고 분리)
 */
import { readFileSync, statSync } from "fs";
import {
  COMMUNITY_PROFILE_VERSION,
  shouldReplaceWithReencode,
  reencodeJobFields,
  isDuplicateUploadError,
  optimizedPath,
} from "./video-profiles.mjs";

/**
 * 재인코딩 1건 수행.
 *
 * **순서 안전성(CDN rollout)**: 운영 응답이 `Cache-Control: max-age=3600` + Cloudflare HIT 라
 * 같은 public URL 에 다른 바이트를 올리면 stale/mixed 응답이 생긴다. 그래서
 *   ① 새 버전 경로(-v2)에 **새 객체** 업로드(upsert:false — 기존 객체 바이트 절대 안 건드림)
 *   ② posts.video_urls 를 새 URL 로 교체
 *   ③ job 마킹(세대 전진 + 새 URL/용량 기록)
 * 순서로 진행한다. ①/②/③ 어디서 죽어도 기존 URL·기존 객체가 그대로 서빙된다(노출 영향 0).
 * 구 객체는 여기서 삭제하지 않는다 — 롤백 여지 + CDN TTL 만료 대기.
 *
 * @returns {Promise<{ outcome: "replaced"|"kept"|"failed", ... }>}
 */
export async function processReencodeJob(job, deps) {
  const {
    storage, runner, markJob, swapVideoUrl, parsed,
    inPath, outPath, targetVersion = COMMUNITY_PROFILE_VERSION,
  } = deps;

  try {
    const inBytes = await runner.downloadToFile(job.original_url, inPath);
    runner.transcode(inPath, outPath);
    const outBytes = runner.sizeOf ? runner.sizeOf(outPath) : statSync(outPath).size;
    const servedBytes = job.optimized_bytes ?? null;

    if (!shouldReplaceWithReencode(outBytes, servedBytes, inBytes)) {
      // keep 도 반드시 세대 마킹 — 안 하면 다음 배치가 같은 행을 다시 뽑아 슬롯을 영원히 점유한다.
      await markJob(job.original_url, reencodeJobFields("kept", {}, targetVersion));
      return { outcome: "kept", inBytes, outBytes, servedBytes };
    }

    // ① 새 버전 경로에 새 객체 업로드
    const newPath = optimizedPath(parsed.path, targetVersion);
    const body = runner.readFile ? runner.readFile(outPath) : readFileSync(outPath);
    const { error: upErr } = await storage
      .from(parsed.bucket)
      .upload(newPath, body, { contentType: "video/mp4", upsert: false });
    // 이미 존재 = 이전 실행이 ①까지 끝내고 죽었다는 뜻 → 바이트를 덮지 않고 ②③만 이어간다.
    if (upErr && !isDuplicateUploadError(upErr)) throw new Error(`upload 실패: ${upErr.message}`);
    const reusedExisting = Boolean(upErr);
    const { data: pub } = storage.from(parsed.bucket).getPublicUrl(newPath);

    // ② posts.video_urls 교체 (여기까지 실패하면 기존 URL 이 계속 서빙 — 노출 영향 0)
    const swapped = await swapVideoUrl(job.post_id, job.optimized_url ?? job.original_url, pub.publicUrl);

    // ③ job 마킹(세대 전진)
    await markJob(job.original_url, reencodeJobFields("replaced", {
      optimizedUrl: pub.publicUrl, originalBytes: inBytes, optimizedBytes: outBytes,
    }, targetVersion));

    return { outcome: "replaced", inBytes, outBytes, servedBytes, newPath, newUrl: pub.publicUrl, swapped, reusedExisting };
  } catch (e) {
    // 실패는 기존 서빙본을 그대로 둔다 — profile_version 미갱신 → 다음 실행에서 재시도.
    return { outcome: "failed", error: e };
  }
}
