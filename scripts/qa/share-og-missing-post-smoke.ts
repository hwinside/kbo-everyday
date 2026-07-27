/**
 * Regression: fetchSharePost() must NOT 406 on missing/deleted posts.
 *
 * `.single()` sends `Accept: application/vnd.pgrst.object+json`, which makes
 * PostgREST answer 406 for 0 rows — a recurring server-side Warning on OG
 * metadata fetches. `.maybeSingle()` (GET) sends `Accept: application/json`
 * and returns null for 0 rows without a 406.
 *
 * This mocks the network at the fetch layer and asserts, black-box, that the
 * posts request uses the array Accept (maybeSingle) and that a missing post
 * returns null with zero 406 responses. A regression to `.single()` flips the
 * Accept header and is caught here.
 */
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake-og-regression.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fake-anon-key";

const PRESENT_POST = {
  id: 4242,
  board_type: "free",
  board_id: null,
  content_type: "general",
  title: "제목",
  content: "본문 내용",
  image_urls: [],
  video_urls: [],
  is_hidden: false,
  author_team_id_snapshot: 1,
  profiles: { nickname: "테스터", team_id: 2 },
};

let objectAcceptSeen = false;
let sixOhSixCount = 0;
let lastPostsAccept: string | null = null;

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!url.pathname.includes("/rest/v1/posts")) {
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const accept =
    (init?.headers && new Headers(init.headers).get("Accept")) || "application/json";
  lastPostsAccept = accept;
  const idFilter = url.searchParams.get("id") ?? "";
  const wantsSingleObject = accept.includes("application/vnd.pgrst.object+json");
  if (wantsSingleObject) objectAcceptSeen = true;

  // eq.4242 -> present row; anything else -> zero rows.
  const rows = idFilter === "eq.4242" ? [PRESENT_POST] : [];

  // Emulate real PostgREST: single-object accept + not exactly 1 row => 406.
  if (wantsSingleObject && rows.length !== 1) {
    sixOhSixCount += 1;
    return new Response(
      JSON.stringify({
        code: "PGRST116",
        message: "JSON object requested, multiple (or no) rows returned",
      }),
      { status: 406, statusText: "Not Acceptable", headers: { "Content-Type": "application/json" } },
    );
  }
  const body = wantsSingleObject ? JSON.stringify(rows[0]) : JSON.stringify(rows);
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

async function main(): Promise<void> {
  try {
    const { fetchSharePost } = await import("../../src/lib/share/post-og");

    // 1) Missing/deleted post must return null WITHOUT provoking a 406.
    const missing = await fetchSharePost(999999999);
    assert.equal(missing, null, "missing post must resolve to null");
    assert.equal(
      lastPostsAccept,
      "application/json",
      `missing-post query must use maybeSingle Accept (got ${lastPostsAccept})`,
    );

    // 2) Present post must map correctly (proves query still works post-change).
    const present = await fetchSharePost(4242);
    assert.ok(present, "present post must resolve");
    assert.equal(present!.id, 4242);
    assert.equal(present!.title, "제목");
    assert.equal(present!.authorNickname, "테스터");
    assert.equal(present!.authorTeamId, 1, "snapshot team wins over profile team");

    // 3) The regression guard: no request ever demanded a single object,
    //    so PostgREST never returned a 406.
    assert.equal(objectAcceptSeen, false, "fetchSharePost must never send single-object Accept");
    assert.equal(sixOhSixCount, 0, "fetchSharePost must never trigger a 406");

    console.log("PASS share-og missing-post: maybeSingle Accept, null on 0 rows, 0x 406, present post maps");
  } finally {
    globalThis.fetch = realFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
