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
import {
  buildTranscodeArgs,
  shouldReplaceWithReencode,
  VIDEO_PROFILES,
  COMMUNITY_PROFILE_VERSION,
  needsReencode,
  pickReencodeTargets,
  reencodeJobFields,
  isDuplicateUploadError,
  isMissingProfileVersionColumn,
  optimizedPath,
} from "../video-profiles.mjs";
import { processReencodeJob } from "../reencode-job.mjs";

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

console.log("\n── 5) 백필 대상 선택: status/세대 필터 + 결정적 정렬 (reencode 와 --reencode-probe 공용) ──");
{
  const j = (id, bytes, extra = {}) => ({ id, post_id: id, optimized_bytes: bytes, status: "done", profile_version: 0, ...extra });

  ok("done + 구 세대 → 대상", needsReencode(j(1, 10)) === true);
  ok("done + 현재 세대 → 대상 아님", needsReencode(j(1, 10, { profile_version: COMMUNITY_PROFILE_VERSION })) === false);
  ok("profile_version 미상(null) → 0 취급, 대상", needsReencode(j(1, 10, { profile_version: null })) === true);
  ok("status=pending → 대상 아님(아직 1차 처리 전)", needsReencode(j(1, 10, { status: "pending" })) === false);
  ok("status=skipped → 대상 아님(원본 유지 결정 건)", needsReencode(j(1, 10, { status: "skipped" })) === false);
  ok("status=failed → 대상 아님", needsReencode(j(1, 10, { status: "failed" })) === false);
  ok("미래 세대(> 현재) → 대상 아님", needsReencode(j(1, 10, { profile_version: COMMUNITY_PROFILE_VERSION + 1 })) === false);

  const pool = [j(1, 5_000_000), j(2, 15_000_000), j(3, 9_000_000), j(4, 15_000_000)];
  const picked = pickReencodeTargets(pool, 3).map((x) => x.id);
  ok("용량 큰 순 정렬 + 동률은 id ASC(결정적)", JSON.stringify(picked) === JSON.stringify([2, 4, 3]));
  ok("limit 을 넘지 않음", pickReencodeTargets(pool, 2).length === 2);
  ok("optimized_bytes null 은 0 취급 — 뒤로 밀리되 탈락 안 함", pickReencodeTargets([j(9, null), j(8, 1)], 2).map((x) => x.id).join() === "8,9");
  ok("빈 입력 → 빈 결과(대상 없음 경로)", pickReencodeTargets([], 5).length === 0);
  ok("전부 현재 세대면 0건 — 백필 완료 상태 표현", pickReencodeTargets(pool.map((x) => ({ ...x, profile_version: COMMUNITY_PROFILE_VERSION })), 5).length === 0);
}

console.log("\n── 6) 배치 간 전진성(progress): 같은 슬롯 재점유 금지 ──");
{
  // 삼순 blocker 2 회귀: 마커 없이 status=done 만 보면 매 배치가 같은 상위 N 건을 다시 뽑는다.
  // 세대 마킹(replaced/kept 모두)을 적용하면 후보 집합이 단조 감소해야 한다.
  const applyFields = (job, fields) => (fields ? { ...job, ...fields } : job);
  let rows = [
    { id: 1, post_id: 1, status: "done", profile_version: 0, optimized_bytes: 15_000_000 },
    { id: 2, post_id: 2, status: "done", profile_version: 0, optimized_bytes: 12_000_000 },
    { id: 3, post_id: 3, status: "done", profile_version: 0, optimized_bytes: 9_000_000 },
    { id: 4, post_id: 4, status: "done", profile_version: 0, optimized_bytes: 7_000_000 },
    { id: 5, post_id: 5, status: "done", profile_version: 0, optimized_bytes: 5_000_000 },
  ];
  /** 배치 1회 = 대상 선택 → outcome 별 필드 적용. outcomeOf(job) → "replaced"|"kept"|"failed" */
  function runBatch(limit, outcomeOf) {
    const targets = pickReencodeTargets(rows, limit);
    const ids = targets.map((t) => t.id);
    for (const t of targets) {
      const outcome = outcomeOf(t);
      const fields = reencodeJobFields(outcome, { optimizedUrl: `u${t.id}`, originalBytes: 20_000_000, optimizedBytes: 4_000_000 });
      rows = rows.map((r) => (r.id === t.id ? applyFields(r, fields) : r));
    }
    return ids;
  }

  // ① 1차 N건 → 2차 N건이 전진한다
  const b1 = runBatch(2, () => "replaced");
  const b2 = runBatch(2, () => "replaced");
  ok("① 1차 배치 = 용량 상위 2건", JSON.stringify(b1) === JSON.stringify([1, 2]));
  ok("① 2차 배치가 1차와 겹치지 않음(전진)", b2.every((id) => !b1.includes(id)));
  ok("① 2차 = 그다음 2건", JSON.stringify(b2) === JSON.stringify([3, 4]));
  ok("① 교체분 optimized_url/bytes 갱신됨", rows.find((r) => r.id === 1).optimized_url === "u1" && rows.find((r) => r.id === 1).optimized_bytes === 4_000_000);

  // ② 절감 미미 keep 도 전진해야 한다 (마킹 안 하면 5번이 영원히 슬롯 점유)
  const b3 = runBatch(2, () => "kept");
  ok("② 남은 1건(5번)이 keep 판정으로 처리됨", JSON.stringify(b3) === JSON.stringify([5]));
  ok("② keep 도 세대 마킹됨 → 재선택 안 됨", rows.find((r) => r.id === 5).profile_version === COMMUNITY_PROFILE_VERSION);
  ok("② keep 은 용량/URL 을 건드리지 않음(기존 서빙본 보존)", rows.find((r) => r.id === 5).optimized_bytes === 5_000_000 && rows.find((r) => r.id === 5).optimized_url === undefined);

  // ③ 전체 완료 후 rerun 이 멱등 — 대상 0건
  ok("③ 전체 완료 후 rerun 대상 0건(멱등)", pickReencodeTargets(rows, 100).length === 0);
  ok("③ rerun 이 아무 행도 안 건드림", runBatch(100, () => "replaced").length === 0);
}

