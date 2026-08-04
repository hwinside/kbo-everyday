/**
 * 직관 라이브 영상 즉시 검증(B+①) 회귀 스모크 — 삼순 09:44 #1·#4 (1)(2)(3).
 * 실행: npm run qa:venue-validate
 *  (1) 미검증 영상 비노출 → ffprobe 통과 즉시 공개(승격 CAS 전 active 불가)
 *  (2) 15초 초과 / ffprobe fault 거부·유지 계약
 *  (3) 즉시 경로 + 30분 recovery 중복 claim 방지(CAS)
 */
import {
  parseFfprobeJson,
  decideVideoVerdict,
  validateAndPromoteVideo,
  needsServerTranscode,
  SERVE_READY_MAX_EDGE_PX,
  SERVE_READY_MAX_BITRATE_BPS,
  type ValidateDeps,
  type FfprobeMeta,
  type ServeReadiness,
} from "../../src/lib/venue-stories/video-validate";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

const probeJson = (durSec: string, withVideo = true) =>
  JSON.stringify({
    streams: withVideo ? [{ codec_type: "video", width: 720, height: 1280 }] : [{ codec_type: "audio" }],
    format: { duration: durSec },
  });

console.log("[parseFfprobeJson — 구조 파싱]");
const m14 = parseFfprobeJson(probeJson("14.2"));
ok("정상 14.2s → durationMs 14200 + video stream", m14?.durationMs === 14200 && m14.hasVideoStream === true && m14.width === 720);
ok("garbage stdout → null(bad_structure)", parseFfprobeJson("not-json{{") === null);
ok("스트림 없음 → hasVideoStream=false", parseFfprobeJson(JSON.stringify({ format: { duration: "3" } }))?.hasVideoStream === false);
ok("duration 미상 → durationMs -1", parseFfprobeJson(JSON.stringify({ streams: [{ codec_type: "video" }], format: {} }))?.durationMs === -1);

console.log("[decideVideoVerdict — 서버 권위 15초 계약]");
ok("14s → ok", decideVideoVerdict(parseFfprobeJson(probeJson("14.0"))).ok === true);
ok("15.999s(톨러런스 내) → ok", decideVideoVerdict(parseFfprobeJson(probeJson("15.999"))).ok === true);
const v16 = decideVideoVerdict(parseFfprobeJson(probeJson("16.001")));
ok("16.001s → duration_exceeded 거부", v16.ok === false && !v16.ok && v16.reason === "duration_exceeded");
const vNoStream = decideVideoVerdict(parseFfprobeJson(probeJson("5", false)));
ok("video stream 없음 → no_video_stream 거부", vNoStream.ok === false && !vNoStream.ok && vNoStream.reason === "no_video_stream");
const vBad = decideVideoVerdict(null);
ok("구조 불량(null meta) → bad_structure 거부", vBad.ok === false && !vBad.ok && vBad.reason === "bad_structure");
const vNoDur = decideVideoVerdict({ durationMs: -1, width: 1, height: 1, hasVideoStream: true });
ok("duration 미상 → bad_structure 거부(클라 힌트 불신)", vNoDur.ok === false && !vNoDur.ok && vNoDur.reason === "bad_structure");

// ── 오케스트레이션 fake deps ──
interface Log { calls: string[]; }
function makeDeps(opts: {
  probe: FfprobeMeta | null | "fault";
  downloadOk?: boolean;
  publishOk?: boolean;
  promoteResult?: boolean | "fault";
  rejectResult?: boolean | "fault";
  readiness?: ServeReadiness;
}): { deps: ValidateDeps; log: Log } {
  const log: Log = { calls: [] };
  const deps: ValidateDeps = {
    async download(b, p) {
      log.calls.push(`download:${b}:${p}`);
      return opts.downloadOk === false ? null : { filePath: "/tmp/fake", bytes: 1000 };
    },
    async probe() {
      log.calls.push("probe");
      return opts.probe;
    },
    async publishOriginal(p) {
      log.calls.push(`publish:${p}`);
      return opts.publishOk !== false;
    },
    async inspectServeReadiness() {
      log.calls.push("inspectServeReadiness");
      return opts.readiness ?? { fastStart: true, maxEdge: 1280 };
    },
    async promoteRow(id, _meta, o) {
      log.calls.push(`promote:${id}:needsTranscode=${o.needsTranscode}`);
      return opts.promoteResult ?? true;
    },
    async rejectRow(id) {
      log.calls.push(`reject:${id}`);
      return opts.rejectResult ?? true;
    },
    async removeObject(b, p) {
      log.calls.push(`remove:${b}:${p}`);
    },
    cleanupTemp() {
      log.calls.push("cleanupTemp");
    },
  };
  return { deps, log };
}

