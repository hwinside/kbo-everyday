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
  type ValidateDeps,
  type FfprobeMeta,
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
    async promoteRow(id) {
      log.calls.push(`promote:${id}`);
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

  // ── P0 #2 transcode worker resurrect 방지 CAS 불변식 ──
  // transcode-videos.mjs update 조건 모사:
  //   .eq("status", expectedStatus).eq("needs_transcode", true)
  //   active 경로는 status를 payload에 포함하지 않음 → removed 상태 보존
  function simulateTranscodeCas(opts: {
    rowStatus: string;
    rowNeedsTranscode: boolean;
    isPending: boolean;
  }): { rowsAffected: number; statusInPayload: boolean } {
    const expectedStatus = opts.isPending ? "pending" : "active";
    const rowsAffected = (opts.rowStatus === expectedStatus && opts.rowNeedsTranscode) ? 1 : 0;
    return { rowsAffected, statusInPayload: opts.isPending };
  }

  console.log("[P0 #2 transcode worker resurrect 방지 CAS 불변식]");
  {
    const r = simulateTranscodeCas({ rowStatus: "removed", rowNeedsTranscode: true, isPending: false });
    ok("active 경로 — removed 행 → 0-row(resurrect 금지)", r.rowsAffected === 0);
    ok("active 경로 — status 페이로드 미포함(재기록 금지)", r.statusInPayload === false);
  }
  {
    const r = simulateTranscodeCas({ rowStatus: "active", rowNeedsTranscode: false, isPending: false });
    ok("active 경로 — needs_transcode=false 이미 완료 → 0-row(중복 방지)", r.rowsAffected === 0);
  }
  {
    const r = simulateTranscodeCas({ rowStatus: "active", rowNeedsTranscode: true, isPending: false });
    ok("active 경로 — active+needs_transcode=true → 1-row(정상 교체)", r.rowsAffected === 1);
  }
  {
    const r = simulateTranscodeCas({ rowStatus: "removed", rowNeedsTranscode: true, isPending: true });
    ok("pending 경로 — removed 행 → 0-row(resurrect 금지)", r.rowsAffected === 0);
  }
  {
    const r = simulateTranscodeCas({ rowStatus: "pending", rowNeedsTranscode: true, isPending: true });
    ok("pending 경로 — 정상 복구 → 1-row + status:active 페이로드", r.rowsAffected === 1 && r.statusInPayload === true);
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
})();
