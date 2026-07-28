/**
 * AI 경기요약 생성 single-flight(lease) DB 통합 테스트 (PGlite 격리 Postgres).
 * 20260726 fence + 20260728 single-flight lease 를 실제 적용해, 동일 gameId 동시 요청이
 * livelock 되지 않고 활성 생성 1개만 진행됨 / winner 저장 성공 / lease 해제·만료·인수를 검증한다.
 * 실행: npm run qa:game-summary-singleflight:db
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

function migration(name: string) {
  return readFileSync(resolve("supabase/migrations", name), "utf8");
}

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  ✗ " + name);
  }
}

async function claim(db: PGlite, gameId: string): Promise<number | null> {
  const r = await db.query<{ t: string | number | null }>(
    "select public.claim_game_summary_generation($1) as t",
    [gameId],
  );
  const t = r.rows[0]?.t;
  return t == null ? null : Number(t);
}

async function save(db: PGlite, gameId: string, token: number): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(
    "select public.save_game_summary_if_current($1,$2,$3::jsonb,$4) as ok",
    [gameId, token, JSON.stringify({ headline: "테스트 요약" }), 13],
  );
  return r.rows[0]?.ok === true;
}

async function main() {
  const db = new PGlite();
  await db.waitReady;
  try {
    // 역할 + game_summaries(저장 대상) 준비 후 마이그레이션 2개 적용.
    await db.exec(`
      do $$ begin
        if not exists (select from pg_roles where rolname='service_role') then create role service_role; end if;
        if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
        if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
      end $$;
      create table if not exists public.game_summaries (
        game_id text primary key,
        summary jsonb,
        prompt_version integer,
        created_at timestamptz default now()
      );
    `);
    await db.exec(migration("20260726_game_summary_generation_fence.sql"));
    await db.exec(migration("20260728_game_summary_single_flight_lease.sql"));

    const G = "20260728WOLG0";

    // 1) 첫 claim → token 발급
    const t1 = await claim(db, G);
    ok("첫 claim 토큰 발급", typeof t1 === "number");

    // 2) 활성 lease 중 재claim → null (single-flight 핵심: token 을 bump 하지 않음)
    ok("활성 lease 중 재claim → null(backoff)", (await claim(db, G)) === null);
    ok("연속 재claim 도 null(무한 bump 없음)", (await claim(db, G)) === null);

    // 3) winner(선행 생성) 저장 → 성공 (token 유지되므로)
    ok("winner save 성공", (await save(db, G, t1!)) === true);
    const saved = await db.query<{ summary: unknown }>(
      "select summary from public.game_summaries where game_id=$1",
      [G],
    );
    ok("game_summaries 저장 확인", !!saved.rows[0]?.summary);

    // 4) save 후 lease 해제 → 재claim 가능(새 token, 단조 증가)
    const t4 = await claim(db, G);
    ok("save 후 lease 해제 → 새 token 발급", typeof t4 === "number" && t4! > t1!);

    // 5) 만료된 stale token 저장 → 거부(superseded 백스톱 유지)
    ok("stale token save → false", (await save(db, G, t1!)) === false);

    // 6) lease 만료(TTL 경과) → 다음 claim 이 인수
    await db.exec(
      `update public.game_summary_generation_claims set claimed_at = now() - interval '10 minutes' where game_id='${G}'`,
    );
    const t5 = await claim(db, G);
    ok("lease 만료 후 claim 인수(새 token)", typeof t5 === "number" && t5! > t4!);
    ok("인수 직후 재claim → null(다시 single-flight)", (await claim(db, G)) === null);

    // 7) 서로 다른 gameId 는 독립
    ok("다른 gameId 독립 claim", typeof (await claim(db, "20260728OBSK0")) === "number");

    // 8) livelock 재현 방지: 활성 생성 중 N회 재요청이 와도 winner token 은 그대로여야 함
    const H = "20260728KTNC0";
    const wt = await claim(db, H);
    for (let i = 0; i < 20; i++) await claim(db, H); // 후발 요청 폭주 시뮬
    ok("폭주 재요청 후에도 winner save 성공(livelock 없음)", (await save(db, H, wt!)) === true);
  } finally {
    console.log(`\ngame-summary single-flight: ${pass} passed, ${fail} failed`);
    await db.close?.();
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
