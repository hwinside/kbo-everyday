/**
 * 커뮤니티 투표(Poll) — route-level E2E (spec specs/community-poll.md §7 ③⑩ + 축2).
 *
 * 삼순 NO-GO 축3: 기존 DB 하네스는 SQL 만 돌아 GET route(③ 마감 후 미투표자 결과
 * 공개 / ⑩ private,no-store 헤더)가 실제로 실행되지 않았다. 이 스모크는 실제
 * Next route 핸들러(GET /api/polls/[postId], POST /api/polls)를 그대로 호출하고,
 * Supabase REST/GoTrue 를 fetch 레이어에서 in-memory 로 목킹(레포 기존 패턴:
 * share-og-missing-post-smoke.ts)해 다음 계약을 고정한다:
 *   ① 진행중 미투표자 voteCount=null (수치 은닉)
 *   ② 투표 후 결과 + mySelection 공개
 *   ③ 마감 후 미투표자도 결과 공개
 *   ⑩ mySelection 담긴 유저별 응답 Cache-Control: private, no-store
 *   신고 블라인드 poll: 상세 GET 404 + OG 에서 poll 메타/비밀 콘텐츠 비노출
 *   축2 canonical ref 검증: 잘못된 team/player ref → 400 (rpc 미호출),
 *       정상 생성 시 create_poll 로 넘어가는 p_team_tags/p_player_tags 가
 *       teams.ts slug / "kboId:이름" canonical 값이며 snapshot 도 서버 SSOT 값.
 *       같은 kind+ref_id 중복은 route 400, RPC 미호출.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://poll-route-regression.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fake-anon-key";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const VALID_TOKEN = "valid-user-token";

// ---------- in-memory store ----------
type PollOptionRow = {
  id: number;
  post_id: number;
  position: number;
  kind: string;
  ref_id: string | null;
  label_snapshot: string | null;
  image_snapshot: string | null;
  vote_count: number;
};
type Store = {
  posts: Map<number, Record<string, unknown>>;
  poll_polls: Map<number, Record<string, unknown>>;
  poll_options: PollOptionRow[];
  poll_votes: { post_id: number; option_id: number; user_id: string }[];
};
const store: Store = { posts: new Map(), poll_polls: new Map(), poll_options: [], poll_votes: [] };

let optSeq = 100;
function seedPoll(opts: {
  postId: number;
  closesAt: string;
  options: { kind: string; refId?: string | null; label?: string | null; vote_count?: number }[];
  votes?: { userId: string; optionIdx: number }[];
  firstVoteAt?: string | null;
  voterCount?: number;
  hidden?: boolean;
  title?: string;
}): number[] {
  store.posts.set(opts.postId, {
    id: opts.postId,
    title: opts.title ?? `poll ${opts.postId}`,
    content: "body",
    board_type: "poll",
    is_hidden: opts.hidden ?? false,
  });
  store.poll_polls.set(opts.postId, {
    post_id: opts.postId,
    allow_multiple: false,
    closes_at: opts.closesAt,
    voter_count: opts.voterCount ?? (opts.votes?.length ?? 0),
    first_vote_at: opts.firstVoteAt ?? (opts.votes?.length ? new Date().toISOString() : null),
  });
  const ids: number[] = [];
  opts.options.forEach((o, i) => {
    const id = ++optSeq;
    ids.push(id);
    store.poll_options.push({
      id,
      post_id: opts.postId,
      position: i,
      kind: o.kind,
      ref_id: o.refId ?? null,
      label_snapshot: o.label ?? null,
      image_snapshot: null,
      vote_count: o.vote_count ?? 0,
    });
  });
  for (const v of opts.votes ?? []) {
    store.poll_votes.push({ post_id: opts.postId, option_id: ids[v.optionIdx], user_id: v.userId });
  }
  return ids;
}

// ---------- fetch mock (GoTrue + PostgREST) ----------
let lastRpc: { name: string; body: Record<string, unknown> } | null = null;
let rpcCount = 0;
let createdPostId = 900;
const restReads = new Map<string, number>();
const realFetch = globalThis.fetch;

function eqFilters(u: URL): Record<string, string> {
  const f: Record<string, string> = {};
  for (const [k, v] of u.searchParams.entries()) {
    if (v.startsWith("eq.")) f[k] = v.slice(3);
  }
  return f;
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string" || input instanceof URL ? input : input.url;
  const u = new URL(raw.toString());

  // GoTrue: /auth/v1/user — Bearer 토큰 검증
  if (u.pathname.endsWith("/auth/v1/user")) {
    const auth =
      (init?.headers && new Headers(init.headers).get("Authorization")) ||
      (input instanceof Request ? input.headers.get("Authorization") : "") ||
      "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (token === VALID_TOKEN) return json({ id: USER_ID, email: "u@e.com" });
    return json({ msg: "invalid token" }, 401);
  }

  const m = u.pathname.match(/\/rest\/v1\/(rpc\/)?(\w+)$/);
  if (!m) return json([], 200);
  const isRpc = Boolean(m[1]);
  const name = m[2];

  if (isRpc) {
    rpcCount++;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    lastRpc = { name, body };
    if (name === "create_poll") return json(++createdPostId); // scalar bigint
    return json(null);
  }
  restReads.set(name, (restReads.get(name) ?? 0) + 1);

  const f = eqFilters(u);
  if (name === "posts") {
    const row = f.id ? store.posts.get(Number(f.id)) : undefined;
    return json(row ? [row] : []);
  }
  if (name === "poll_polls") {
    const row = f.post_id ? store.poll_polls.get(Number(f.post_id)) : undefined;
    return json(row ? [row] : []);
  }
  if (name === "poll_options") {
    const rows = store.poll_options
      .filter((o) => o.post_id === Number(f.post_id))
      .sort((a, b) => a.position - b.position);
    return json(rows);
  }
  if (name === "poll_votes") {
    const rows = store.poll_votes.filter(
      (v) => v.post_id === Number(f.post_id) && (!f.user_id || v.user_id === f.user_id),
    );
    return json(rows.map((v) => ({ option_id: v.option_id })));
  }
  return json([]);
}) as typeof fetch;

// ---------- helpers to invoke real handlers ----------
async function callGet(
  GET: (req: unknown, ctx: { params: Promise<{ postId: string }> }) => Promise<Response>,
  postId: number,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const req = new Request(`https://keubo.fan/api/polls/${postId}`, { headers });
  return GET(req, { params: Promise.resolve({ postId: String(postId) }) });
}

async function main(): Promise<void> {
  let pass = 0;
  const ok = (n: string, c: boolean) => {
    if (c) {
      pass++;
      console.log("  ✓", n);
    } else {
      throw new Error("FAIL: " + n);
    }
  };
  try {
    const { GET } = await import("../../src/app/api/polls/[postId]/route");
    const { GET: GET_OG } = await import("../../src/app/api/og/poll/[postId]/route");
    const { POST } = await import("../../src/app/api/polls/route");

    // seed: 진행중(미투표자용) — user 미투표
    const future = new Date(Date.now() + 3600_000).toISOString();
    const inProg = seedPoll({
      postId: 1,
      closesAt: future,
      options: [
        { kind: "team", refId: "lg", vote_count: 3 },
        { kind: "team", refId: "doosan", vote_count: 1 },
      ],
      firstVoteAt: new Date().toISOString(),
      voterCount: 4,
    });

    // ① 진행중 미투표자(무인증) → voteCount 은닉
    const r1 = await callGet(GET as never, 1);
    const b1 = (await r1.clone().json()) as {
      canSeeResults: boolean;
      voterCount: number;
      voted: boolean;
      options: { voteCount: number | null }[];
    };
    ok("① in-progress non-voter: 200", r1.status === 200);
    ok("① canSeeResults=false", b1.canSeeResults === false);
    ok("① voted=false", b1.voted === false);
    ok("① every option voteCount hidden (null)", b1.options.every((o) => o.voteCount === null));
    ok("① voterCount public (number)", typeof b1.voterCount === "number" && b1.voterCount === 4);
    ok("⑩ Cache-Control private,no-store", r1.headers.get("Cache-Control") === "private, no-store");

    // 투표한 유저 seed (같은 poll 에 표 추가)
    store.poll_votes.push({ post_id: 1, option_id: inProg[0], user_id: USER_ID });

    // ② 투표 후(인증) → 결과 + mySelection 공개
    const r2 = await callGet(GET as never, 1, VALID_TOKEN);
    const b2 = (await r2.json()) as {
      canSeeResults: boolean;
      voted: boolean;
      mySelection: number[];
      options: { id: number; voteCount: number | null }[];
    };
    ok("② voter canSeeResults=true", b2.canSeeResults === true);
    ok("② voted=true", b2.voted === true);
    ok("② mySelection = [option]", b2.mySelection.length === 1 && b2.mySelection[0] === inProg[0]);
    ok("② option voteCount revealed (numbers)", b2.options.every((o) => typeof o.voteCount === "number"));

    // ③ 마감 후 미투표자(무인증) → 결과 공개
    const past = new Date(Date.now() - 3600_000).toISOString();
    seedPoll({
      postId: 2,
      closesAt: past,
      options: [
        { kind: "team", refId: "kia", vote_count: 5 },
        { kind: "team", refId: "lotte", vote_count: 2 },
      ],
      voterCount: 7,
      firstVoteAt: new Date().toISOString(),
    });
    const r3 = await callGet(GET as never, 2);
    const b3 = (await r3.clone().json()) as {
      closed: boolean;
      canSeeResults: boolean;
      voted: boolean;
      options: { voteCount: number | null }[];
    };
    ok("③ closed poll closed=true", b3.closed === true);
    ok("③ closed non-voter canSeeResults=true", b3.canSeeResults === true);
    ok("③ closed non-voter voted=false", b3.voted === false);
    ok("③ closed non-voter sees numbers", b3.options.every((o) => typeof o.voteCount === "number"));
    ok("⑩ closed response private,no-store", r3.headers.get("Cache-Control") === "private, no-store");

    // 신고 블라인드: 공용 helper 에서 즉시 null → 상세 404, OG 는 fallback만 렌더하고
    // poll_polls/options 를 조회하지 않아 질문/선지 콘텐츠가 유입될 수 없다.
    seedPoll({
      postId: 3,
      closesAt: future,
      options: [
        { kind: "etc", label: "HIDDEN_SECRET_OPTION" },
        { kind: "etc", label: "other" },
      ],
      hidden: true,
      title: "HIDDEN_SECRET_TITLE",
    });
    const hiddenGet = await callGet(GET as never, 3);
    ok("hidden poll detail GET → 404", hiddenGet.status === 404);
    const pollReadsBeforeOg = restReads.get("poll_polls") ?? 0;
    const optionReadsBeforeOg = restReads.get("poll_options") ?? 0;
    const hiddenOg = await GET_OG(new Request("https://keubo.fan/api/og/poll/3"), {
      params: Promise.resolve({ postId: "3" }),
    });
    const hiddenOgBytes = Buffer.from(await hiddenOg.arrayBuffer());
    ok("hidden poll OG returns fallback image", hiddenOg.status === 200 && hiddenOgBytes.length > 0);
    ok(
      "hidden poll OG does not read poll metadata/options",
      (restReads.get("poll_polls") ?? 0) === pollReadsBeforeOg &&
        (restReads.get("poll_options") ?? 0) === optionReadsBeforeOg,
    );
    ok(
      "hidden poll OG bytes exclude secret text",
      !hiddenOgBytes.includes(Buffer.from("HIDDEN_SECRET_TITLE")) &&
        !hiddenOgBytes.includes(Buffer.from("HIDDEN_SECRET_OPTION")),
    );

    // ---------- 축2: canonical ref 검증 + tag 파생 ----------
    const mkPost = (options: unknown[]) =>
      new Request("https://keubo.fan/api/polls", {
        method: "POST",
        headers: { Authorization: `Bearer ${VALID_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Q?", closesAt: future, options }),
      });

    // 잘못된 team ref → 400, rpc 미호출
    rpcCount = 0;
    lastRpc = null;
    const bad1 = await POST(mkPost([
      { kind: "team", refId: "not-a-team" },
      { kind: "team", refId: "lg" },
    ]) as never);
    ok("축2 bad team ref → 400", bad1.status === 400);
    ok("축2 bad team ref → rpc not called", rpcCount === 0 && lastRpc === null);

    // 잘못된 player ref → 400
    const bad2 = await POST(mkPost([
      { kind: "player", refId: "000000" },
      { kind: "player", refId: "53006" },
    ]) as never);
    ok("축2 bad player ref → 400", bad2.status === 400);

    // 정상 team poll → 201 + canonical team_tags
    rpcCount = 0;
    lastRpc = null;
    const good1 = await POST(mkPost([
      {
        kind: "team",
        refId: "lg",
        label: "두산 베어스",
        image: "https://attacker.invalid/logo.svg",
      },
      { kind: "team", refId: "doosan" },
    ]) as never);
    ok("축2 valid team poll → 201", good1.status === 201);
    ok("축2 create_poll called once", rpcCount === 1 && lastRpc?.name === "create_poll");
    {
      const tt = ((lastRpc?.body.p_team_tags as string[]) ?? []).slice().sort();
      const pt = (lastRpc?.body.p_player_tags as string[]) ?? [];
      ok("축2 team poll p_team_tags = [doosan,lg]", JSON.stringify(tt) === JSON.stringify(["doosan", "lg"]));
      ok("축2 team poll p_player_tags = []", pt.length === 0);
      const opts = (lastRpc?.body.p_options as {
        ref_id: string;
        label: string;
        image: string | null;
      }[]) ?? [];
      const lg = opts.find((o) => o.ref_id === "lg");
      ok(
        "snapshot spoof ignored: lg → canonical name/logo",
        lg?.label === "LG 트윈스" && lg.image === "/logos/lg.svg",
      );
    }

    // 동일 canonical ref 중복 → 400, RPC 미호출
    rpcCount = 0;
    lastRpc = null;
    const dup = await POST(mkPost([
      { kind: "team", refId: "lg" },
      { kind: "team", refId: "lg" },
    ]) as never);
    ok("duplicate canonical team ref → 400", dup.status === 400);
    ok("duplicate canonical team ref → rpc not called", rpcCount === 0 && lastRpc === null);

    // 정상 player poll → 201 + canonical player_tags("kboId:이름") + 소속팀 union team_tags
    rpcCount = 0;
    lastRpc = null;
    const good2 = await POST(mkPost([
      {
        kind: "player",
        refId: "53006",
        label: "공격자",
        image: "https://attacker.invalid/player.jpg",
      }, // 강건 (KT)
      { kind: "player", refId: "56769" }, // 강건우 (한화)
    ]) as never);
    ok("축2 valid player poll → 201", good2.status === 201);
    {
      const pt = ((lastRpc?.body.p_player_tags as string[]) ?? []).slice().sort();
      const tt = ((lastRpc?.body.p_team_tags as string[]) ?? []).slice().sort();
      ok(
        "축2 player poll p_player_tags = canonical kboId:이름",
        JSON.stringify(pt) === JSON.stringify(["53006:강건", "56769:강건우"]),
      );
      ok("축2 player poll team_tags union = [hanwha,kt]", JSON.stringify(tt) === JSON.stringify(["hanwha", "kt"]));
      const opts = (lastRpc?.body.p_options as {
        ref_id: string;
        label: string;
        image: string | null;
      }[]) ?? [];
      const player = opts.find((o) => o.ref_id === "53006");
      ok(
        "player snapshot spoof ignored: canonical roster name/photo",
        player?.label === "강건" && player.image === "/players/53006.jpg",
      );
    }

    // ---------- 수동 태그(작성 UI 태그 섹션) union / dedupe / 위조 거절 / 모더레이션 ----------
    const mkPostTags = (body: Record<string, unknown>) =>
      new Request("https://keubo.fan/api/polls", {
        method: "POST",
        headers: { Authorization: `Bearer ${VALID_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Q?", closesAt: future, ...body }),
      });

    // etc-only 투표 + 수동 team/player 태그 → 201, 수동 태그가 canonical 로 p_team_tags/p_player_tags 에 반영
    rpcCount = 0;
    lastRpc = null;
    const etcManual = await POST(mkPostTags({
      options: [{ kind: "etc", label: "치킨" }, { kind: "etc", label: "피자" }],
      teamTags: ["lg"],
      playerTags: ["56769:강건우"], // 한화
    }) as never);
    ok("수동태그 etc-only + manual → 201", etcManual.status === 201);
    {
      const tt = ((lastRpc?.body.p_team_tags as string[]) ?? []).slice().sort();
      const pt = ((lastRpc?.body.p_player_tags as string[]) ?? []).slice().sort();
      // lg(수동) + hanwha(선수 소속팀 union)
      ok("수동태그 team_tags = [hanwha,lg]", JSON.stringify(tt) === JSON.stringify(["hanwha", "lg"]));
      ok("수동태그 player_tags = [56769:강건우]", JSON.stringify(pt) === JSON.stringify(["56769:강건우"]));
    }

    // 선지 파생 태그 + 동일 수동 태그 → dedupe(중복 없음)
    rpcCount = 0;
    lastRpc = null;
    const dedupe = await POST(mkPostTags({
      options: [{ kind: "team", refId: "lg" }, { kind: "team", refId: "doosan" }],
      teamTags: ["lg", "doosan"], // 선지와 중복
    }) as never);
    ok("수동태그 option+manual dedupe → 201", dedupe.status === 201);
    {
      const tt = ((lastRpc?.body.p_team_tags as string[]) ?? []).slice().sort();
      ok("수동태그 dedupe team_tags = [doosan,lg]", JSON.stringify(tt) === JSON.stringify(["doosan", "lg"]));
    }

    // 위조/알 수 없는 수동 팀 태그 → 400, RPC 미호출
    rpcCount = 0;
    lastRpc = null;
    const forgedTeam = await POST(mkPostTags({
      options: [{ kind: "etc", label: "A" }, { kind: "etc", label: "B" }],
      teamTags: ["not-a-team"],
    }) as never);
    ok("위조 수동 team 태그 → 400", forgedTeam.status === 400);
    ok("위조 수동 team 태그 → rpc not called", rpcCount === 0 && lastRpc === null);

    // 위조/알 수 없는 수동 선수 태그 → 400
    rpcCount = 0;
    lastRpc = null;
    const forgedPlayer = await POST(mkPostTags({
      options: [{ kind: "etc", label: "A" }, { kind: "etc", label: "B" }],
      playerTags: ["000000:가짜"],
    }) as never);
    ok("위조 수동 player 태그 → 400", forgedPlayer.status === 400);
    ok("위조 수동 player 태그 → rpc not called", rpcCount === 0 && lastRpc === null);

    console.log(
      `\npoll route E2E: ${pass} PASS (①②③⑩ + hidden GET/OG + canonical snapshots/tags + duplicate refs + manual tags union/dedupe/forged)`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
