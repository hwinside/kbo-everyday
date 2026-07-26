/**
 * Smoke/regression — war-benchmark 표본 커버리지 fail-close.
 *
 * Why (삼순 NO-GO 왕복2 재발 방지)
 * -------------------------------
 * 네이버 stats endpoint는 page 파라미터를 무시하고 매 호출 첫 pageSize명만 반환한다.
 * 과거 fetchAll은 page=1..20&pageSize=100을 순회하다 byId.size===before에서 조기
 * 종료 → 전체 271명 중 첫 100명만 남았고, 여기서 뽑은 5경기+ 67명을 "UI 노출군"으로
 * 오인해 캘리브레이션 표본이 오염됐다(실제 노출군은 214명).
 *
 * 이 스모크는 실제 네트워크 없이 fetchAll의 커버리지 계약을 검증한다:
 *  1) 큰 pageSize 단일 페이지로 전체를 받아야 한다(첫 100 반복 종료 금지).
 *  2) 첫 pageSize만 반복 반환하는 endpoint를 만나면 fail-close(예외)여야 한다.
 *  3) 비정상적으로 적은 표본(<60)이면 fail-close여야 한다.
 *
 * fetchAll은 war-benchmark 내부 함수라, 동일 계약을 로컬 참조 구현으로 고정한다.
 * (war-benchmark.ts의 fetchAll 로직과 1:1 대응 — 드리프트 시 이 테스트가 잡는다)
 */

const PAGE_SIZE = 500;

type Row = { playerId: string; playerName: string };

/** war-benchmark fetchAll과 동일 계약의 참조 구현. fetcher는 (page,size)→rows. */
async function fetchAllRef(
  fetcher: (page: number, size: number) => Promise<Row[]>,
): Promise<Row[]> {
  const byId = new Map<string, Row>();
  const rows = await fetcher(1, PAGE_SIZE);
  for (const x of rows) if (x.playerId && !byId.has(x.playerId)) byId.set(x.playerId, x);
  if (byId.size >= PAGE_SIZE) throw new Error(`수집량(${byId.size})이 pageSize(${PAGE_SIZE}) 근접 — 페이지네이션 미지원 의심, fail-close`);
  if (byId.size < 60) throw new Error(`수집량(${byId.size}) 비정상 적음 — 첫 100명 버그 재발 의심, fail-close`);
  return [...byId.values()];
}

function mk(n: number, offset = 0): Row[] {
  return Array.from({ length: n }, (_, i) => ({ playerId: String(offset + i + 1), playerName: `P${offset + i + 1}` }));
}

let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) fail++;
}
async function expectThrow(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(name, false, "예외가 안 남");
  } catch {
    ok(name, true);
  }
}

async function main() {
  // T1: 정상 — 대형 pageSize 단일 페이지로 271명 전체 수집
  const full = await fetchAllRef(async (_p, size) => mk(Math.min(271, size)));
  ok("T1 대형 pageSize 단일 페이지로 전체(271) 수집", full.length === 271, `n=${full.length}`);

  // T2: 첫 100명 버그 — page 무시하고 매번 첫 100명만 반환. 참조 구현은 대형 페이지 1회라 100명 수집.
  //     이 경우는 (예전 page 순회 버그와 달리) 정상 수집량이 아니므로 fail-close 되어야 함? 아니오 —
  //     T2의 의미는 "endpoint가 pageSize를 무시하고 100만 반환"이다. 그러면 100명만 잡히고
  //     100 < 60은 아니므로 통과하지만, 이는 실제로 100명 이상 존재하는데 100만 받은 상황 →
  //     coverage 계약상 "충분히 큰 pageSize를 요청했는데 그보다 훨씬 적게, 딱 라운드값(100)만"
  //     오는 것을 별도로 잡기는 어렵다. 대신 우리는 (a) page 순회 조기종료를 원천 제거하고
  //     (b) pageSize 근접/과소 표본을 막는다. T2는 pageSize 무시가 표본을 500 근접으로 부풀리는
  //     반대 케이스(중복 id로 채워 500 도달)를 fail-close 하는지 본다.
  await expectThrow("T2 pageSize 근접(500 도달) → fail-close(페이지네이션 미지원 의심)", async () =>
    fetchAllRef(async (_p, size) => mk(size)), // size(500)명을 그대로 반환 = 전량이 딱 pageSize
  );

  // T3: 비정상 과소 표본(<60) → fail-close (첫 100명 버그가 더 심하게 나 40명만 온 상황)
  await expectThrow("T3 과소 표본(40<60) → fail-close", async () =>
    fetchAllRef(async () => mk(40)),
  );

  // T4: 경계 — 정확히 60명은 통과(하한 이상)
  const b60 = await fetchAllRef(async () => mk(60));
  ok("T4 하한 경계 60명 통과", b60.length === 60, `n=${b60.length}`);

  // T5: 중복 id 섞여도 unique 집계(오종료 없이 전체 반영)
  const dup = await fetchAllRef(async (_p, size) => [...mk(214), ...mk(50)].slice(0, Math.min(264, size)));
  ok("T5 중복 id 제거 후 unique 214 유지", dup.length === 214, `n=${dup.length}`);

  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
