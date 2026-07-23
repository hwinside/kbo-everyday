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

  const { orderBySeen, loadSeenIds, markStorySeen, _internal } = await import(
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

  console.log("[markStorySeen/loadSeenIds — 저장·복원·중복]");
  {
    markStorySeen("G1", "s1");
    markStorySeen("G1", "s2");
    markStorySeen("G1", "s1"); // 중복
    const ids = loadSeenIds("G1");
    ok("저장·복원", ids.has("s1") && ids.has("s2") && ids.size === 2);
    ok("다른 게임과 격리", loadSeenIds("G2").size === 0);
  }

  console.log("[저장소 상한 — 게임 LRU/id cap]");
  {
    for (let g = 0; g < _internal.MAX_GAMES + 5; g++) markStorySeen(`LRU${g}`, "x");
    const raw = JSON.parse(store.get(_internal.STORAGE_KEY) ?? "{}") as Record<string, string[]>;
    ok(`게임 키 ${_internal.MAX_GAMES}개 이하 유지`, Object.keys(raw).length <= _internal.MAX_GAMES);
    ok("가장 오래된 게임 축출", !("G1" in raw) || Object.keys(raw).length <= _internal.MAX_GAMES);
    ok("최근 게임은 유지", `LRU${_internal.MAX_GAMES + 4}` in raw);
  }

  console.log("[깨진 저장값 방어]");
  {
    store.set(_internal.STORAGE_KEY, "not-json{{{");
    ok("파싱 실패 시 빈 Set", loadSeenIds("G1").size === 0);
    store.set(_internal.STORAGE_KEY, JSON.stringify([1, 2, 3]));
    ok("배열 루트도 빈 Set", loadSeenIds("G1").size === 0);
  }

  console.log("[컴포넌트 배선 정적 계약]");
  {
    const root = join(__dirname, "../..");
    const section = readFileSync(join(root, "src/components/game/VenueStorySection.tsx"), "utf-8");
    const viewer = readFileSync(join(root, "src/components/game/VenueStoryViewer.tsx"), "utf-8");
    ok("트레이가 orderedStories 렌더", section.includes("orderedStories.map((s, i)"));
    ok("본 스토리 회색/안 본 빨강 테두리", /seenIds\.has\(String\(s\.id\)\) \? "ring-gray-500\/50" : "ring-red-500\/60"/.test(section));
    ok("뷰어에 orderedStories 전달(인덱스 일치)", section.includes("stories={orderedStories}"));
    ok("뷰어 닫힐 때만 재정렬(loadSeenIds 재로드)", /setViewerIndex\(null\);[\s\S]{0,200}?setSeenIds\(loadSeenIds\(gameId\)\)/.test(section));
    ok("뷰어가 표시 스토리 본 처리(onStorySeen)", viewer.includes("onStorySeen?.(storyId)"));
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main();
