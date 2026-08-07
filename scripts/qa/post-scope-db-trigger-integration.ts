/**
 * 글 공개범위 DB 경계 — **실제 PostgreSQL(PGlite 17) 행동 회귀**.
 *
 * ⚠️ 이 파일이 존재하는 이유 (삼순 NO-GO 2026-08-06):
 *   직전 판본의 §4-4 는 migration **SQL 텍스트를 정규식으로 훑기만** 했다. 그래서
 *     · `jsonb_array_length(...) = 0` 이라는 *문자열*이 있으면 GREEN — 그 조건이
 *       실제로 무엇을 거절하는지는 검증하지 않았다.
 *     · 실제로 `['']`·`['not-a-team']` 같은 비-canonical 값은 길이 1이라 통과했는데,
 *       게이트는 그걸 전혀 몰랐다. 화면에선 `getTeamBySlug` 가 못 찾아 팀 0개 →
 *       "전체구단 공개"로 접힌다. **DB 는 통과, 스펙은 깨짐.**
 *     · 트리거 이름을 바꾸거나 함수 본문을 통째로 비워도, 파일에 그 문자열만 남아 있으면 GREEN.
 *
 *   여기서는 진짜 Postgres 를 띄우고 migration 을 **그대로 실행**한 뒤 INSERT/UPDATE 를
 *   실제로 시도해 SQLSTATE 로 판정한다. 가드를 지우면 반드시 RED 다.
 *   PGlite 는 외부 바이너리·자격증명이 필요 없어 Vercel prebuild(required)에서도 항상 돈다
 *   (`player-popularity-rpc-pg17.sh` 는 로컬 전용이라 CI 에서 SKIP 된다 — 같은 실수 반복 금지).
 *
 * ⚠️ RLS/role 축 (삼순 NO-GO 2026-08-07):
 *   직전 판본은 board_type 으로 stadium/announcement/news 를 **면제**했고, 게이트는 RLS·role 없는
 *   자체 스캐폴딩에서 그 무태그 INSERT 를 오히려 GREEN 으로 기대했다. 그런데 posts 의 INSERT RLS 는
 *   `Auth users create` = WITH CHECK (auth.uid() = author_id) 하나뿐이고 role 제한이 없다
 *   (Production pg_policy 실측). board_type 은 **클라이언트가 고르는 값**이므로 일반 로그인 사용자가
 *   `board_type:'stadium'` + `team_tags:[]` 로 직접 INSERT 하면 면제를 그대로 타고 우회한다.
 *   → 면제를 제거했고, 이 게이트도 **실제 role + 실제 RLS 정책** 위에서 검증한다.
 *     `authenticated` 로 SET ROLE + JWT claim 주입 → 정책이 실제로 평가되게 만든 뒤 INSERT 를 때린다.
 *
 * 커버:
 *   ① 거절 — team_tags NULL / [] / [''] / ['   '] / ['not-a-team'] / ['allstar-nanum'] / 숫자·객체
 *   ② 통과 — 1팀 / 10팀 전부 / 비-canonical 섞여도 canonical 1개면 통과
 *   ③ slug 집합 exact — 트리거가 아는 slug 집합 == `TEAMS`(teams.ts) 집합. 양방향.
 *   ④ UPDATE 무영향 — 신고·카운터·본문 수정이 23514 로 죽지 않는다(태그 없는 레거시 행 포함)
 *   ⑤ **RLS actual** — `authenticated` role + 실제 정책으로 board_type 전 타입 무태그 INSERT RED.
 *      면제 우회(stadium/announcement/news)가 실제 role 에서 막히는지가 이 게이트의 핵심이다.
 *   ⑥ **trusted writer GREEN** — service_role(BYPASSRLS)이 태그를 채우면 통과. 과잉 차단이 아님을 증명.
 *   ⑦ 신설 board_type fail-close — 면제 목록이 없으므로 어떤 값이든 우회 불가
 *   ⑧ 트리거 순서 — poll 글이 태그 없이 들어오면 poll 전용 에러가 아니라 **공개범위 에러**가 난다
 *   ⑨ 멱등 — migration 두 번 적용해도 트리거가 중복되지 않는다
 *   ⑩ 쓰는 쪽 계약 — 구장/공지/기사 호출부가 실제로 태그를 채우는지(면제 제거의 반대급부)
 *
 * 실행: npm run qa:post-scope-db-trigger
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { TEAMS } from "../../src/lib/constants/teams";
import { ALL_TEAM_SLUGS } from "../../src/lib/utils/post-scope";
import { teamSlugsForStadium } from "../../src/lib/constants/stadiums";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    failures.push(name);
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * migration 파일을 **내용으로** 찾는다. 파일명을 하드코딩하면 이름이 바뀌었을 때 게이트가
 * 조용히 다른 파일을 읽거나 통과한다(#1110 에서 실제로 겪은 false-green).
 */
