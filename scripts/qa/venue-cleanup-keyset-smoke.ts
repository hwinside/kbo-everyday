/**
 * 직관 라이브 cleanup referenced 집합 keyset pagination 회귀 스모크 — 삼순 09:44 #3·#4 (5).
 * 실행: npm run qa:venue-cleanup-keyset
 *  - offset(.range) 방식은 동시 insert/update 시 참조행 누락 → orphan 오삭제 위험.
 *  - keyset(id > lastId, id asc) 은 스캔 시작 시점에 존재하던 행을 절대 놓치지 않는다.
 */
import {
  collectReferencedPaths,
  type RefPageRow,
} from "../../src/lib/venue-stories/cleanup-policy";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

function row(id: number): RefPageRow {
  return {
    id,
    media_bucket: "videos",
    media_path: `venue-stories/G/u/${id}.mp4`,
    thumb_bucket: id % 2 === 0 ? "photos" : null,
    thumb_path: id % 2 === 0 ? `venue-stories/G/u/${id}.jpg` : null,
  };
}

/** id 오름차순 테이블 기반 fake pager (keyset 계약: id > afterId 순서대로 limit개) */
function pagerOf(table: () => RefPageRow[]) {
  return async (afterId: number, limit: number) =>
    table()
      .filter((r) => r.id > afterId)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
}

(async () => {
  console.log("[경계값 — 2000 / 2001행]");
  {
    const table = Array.from({ length: 2000 }, (_, i) => row(i + 1));
    const set = await collectReferencedPaths(pagerOf(() => table), 1000);
    ok("2000행(페이지 경계 정확히) 전부 수집", set != null && table.every((r) => set.has(`videos:${r.media_path}`)));
    ok("2000행 media+thumb 참조 수 일치", set != null && set.size === 2000 + 1000);
  }
  {
    const table = Array.from({ length: 2001 }, (_, i) => row(i + 1));
    const set = await collectReferencedPaths(pagerOf(() => table), 1000);
    ok("2001행(경계+1) 전부 수집", set != null && table.every((r) => set.has(`videos:${r.media_path}`)));
  }

  console.log("[동시 insert 안정성 — offset 누락 재현 불가 확인]");
  {
    // 스캔 시작 시점 1500행. 첫 페이지(1000) 처리 후 동시 insert 로 id 3000~3005 추가.
    // offset 방식이면 페이지 프레임이 밀려 기존 행 누락 가능 — keyset 은 기존 1500행 전부 보장.
    let table = Array.from({ length: 1500 }, (_, i) => row(i + 1));
    const initial = [...table];
    let pageCount = 0;
    const pager = async (afterId: number, limit: number) => {
      pageCount++;
      if (pageCount === 2) {
        table = [...table, row(3000), row(3001), row(3002), row(3003), row(3004), row(3005)];
      }
      return table
        .filter((r) => r.id > afterId)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit);
    };
    const set = await collectReferencedPaths(pager, 1000);
    ok(
      "스캔 중 동시 insert 에도 기존 1500행 참조 전부 수집(orphan 오삭제 방지)",
      set != null && initial.every((r) => set.has(`videos:${r.media_path}`)),
    );
  }

  console.log("[fault 계약]");
  {
    const set = await collectReferencedPaths(async () => null, 1000);
    ok("페이지 fault → null(호출부가 orphan 스캔 중단+관제)", set === null);
  }
  {
    let calls = 0;
    const set = await collectReferencedPaths(async (afterId, limit) => {
      calls++;
      if (calls === 2) return null; // 두 번째 페이지에서 fault
      return Array.from({ length: limit }, (_, i) => row(afterId + i + 1));
    }, 1000);
    ok("중간 페이지 fault 도 null(부분 집합으로 오삭제 금지)", set === null);
  }
  {
    const set = await collectReferencedPaths(async () => [], 1000);
    ok("빈 테이블 → 빈 집합", set != null && set.size === 0);
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
})();
