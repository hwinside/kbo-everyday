/**
 * 뉴스 조회수 서명 실배선 회귀 (삼순 2차 리뷰 blocker — 2026-08-14).
 *
 * unsigned 경로가 하나라도 남으면 해당 표면 클릭이 전부 미집계되는 결손을 고정한다:
 *   1) /api/news cold 경로 — 전 항목 viewToken 부착·검증 통과
 *   2) /api/news cache-hit(1h) 경로 — 동일하게 부착 (1차 결손 지점)
 *   3) /api/news/batch(edge, 홈 캐러셀) — 부착 + node/edge 서명 동일성
 *   4) 발급 토큰으로 /api/content-views/view POST → 200, 변조 토큰 → 403
 *   5) 홈 로컬 캐시 버전 v4 폐기(unsigned 구캐시 무효화) + viewToken 매핑
 *
 * 실행: tsx --test scripts/qa/content-views-news-wiring-smoke.ts
 * mutation(RED 증명): CONTENT_VIEWS_MUTATION=cache|cold|batch 로 서명 배선을 벗긴
 * 사본을 태우면 이 게이트가 실패해야 한다 — content-views-news-wiring-mutations.ts 가 구동.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

process.env.SUPABASE_SERVICE_ROLE_KEY ??= "content-views-wiring-test-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://content-views-wiring-test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.NAVER_CLIENT_ID ??= "test-naver-id";
process.env.NAVER_CLIENT_SECRET ??= "test-naver-secret";

const ROOT = path.join(__dirname, "..", "..");
const MUTATION = process.env.CONTENT_VIEWS_MUTATION || "";

const NAVER_FIXTURE = {
  items: [
    {
      title: "LG 트윈스 <b>테스트</b> 기사 1",
      link: "https://n.news.naver.com/mnews/article/001/0015000001",
      originallink: "https://press.example.com/articles/1",
      description: "본문 요약 1",
      pubDate: new Date().toUTCString(),
    },
    {
      title: "LG 트윈스 테스트 기사 2",
      link: "https://n.news.naver.com/mnews/article/001/0015000002",
      originallink: "https://press.example.com/articles/2",
      description: "본문 요약 2",
      pubDate: new Date().toUTCString(),
    },
  ],
};

let naverCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("openapi.naver.com")) {
    naverCalls += 1;
    return new Response(JSON.stringify(NAVER_FIXTURE), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("supabase.co")) {
    // /view route 의 increment RPC — 성공으로 응답해 200 ok 경로 확인
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

/** mutation 모드: 서명 배선을 벗긴 사본 route 를 만들어 그쪽을 import. */
function routeImportPath(kind: "news" | "batch"): string {
  const original =
    kind === "news" ? "src/app/api/news/route.ts" : "src/app/api/news/batch/route.ts";
  const wants =
    (kind === "news" && (MUTATION === "cache" || MUTATION === "cold")) ||
    (kind === "batch" && MUTATION === "batch");
  if (!wants) return path.join(ROOT, original);

  let source = readFileSync(path.join(ROOT, original), "utf8");
  if (MUTATION === "cache") {
    // cache-hit 경로만 unsigned (1차 결손 재현)
    source = source.replace(
      "NextResponse.json({ items: withNewsViewTokens(items), _q: cached.data._q })",
      "NextResponse.json({ items, _q: cached.data._q })",
    );
  } else if (MUTATION === "cold") {
    source = source.replace(
      "NextResponse.json({ items: withNewsViewTokens(itemsOut), _q: searchQuery })",
      "NextResponse.json({ items: itemsOut, _q: searchQuery })",
    );
  } else if (MUTATION === "batch") {
    source = source.replace(
      "NextResponse.json({ items: await withNewsViewTokensEdge(deduped.slice(0, 10)) })",
      "NextResponse.json({ items: deduped.slice(0, 10) })",
    );
  }
  const mutated = path.join(ROOT, original.replace("route.ts", `route.mutation-tmp.ts`));
  writeFileSync(mutated, source);
  process.on("exit", () => {
    try { rmSync(mutated); } catch { /* ignore */ }
  });
  return mutated;
}

type TokenedNews = { link: string; originalLink?: string; viewToken?: string };

