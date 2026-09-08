/** Browser-only fixture: never writes to Supabase. Shared by UI and RSC gates. */
export const HOME_POPULAR_IDS = Array.from({ length: 20 }, (_, i) => 1000 - i);
export const HOME_POPULAR_LINKS = 'a[data-home-post-id]';
export const HOME_LATEST_IDS = Array.from({ length: 40 }, (_, i) => 2000 - i);

export function homePopularFixturePosts() {
  return HOME_POPULAR_IDS.map((id, i) => ({
    id, author_id: "00000000-0000-4000-8000-000000000001",
    board_type: "team", board_id: "lg", content_type: "general",
    title: `인기글 ${id}`, content: "브라우저 검증 픽스처",
    image_urls: [], video_urls: [], like_count: 100 - i, comment_count: 0,
    created_at: new Date(Date.now() - 3600000 - i * 1000).toISOString(), is_hidden: false,
    game_id: null, player_tags: [], team_tags: ["lg"], hashtags: [],
    author_team_id_snapshot: 1, click_view_count: 0, impression_view_count: 0,
    popularity: 100 - i,
    profiles: { nickname: "테스트유저", team_id: 1, grade: "bronze", points: 0, avatar_url: null },
  }));
}

export async function installHomePopularFixture(page, { empty = false } = {}) {
  // Returning guest with LG selected. Use the app's persisted onboarding state,
  // not forced clicks through a full-screen onboarding overlay.
  await page.addInitScript(() => {
    localStorage.setItem("kbo-my-team", "1");
    localStorage.setItem("kbo-onboarding-status", "skipped");
  });
  const latestRows = HOME_LATEST_IDS.map((id, i) => ({ ...homePopularFixturePosts()[0], id,
    title: `최신글 ${id}`, popularity: 0, like_count: 0,
    created_at: new Date(Date.now() - i * 60000).toISOString() }));
  const state = { requests: [], latestRequests: [], latestRows, fail: false, failLatest: false };
  await page.route("**/rest/v1/rpc/home_popular_posts**", async (route) => {
    const args = route.request().postDataJSON() ?? {};
    state.requests.push(args);
    if (state.fail) {
      await route.fulfill({ status: 500, json: { message: "fixture RPC failure" } });
      return;
    }
    const excluded = new Set(args.p_exclude ?? []);
    const rows = empty ? [] : homePopularFixturePosts()
      .map((p, i) => ({ ...p, team_tags: i % 2 ? ["lg", "doosan"] : ["doosan"] }))
      .filter((p) => !excluded.has(p.id) && Date.parse(p.created_at) >= Date.parse(args.p_since))
      .slice(0, args.p_limit);
    await route.fulfill({ status: 200, json: rows });
  });
  await page.route("**/rest/v1/rpc/home_team_latest_posts**", async (route) => {
    const args = route.request().postDataJSON() ?? {};
    state.latestRequests.push(args);
    if (state.failLatest) {
      await route.fulfill({ status: 500, json: { message: "fixture latest RPC failure" } });
      return;
    }
    const before = args.p_before_created_at ? Date.parse(args.p_before_created_at) : null;
    const rows = empty ? [] : state.latestRows
      .filter((p) => JSON.stringify(p.team_tags) === JSON.stringify([args.p_team_slug]))
      .filter((p) => before === null || Date.parse(p.created_at) < before || (Date.parse(p.created_at) === before && p.id < args.p_before_id))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)
      .slice(0, args.p_limit);
    await route.fulfill({ status: 200, json: rows });
  });
  return state;
}
