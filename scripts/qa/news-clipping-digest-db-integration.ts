/**
 * news_clipping_digests insert-once RPC DB 통합 테스트 (PGlite).
 *
 * Why (삼순 blocker 3, 2026-08-20 4차)
 * -----------------------------------
 * 앞선 16 mutations 는 `types + loader` 만 훼손해서 **SQL/RPC 계약은 하나도 검증하지 않았다.**
 * 그런데 blocker 3 의 본체는 SQL 쪽이다 — 충돌(이미 존재) 시 RPC 가 id 만 돌려주면
 * 카드는 저장된 A 를 보여주는데 푸시 preview 는 이번에 생성한 B 에서 만들어져 갈라진다.
 *
 * 여기서 고정하는 계약:
 *  1. A insert → B conflict 시 **같은 id** 를 돌려준다(새 행을 만들지 않는다).
 *  2. 충돌 시 **저장된 A 의 overview** 를 돌려준다(B 가 아니라).
 *  3. 충돌해도 **DB 행은 A 그대로**다(articles·overview·team_name 불변).
 *  4. 그 반환값으로 만든 push preview 가 **A 기준**이다(카드=A, 푸시=A).
 *  5. 빈 articles 는 거부한다(기사 없음 카드를 참조하게 두지 않는다).
 *  6. 권한: anon/authenticated 는 RPC 실행 불가, authenticated 는 SELECT 만 가능.
 *
 * 실행: npx tsx scripts/qa/news-clipping-digest-db-integration.ts
 *       (npm run qa:news-clip-digest:db)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { toPushPreview } from "@/types/news-clipping";
import type { NewsClippingLegacyPayload, NewsClippingArticle } from "@/types/news-clipping";

// production helper 는 supabase admin 을 transitively import 하므로 env 가 먼저 있어야 한다.
// (조회는 전부 PGlite shim 으로 가고 실제 네트워크는 타지 않는다.)
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "qa-service-role-key";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "qa-anon-key";

// ⚠️ esbuild 의 cjs 트랜스폼은 import 를 최상단으로 끌어올린다 — 위 env 대입보다 먼저
//    평가되면 supabase 클라이언트 생성이 터진다. 그래서 동적으로 가져온다.
//    (하네스의 로딩 순서 문제이지 프로덕션 코드의 문제가 아니다.)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { toRefClippingPayload } = require("@/lib/news-clipping") as {
  toRefClippingPayload: (
    admin: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
    payload: NewsClippingLegacyPayload,
  ) => Promise<{
    ref: { digest_id: number; push_preview?: string };
    canonical: { overview: string; articles: NewsClippingArticle[] };
    reused: boolean;
  } | null>;
};

function migration(name: string) {
  return readFileSync(resolve("supabase/migrations", name), "utf8");
}

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}

const ARTICLES_A = [
  { title: "A-기사1", link: "https://n.news/a1", thumbnail_url: null, summary: ["a", "b", "c"] },
  { title: "A-기사2", link: "https://n.news/a2", thumbnail_url: null, summary: ["a", "b", "c"] },
];
const ARTICLES_B = [
  { title: "B-기사1", link: "https://n.news/b1", thumbnail_url: null, summary: ["x", "y", "z"] },
];
const OVERVIEW_A = "A 총평 — 4연승 질주";
const OVERVIEW_B = "B 총평 — 완전히 다른 요약";

interface UpsertRow {
  digest_id: number | string;
  stored_overview: string;
  stored_articles: unknown;
  was_inserted: boolean;
}

/**
 * production `toRefClippingPayload` 가 쓰는 supabase.rpc 표면을 PGlite 로 흉내낸다.
 *
 * ⚠️ 삼순 blocker (5차): 게이트가 SQL 만 직접 부르고 **프로덕션 helper 를 안 태우면**,
 *    SQL 이 stored_articles 를 안 돌려줘도 helper 쪽 폴백 때문에 GREEN 이 된다(false-green).
 *    실제 호출 경로를 그대로 태워야 "카드=A, 푸시=A" 가 종단에서 증명된다.
 */
