/**
 * 커뮤니티 투표 목록 카드 실행형 회귀 (spec §6, S3).
 *
 * 삼순 2차 재리뷰 P1 반영:
 *   1) 무한피드 누적 id ↔ summaries 100개 상한 충돌 — chunkSummaryIds 로 101개+ 전량 커버.
 *   2) 마감 배지 경계 전환 — pollBoundaryTimer / isPollEffectiveClosed 순수 함수 회귀.
 *
 * 순수 함수만 검증(브라우저/DOM 불요). route 도달성·hidden·득표수·100-cap 은 poll-route-e2e.
 */
import "./_smoke-env"; // supabase client 싱글톤(poll-client 트랜지티브 로드)이 env 요구 → 더미 선주입
import { chunkSummaryIds, SUMMARIES_CHUNK } from "../../src/lib/community/poll-client";
import { isPollEffectiveClosed, pollBoundaryTimer } from "../../src/components/community/PollCardBody";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

// ---------- 1) chunkSummaryIds: 무한피드 100개 상한 커버 ----------
{
  const ids0 = chunkSummaryIds([]);
  ok("빈 입력 → chunk 0개", ids0.length === 0);

  const ids50 = chunkSummaryIds(Array.from({ length: 50 }, (_, i) => i + 1));
  ok("50개 → 단일 chunk", ids50.length === 1 && ids50[0].length === 50);

  const ids100 = chunkSummaryIds(Array.from({ length: 100 }, (_, i) => i + 1));
  ok("100개 경계 → 단일 chunk", ids100.length === 1 && ids100[0].length === 100);

  const src101 = Array.from({ length: 101 }, (_, i) => i + 1);
  const ids101 = chunkSummaryIds(src101);
  ok("101개 → 2 chunk(100+1)", ids101.length === 2 && ids101[0].length === 100 && ids101[1].length === 1);
  const flat101 = ids101.flat();
  ok("101개 전량 커버(101번째 포함)", flat101.length === 101 && flat101.includes(101));

  const src250 = Array.from({ length: 250 }, (_, i) => i + 1);
  const ids250 = chunkSummaryIds(src250);
  ok("250개 → 3 chunk(100/100/50)", ids250.length === 3 && ids250.every((c) => c.length <= SUMMARIES_CHUNK));
  ok("250개 각 chunk ≤100", ids250.flat().length === 250);

  // 중복·비유효 제거
  const dedup = chunkSummaryIds([1, 1, 2, -3, 0, NaN as unknown as number, 4]);
  ok("중복·비유효 제거 후 chunk", JSON.stringify(dedup) === JSON.stringify([[1, 2, 4]]));
}

// ---------- 2) 마감 경계: isPollEffectiveClosed / pollBoundaryTimer ----------
{
  const now = Date.parse("2026-07-28T12:00:00Z");
  const future = new Date(now + 3600_000).toISOString(); // +1h
  const past = new Date(now - 1000).toISOString(); // 이미 지남
  const far = new Date(now + 10 * 86400_000).toISOString(); // +10일

  ok("server closed=true → effectiveClosed", isPollEffectiveClosed({ closed: true, closesAt: future }, now));
  ok("진행중(미래 마감) → not closed", !isPollEffectiveClosed({ closed: false, closesAt: future }, now));
  ok("경계 도달(과거 마감) → effectiveClosed", isPollEffectiveClosed({ closed: false, closesAt: past }, now));

  ok("closed poll timer → kind closed", pollBoundaryTimer({ closed: true, closesAt: future }, now).kind === "closed");
  {
    const t = pollBoundaryTimer({ closed: false, closesAt: past }, now);
    ok("이미 마감 → fire(ms 0)", t.kind === "fire" && t.ms === 0);
  }
  {
    const t = pollBoundaryTimer({ closed: false, closesAt: future }, now);
    ok("1h 뒤 마감 → fire(경계+250ms)", t.kind === "fire" && t.ms === 3600_000 + 250);
  }
  {
    const t = pollBoundaryTimer({ closed: false, closesAt: far }, now);
    ok("10일 뒤 마감 → hop(6h 재예약, setTimeout 상한 회피)", t.kind === "hop" && t.ms === 6 * 60 * 60 * 1000);
  }
}

console.log(`\npoll card smoke: ${pass} PASS${fail ? `, ${fail} FAIL` : ""}`);
if (fail) process.exit(1);
