/** Browser-only fixture: never writes to Supabase. Shared by UI and RSC gates. */
export const HOME_POPULAR_IDS = Array.from({ length: 20 }, (_, i) => 1000 - i);
export const HOME_POPULAR_LINKS = 'a[href^="/community/teams/lg/posts/"]';

export function homePopularFixturePosts() {
  return HOME_POPULAR_IDS.map((id, i) => ({
    id, author_id: "00000000-0000-4000-8000-000000000001",
    board_type: "team", board_id: "lg", content_type: "general",
    title: `인기글 ${id}`, content: "브라우저 검증 픽스처",
    image_urls: [], video_urls: [], like_count: 100 - i, comment_count: 0,
    created_at: new Date(Date.now() - 86400000).toISOString(), is_hidden: false,
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
  const state = { requests: [], fail: false };
  await page.route("**/rest/v1/rpc/home_popular_posts**", async (route) => {
    const args = route.request().postDataJSON() ?? {};
    state.requests.push(args);
    if (state.fail) {
      await route.fulfill({ status: 500, json: { message: "fixture RPC failure" } });
      return;
    }
    const excluded = new Set(args.p_exclude ?? []);
    const rows = empty ? [] : homePopularFixturePosts()
      .filter((p) => !excluded.has(p.id)).slice(0, args.p_limit);
    await route.fulfill({ status: 200, json: rows });
  });
  return state;
}