async function assertAllTokened(items: TokenedNews[], label: string): Promise<string> {
  const { verifyContentViewToken } = await import("../../src/lib/content-views/sign");
  const { newsContentId } = await import("../../src/lib/content-views/policy");
  assert.ok(items.length > 0, `${label}: 항목이 있어야 함`);
  for (const item of items) {
    const id = newsContentId(item.link, item.originalLink);
    assert.ok(id, `${label}: content id 산출`);
    assert.ok(item.viewToken, `${label}: viewToken 부착 (${item.link})`);
    assert.equal(
      verifyContentViewToken("news", id, item.viewToken),
      true,
      `${label}: viewToken 검증 통과`,
    );
  }
  const first = items[0];
  return first.viewToken as string;
}

test("① /api/news cold 경로 — 전 항목 서명 부착·검증 통과", async () => {
  const { GET } = await import(routeImportPath("news"));
  const res = await GET(new NextRequest("http://localhost/api/news?q=%ED%85%8C%EC%8A%A4%ED%8A%B8"));
  assert.equal(res.status, 200);
  const body = await res.json();
  await assertAllTokened(body.items, "cold");
  assert.ok(naverCalls >= 1, "cold 경로는 Naver 실호출");
});

test("② /api/news cache-hit 경로 — unsigned 캐시 결손 방지", async () => {
  const callsBefore = naverCalls;
  const { GET } = await import(routeImportPath("news"));
  const res = await GET(new NextRequest("http://localhost/api/news?q=%ED%85%8C%EC%8A%A4%ED%8A%B8"));
  assert.equal(res.status, 200);
  assert.equal(naverCalls, callsBefore, "같은 쿼리 재요청은 cache-hit(Naver 추가 호출 0)");
  const body = await res.json();
  await assertAllTokened(body.items, "cache-hit");
});

test("③ /api/news/batch(edge) — 서명 부착 + node/edge 서명 동일성", async () => {
  const { POST } = await import(routeImportPath("batch"));
  const res = await POST(
    new NextRequest("http://localhost/api/news/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team: "LG", players: [] }),
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  await assertAllTokened(body.items, "batch");

  // edge(Web Crypto) 서명 == node(node:crypto) 서명 — 두 구현이 갈리면 /view 검증이 전부 403
  const { signContentView } = await import("../../src/lib/content-views/sign");
  const { signContentViewEdge } = await import("../../src/lib/content-views/sign-edge");
  const sample = "https://press.example.com/articles/1";
  assert.equal(await signContentViewEdge("news", sample), signContentView("news", sample));
});

test("④ 발급 토큰 → /view 200, 변조 토큰 → 403", async () => {
  const { GET } = await import(routeImportPath("news"));
  const res = await GET(new NextRequest("http://localhost/api/news?q=%ED%85%8C%EC%8A%A4%ED%8A%B8"));
  const body = await res.json();
  const item = body.items[0] as TokenedNews;
  const { newsContentId } = await import("../../src/lib/content-views/policy");
  const id = newsContentId(item.link, item.originalLink)!;

  const { POST: viewPost } = await import("../../src/app/api/content-views/view/route");
  const call = (token: string | undefined) =>
    viewPost(
      new NextRequest("http://localhost/api/content-views/view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "news", id, token }),
      }),
    );

  const ok = await call(item.viewToken);
  assert.equal(ok.status, 200, "유효 서명은 200");
  const tampered = await call("f".repeat(32));
  assert.equal(tampered.status, 403, "변조 서명은 403");
  const missing = await call(undefined);
  assert.equal(missing.status, 403, "서명 부재는 403");
});

test("⑤ 홈 로컬 캐시 — unsigned v4 폐기 + viewToken 매핑", () => {
  const source = readFileSync(path.join(ROOT, "src/hooks/useHomeNews.ts"), "utf8");
  assert.ok(!source.includes('"kbo-home-news-v4"'), "unsigned 구버전 캐시 키(v4)는 폐기돼야 함");
  assert.match(source, /NEWS_CACHE_KEY = "kbo-home-news-v\d+"/, "버전드 캐시 키 유지");
  assert.match(source, /viewToken: item\.viewToken/, "toHomeNewsItems가 viewToken을 매핑해야 함");
});
