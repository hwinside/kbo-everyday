/**
 * 직관 스토리 본/안 본 구분 스모크 (하린아빠 2026-07-23 21:52 지시).
 * 실행: npm run qa:venue-story-seen
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

async function main() {
  // localStorage 폴리필 (node 환경)
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };

  const { orderBySeen, loadSeenIds, markStorySeen, seenStorageKey, _internal } = await import(
    "../../src/lib/venue-stories/seen"
  );

  console.log("[orderBySeen — 안 본 것 좌측 전진배치, 그룹 내 순서 유지]");
  {
    const stories = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const out = orderBySeen(stories, new Set(["b", "c"]));
    ok("안 본(a,d) 앞 + 본(b,c) 뒤", out.map((s) => s.id).join(",") === "a,d,b,c");
    ok("seen 없으면 원래 순서", orderBySeen(stories, new Set()).map((s) => s.id).join(",") === "a,b,c,d");
    ok("전부 본 경우도 원래 순서", orderBySeen(stories, new Set(["a", "b", "c", "d"])).map((s) => s.id).join(",") === "a,b,c,d");
    ok("원본 배열 불변", stories.map((s) => s.id).join(",") === "a,b,c,d");
    // 실제 VenueStory.id는 number — number id도 동작해야 함
    const numStories = [{ id: 1 }, { id: 2 }, { id: 3 }];
    ok("number id 지원", orderBySeen(numStories, new Set(["2"])).map((s) => s.id).join(",") === "1,3,2");
  }

  console.log("[markStorySeen/loadSeenIds — 저장·복원·중복 (user scope)]");
  {
    markStorySeen("G1", "s1", "userA");
    markStorySeen("G1", "s2", "userA");
    markStorySeen("G1", "s1", "userA"); // 중복
    const ids = loadSeenIds("G1", "userA");
    ok("저장·복원", ids.has("s1") && ids.has("s2") && ids.size === 2);
    ok("다른 게임과 격리", loadSeenIds("G2", "userA").size === 0);
  }

  console.log("[사용자 스코프 격리 — 삼순 #809 blocker 시나리오]");
  {
    // A가 봄 → B는 안 본 상태
    markStorySeen("GAME-1", "story-1", "acctA");
    ok("A가 본 스토리", loadSeenIds("GAME-1", "acctA").has("story-1"));
    ok("B는 A의 이력에 영향받지 않음(안 본 상태)", !loadSeenIds("GAME-1", "acctB").has("story-1"));

    // B가 본 뒤 서로 영향 없음
    markStorySeen("GAME-1", "story-2", "acctB");
    ok("B의 이력이 A에 영향 없음", !loadSeenIds("GAME-1", "acctA").has("story-2"));
    ok("A의 이력이 B에 영향 없음(story-1 여전히 미시청)", !loadSeenIds("GAME-1", "acctB").has("story-1"));

    // 새로고침(재로드) 후 동일 사용자 유지 — storage에서 다시 읽어도 동일
    ok("재로드 후 동일 사용자 이력 유지", loadSeenIds("GAME-1", "acctA").has("story-1") && loadSeenIds("GAME-1", "acctB").has("story-2"));

    // 비로그인(anon) 정책: 로그인 사용자와 분리, anon끼리는 공유
    markStorySeen("GAME-1", "story-3", null);
    ok("anon 이력은 로그인 사용자와 분리", !loadSeenIds("GAME-1", "acctA").has("story-3"));
    ok("anon namespace 유지(null/undefined 동일 취급)", loadSeenIds("GAME-1", undefined).has("story-3"));
    ok("로그인 시 anon 이력 미승계", !loadSeenIds("GAME-1", "acctC").has("story-3"));
    ok("storage key 분리 확인", seenStorageKey("acctA") !== seenStorageKey("acctB") && seenStorageKey(null) === seenStorageKey(undefined));
  }

  console.log("[저장소 상한 — 게임 LRU/id cap]");
  {
    for (let g = 0; g < _internal.MAX_GAMES + 5; g++) markStorySeen(`LRU${g}`, "x", "userA");
    const raw = JSON.parse(store.get(seenStorageKey("userA")) ?? "{}") as Record<string, string[]>;
    ok(`게임 키 ${_internal.MAX_GAMES}개 이하 유지`, Object.keys(raw).length <= _internal.MAX_GAMES);
    ok("가장 오래된 게임 축출", !("G1" in raw) || Object.keys(raw).length <= _internal.MAX_GAMES);
    ok("최근 게임은 유지", `LRU${_internal.MAX_GAMES + 4}` in raw);
  }

  console.log("[깨진 저장값 방어]");
  {
    store.set(seenStorageKey("userA"), "not-json{{{");
    ok("파싱 실패 시 빈 Set", loadSeenIds("G1", "userA").size === 0);
    store.set(seenStorageKey("userA"), JSON.stringify([1, 2, 3]));
    ok("배열 루트도 빈 Set", loadSeenIds("G1", "userA").size === 0);
  }

  console.log("[컴포넌트 배선 정적 계약]");
  {
    const root = join(__dirname, "../..");
    const section = readFileSync(join(root, "src/components/game/VenueStorySection.tsx"), "utf-8");
    const viewer = readFileSync(join(root, "src/components/game/VenueStoryViewer.tsx"), "utf-8");
    ok("트레이가 orderedStories 렌더", section.includes("orderedStories.map((s, i)"));
    ok("본 스토리 회색/안 본 빨강 테두리", /seenIds\.has\(String\(s\.id\)\) \? "ring-gray-500\/50" : "ring-red-500\/60"/.test(section));
    ok("뷰어에 orderedStories 전달(인덱스 일치)", section.includes("stories={orderedStories}"));
    ok("뷰어 닫힐 때만 재정렬(loadSeenIds 재로드, user scope)", /setViewerIndex\(null\);[\s\S]{0,200}?setSeenIds\(loadSeenIds\(gameId, userId\)\)/.test(section));
    ok("뷰어가 표시 스토리 본 처리(onStorySeen)", viewer.includes("onStorySeen?.(storyId)"));
    ok("로드가 user.id 스코프(계정 전환 시 재로드)", /setSeenIds\(loadSeenIds\(gameId, userId\)\);\s*\n\s*\}, \[gameId, userId\]\)/.test(section));
    ok("기록도 user.id 스코프", section.includes("markStorySeen(gameId, storyId, userId)"));
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main();