function adminShim(db: PGlite) {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      try {
        const r = await db.query(
          `select * from public.${fn}($1::date,$2::int,$3,$4,$5::jsonb)`,
          [
            args.p_clip_date,
            args.p_team_id,
            args.p_team_name,
            args.p_overview,
            JSON.stringify(args.p_articles),
          ],
        );
        return { data: r.rows, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };
}

function legacyPayload(
  date: string,
  teamId: number,
  teamName: string,
  overview: string,
  articles: unknown[],
): NewsClippingLegacyPayload {
  return {
    type: "news_clipping",
    team_id: teamId,
    team_name: teamName,
    date,
    overview,
    articles: articles as NewsClippingLegacyPayload["articles"],
  };
}

async function upsert(
  db: PGlite,
  clipDate: string,
  teamId: number,
  teamName: string,
  overview: string,
  articles: unknown[],
): Promise<UpsertRow> {
  const r = await db.query<UpsertRow>(
    "select digest_id, stored_overview, stored_articles, was_inserted from public.upsert_news_clipping_digest($1::date,$2::int,$3,$4,$5::jsonb)",
    [clipDate, teamId, teamName, overview, JSON.stringify(articles)],
  );
  return r.rows[0]!;
}

async function main() {
  const db = new PGlite();
  await db.waitReady;
  try {
    await db.exec(`
      do $$ begin
        if not exists (select from pg_roles where rolname='service_role') then create role service_role; end if;
        if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
        if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
      end $$;
    `);
    await db.exec(migration("20260820010000_news_clipping_digest.sql"));

    // ── 1) 최초 insert ────────────────────────────────────────────────────
    const a = await upsert(db, "2026-08-19", 1, "LG 트윈스", OVERVIEW_A, ARTICLES_A);
    ok("최초 insert 는 id 를 돌려준다", Number(a.digest_id) > 0);
    ok("최초 insert 는 방금 넣은 overview 를 돌려준다", a.stored_overview === OVERVIEW_A);

    // ── 2) 충돌: 같은 (clip_date, team_id) 를 다른 내용으로 다시 부른다 ──
    //     cron 재실행·샘플 선점·부분 재시도가 이 상황이다.
    const b = await upsert(db, "2026-08-19", 1, "LG 트윈스(개명)", OVERVIEW_B, ARTICLES_B);
    ok(
      `충돌 시 같은 id 를 돌려준다 (A ${a.digest_id} / B ${b.digest_id})`,
      Number(b.digest_id) === Number(a.digest_id),
    );
    // ⚠️ 이게 blocker 3 의 본체: id 만 맞고 overview 가 B 면 카드=A / 푸시=B 로 갈라진다.
    ok(
      `충돌 시 **저장된 A 의 overview** 를 돌려준다 (실측 "${b.stored_overview}")`,
      b.stored_overview === OVERVIEW_A,
    );

    // ── 3) DB 행은 A 그대로여야 한다(발송된 쪽지들이 이 행을 참조 중) ────
    const row = await db.query<{
      cnt: number | string;
      team_name: string;
      overview: string;
      first_title: string;
      n_articles: number | string;
    }>(`
      select (select count(*) from public.news_clipping_digests) as cnt,
             team_name, overview,
             (articles->0->>'title') as first_title,
             jsonb_array_length(articles) as n_articles
        from public.news_clipping_digests
       where clip_date = '2026-08-19' and team_id = 1
    `);
    const d = row.rows[0]!;
    ok("행이 새로 생기지 않는다", Number(d.cnt) === 1);
    ok("articles 가 A 그대로", d.first_title === "A-기사1" && Number(d.n_articles) === 2);
    ok("overview 가 A 그대로", d.overview === OVERVIEW_A);
    ok("team_name 도 A 그대로(개명본으로 덮이지 않음)", d.team_name === "LG 트윈스");

    // ── 4) 종단: 반환값으로 만든 push preview 가 A 기준이다 ──────────────
    //     프로덕션(toRefClippingPayload)이 하는 것과 같은 계산을 여기서 재현한다.
    const previewFromRpc = toPushPreview(b.stored_overview);
    ok(`푸시 preview 가 A 기준 (실측 "${previewFromRpc}")`, previewFromRpc === OVERVIEW_A);
    ok("푸시 preview 가 B 를 타지 않는다", previewFromRpc !== OVERVIEW_B);

    // ── 4b) stored_articles / was_inserted 를 RPC 가 실제로 돌려주는가 ────
    // ⚠️ 삼순 blocker (5차): 이 검증이 없으면 SQL 이 stored_articles 를 빼먹어도
    //    호출부 폴백(payload.articles) 때문에 GREEN 이 된다 = false-green.
    {
      const aTitles = (a.stored_articles as Array<{ title: string }> | null)?.map((x) => x.title);
      const bTitles = (b.stored_articles as Array<{ title: string }> | null)?.map((x) => x.title);
      ok("최초 insert 가 stored_articles 를 돌려준다", Array.isArray(a.stored_articles));
      ok(
        `최초 insert 의 articles 는 A (실측 ${JSON.stringify(aTitles)})`,
        JSON.stringify(aTitles) === JSON.stringify(["A-기사1", "A-기사2"]),
      );
      ok("충돌 시에도 stored_articles 를 돌려준다", Array.isArray(b.stored_articles));
      // 이게 핵심: 충돌이면 **저장된 A 의 articles** 여야 한다(B 가 아니라).
      ok(
        `충돌 시 stored_articles 는 A 다 (실측 ${JSON.stringify(bTitles)})`,
        JSON.stringify(bTitles) === JSON.stringify(["A-기사1", "A-기사2"]),
      );
      // was_inserted: overview 비교로 추정하지 않고 DB 가 사실을 돌려준다.
      ok("최초 insert 는 was_inserted=true", a.was_inserted === true);
      ok("충돌은 was_inserted=false", b.was_inserted === false);
    }

    // ── 4c) production helper 종단 (toRefClippingPayload) ────────────────
    // 게이트가 SQL 만 직접 부르면 helper 의 폴백·추정 로직이 검증되지 않는다.
    // 실제 호출 경로를 그대로 태워 "카드=A, 푸시=A, reused=true" 를 고정한다.
    {
      const admin = adminShim(db);
      // 신규(다른 날짜) — reused=false, canonical = 방금 넣은 값
      const fresh = await toRefClippingPayload(
        admin,
        legacyPayload("2026-09-01", 9, "NC 다이노스", "신규 총평", ARTICLES_A),
      );
      ok("helper 신규 호출 성공", fresh !== null);
      ok("helper 신규는 reused=false", fresh?.reused === false);
      ok("helper 신규 canonical.overview", fresh?.canonical.overview === "신규 총평");
      ok(
        `helper 신규 canonical.articles 2건 (실측 ${fresh?.canonical.articles.length})`,
        fresh?.canonical.articles.length === 2,
      );
      ok("helper 신규 ref 에 push_preview 가 실린다", typeof fresh?.ref.push_preview === "string");

      // 충돌(같은 날짜·팀을 다른 내용으로) — canonical 은 **A**, reused=true
      const conflict = await toRefClippingPayload(
        admin,
        legacyPayload("2026-09-01", 9, "NC 다이노스(개명)", "덮어쓰기 시도 총평", ARTICLES_B),
      );
      ok("helper 충돌 호출 성공", conflict !== null);
      ok("helper 충돌은 reused=true", conflict?.reused === true);
      ok(
        `helper 충돌 canonical.overview 는 A (실측 "${conflict?.canonical.overview}")`,
        conflict?.canonical.overview === "신규 총평",
      );
      ok(
        `helper 충돌 canonical.articles 도 A (실측 ${JSON.stringify(
          conflict?.canonical.articles.map((x) => x.title),
        )})`,
        JSON.stringify(conflict?.canonical.articles.map((x) => x.title)) ===
          JSON.stringify(["A-기사1", "A-기사2"]),
      );
      ok(
        `helper 충돌 push_preview 도 A 기준 (실측 "${conflict?.ref.push_preview}")`,
        conflict?.ref.push_preview === "신규 총평",
      );
      ok("helper 충돌도 같은 digest_id", conflict?.ref.digest_id === fresh?.ref.digest_id);

      // 같은 overview 로 재실행 — overview 비교로는 구분 불가한 케이스.
      // 추정이 아니라 was_inserted 사실을 쓰는지 여기서 갈린다.
      const sameOverview = await toRefClippingPayload(
        admin,
        legacyPayload("2026-09-01", 9, "NC 다이노스", "신규 총평", ARTICLES_B),
      );
      ok(
        "helper: overview 가 같아도 재사용을 정확히 보고한다(추정 아님)",
        sameOverview?.reused === true,
      );
      ok(
        "helper: overview 동일·articles 변경 충돌에서도 canonical 은 A",
        JSON.stringify(sameOverview?.canonical.articles.map((x) => x.title)) ===
          JSON.stringify(["A-기사1", "A-기사2"]),
      );
    }

    // ── 5) 서로 다른 (날짜, 팀) 은 별도 행 ───────────────────────────────
    const other = await upsert(db, "2026-08-19", 2, "두산 베어스", "두산 총평", ARTICLES_A);
    ok("다른 팀은 새 행", Number(other.digest_id) !== Number(a.digest_id));
    const nextDay = await upsert(db, "2026-08-20", 1, "LG 트윈스", "다음날 총평", ARTICLES_A);
    ok("다른 날짜는 새 행", Number(nextDay.digest_id) !== Number(a.digest_id));
    ok("다음날은 자기 overview", nextDay.stored_overview === "다음날 총평");

    // ── 6) 빈 articles 거부 ──────────────────────────────────────────────
    for (const [label, val] of [
      ["빈 배열", "[]"],
      ["null", "null"],
      ["객체", '{"a":1}'],
    ] as const) {
      let threw = false;
      try {
        await db.query(
          "select digest_id from public.upsert_news_clipping_digest('2026-08-21'::date,3,'키움','x',$1::jsonb)",
          [val],
        );
      } catch {
        threw = true;
      }
      ok(`articles ${label} 은 거부된다`, threw);
    }

    // ── 7) 권한 ──────────────────────────────────────────────────────────
    // ⚠️ 하네스 교정(2026-08-20 실측): `set local role` 은 **트랜잭션 안에서만** 유효하다.
    //    트랜잭션 밖에서 부르면 조용히 no-op 이라 current_user 가 postgres(superuser) 그대로였고,
    //    그래서 "거부돼야 할 것이 통과"했다. 서비스 결함이 아니라 내 관측 결함이었다.
    //    (superuser 는 grant/RLS 를 우회하므로, 역할 전환이 실제로 됐는지부터 확인한다.)
    async function asRole<T>(role: string, fn: () => Promise<T>): Promise<{ who: string; result: T | null; threw: boolean }> {
      let threw = false;
      let result: T | null = null;
      let who = "";
      await db.exec("begin");
      try {
        await db.exec(`set local role ${role}`);
        who = (await db.query<{ u: string }>("select current_user as u")).rows[0]?.u ?? "";
        result = await fn();
      } catch {
        threw = true;
      } finally {
        await db.exec("rollback");
      }
      return { who, result, threw };
    }

    for (const role of ["anon", "authenticated"] as const) {
      const r = await asRole(role, () =>
        db.query(
          "select digest_id from public.upsert_news_clipping_digest('2026-08-22'::date,4,'롯데','x','[{\"t\":1}]'::jsonb)",
        ),
      );
      // 무대 성립 확인 — 역할 전환이 실패하면 이 검사는 아무것도 증명하지 않는다.
      ok(`${role} 로 실제 전환됐다 (current_user=${r.who})`, r.who === role);
      ok(`${role} 은 RPC 실행 불가`, r.threw);
    }
    {
      // 카드 렌더에 필요하므로 authenticated 는 SELECT 가 가능해야 한다.
      const r = await asRole("authenticated", async () => {
        const q = await db.query<{ c: number | string }>(
          "select count(*)::int as c from public.news_clipping_digests",
        );
        return Number(q.rows[0]?.c ?? 0);
      });
      ok("authenticated SELECT 무대 성립", r.who === "authenticated");
      ok(
        `authenticated 는 SELECT 가능(카드가 렌더돼야 하므로, 실측 ${r.result}행)`,
        !r.threw && (r.result ?? 0) >= 1,
      );
    }
    {
      const r = await asRole("authenticated", () =>
        db.query(
          "insert into public.news_clipping_digests (clip_date, team_id, team_name, articles) values ('2026-08-23',5,'한화','[]'::jsonb)",
        ),
      );
      ok("authenticated INSERT 무대 성립", r.who === "authenticated");
      ok("authenticated 는 직접 INSERT 불가", r.threw);
    }

    console.log(`\nnews-clipping digest DB: ${fail === 0 ? "PASS" : `${fail} FAILED`}`);
    if (fail > 0) process.exit(1);
  } finally {
    await db.close();
  }
}

void main().catch((e) => {
  console.error("db integration crashed:", e);
  process.exit(1);
});
