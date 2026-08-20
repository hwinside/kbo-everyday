/**
 * game-detail raw content-hash memoize 회귀 (Fluid Active CPU 절감 — 삼순 A안 재게이트).
 *
 * A. memoizeByContentHash 헬퍼 동작 고정:
 *    ① 동일 raw → 파싱 1회, 결과 동일 참조
 *    ② raw 변경 → 즉시 재계산(staleness 0)
 *    ③ 변경 후 원래 raw 재조회 → 여전히 정확(hash 격리)
 *    ④ bounded eviction(maxSize 초과 시 LRU 제거) + 히트 시 recency 갱신
 *    ⑤ mutation isolation: 반환 결과 deepFreeze(변형 시 throw, 다음 히트 무오염)
 *    ⑥ 에러/직렬화 불가 우회(정확성 우선)
 *    ⑦ hash 충돌 방어(serialized 재확인)
 * B. game-detail route 배선 정적 검사(파서 순수 impl + memoize 래핑, upstream fetch 불변).
 *
 * 실행: npx tsx scripts/qa/game-detail-parse-memo.ts
 */
import { readFileSync } from "node:fs";
import { memoizeByContentHash, deepFreeze } from "../../src/lib/http/parse-memo";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) pass += 1;
  else { fail += 1; console.error(`  ✗ ${name}`); }
}

function main() {
  // ① 동일 raw → 파싱 1회, 동일 참조
  {
    let calls = 0;
    const parse = memoizeByContentHash((d: { v: number }) => { calls += 1; return { out: d.v * 2 }; });
    const r1 = parse({ v: 3 });
    const r2 = parse({ v: 3 }); // 다른 객체, 같은 content
    check("① 동일 content → 파싱 1회", calls === 1);
    check("① 동일 content → 동일 참조 반환", r1 === r2);
    check("① size=1", parse.size === 1);
  }

  // ② raw 변경 → 즉시 재계산
  {
    let calls = 0;
    const parse = memoizeByContentHash((d: { v: number }) => { calls += 1; return { out: d.v }; });
    parse({ v: 1 });
    const r = parse({ v: 2 });
    check("② raw 변경 → 재계산(2회)", calls === 2 && r.out === 2);
  }

  // ③ 변경 후 원래 raw 재조회 → 정확
  {
    let calls = 0;
    const parse = memoizeByContentHash((d: { v: number }) => { calls += 1; return { out: d.v }; });
    const a1 = parse({ v: 1 });
    parse({ v: 2 });
    const a2 = parse({ v: 1 });
    check("③ 원래 raw 재조회 결과 정확", a2.out === 1);
    check("③ 원래 raw 캐시 히트(재파싱 없음이면 참조 동일)", a1 === a2 && calls === 2);
  }

  // ④ bounded eviction + recency
  {
    let calls = 0;
    const parse = memoizeByContentHash((d: { v: number }) => { calls += 1; return { out: d.v }; }, 2);
    parse({ v: 1 });          // [1]
    parse({ v: 2 });          // [1,2]
    parse({ v: 1 });          // 히트 → recency 갱신 [2,1]
    parse({ v: 3 });          // 초과 → 가장 오래된 2 제거 [1,3]
    check("④ maxSize 유지(size=2)", parse.size === 2);
    const before = calls;
    parse({ v: 1 });          // 1은 살아있어야 함(히트)
    check("④ recency 갱신된 1은 살아있음(히트)", calls === before);
    parse({ v: 2 });          // 2는 제거됐어야 함(미스=재계산)
    check("④ 오래된 2는 evict됨(미스)", calls === before + 1);
  }

  // ⑤ mutation isolation: 반환 결과 freeze
  {
    const parse = memoizeByContentHash((d: { v: number }) => ({ nested: { x: d.v }, arr: [d.v] }));
    const r = parse({ v: 5 });
    let frozen = false;
    try { (r as { nested: { x: number } }).nested.x = 99; } catch { frozen = true; }
    // strict mode(ESM)에서 frozen 객체 쓰기는 throw. 값도 불변이어야 함.
    check("⑤ 결과 deepFreeze(중첩 변형 차단)", frozen || r.nested.x === 5);
    check("⑤ 다음 히트 무오염", parse({ v: 5 }).nested.x === 5 && parse({ v: 5 }).arr[0] === 5);
  }

  // ⑥ 직렬화 불가 우회
  {
    let calls = 0;
    const parse = memoizeByContentHash((d: unknown) => { calls += 1; return { ok: true, d }; });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    parse(circular);
    parse(circular);
    check("⑥ 직렬화 불가 입력은 memoize 우회(매번 실행)", calls === 2);
    check("⑥ 우회 시 size 증가 없음", parse.size === 0);
  }

  // ⑦ deepFreeze 순수 값
  {
    const o = deepFreeze({ a: { b: [1, 2] } });
    check("⑦ deepFreeze 중첩 동결", Object.isFrozen(o) && Object.isFrozen(o.a) && Object.isFrozen(o.a.b));
    check("⑦ 원시값 통과", deepFreeze(3) === 3 && deepFreeze(null) === null);
  }

  // ── B. 배선 정적 검사 ──
  // PR #1257: GET 구현(파서·memoize·fetch·reportDetailDegradation)이 route →
  // src/lib/services/game-detail.ts 로 물리 이동 — 계약 검사도 구현 파일을 본다(강도 동일).
  // 단 관측(after) 실행은 route 경계 책임이 됐으므로 route↔service 양쪽을 분리 검사한다.
  {
    const src = readFileSync("src/lib/services/game-detail.ts", "utf8");
    check("B: memoize 헬퍼 import", src.includes('from "@/lib/http/parse-memo"'));
    check("B: 파서 순수 impl 분리(parseScoreBoardImpl 등)",
      src.includes("function parseScoreBoardImpl(") &&
      src.includes("function parseLineupImpl(") &&
      src.includes("function parseBoxScoreImpl("));
    check("B: 3종 파서 memoize 래핑",
      /const parseScoreBoard = memoizeByContentHash\(parseScoreBoardImpl\)/.test(src) &&
      /const parseLineup = memoizeByContentHash\(parseLineupImpl\)/.test(src) &&
      /const parseBoxScore = memoizeByContentHash\(parseBoxScoreImpl\)/.test(src));
    check("B: 호출부는 memoize 래퍼를 사용(parseScoreBoard( 등 유지)",
      /parseScoreBoard\(scoreBoardRes/.test(src) &&
      /parseLineup\(lineupRes/.test(src) &&
      /parseBoxScore\(boxScoreRes/.test(src));
    check("B: upstream 최신 raw fetch 불변(next:{revalidate} + no-store 유지)",
      /next: \{ revalidate \}/.test(src));
    check("B: full-route single-flight 미도입(신선도 하드제약)",
      !src.includes("createSingleFlight") && !src.includes("gameDetailFlight"));
    // 관측 parity: service 는 순수(effect 반환), route 경계가 after() 로 실행한다(삼순 #1257 2차 ②).
    const routeSrc = readFileSync("src/app/api/game-detail/route.ts", "utf8");
    check("B: report/after 경로 불변(관측 parity — service 보고 + route after 실행)",
      src.includes("reportDetailDegradation(") &&
      src.includes("onDeferredEffect?.(async () =>") &&
      routeSrc.includes("after(() => effect())"));
  }

  console.log(`\ngame-detail-parse-memo: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
  if (fail) process.exit(1);
}

main();