console.log("\n── 7) 중단 후 재개 + 실패 재시도 ──");
{
  let rows = [
    { id: 1, post_id: 1, status: "done", profile_version: 0, optimized_bytes: 15_000_000 },
    { id: 2, post_id: 2, status: "done", profile_version: 0, optimized_bytes: 12_000_000 },
    { id: 3, post_id: 3, status: "done", profile_version: 0, optimized_bytes: 9_000_000 },
  ];
  // 배치 도중 크래시 모사: 1번만 마킹되고 프로세스가 죽음(2·3 미처리)
  const first = pickReencodeTargets(rows, 3).map((x) => x.id);
  rows = rows.map((r) => (r.id === 1 ? { ...r, ...reencodeJobFields("replaced", { optimizedUrl: "u1", originalBytes: 20, optimizedBytes: 4 }) } : r));
  const resumed = pickReencodeTargets(rows, 3).map((x) => x.id);
  ok("중단 전 대상 3건", JSON.stringify(first) === JSON.stringify([1, 2, 3]));
  ok("재개 시 마킹된 1건은 빠지고 남은 2건만(재개 가능)", JSON.stringify(resumed) === JSON.stringify([2, 3]));

  // 실패 건은 마킹하지 않는다 → 다음 실행에서 재시도된다
  ok("실패 outcome 은 갱신 필드 없음(null)", reencodeJobFields("failed") === null);
  const afterFail = rows.map((r) => (r.id === 2 ? { ...r } : r)); // 실패 = 무변경
  ok("실패 건은 다음 배치에서 재시도 대상으로 남음", pickReencodeTargets(afterFail, 3).some((x) => x.id === 2));
}

console.log("\n── 8) 세대별 객체 경로: CDN stale 방지(같은 URL 바이트 교체 금지) ──");
{
  const orig = "gif-collector/2026/07/clip.mov";
  const v0 = optimizedPath(orig);
  const v2 = optimizedPath(orig, COMMUNITY_PROFILE_VERSION);
  ok("기본(버전 미지정) = 기존 경로 규약 — 이미 서빙 중인 URL 불변", /^transcoded\/gif-collector\/2026\/07\/clip-[0-9a-f]{8}\.mp4$/.test(v0));
  ok("v1 도 기존 경로 유지(레거시 불변)", optimizedPath(orig, 1) === v0);
  ok("현재 세대는 다른 경로 — 같은 URL 에 다른 바이트 upsert 안 함", v2 !== v0);
  ok(`현재 세대 경로에 -v${COMMUNITY_PROFILE_VERSION} 접미사`, v2.endsWith(`-v${COMMUNITY_PROFILE_VERSION}.mp4`));
  ok("같은 원본+같은 세대 → 같은 경로(재실행 멱등)", optimizedPath(orig, COMMUNITY_PROFILE_VERSION) === v2);
  ok("확장자만 다른 동명 원본은 서로 다른 경로(해시 충돌 방지 유지)",
    optimizedPath("a/clip.mov", 2) !== optimizedPath("a/clip.mp4", 2));
  ok("디렉터리 구조 보존", v2.startsWith("transcoded/gif-collector/2026/07/"));
  ok("루트 파일(디렉터리 없음)도 정상", /^transcoded\/clip-[0-9a-f]{8}-v2\.mp4$/.test(optimizedPath("clip.mp4", 2)));
  // 세대가 또 올라가면 또 다른 경로여야 한다(다음 백필도 CDN 안전)
  ok("다음 세대는 또 다른 경로", optimizedPath(orig, 3) !== v2);
}