function findMigrations(marker: RegExp): string[] {
  const dir = resolve("supabase/migrations");
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort() // 적재 순서 = 파일명(=타임스탬프) 순. 재정의 migration 이 나중에 오게 한다.
    .filter((f) => marker.test(readFileSync(resolve(dir, f), "utf8")))
    .map((f) => readFileSync(resolve(dir, f), "utf8"));
  if (hits.length === 0) {
    throw new Error(`migration 탐색 실패: ${marker} 매치 0개`);
  }
  return hits;
}

function findMigration(marker: RegExp): string {
  const hits = findMigrations(marker);
  if (hits.length !== 1) {
    throw new Error(`migration 탐색 실패: ${marker} 매치 ${hits.length}개 (1개여야 함)`);
  }
  return hits[0]!;
}

/** INSERT 를 실제로 시도하고 SQLSTATE 를 돌려준다. null = 성공. */
async function tryInsert(
  db: PGlite,
  row: { boardType: string; teamTags: unknown },
): Promise<string | null> {
  try {
    await db.query(
      `INSERT INTO public.posts (author_id, board_type, board_id, title, content, team_tags)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        "11111111-1111-4111-8111-111111111111",
        row.boardType,
        "b",
        "t",
        "c",
        row.teamTags === null ? null : JSON.stringify(row.teamTags),
      ],
    );
    return null;
  } catch (e) {
    const code = (e as { code?: string }).code;
    return code ?? `NO_SQLSTATE:${(e as Error).message}`;
  }
}

const CHECK_VIOLATION = "23514";

async function main() {
  console.log("\n글 공개범위 DB 경계 — 실제 Postgres 행동 검증\n");

  const scopeMigration = findMigration(/posts_require_team_scope/);
  // poll 계약은 재정의 migration 이 따로 있다(20260728). 실제 운영처럼 **순서대로 전부** 적재해야
  // 최종 트리거 상태가 Production 과 같아진다. 하나만 골라 올리면 순서 주장(⑦)이 헛것이 된다.
  const pollMigrations = findMigrations(/CREATE OR REPLACE FUNCTION public\.poll_posts_edit_lock/);

  const db = new PGlite();

  // ── 스캐폴딩: 실제 스키마 + **실제 role + 실제 RLS 정책** ──────────────────
  //   RLS/role 없이 superuser 로만 INSERT 하면 "정책이 이걸 막는가"를 전혀 검증하지 못한다.
  //   Supabase 의 auth.uid() 는 JWT claim 에서 읽으므로 동일 계약을 세워 정책이 실제로 평가되게 한다.
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;

    CREATE SCHEMA IF NOT EXISTS auth;
    -- Supabase 와 동일: 요청 JWT claim 에서 uid 를 읽는다.
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    $fn$;

    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES
      ('11111111-1111-4111-8111-111111111111'),
      ('22222222-2222-4222-8222-222222222222');

    CREATE TABLE public.posts (
      id            bigserial PRIMARY KEY,
      author_id     uuid NOT NULL REFERENCES auth.users(id),
      board_type    text NOT NULL,
      board_id      text,
      title         text,
      content       text,
      team_tags     jsonb DEFAULT '[]'::jsonb,
      player_tags   jsonb DEFAULT '[]'::jsonb,
      is_hidden     boolean DEFAULT false,
      comment_count int DEFAULT 0,
      like_count    int DEFAULT 0,
      created_at    timestamptz DEFAULT now()
    );

    ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT SELECT, INSERT, UPDATE ON public.posts TO authenticated;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

    -- Production pg_policy 실측 그대로(2026-08-07 조회):
    --   "Auth users create" : INSERT, WITH CHECK (auth.uid() = author_id), role 제한 없음
    --   "Anyone can read posts" : SELECT USING (true)
    --   "Authors update own" : UPDATE USING (auth.uid() = author_id)
    -- 즉 board_type 에 대한 제약이 전혀 없다 → board_type 면제는 곧 우회로였다.
    CREATE POLICY "Auth users create" ON public.posts
      FOR INSERT WITH CHECK (auth.uid() = author_id);
    CREATE POLICY "Anyone can read posts" ON public.posts
      FOR SELECT USING (true);
    CREATE POLICY "Authors update own" ON public.posts
      FOR UPDATE USING (auth.uid() = author_id);
  `);

  // poll 계약을 **실제 파일 그대로** 올린다. 트리거 순서 주장(⑦)을 자기재구현 없이 검증하기 위함.
  for (const sql of pollMigrations) {
    await db.exec(sql.replaceAll(/^\s*(REVOKE|GRANT).*$/gm, ""));
  }
  await db.exec(scopeMigration);

  // ── ① 거절 ────────────────────────────────────────────────────────────────
  console.log("\n[1] 거절 — canonical 구단 slug 0개");
  const rejects: Array<[string, unknown]> = [
    ["NULL", null],
    ["빈 배열 []", []],
    ["빈 문자열 ['']", [""]],
    ["공백 ['   ']", ["   "]],
    ["미상 슬러그 ['not-a-team']", ["not-a-team"]],
    ["대문자 ['LG'] (canonical 은 소문자)", ["LG"]],
    ["올스타 ['allstar-nanum'] (정규 10구단 아님)", ["allstar-nanum"]],
    ["비-canonical 여러 개", ["", "not-a-team", "ot"]],
    ["배열이 아닌 객체", { lg: true }],
    ["배열이 아닌 문자열", "lg"],
  ];
  for (const [label, tags] of rejects) {
    const code = await tryInsert(db, { boardType: "free", teamTags: tags });
    ok(`거절: ${label}`, code === CHECK_VIOLATION, `SQLSTATE ${code ?? "성공(=결함)"}`);
  }

  // ── ② 통과 ────────────────────────────────────────────────────────────────
  console.log("\n[2] 통과 — canonical 구단 slug 1개 이상");
  const allSlugs = TEAMS.map((t) => t.slug);
  const accepts: Array<[string, unknown]> = [
    ["1팀 ['lg']", ["lg"]],
    ["10팀 전부(전체 선택)", allSlugs],
    ["canonical + 쓰레기 혼합", ["not-a-team", "kia"]],
  ];
  for (const [label, tags] of accepts) {
    const code = await tryInsert(db, { boardType: "free", teamTags: tags });
    ok(`통과: ${label}`, code === null, code ? `SQLSTATE ${code}` : undefined);
  }

  // ── ③ slug 집합 exact — 트리거 ↔ teams.ts 양방향 ──────────────────────────
  // 한쪽만 검사하면 드리프트를 못 잡는다: 트리거에 옛 slug 가 남거나(→ 앱은 모르는 팀 통과),
  // 새 구단이 teams.ts 에만 생기면(→ 정상 글이 거절) 둘 다 사고다.
  console.log("\n[3] slug 집합 exact — 트리거 ↔ teams.ts");
  for (const slug of allSlugs) {
    const code = await tryInsert(db, { boardType: "free", teamTags: [slug] });
    ok(`teams.ts '${slug}' 를 트리거가 인정`, code === null, code ? `SQLSTATE ${code}` : undefined);
  }
  // 역방향: 트리거가 teams.ts 에 없는 slug 를 인정하면 안 된다. migration 본문에서 IN 목록을
  // 뽑아 teams.ts 집합과 대조한다(문자열 검사가 아니라 집합 비교).
  const inList = /WHERE t\.slug IN \(([\s\S]*?)\)/.exec(scopeMigration)?.[1] ?? "";
  const triggerSlugs = [...inList.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  ok(
    "트리거 slug 집합 == teams.ts 집합 (초과 slug 0)",
    JSON.stringify(triggerSlugs) === JSON.stringify([...allSlugs].sort()),
    `트리거=${triggerSlugs.join(",")} / teams.ts=${[...allSlugs].sort().join(",")}`,
  );

  // ── ④ UPDATE 무영향 ───────────────────────────────────────────────────────
  // INSERT 전용이 아니면 신고·좋아요·댓글수 갱신이 전부 23514 로 죽는다. 레거시(무태그) 행에서도
  // 죽지 않아야 한다 — 운영 사고 축이라 여기서 실제로 UPDATE 를 때린다.
  console.log("\n[4] UPDATE 무영향 — 신고·카운터·본문 수정");
  // 레거시(무태그) 행을 심기 위해 잠시 트리거를 끓다. 트리거 이름을 하드코딩하면 이름이 바뀌었을 때
  // 게이트가 엉뜍한 곳에서 터져 진단을 흐린다 — pg_trigger 에서 실제 이름을 읽어 쓴다.
  const trg = await db.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'public.posts'::regclass AND NOT tgisinternal
        AND tgfoid = 'public.posts_require_team_scope'::regproc`,
  );
  const trgName = trg.rows[0]?.tgname;
  ok("공개범위 트리거가 posts 에 실제로 붙어있다", !!trgName, trgName ?? "(없음)");
  if (trgName) await db.exec(`ALTER TABLE public.posts DISABLE TRIGGER ${trgName}`);
  await db.query(
    `INSERT INTO public.posts (id, author_id, board_type, board_id, title, content, team_tags)
     VALUES (9001, '11111111-1111-4111-8111-111111111111', 'free', 'general', 'legacy', 'c', '[]'::jsonb)`,
  );
  if (trgName) await db.exec(`ALTER TABLE public.posts ENABLE TRIGGER ${trgName}`);
  const updates: Array<[string, string]> = [
    ["신고 블라인드(is_hidden)", "UPDATE public.posts SET is_hidden = true WHERE id = 9001"],
    ["댓글수 카운터", "UPDATE public.posts SET comment_count = comment_count + 1 WHERE id = 9001"],
    ["좋아요 카운터", "UPDATE public.posts SET like_count = like_count + 1 WHERE id = 9001"],
    ["본문 수정", "UPDATE public.posts SET content = 'edited' WHERE id = 9001"],
  ];
  for (const [label, sql] of updates) {
    let code: string | null = null;
    try {
      await db.query(sql);
    } catch (e) {
      code = (e as { code?: string }).code ?? "ERR";
    }
    ok(`레거시 무태그 행 UPDATE 통과: ${label}`, code === null, code ? `SQLSTATE ${code}` : undefined);
  }

  // ── ⑤ RLS actual — authenticated role 로 직접 INSERT ─────────────────────
  //   **이 게이트의 핵심.** 직전 판본은 stadium/announcement/news 를 board_type 으로 면제했는데,
  //   board_type 은 클라이언트가 고르는 값이고 INSERT 정책엔 board_type 제약이 없다.
  //   즉 면제 목록 자체가 우회로였다(삼순 NO-GO 2026-08-07).
  //   superuser 로 INSERT 하면 RLS 를 건너뛰어 이 축을 전혀 증명하지 못하므로,
  //   실제 `authenticated` role + JWT claim 으로 정책을 태운 뒤 판정한다.
  console.log("\n[5] RLS actual — authenticated 직접 INSERT (면제 우회 차단)");
  const ATTACKER = "11111111-1111-4111-8111-111111111111";

  /** 실제 authenticated role + JWT claim 으로 INSERT 를 시도한다. null = 저장 성공(=우회). */
  async function insertAsAuthenticated(boardType: string, teamTags: unknown): Promise<string | null> {
    await db.exec("BEGIN");
    try {
      await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [ATTACKER]);
      await db.exec("SET LOCAL ROLE authenticated");
      await db.query(
        `INSERT INTO public.posts (author_id, board_type, board_id, title, content, team_tags)
         VALUES ($1, $2, 'b', 't', 'c', $3::jsonb)`,
        [ATTACKER, boardType, teamTags === null ? null : JSON.stringify(teamTags)],
      );
      await db.exec("ROLLBACK");
      return null;
    } catch (e) {
      await db.exec("ROLLBACK").catch(() => {});
      return (e as { code?: string }).code ?? `NO_SQLSTATE:${(e as Error).message}`;
    }
  }

  // 정책이 실제로 평가되고 있는지 먼저 증명한다. 이게 통과하지 않으면 아래 RED 는
  // "RLS 가 막았다"가 아니라 "role 설정이 잘못됐다"일 수 있다 — 게이트가 이유를 착각하면 안 된다.
  const foreignAuthor = await insertAsAuthenticated("free", ["lg"]);
  // 남의 author_id 로는 못 쓴다는 것 = 정책이 살아있다는 증거(42501 = RLS 위반).
  await db.exec("BEGIN");
  let policyAlive = "";
  try {
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [ATTACKER]);
    await db.exec("SET LOCAL ROLE authenticated");
    await db.query(
      `INSERT INTO public.posts (author_id, board_type, board_id, title, content, team_tags)
       VALUES ('22222222-2222-4222-8222-222222222222', 'free', 'b', 't', 'c', '["lg"]'::jsonb)`,
    );
    policyAlive = "(성공 = 정책 미작동)";
  } catch (e) {
    policyAlive = (e as { code?: string }).code ?? "ERR";
  }
  await db.exec("ROLLBACK").catch(() => {});
  ok("RLS 정책이 실제로 평가된다 — 남의 author_id INSERT 는 42501", policyAlive === "42501", `SQLSTATE ${policyAlive}`);
  ok("정상 경로는 authenticated 로 저장된다 — 과잉 차단 아님", foreignAuthor === null, foreignAuthor ?? "");

  // 본 판정: 면제였던 3타입을 포함해 **어떤 board_type 으로도** 무태그 저장 불가.
  for (const bt of ["stadium", "announcement", "news", "free", "team", "player", "poll", "brand-new-2027"]) {
    const code = await insertAsAuthenticated(bt, []);
    ok(
      `authenticated 우회 차단: board_type='${bt}' 무태그 INSERT 거절`,
      code === CHECK_VIOLATION,
      `SQLSTATE ${code ?? "성공(=우회 성립, 결함)"}`,
    );
  }
  // 쓰레기 slug 로도 우회 불가(길이 검사였다면 여기서 뚫린다).
  for (const bad of [[""], ["not-a-team"], ["allstar-nanum"]]) {
    const code = await insertAsAuthenticated("stadium", bad);
    ok(
      `authenticated 우회 차단: stadium + ${JSON.stringify(bad)} 거절`,
      code === CHECK_VIOLATION,
      `SQLSTATE ${code ?? "성공(=결함)"}`,
    );
  }

  // ── ⑥ trusted writer GREEN ────────────────────────────────────────────────
  //   면제를 없앤 대신 "쓰는 쪽이 태그를 채운다"가 성립해야 한다. 서버(service_role)가
  //   구장→팀 파생 / 10팀 전부를 채우면 정상 저장돼야 한다. 이게 없으면 과잉 차단이다.
  console.log("\n[6] trusted writer GREEN — 쓰는 쪽이 태그를 채우면 통과");
  const jamsil = teamSlugsForStadium("jamsil");
  ok("구장→팀 파생: 잠실 = LG·두산 2팀", JSON.stringify(jamsil) === JSON.stringify(["lg", "doosan"]), jamsil.join(","));
  const gocheok = teamSlugsForStadium("gocheok");
  ok("구장→팀 파생: 고척 = 키움 1팀", JSON.stringify(gocheok) === JSON.stringify(["kiwoom"]), gocheok.join(","));
  ok("구장→팀 파생: 미상 구장은 빈 배열(임의 팀 금지)", teamSlugsForStadium("no-such-stadium").length === 0);
  ok("ALL_TEAM_SLUGS 는 정규 10구단", ALL_TEAM_SLUGS.length === 10 && !ALL_TEAM_SLUGS.some((s2) => s2.startsWith("allstar")));

  for (const [label, bt, tags] of [
    ["구장 좌석팁(잠실 → LG·두산)", "stadium", jamsil],
    ["공지 브릿지(10팀 전부)", "announcement", ALL_TEAM_SLUGS],
    ["기사 브릿지(10팀 전부)", "news", ALL_TEAM_SLUGS],
  ] as Array<[string, string, string[]]>) {
    const code = await tryInsert(db, { boardType: bt, teamTags: tags });
    ok(`trusted writer GREEN: ${label}`, code === null, code ? `SQLSTATE ${code}` : undefined);
  }

  // ── ⑧ 트리거 순서 — 공개범위 에러가 poll 에러에 가려지지 않는다 ──────────
  // `a_` prefix 계약. 순서가 뒤집히면 poll 전용 메시지가 먼저 나와, 작성자는 "왜 막혔는지"를
  // 잘못 안내받는다. 메시지 문자열로 판정한다(둘 다 SQLSTATE 는 23514 라 코드로는 구분 불가).
  console.log("\n[8] 트리거 순서 — a_ prefix 계약");
  let pollMsg = "";
  try {
    await db.query(
      `INSERT INTO public.posts (author_id, board_type, board_id, title, content, team_tags)
       VALUES ('11111111-1111-4111-8111-111111111111', 'poll', 'poll', 't', 'c', '[]'::jsonb)`,
    );
  } catch (e) {
    pollMsg = (e as Error).message;
  }
  ok(
    "무태그 poll 글은 공개범위 에러가 먼저 난다(poll 전용 에러에 안 가림)",
    /canonical KBO team tag/.test(pollMsg),
    `실제 메시지: ${pollMsg.slice(0, 90) || "(에러 없음 = 결함)"}`,
  );
  // 이름 계약도 명시 검증 — 같은 타이밍의 트리거는 이름 알파벳 순으로 실행된다.
  ok(
    "트리거 이름이 poll_posts_edit_lock_trg 보다 앞선다",
    !!trgName && trgName < "poll_posts_edit_lock_trg",
    `${trgName} vs poll_posts_edit_lock_trg`,
  );

  // ── ⑨ 멱등 ────────────────────────────────────────────────────────────────
  console.log("\n[9] 멱등");
  // 재적용이 **예외 없이** 끝나야 한다. DROP 대상 이름이 어긋나면 여기서 터진다 —
  // 그걸 크래시로 둘지 않고 실패 항목으로 기록해야 진단이 된다.
  let reapplyErr = "";
  try {
    await db.exec(scopeMigration);
  } catch (e) {
    reapplyErr = (e as Error).message;
  }
  ok("migration 재적용이 예외 없이 끝난다", reapplyErr === "", reapplyErr.slice(0, 120));
  const dup = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgrelid = 'public.posts'::regclass AND tgname = 'a_posts_require_team_scope_trg'`,
  );
  ok("재적용해도 트리거 1개", dup.rows[0]?.n === 1, `count=${dup.rows[0]?.n}`);
  const stillRejects = await tryInsert(db, { boardType: "free", teamTags: [] });
  ok("재적용 후에도 무태그 거절 유지", stillRejects === CHECK_VIOLATION, `SQLSTATE ${stillRejects ?? "성공(=결함)"}`);

  await db.close();

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error(`\n  실패 항목: ${failures.join(" / ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
