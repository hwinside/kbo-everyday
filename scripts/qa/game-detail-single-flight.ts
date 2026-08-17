/**
 * game-detail in-flight single-flight 회귀 (Fluid Active CPU 절감).
 *
 * A. createSingleFlight 헬퍼 동작 고정:
 *    ① 동시 같은 key → factory 정확히 1회, 대기자 모두 같은 결과
 *    ② settle 후 재호출 → factory 재실행(= staleness 0, 낡은 결과 재사용 안 함)
 *    ③ 에러 공유 + settle 후 자가복구
 *    ④ key 격리(다른 key는 독립 실행)
 *    ⑤ size 관측: in-flight 중 증가, settle 후 0
 * B. game-detail route 배선 정적 검사.
 *
 * 실행: npx tsx scripts/qa/game-detail-single-flight.ts
 */
import { readFileSync } from "node:fs";
import { createSingleFlight } from "../../src/lib/http/single-flight";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) pass += 1;
  else { fail += 1; console.error(`  ✗ ${name}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function main() {
  // ① 동시 같은 key → factory 1회
  {
    const sf = createSingleFlight<number>();
    let calls = 0;
    const d = deferred<number>();
    const factory = () => { calls += 1; return d.promise; };
    const p1 = sf.run("k", factory);
    const p2 = sf.run("k", factory);
    check("① 동시 같은 key size=1", sf.size === 1);
    d.resolve(42);
    const [a, b] = await Promise.all([p1, p2]);
    check("① factory 정확히 1회 호출", calls === 1);
    check("① 대기자 모두 같은 결과", a === 42 && b === 42);
    await tick();
    check("① settle 후 size=0", sf.size === 0);
  }

  // ② settle 후 재호출 → factory 재실행(staleness 0)
  {
    const sf = createSingleFlight<number>();
    let calls = 0;
    const run = async (v: number) => {
      const d = deferred<number>();
      const p = sf.run("k", () => { calls += 1; return d.promise; });
      d.resolve(v);
      return p;
    };
    check("② 1차 결과", (await run(1)) === 1);
    await tick();
    check("② settle 후 2차는 새 factory 실행", (await run(2)) === 2 && calls === 2);
  }

  // ③ 에러 공유 + 자가복구
  {
    const sf = createSingleFlight<number>();
    let calls = 0;
    const d = deferred<number>();
    const p1 = sf.run("k", () => { calls += 1; return d.promise; });
    const p2 = sf.run("k", () => { calls += 1; return d.promise; });
    d.reject(new Error("boom"));
    let e1 = "", e2 = "";
    await p1.catch((e) => { e1 = (e as Error).message; });
    await p2.catch((e) => { e2 = (e as Error).message; });
    check("③ 에러 공유(대기자 모두 같은 에러) + factory 1회", e1 === "boom" && e2 === "boom" && calls === 1);
    await tick();
    check("③ 에러 settle 후 size=0(고정 안 됨)", sf.size === 0);
    const d2 = deferred<number>();
    const p3 = sf.run("k", () => { calls += 1; return d2.promise; });
    d2.resolve(7);
    check("③ 자가복구: 다음 호출은 새 factory 성공", (await p3) === 7 && calls === 2);
  }

  // ④ key 격리
  {
    const sf = createSingleFlight<string>();
    const da = deferred<string>();
    const db = deferred<string>();
    let aCalls = 0, bCalls = 0;
    const pa = sf.run("a", () => { aCalls += 1; return da.promise; });
    const pb = sf.run("b", () => { bCalls += 1; return db.promise; });
    check("④ 서로 다른 key size=2", sf.size === 2);
    da.resolve("A"); db.resolve("B");
    check("④ key별 독립 결과", (await pa) === "A" && (await pb) === "B" && aCalls === 1 && bCalls === 1);
  }

  // ⑤ 동기 throw도 rejection으로 정규화
  {
    const sf = createSingleFlight<number>();
    let caught = "";
    await sf.run("k", () => { throw new Error("sync"); }).catch((e) => { caught = (e as Error).message; });
    check("⑤ factory 동기 throw → rejection", caught === "sync");
    await tick();
    check("⑤ 동기 throw 후 size=0", sf.size === 0);
  }

  // ── B. game-detail route 배선 정적 검사 ──
  {
    const src = readFileSync("src/app/api/game-detail/route.ts", "utf8");
    check("B: single-flight 헬퍼 import", src.includes('from "@/lib/http/single-flight"'));
    check("B: 모듈 레벨 flight 인스턴스", /const gameDetailFlight = createSingleFlight<[^>]*>\(\);/.test(src));
    check("B: key = gameId|seasonId|srId",
      /const key = `\$\{gameId\}\|\$\{seasonId\}\|\$\{overrideSrId \?\? ""\}`/.test(src));
    check("B: GET이 flight.run으로 compute를 감쌈",
      /gameDetailFlight\.run\(\s*key,\s*\(\) => computeGameDetailData\(gameId, seasonId, overrideSrId\)/.test(src));
    check("B: per-request ETag/304 보존(성공 경로)",
      /if \(result\.isError\) return NextResponse\.json\(result\.data, \{ status: 200 \}\);\s*\n\s*return await jsonWithETag\(req, result\.data\);/.test(src));
    check("B: 계산부는 req 비의존 함수로 분리",
      /async function computeGameDetailData\(\s*gameId: string,\s*seasonId: string,\s*overrideSrId: string \| null,\s*\): Promise<DetailComputeResult>/.test(src));
    check("B: compute 내부에서 req.nextUrl 미사용(공유 안전)",
      !/computeGameDetailData[\s\S]*?req\.nextUrl/.test(src.slice(src.indexOf("async function computeGameDetailData"))));
  }

  console.log(`\ngame-detail-single-flight: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
  if (fail) process.exit(1);
}

void main();