console.log("\n── 9) 중복 업로드 에러 판정: 이전 실행 업로드본 재사용(바이트 덮어쓰기 금지) ──");
{
  ok("409 statusCode → 중복", isDuplicateUploadError({ statusCode: "409", message: "The resource already exists" }) === true);
  ok("Duplicate 메시지 → 중복", isDuplicateUploadError({ error: "Duplicate", message: "resource already exists" }) === true);
  ok("일반 실패는 중복 아님(throw 되어야 함)", isDuplicateUploadError({ statusCode: "500", message: "internal" }) === false);
  ok("에러 없음 → 중복 아님", isDuplicateUploadError(null) === false);
}

console.log("\n── 9-b) profile_version 컬럼 부재 판정: 마이그레이션 미적용 환경에서 probe 만 허용 ──");
{
  ok("postgres 42703(undefined_column) → 부재", isMissingProfileVersionColumn({ code: "42703", message: `column video_transcode_jobs.profile_version does not exist` }) === true);
  ok("메시지 기반 판정", isMissingProfileVersionColumn({ message: "column \"profile_version\" does not exist" }) === true);
  ok("무관한 에러는 부재 아님(그대로 throw 되어야 함)", isMissingProfileVersionColumn({ code: "PGRST301", message: "JWT expired" }) === false);
  ok("에러 없음 → 부재 아님", isMissingProfileVersionColumn(null) === false);
  // 컬럼이 없으면 행에 profile_version 이 안 실린다 → 전부 세대 0 = 전량 백필 대상으로 보여야 함
  const legacyRows = [{ id: 1, status: "done", optimized_bytes: 9 }, { id: 2, status: "done", optimized_bytes: 3 }];
  ok("컬럼 부재 행(profile_version 없음) → 전량 대상으로 실측 가능", pickReencodeTargets(legacyRows, 10).length === 2);
}

