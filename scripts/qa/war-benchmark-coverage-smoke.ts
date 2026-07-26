/**
 * Smoke/regression — war-benchmark 표본 커버리지 fail-close.
 *
 * Why (삼순 NO-GO 왕복2·3 재발 방지)
 * -----------------------------------
 * 네이버 stats endpoint는 page 파라미터를 무시하고 매 호출 첫 pageSize명만 반환한다.
 * 과거 fetchAll은 page=1..20&pageSize=100을 순회하다 byId.size===before에서 조기
 * 종료 → 전체 271명 중 첫 100명만 남았고, 여기서 뽑은 5경기+ 67명을 "UI 노출군"으로
 * 오인해 캘리브레이션 표본이 오염됐다(실제 노출군은 214명).
 *
 * 이 스모크는 production 함수 `collectNaverPlayers`를 직접 import해(복제 아님)
 * fetcher를 주입하여 커버리지 계약을 고정한다:
 *  1) 대형 단일 페이지로 전체(271)를 받으면 정상.
 *  2) endpoint가 pageSize를 무시하고 첫 100명만 반환하면 fail-close(예외) — 핵심 계약.
 *  3) pageSize에 꽉 차게(500) 반환하면 fail-close(더 큰 pageSize 필요).
 *  4) type별 최소 coverage(150) 미달이면 fail-close.
 *  5) 중복 id는 dedup 후 unique 집계.
 */

import { collectNaverPlayers, NAVER_PAGE_SIZE, NAVER_MIN_COVERAGE } from "../war-benchmark";

type Row = { playerId: string; playerName: string };

function mk(n: number, offset = 0): Row[] {
  return Array.from({ length: n }, (_, i) => ({ playerId: String(offset + i + 1), playerName: `P${offset + i + 1}` }));
}

let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) fail++;
}
async function expectThrow(name: string, fn: () => Promise<unknown>, mustMatch?: RegExp) {
  try {
    await fn();
    ok(name, false, "예외가 안 남");
  } catch (e) {
    const msg = (e as Error).message;
    ok(name, mustMatch ? mustMatch.test(msg) : true, mustMatch ? `msg="${msg.slice(0, 60)}"` : "");
  }
}

async function main() {
  // T1: 정상 — 대형 pageSize 단일 페이지로 271명 전체 수집
  const full = await collectNaverPlayers<Row>("PITCHER", async (_p, size) => mk(Math.min(271, size)));
  ok("T1 대형 pageSize 단일 페이지로 전체(271) 수집", full.length === 271, `n=${full.length}`);

  // T2 (핵심): endpoint가 pageSize=500을 무시하고 첫 100명만 반환 → fail-close 여야 한다.
  //     (과거 버그: 100명은 <60이 아니므로 예전 가드는 통과시켰다 → 이번엔 최소 coverage 150으로 거부)
  await expectThrow(
    "T2 첫 100명만 반환(pageSize 무시) → fail-close",
    () => collectNaverPlayers<Row>("PITCHER", async () => mk(100)),
    /coverage|100/,
  );

  // T3: pageSize 근접(500 도달) → fail-close(더 큰 pageSize 필요)
  await expectThrow(
    "T3 pageSize 근접(500) → fail-close",
    () => collectNaverPlayers<Row>("PITCHER", async (_p, size) => mk(size)),
    /pageSize|근접/,
  );

  // T4: type별 최소 coverage(150) 경계 — 149 실패 / 150 통과
  await expectThrow(
    "T4a 149명(<최소 150) → fail-close",
    () => collectNaverPlayers<Row>("HITTER", async () => mk(149)),
  );
  const b150 = await collectNaverPlayers<Row>("HITTER", async () => mk(150));
  ok("T4b 최소 coverage 경계 150명 통과", b150.length === 150, `n=${b150.length}`);

  // T5: 중복 id 섞여도 unique 집계(오종료 없이 전체 반영)
  const dup = await collectNaverPlayers<Row>("PITCHER", async (_p, size) => [...mk(214), ...mk(50)].slice(0, Math.min(264, size)));
  ok("T5 중복 id 제거 후 unique 214 유지", dup.length === 214, `n=${dup.length}`);

  // T6: 상수 계약 노출 확인(드리프트 방지)
  ok("T6 NAVER_PAGE_SIZE=500 · 최소 coverage 150", NAVER_PAGE_SIZE === 500 && NAVER_MIN_COVERAGE.PITCHER >= 150 && NAVER_MIN_COVERAGE.HITTER >= 150,
    `pageSize=${NAVER_PAGE_SIZE} min=${JSON.stringify(NAVER_MIN_COVERAGE)}`);

  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
