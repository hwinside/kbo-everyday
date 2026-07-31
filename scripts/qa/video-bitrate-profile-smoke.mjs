/**
 * 커뮤니티 영상 인코딩 프로필 회귀 스모크 — npm run qa:video-bitrate
 *
 * 배경(운영 실측 2026-07-31): Supabase cached egress 가 사이클 39% 시점에 90%(224.7/250GB) 소진.
 * storage.objects 실측상 영상 392개 1,416MB 가 전체 용량의 88%. 기존 community 프로필
 * (crf27/1280/128k) 은 이미 1040px 이하인 긴 영상에서 5% 밖에 못 줄였다(gif-collector/9:
 * 17.4MB → 16.5MB). 새 프로필(crf30/720/64k mono) 20샘플 실측 141.6MB → 51.3MB(64% 절감).
 *
 * 이 스모크는 ffmpeg 실행 없이 **순수 함수**(인자 조립·교체 판정)만 검증한다.
 * 실제 인코딩 절감률은 `node scripts/transcode-videos.mjs --probe` 로 별도 실측한다.
 */
import { buildTranscodeArgs, shouldReplaceWithReencode, VIDEO_PROFILES } from "../video-profiles.mjs";

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

/** args 배열에서 flag 다음 값 반환(없으면 null). */
function argOf(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

console.log("\n── 1) community 프로필: egress 절감 파라미터가 실제 인자에 실린다 ──");
{
  const args = buildTranscodeArgs("/tmp/in.mp4", "/tmp/out.mp4", VIDEO_PROFILES.community);
  ok("crf 30 (기존 27 → 압축 강화)", argOf(args, "-crf") === "30");
  ok("긴 변 720 박스 (기존 1280)", (argOf(args, "-vf") || "").includes("min(720,iw)"));
  ok("오디오 64k (기존 128k)", argOf(args, "-b:a") === "64k");
  ok("오디오 모노(-ac 1)", argOf(args, "-ac") === "1");
  ok("preset medium (veryfast 대비 동일 crf에서 더 작음)", argOf(args, "-preset") === "medium");
  ok("faststart 유지 — 스트리밍 첫 프레임 지연 방지", args.includes("+faststart"));
  ok("yuv420p 유지 — iOS/Android 디코더 호환", argOf(args, "-pix_fmt") === "yuv420p");
  ok("확대 금지(force_original_aspect_ratio=decrease)", (argOf(args, "-vf") || "").includes("decrease"));
  ok("짝수 보정 유지 — libx264 요구", (argOf(args, "-vf") || "").includes("trunc(iw/2)*2"));
  ok("입출력 경로가 올바른 위치", args[2] === "/tmp/in.mp4" && args[args.length - 1] === "/tmp/out.mp4");
}

console.log("\n── 2) venue 프로필: 직관 라이브는 무변경(화질 체감 우선, 용량 기여 미미) ──");
{
  const args = buildTranscodeArgs("/tmp/in.mp4", "/tmp/out.mp4", VIDEO_PROFILES.venue);
  ok("crf 27 유지", argOf(args, "-crf") === "27");
  ok("긴 변 1280 유지", (argOf(args, "-vf") || "").includes("min(1280,iw)"));
  ok("오디오 128k 유지", argOf(args, "-b:a") === "128k");
  ok("모노 강제 안 함(스테레오 보존)", argOf(args, "-ac") === null);
  ok("preset veryfast 유지 — 업로드 직후 처리 지연 방지", argOf(args, "-preset") === "veryfast");
  ok("community 와 실제로 다른 인자 집합", JSON.stringify(args) !== JSON.stringify(buildTranscodeArgs("/tmp/in.mp4", "/tmp/out.mp4", VIDEO_PROFILES.community)));
}

console.log("\n── 3) 프로필 미지정 기본값 = community (호출부 누락 시 안전) ──");
{
  const a = buildTranscodeArgs("/tmp/in.mp4", "/tmp/out.mp4");
  ok("기본 crf 30", argOf(a, "-crf") === "30");
}

console.log("\n── 4) 재인코딩 교체 판정: 이득 없으면 기존 서빙본을 지킨다 ──");
{
  const MB = 1024 * 1024;
  // 실측 케이스: 현재 서빙 15.76MB → 새 결과 7.35MB (53% 절감) → 교체
  ok("실측 53% 절감 → 교체", shouldReplaceWithReencode(7.35 * MB, 15.76 * MB, 17.4 * MB) === true);
  // 절감 미미(2%) → 유지. 무의미한 재업로드로 세대손실만 쌓는 것 방지.
  ok("2% 절감 → 교체 안 함", shouldReplaceWithReencode(9.8 * MB, 10 * MB, 12 * MB) === false);
  // 오히려 커지는 경우 → 절대 교체 금지(회귀 방지 핵심)
  ok("새 결과가 더 큼 → 교체 안 함", shouldReplaceWithReencode(12 * MB, 10 * MB, 12 * MB) === false);
  // 경계: 정확히 5% 감소는 교체(임계 포함)
  ok("정확히 5% 절감 → 교체(경계 포함)", shouldReplaceWithReencode(9.5 * MB, 10 * MB, 12 * MB) === true);
  ok("4.9% 절감 → 교체 안 함(경계 바로 아래)", shouldReplaceWithReencode(9.51 * MB, 10 * MB, 12 * MB) === false);
  // optimized_bytes 가 null(과거 job) 이면 원본 대비로 판정 — baseline 유실 시 오판 방지
  ok("서빙본 크기 미상 → 원본 기준 판정", shouldReplaceWithReencode(5 * MB, null, 17 * MB) === true);
  ok("서빙본 크기 미상 + 원본 대비 이득 없음 → 교체 안 함", shouldReplaceWithReencode(16.9 * MB, null, 17 * MB) === false);
  // baseline 자체가 없거나 0이면 판단 불가 → fail-closed(교체 안 함)
  ok("baseline 0 → fail-closed", shouldReplaceWithReencode(1 * MB, 0, 0) === false);
  ok("baseline null/undefined → fail-closed", shouldReplaceWithReencode(1 * MB, null, null) === false);
}

console.log(`\n결과: ✅ ${pass} / ❌ ${fail}`);
if (fail > 0) process.exit(1);