console.log("\n── 10) 재인코딩 1건 처리 순서: 업로드 → posts 스왑 → job 마킹 (중간 실패 시 노출 영향 0) ──");
{
  const MB = 1024 * 1024;
  const JOB = {
    id: 1, post_id: 77,
    original_url: "https://x.supabase.co/storage/v1/object/public/photos/gif/clip.mov",
    optimized_url: "https://x.supabase.co/storage/v1/object/public/photos/transcoded/gif/clip-abcd1234.mp4",
    optimized_bytes: 15 * MB,
  };
  const PARSED = { bucket: "photos", path: "gif/clip.mov" };

  /** 주입 하네스: 각 단계 호출 순서를 기록하고 원하는 지점에서 실패를 주입한다. */
  function harness({ outBytes = 6 * MB, uploadError = null, swapThrows = false, markThrows = false, swapped = 1 } = {}) {
    const calls = [];
    const state = { uploadedPaths: [], jobFields: null, postsUrl: JOB.optimized_url };
    return {
      calls, state,
      deps: {
        parsed: PARSED, inPath: "/tmp/in.mov", outPath: "/tmp/out.mp4",
        storage: {
          from: () => ({
            upload: async (path, _body, opts) => {
              calls.push("upload");
              if (uploadError) return { error: uploadError };
              state.uploadedPaths.push({ path, upsert: opts.upsert });
              return { error: null };
            },
            getPublicUrl: (path) => ({ data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/photos/${path}` } }),
          }),
        },
        runner: {
          downloadToFile: async () => { calls.push("download"); return 20 * MB; },
          transcode: () => { calls.push("transcode"); },
          sizeOf: () => outBytes,
          readFile: () => Buffer.alloc(8),
        },
        swapVideoUrl: async (_postId, _from, to) => {
          calls.push("swap");
          if (swapThrows) throw new Error("swap 실패");
          state.postsUrl = to;
          return swapped;
        },
        markJob: async (_url, fields) => {
          calls.push("mark");
          if (markThrows) throw new Error("mark 실패");
          state.jobFields = fields;
        },
      },
    };
  }

  // (A) 정상 교체 — 순서와 부수효과 전부 확인
  {
    const h = harness();
    const res = await processReencodeJob(JOB, h.deps);
    ok("A: outcome=replaced", res.outcome === "replaced");
    ok("A: 호출 순서 = 업로드 → 스왑 → 마킹", JSON.stringify(h.calls) === JSON.stringify(["download", "transcode", "upload", "swap", "mark"]));
    ok("A: 새 버전 경로(-v2)에 업로드", h.state.uploadedPaths[0].path.endsWith(`-v${COMMUNITY_PROFILE_VERSION}.mp4`));
    ok("A: upsert:false — 기존 객체 바이트를 덮지 않음(CDN stale 방지 핵심)", h.state.uploadedPaths[0].upsert === false);
    ok("A: posts 가 새 URL 로 교체됨", h.state.postsUrl === res.newUrl && res.newUrl !== JOB.optimized_url);
    ok("A: job 이 현재 세대로 마킹됨(전진)", h.state.jobFields.profile_version === COMMUNITY_PROFILE_VERSION);
    ok("A: job optimized_url 도 새 URL", h.state.jobFields.optimized_url === res.newUrl);
  }

  // (B) 업로드 실패 → 스왑/마킹에 도달하지 않음 = 기존 URL 계속 서빙
  {
    const h = harness({ uploadError: { statusCode: "500", message: "boom" } });
    const res = await processReencodeJob(JOB, h.deps);
    ok("B: 업로드 실패 → outcome=failed", res.outcome === "failed");
    ok("B: posts 를 건드리지 않음(기존 URL 서빙 유지)", h.state.postsUrl === JOB.optimized_url);
    ok("B: 세대 마킹 없음 → 다음 실행 재시도", h.state.jobFields === null && !h.calls.includes("mark"));
  }

  // (C) 스왑 실패 → 마킹 안 됨. 새 객체는 올라갔지만 아무도 참조 안 함(고아) = 노출 영향 0
  {
    const h = harness({ swapThrows: true });
    const res = await processReencodeJob(JOB, h.deps);
    ok("C: 스왑 실패 → outcome=failed", res.outcome === "failed");
    ok("C: 마킹 도달 안 함 → 재시도 대상 유지", !h.calls.includes("mark"));
    ok("C: posts 는 여전히 기존 URL(중간 실패에도 노출 정상)", h.state.postsUrl === JOB.optimized_url);
  }

  // (D) 스왑 성공 후 마킹 실패 → 재시도 시 중복 업로드를 만나도 바이트를 덮지 않고 이어감
  {
    const h = harness({ markThrows: true });
    const res = await processReencodeJob(JOB, h.deps);
    ok("D: 마킹 실패 → outcome=failed(세대 미전진 → 재시도)", res.outcome === "failed");
    ok("D: posts 는 이미 새 URL — 새 객체가 서빙 중이라 유저 노출 정상", h.state.postsUrl !== JOB.optimized_url);

    const retry = harness({ uploadError: { statusCode: "409", message: "already exists" } });
    const res2 = await processReencodeJob(JOB, retry.deps);
    ok("D: 재시도 시 중복 업로드 → 덮어쓰기 없이 replaced 로 완주", res2.outcome === "replaced" && res2.reusedExisting === true);
    ok("D: 재시도가 기존 객체 바이트를 안 씀", retry.state.uploadedPaths.length === 0);
    ok("D: 재시도에서 세대 마킹 완료(전진)", retry.state.jobFields.profile_version === COMMUNITY_PROFILE_VERSION);
  }

  // (E) 절감 미미 → keep: 업로드/스왑을 아예 안 하고 세대만 마킹
  {
    const h = harness({ outBytes: 14.9 * MB }); // 서빙 15MB 대비 <5% 절감
    const res = await processReencodeJob(JOB, h.deps);
    ok("E: outcome=kept", res.outcome === "kept");
    ok("E: 업로드/스왑 안 함(무의미한 재업로드 방지)", !h.calls.includes("upload") && !h.calls.includes("swap"));
    ok("E: 그래도 세대 마킹은 함 — 다음 배치 슬롯 점유 방지", h.state.jobFields.profile_version === COMMUNITY_PROFILE_VERSION);
    ok("E: 용량/URL 필드는 안 건드림(기존 서빙본 메타 보존)", h.state.jobFields.optimized_url === undefined && h.state.jobFields.optimized_bytes === undefined);
  }

  // (F) posts 스왑 0건(게시글이 URL 을 이미 안 들고 있음) — 실패로 취급하지 않고 전진
  {
    const h = harness({ swapped: 0 });
    const res = await processReencodeJob(JOB, h.deps);
    ok("F: 스왑 0건이어도 replaced 로 전진(고아 job 무한 재시도 방지)", res.outcome === "replaced" && res.swapped === 0);
  }
}

console.log(`\n결과: ✅ ${pass} / ❌ ${fail}`);
if (fail > 0) process.exit(1);