const ROW = { id: 7, media_bucket: "venue-staging", media_path: "venue-stories/G/u/1.mp4" };
const okMeta: FfprobeMeta = { durationMs: 12000, width: 720, height: 1280, hasVideoStream: true };

(async () => {
  console.log("[(1) pending → ffprobe 통과 즉시 공개 — 승격 순서 불변식]");
  {
    const { deps, log } = makeDeps({ probe: okMeta });
    const r = await validateAndPromoteVideo(deps, ROW);
    ok("통과 → promoted", r.outcome === "promoted");
    const pubIdx = log.calls.findIndex((c) => c.startsWith("publish"));
    const promIdx = log.calls.findIndex((c) => c.startsWith("promote"));
    ok("공개 게시(publish)가 CAS 승격(promote)보다 먼저", pubIdx >= 0 && promIdx > pubIdx);
    ok("승격 후 staging 원본 정리", log.calls.includes("remove:venue-staging:venue-stories/G/u/1.mp4"));
  }
  {
    const { deps, log } = makeDeps({ probe: { ...okMeta, durationMs: 20000 } });
    const r = await validateAndPromoteVideo(deps, ROW);
    ok("거부 시 publish/promote 미호출(비노출 유지)", r.outcome === "rejected" && !log.calls.some((c) => c.startsWith("publish") || c.startsWith("promote")));
  }

  console.log("[(2) 초과/fault 계약]");
  {
    const { deps, log } = makeDeps({ probe: { ...okMeta, durationMs: 16001 } });
    const r = await validateAndPromoteVideo(deps, ROW);
    ok("16.001s → rejected(duration_exceeded) + reject CAS", r.outcome === "rejected" && r.outcome === "rejected" && r.reason === "duration_exceeded" && log.calls.includes("reject:7"));
    ok("거부 후 staging 정리", log.calls.some((c) => c.startsWith("remove:venue-staging")));
  }
  {
    const { deps, log } = makeDeps({ probe: null });
    const r = await validateAndPromoteVideo(deps, ROW);
    ok("구조 불량 → rejected(bad_structure)", r.outcome === "rejected" && r.reason === "bad_structure");
    ok("구조 불량도 노출 없음", !log.calls.some((c) => c.startsWith("publish")));
  }
  {
    const { deps, log } = makeDeps({ probe: "fault" });
    const r = await validateAndPromoteVideo(deps, ROW);
    ok("ffprobe 실행 불가 → fault(검증 약화 금지, pending 유지)", r.outcome === "fault");
    ok("fault 시 reject/promote 미호출(removed 로 오판 금지)", !log.calls.some((c) => c.startsWith("reject") || c.startsWith("promote")));
  }
  {
    const { deps } = makeDeps({ probe: okMeta, downloadOk: false });
    const r = await validateAndPromoteVideo(deps, ROW);
    ok("다운로드 fault → fault(pending 유지 → 복구 워커)", r.outcome === "fault");
  }
  {
    const { deps } = makeDeps({ probe: okMeta, publishOk: false });
    const r = await validateAndPromoteVideo(deps, ROW);
    ok("공개 게시 fault → fault(절대 active 승격 없음)", r.outcome === "fault");
  }

  console.log("[(3) 즉시 + 30분 recovery 중복 claim 방지(CAS)]");
  {
    const { deps, log } = makeDeps({ probe: okMeta, promoteResult: false });
    const r = await validateAndPromoteVideo(deps, ROW);
    ok("promote CAS 패배 → already_claimed(중복 승격 없음)", r.outcome === "already_claimed");
    ok("CAS 패배 시 공개 객체 생존(삭제 금지, 불변식: status=active→publicExists=true)", !log.calls.includes("remove:videos:venue-stories/G/u/1.mp4"));
    ok("CAS 패배 시 staging 원본은 승자에게 위임(미삭제)", !log.calls.includes("remove:venue-staging:venue-stories/G/u/1.mp4"));
  }
  {
    const { deps } = makeDeps({ probe: { ...okMeta, durationMs: 99999 }, rejectResult: false });
    const r = await validateAndPromoteVideo(deps, ROW);
    ok("reject CAS 패배 → already_claimed", r.outcome === "already_claimed");
  }
  {
    // 동시 2회 검증 시뮬레이션: 공유 상태에서 첫 CAS 만 성공
    let status = "pending";
    const publicRemovals: string[] = [];
    const casPromote = async () => {
      if (status !== "pending") return false;
      status = "active";
      return true;
    };
    const mk = () => {
      const { deps } = makeDeps({ probe: okMeta });
      deps.promoteRow = casPromote;
      // publicBucket("videos") removeObject 호출을 추적 — loser가 삭제하면 안 됨
      deps.removeObject = async (b, p) => {
        if (b === "videos") publicRemovals.push(p);
      };
      return deps;
    };
    const [a, b] = await Promise.all([
      validateAndPromoteVideo(mk(), ROW),
      validateAndPromoteVideo(mk(), ROW),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    ok("동시 검증 2회 → promoted 1 + already_claimed 1", outcomes[0] === "already_claimed" && outcomes[1] === "promoted" && status === "active");
    ok("동시성 공개 객체 최종 생존 — loser가 publicBucket 삭제 안 함(불변식)", publicRemovals.length === 0);
  }

  // ── 후속 최적화 큐(needs_transcode) 서버 실측 판정 (삼순 NO-GO ③) ──
  // 사고: 클라이언트 정규화가 실패하면 느린 원본이 올라가는데, 종전에는 needs_transcode 가
  // promoteStatus === "active" 로 **경로별 고정**이라 diary_manual(archived) 은 영구히 미최적화로
  // 종결됐다. 이젠 서버가 바이트/ffprobe 실측값으로 판정한다.
  console.log("[(4) 후속 최적화 큐 — 서버 실측 판정]");
  {
    const ready: ServeReadiness = { fastStart: true, maxEdge: 1280 };
    // 8초 3.5MB ≈ 3.5Mbps — 정규화 성공본의 실측 프로필
    ok(
      "정규화 성공본(720p·faststart·3.5Mbps) → 큐 불필요",
      needsServerTranscode({ readiness: ready, bytes: 3_625_733, durationMs: 8_000 }) === false,
    );
    // 실측 s847: 12.98초 38.6MB, moov 끝, 1920x1080
    ok(
      "실측 s847(faststart 아님) → 큐 필요",
      needsServerTranscode({
        readiness: { fastStart: false, maxEdge: 1920 },
        bytes: 38_560_432,
        durationMs: 12_978,
      }) === true,
    );
    ok(
      "faststart 이어도 긴변 1920 → 큐 필요",
      needsServerTranscode({
        readiness: { fastStart: true, maxEdge: 1920 },
        bytes: 3_000_000,
        durationMs: 8_000,
      }) === true,
    );
    ok(
      `faststart + 720p 여도 비트레이트 과다(>${SERVE_READY_MAX_BITRATE_BPS}bps) → 큐 필요`,
      needsServerTranscode({
        readiness: { fastStart: true, maxEdge: SERVE_READY_MAX_EDGE_PX },
        bytes: 20_025_217,
        durationMs: 7_978,
      }) === true,
    );
    ok(
      "faststart 미상(null) → fail-close 로 큐 필요",
      needsServerTranscode({
        readiness: { fastStart: null, maxEdge: 720 },
        bytes: 1_000_000,
        durationMs: 8_000,
      }) === true,
    );
    ok(
      "해상도 미상(null) → fail-close 로 큐 필요",
      needsServerTranscode({
        readiness: { fastStart: true, maxEdge: null },
        bytes: 1_000_000,
        durationMs: 8_000,
      }) === true,
    );
    ok(
      "duration 0 → 비트레이트 계산 불가 → 큐 필요",
      needsServerTranscode({ readiness: ready, bytes: 1_000_000, durationMs: 0 }) === true,
    );
  }
  {
    // 오케스트레이션 결속 — readiness 가 promoteRow 의 needsTranscode 로 실제 전달되는가
    const slow = makeDeps({
      probe: okMeta,
      readiness: { fastStart: false, maxEdge: 1920 },
    });
    await validateAndPromoteVideo(slow.deps, ROW);
    ok(
      "느린 원본 → promoteRow(needsTranscode=true) 로 큐에 올라간다",
      slow.log.calls.includes("promote:7:needsTranscode=true"),
    );
    ok(
      "readiness 실측이 promote 앞에 수행된다",
      slow.log.calls.indexOf("inspectServeReadiness") <
        slow.log.calls.findIndex((c) => c.startsWith("promote:")),
    );
    const fast = makeDeps({ probe: okMeta, readiness: { fastStart: true, maxEdge: 720 } });
    await validateAndPromoteVideo(fast.deps, ROW);
    ok(
      "이미 최적화된 영상 → promoteRow(needsTranscode=false) — 불필요한 재인코딩 안 한다",
      fast.log.calls.includes("promote:7:needsTranscode=false"),
    );
  }

  // ── (5) **실제 배포되는 서버 deps** 검증 ──
  // 위 (4)는 fake deps 만 봤기 때문에, video-validate-server.ts 의 needs_transcode 를 종전처럼
  // `promoteStatus === "active"` 로 되돌려도 GREEN 이었다(삼순 ①과 같은 유형의 false-green —
  // 자체 mutation 으로 직접 잡았다). 여기서는 실제 realDeps 를 로드해
  // "promoteRow 가 서버 실측값(needsTranscode)을 그대로 쓰는가"를 supabase 호출 직전까지 추적한다.
  console.log("[(5) 실배선 검증 — video-validate-server realDeps]");
  {
    process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://smoke.invalid";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "smoke-anon-key";
    const { __qaRealDeps } = await import("../../src/lib/venue-stories/video-validate-server");
    const { supabaseAdmin } = await import("../../src/lib/supabase/admin");

    // supabase.from(...).update(payload) 의 payload 를 가로채서 실제 기록값을 읽는다.
    const captured: Record<string, unknown>[] = [];
    const admin = supabaseAdmin as unknown as { from: (t: string) => unknown };
    const originalFrom = admin.from.bind(supabaseAdmin);
    admin.from = (table: string) => {
      if (table !== "venue_stories") return originalFrom(table);
      const chain = {
        update(payload: Record<string, unknown>) {
          captured.push(payload);
          return chain;
        },
        eq: () => chain,
        select: async () => ({ data: [{ id: 7 }], error: null }),
      };
      return chain;
    };

    try {
      for (const promoteStatus of ["active", "archived"] as const) {
        for (const needsTranscode of [true, false]) {
          captured.length = 0;
          const deps = __qaRealDeps(promoteStatus);
          const r = await deps.promoteRow(7, okMeta, { needsTranscode });
          ok(
            `realDeps(${promoteStatus}) promoteRow(needsTranscode=${needsTranscode}) → CAS 성공`,
            r === true,
          );
          ok(
            `realDeps(${promoteStatus}) 가 needs_transcode=${needsTranscode} 를 그대로 기록(경로별 고정값 아님)`,
            captured.length === 1 && captured[0].needs_transcode === needsTranscode,
          );
        }
      }
      // 종전 버그 재현 방지의 핵심: archived + 느린 원본이 큐에 올라가야 한다
      captured.length = 0;
      await __qaRealDeps("archived").promoteRow(7, okMeta, { needsTranscode: true });
      ok(
        "diary_manual(archived) 느린 영상도 needs_transcode=true — 영구 미최적화 종결 안 된다",
        captured.length === 1 && captured[0].needs_transcode === true,
      );

      // inspectServeReadiness 가 실제 파일 바이트를 읽는지(박스 순서 판정)
      const fsMod = await import("node:fs/promises");
      const osMod = await import("node:os");
      const pathMod = await import("node:path");
      const mkBox = (type: string, size: number) => {
        const b = Buffer.alloc(8);
        b.writeUInt32BE(size, 0);
        b.write(type, 4, "latin1");
        return b;
      };
      const tmpDir = await fsMod.mkdtemp(pathMod.join(osMod.tmpdir(), "venue-validate-smoke-"));
      const fastPath = pathMod.join(tmpDir, "fast.mp4");
      const slowPath = pathMod.join(tmpDir, "slow.mp4");
      await fsMod.writeFile(
        fastPath,
        Buffer.concat([mkBox("ftyp", 20), Buffer.alloc(12), mkBox("moov", 8), mkBox("mdat", 8)]),
      );
      await fsMod.writeFile(
        slowPath,
        Buffer.concat([mkBox("ftyp", 20), Buffer.alloc(12), mkBox("mdat", 4096)]),
      );
      const deps = __qaRealDeps("active");
      const rFast = await deps.inspectServeReadiness(fastPath, okMeta);
      const rSlow = await deps.inspectServeReadiness(slowPath, okMeta);
      const rMissing = await deps.inspectServeReadiness(
        pathMod.join(tmpDir, "nope.mp4"),
        okMeta,
      );
      ok("realDeps inspectServeReadiness: moov 선행 파일 → fastStart=true", rFast.fastStart === true);
      ok("realDeps inspectServeReadiness: mdat 선행 파일 → fastStart=false", rSlow.fastStart === false);
      ok("realDeps inspectServeReadiness: 읽기 실패 → null(fail-close 입력)", rMissing.fastStart === null);
      ok(
        "realDeps inspectServeReadiness: maxEdge 가 ffprobe 메타에서 도출",
        rFast.maxEdge === Math.max(okMeta.width!, okMeta.height!),
      );
      await fsMod.rm(tmpDir, { recursive: true, force: true });
    } finally {
      admin.from = originalFrom as typeof admin.from;
    }
  }

  // P0 #2 transcode worker CAS 불변식은 venue-transcode-worker-smoke.ts(processVenueJob 실제 실행)로 이전.
  // simulateCatchCas / simulateTranscodeCas 조건 복사 제거 — 실제 함수 실행으로 대체.

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
})();
