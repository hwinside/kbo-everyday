/**
 * 야잘알봇 기사 근거(tier2) 적재 계약 회귀.
 *
 * 고정하는 계약:
 *  1. **클리핑 필터 이전 분기** — 카드에서 탈락하는 종합기사(`선두 KT, 한화 12-1 완파…(종합)`)도
 *     RAG 근거로는 적재된다. sink 를 *어느* 클리핑 필터 뒤로 옮겨도 RED 여야 한다
 *     (사진/타팀 필터 뒤·제목게이트 앞으로 옮기면 GREEN 이던 결손 — 삼순 P0).
 *  2. **발송 보호** — 적재는 발송이 끝난 뒤에 돌고, 실패해도 던지지 않으며, 예산을 넘기면 멈춘다.
 *     문자열이 아니라 실제 함수를 실패/지연 클라이언트로 태워 증명한다.
 *  3. **원자 병합** — team_ids 합집합은 DB 안에서 계산된다. 조회 실패로 덮어쓰는 상태가
 *     존재하지 않고, 동시 실행에서도 합집합이 유실되지 않는다(실제 migration RPC 실행).
 *  4. **커버리지 원장** — 팀×날짜로 0건/수집실패/적재실패/절단이 사후에 구분된다.
 *  5. **content_hash CAS** — 임베딩 중 본문이 바뀌면 옛 벡터가 붙지 않는다(SQL 행동 + route 결속).
 *  6. **30일 롤링 이중 방어** — purge 함수(물리 삭제) + 서빙 뷰 술어(검색 차단).
 *  7. **RPC fail-close** — 빈/범위밖 team_ids, 빈 embedding, 영벡터는 조용한 0행이 아니라 예외다.
 *  8. **백필은 발송을 타지 않는다** — 백필 route 가 buildTeamClipping/Gemini/OG 를 호출하지 않는다.
 *     쪽지 발송 경로를 재사용하면 백필 1회로 과거 날짜 쪽지가 유저에게 쏟아진다.
 *  9. **백필 커버리지는 (날짜, 팀) 단위** — 한 팀이 여러 날짜에 걸리므로 팀 단위로 집계하면
 *     한 날의 실패가 다른 날을 덮는다. 날짜별로 분리돼야 "7/31 근거 몇 건" 을 답할 수 있다.
 * 10. **깊이 한계 노출** — API start 상한에 막히면 조용히 끝내지 않고 신호를 남긴다.
 *
 * 실제 migration 을 PGlite(pgvector)로 적용해 검증한다 — SQL 을 게이트가 재구현하지 않는다.
 */

// 실제 수집 함수(buildTeamClipping)를 태우기 위해 news-clipping 을 import 하는데, 그 모듈이
// 끌어오는 supabase admin 싱글톤이 모듈 로드 시점에 env 를 요구한다. 네트워크는 전부 스텁이라
// 이 값들이 쓰이는 경로는 없다 — 로드만 통과시키는 용도다.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://smoke.local";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "smoke-anon-key";


import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

import type { NewsItem } from "../../src/types/api";
import {
  articleKeyFor,
  articleContent,
  contentHashFor,
  pressHostFor,
  toNewsArticleRows,
  NEWS_EMBED_MAX_ATTEMPTS,
  NEWS_RETENTION_DAYS,
  type NewsArticleRow,
} from "../../src/lib/baseball-qa/rag/news-articles";
import {
  ingestNewsArticles,
  NEWS_UPSERT_CHUNK,
  type NewsIngestClient,
  type TeamCollection,
} from "../../src/lib/baseball-qa/rag/news-ingest";
import type { RawCandidateMeta } from "../../src/lib/news-clipping";
import { RAG_EMBEDDING_DIM } from "../../src/lib/baseball-qa/rag/contracts";

const MIGRATION = "supabase/migrations/20260805180000_baseball_genius_news_articles.sql";
const CLIPPING_ROUTE = "src/app/api/cron/news-clipping/route.ts";
const CLIPPING_LIB = "src/lib/news-clipping.ts";
const EMBED_ROUTE = "src/app/api/cron/news-rag-embed/route.ts";
const NOW = new Date("2026-08-05T09:00:00Z");
const CLIP_DATE = "2026-08-05";

/**
 * 카드 **전용** 품질 필터. 근거로는 과하므로 sink 는 이들보다 앞이어야 한다.
 * ⚠️ isTeamBaseballRelevant 는 여기 없다 — 그건 카드 필터가 아니라 야구 관련성 가드다.
 */
const CARD_ONLY_FILTERS = ["isPhotoArticle", "isOtherTeamTitle", "hasClippingTitleSignal"];

/**
 * 근거 오염 가드. sink 는 이걸 **통과시켜야** 한다.
 * 건너뛰면 2026-07-19 실재 회귀(여자골프 기사 속 'LG 트윈스 김진성')가 RAG 원장에 들어간다.
 */
const RELEVANCE_GUARD = "isTeamBaseballRelevant";

let passed = 0;
function pass(label: string): void {
  passed += 1;
  console.log(`PASS ${label}`);
}

function iso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toUTCString();
}

function item(overrides: Partial<NewsItem> & { title: string; link: string }): NewsItem {
  return {
    description: "기본 발췌 문장입니다.",
    originalLink: undefined,
    pubDate: iso(1),
    ...overrides,
  };
}

// ── 1. 적재 필터 계약 ─────────────────────────────────────────────────────────

function verifyIngestFilters(): void {
  // 클리핑 카드에서 탈락하는 실제 표본(2026-08-02 네이버 실측 문구 기반).
  const comprehensive = item({
    title: "선두 KT, 한화 12-1 완파 '6연승'…2위 삼성에 1경기 차(종합)",
    description:
      "3위를 넘보는 두산 베어스는 '잠실 더비'에서 LG 트윈스를 8-3으로 제압했다. 전날 연장 11회 접전 끝에 정수빈의 '3피트 라인 아웃'으로 2-2 무승부를 거둔 두산은 하루 뒤 아쉬움을 달랬다.",
    link: "https://n.news.naver.com/mnews/article/001/0000000001",
  });
  const photo = item({
    title: "[포토] 두산 정수빈, 팬들에게 인사",
    link: "https://n.news.naver.com/mnews/article/001/0000000002",
  });

  const rows = toNewsArticleRows([comprehensive, photo], 2, NOW);
  assert.equal(rows.length, 2, "종합기사·사진기사 모두 근거로는 적재돼야 한다");
  assert.ok(
    rows.some((r) => r.title.includes("(종합)")),
    "타팀 제목 종합기사가 빠지면 3피트 논란의 실제 근거가 사라진다",
  );
  pass("클리핑 필터 이전 분기 — 종합기사·사진기사 적재 보존");

  const rejected = toNewsArticleRows(
    [
      item({ title: "비네이버 기사", link: "https://sports.chosun.com/x" }),
      item({ title: "발췌 없음", description: "   ", link: "https://n.news.naver.com/a/3" }),
      item({ title: "", description: "본문", link: "https://n.news.naver.com/a/4" }),
      item({ title: "시각 불명", pubDate: "not-a-date", link: "https://n.news.naver.com/a/5" }),
      item({ title: "보유기간 초과", pubDate: iso(NEWS_RETENTION_DAYS + 1), link: "https://n.news.naver.com/a/6" }),
    ],
    2,
    NOW,
  );
  assert.equal(rejected.length, 0, "비네이버·빈본문·시각불명·기간초과는 적재 대상이 아니다");
  pass("근거 불가 항목 fail-close — 비네이버/빈본문/시각불명/30일초과");

  const boundary = toNewsArticleRows(
    [item({ title: "경계 기사", pubDate: iso(NEWS_RETENTION_DAYS - 1), link: "https://n.news.naver.com/a/7" })],
    2,
    NOW,
  );
  assert.equal(boundary.length, 1, "보유기간 안쪽 기사를 버리면 창이 30일보다 좁아진다");
  pass("보유기간 경계 — 29일 전 기사 보존");
}

function verifyIdentity(): void {
  const link = "https://n.news.naver.com/mnews/article/001/0000000001";
  assert.equal(articleKeyFor(link), articleKeyFor(` ${link} `), "공백 차이로 같은 기사가 두 행이 되면 안 된다");
  assert.notEqual(articleKeyFor(link), articleKeyFor(`${link}2`), "다른 기사는 다른 키여야 한다");

  assert.equal(pressHostFor("https://www.chosun.com/a", link), "chosun.com");
  assert.equal(pressHostFor(undefined, link), "n.news.naver.com");
  assert.equal(pressHostFor("not-a-url", "also-not-a-url"), null, "호스트 파싱 실패는 적재를 막지 않는다");

  assert.notEqual(
    contentHashFor("제목", "본문"),
    contentHashFor("제목", "수정된 본문"),
    "본문이 바뀌었는데 해시가 같으면 낡은 벡터가 그대로 서빙된다",
  );
  assert.equal(articleContent("제목 ", " 본문"), "제목\n본문");
  pass("기사 identity + content_hash 변경 감지 + 임베딩 입력 포맷");
}

// ── 2. 배선 (AST — 실제 호출 위치) ───────────────────────────────────────────

function loadProgram(files: string[]): ts.Program {
  return ts.createProgram(
    files.map((f) => path.join(process.cwd(), f)),
    { allowJs: false, noEmit: true, skipLibCheck: true, esModuleInterop: true, jsx: ts.JsxEmit.Preserve },
  );
}

/** 지정한 함수 호출의 **최초 등장 위치**(문자 오프셋)를 모은다. */
function callPositions(source: ts.SourceFile, names: string[]): Map<string, number> {
  const found = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
          ? callee.name.text
          : null;
      if (name && names.includes(name) && !found.has(name)) {
        found.set(name, node.getStart(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function verifyWiring(): void {
  const program = loadProgram([CLIPPING_ROUTE, CLIPPING_LIB, EMBED_ROUTE]);

  // (a) cron route — sink 를 실제로 넘기고, 적재를 **발송 뒤에** 호출한다.
  const routeSource = program.getSourceFile(path.join(process.cwd(), CLIPPING_ROUTE));
  assert.ok(routeSource, "cron route 소스를 찾지 못했다");

  let sinkArgIdentifier: string | null = null;
  const visitRoute = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "buildTeamClipping" &&
      node.arguments.length >= 5
    ) {
      const arg = node.arguments[4];
      if (ts.isIdentifier(arg)) sinkArgIdentifier = arg.text;
    }
    ts.forEachChild(node, visitRoute);
  };
  visitRoute(routeSource!);
  assert.ok(
    sinkArgIdentifier,
    "cron route 가 buildTeamClipping 에 raw 후보 sink 를 넘기지 않는다 — 적재가 영원히 0건이 된다",
  );

  const routeCalls = callPositions(routeSource!, ["ingestNewsArticles", "sendTeamClipping"]);
  const ingestPos = routeCalls.get("ingestNewsArticles");
  const sendPos = routeCalls.get("sendTeamClipping");
  assert.ok(ingestPos !== undefined, "cron route 가 ingestNewsArticles 를 호출하지 않는다 — 수집만 하고 버린다");
  assert.ok(sendPos !== undefined, "cron route 가 sendTeamClipping 을 호출하지 않는다 — 발송 경로를 찾을 수 없다");
  assert.ok(
    ingestPos! > sendPos!,
    "적재가 발송보다 앞에 있다 — 적재가 느리면 maxDuration 에 걸려 쪽지가 아예 안 나간다",
  );
  pass(`cron route actual binding — sink '${sinkArgIdentifier}' 전달 + 적재는 발송 뒤`);

  // (b) news-clipping — sink 는 카드 전용 필터보다 **앞**, 야구 관련성 가드는 **통과**.
  //     순서만 보면 relevance 를 건너뛴 것도 GREEN 이 되므로 관련성 가드는 별도로 확인한다.
  const libSource = program.getSourceFile(path.join(process.cwd(), CLIPPING_LIB));
  assert.ok(libSource, "news-clipping 소스를 찾지 못했다");

  const libCalls = callPositions(libSource!, [...CARD_ONLY_FILTERS, RELEVANCE_GUARD, "onRawCandidates"]);
  const sinkCallPos = libCalls.get("onRawCandidates");
  assert.ok(sinkCallPos !== undefined, "news-clipping 이 raw sink 를 호출하지 않는다");

  const filterPositions = CARD_ONLY_FILTERS.map((name) => {
    const pos = libCalls.get(name);
    assert.ok(pos !== undefined, `카드 필터 '${name}' 호출을 찾지 못했다 — 순서 판정이 무효가 된다`);
    return { name, pos: pos! };
  });
  const earliest = filterPositions.reduce((a, b) => (a.pos <= b.pos ? a : b));
  assert.ok(
    sinkCallPos! < earliest.pos,
    `sink 호출이 카드 전용 필터 '${earliest.name}' 보다 뒤에 있다 — 근거로 필요한 종합기사가 탈락한다`,
  );
  pass(`news-clipping — sink 가 카드 전용 필터 ${CARD_ONLY_FILTERS.length}종보다 앞 (최초: ${earliest.name})`);

  // (c) 임베딩 write 가 content_hash 를 조건으로 건다(CAS). 조건 없이 쓰면 옛 벡터가 새 본문에 붙는다.
  const embedSource = program.getSourceFile(path.join(process.cwd(), EMBED_ROUTE));
  assert.ok(embedSource, "embed route 소스를 찾지 못했다");

  // 체인을 **아래로** 훑는다. ts.createProgram 은 타입체크 전까지 parent 포인터를 채우지 않아
  // 부모 추적 방식은 조용히 무효가 된다(실측 — CAS 가 있는데도 못 찾았다).
  const writesVector = (node: ts.Node): boolean => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "update"
    ) {
      const arg = node.arguments[0];
      if (
        arg &&
        ts.isObjectLiteralExpression(arg) &&
        arg.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "embedding")
      ) {
        return true;
      }
    }
    // .eq(...).select(...) 같은 체인은 expression 쪽으로 계속 내려간다.
    if (ts.isCallExpression(node)) return writesVector(node.expression);
    if (ts.isPropertyAccessExpression(node)) return writesVector(node.expression);
    if (ts.isAwaitExpression(node)) return writesVector(node.expression);
    return false;
  };

  let vectorUpdateHasCas = false;
  let vectorUpdateSeen = false;
  const visitEmbed = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "update"
    ) {
      const arg = node.arguments[0];
      if (
        arg &&
        ts.isObjectLiteralExpression(arg) &&
        arg.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "embedding")
      ) {
        vectorUpdateSeen = true;
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "eq"
    ) {
      const key = node.arguments[0];
      if (key && ts.isStringLiteral(key) && key.text === "content_hash" && writesVector(node.expression)) {
        vectorUpdateHasCas = true;
      }
    }
    ts.forEachChild(node, visitEmbed);
  };
  visitEmbed(embedSource!);
  // 탐지기가 대상을 아예 못 찾은 채 통과하는 false-green 을 막는다.
  assert.ok(vectorUpdateSeen, "embed route 에서 벡터 write 자체를 찾지 못했다 — CAS 판정이 무효다");
  assert.ok(
    vectorUpdateHasCas,
    "임베딩 write 에 content_hash CAS 가 없다 — 처리 중 본문이 바뀌면 새 본문에 옛 벡터가 붙는다",
  );
  pass("embed route — 벡터 write 가 content_hash CAS 로 보호됨");
}

// ── 2-b. 절단 신호 (실제 collectYesterdayCandidates 실행) ────────────────────
//
// AST 로 "truncated 를 넘기는가" 만 보면 `truncated: false` 하드코딩을 못 잡는다(실측 GREEN).
// 네이버 응답만 스텁으로 갈아끼우고 **실제 수집 함수를 그대로 태워** 신호를 관측한다.

async function captureSinkMeta(pageSizes: { lastItemIsYesterday: boolean }): Promise<{
  meta: RawCandidateMeta;
  itemCount: number;
}> {
  const { kstDateString } = await import("../../src/lib/news-clipping");
  const yesterday = kstDateString(-1);
  const olderDay = kstDateString(-3);
  const toPubDate = (kstDay: string) => new Date(`${kstDay}T03:00:00+09:00`).toUTCString();

  const makePage = (prefix: string, lastOld: boolean): unknown[] =>
    Array.from({ length: 3 }, (_, i) => ({
      title: `LG 트윈스 ${prefix}-${i}`,
      description: "발췌 문장",
      link: `https://n.news.naver.com/mnews/article/001/${prefix}${i}`,
      originallink: `https://www.chosun.com/${prefix}${i}`,
      pubDate: toPubDate(lastOld && i === 2 ? olderDay : yesterday),
    }));

  // 페이지1의 마지막이 어제보다 오래되면 루프가 1페이지에서 끝난다(= 더 볼 게 없음).
  const page1 = makePage("a", !pageSizes.lastItemIsYesterday);
  const page2 = makePage("b", false);

  const originalFetch = globalThis.fetch;
  let naverCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("openapi.naver.com")) {
      const items = naverCalls === 0 ? page1 : page2;
      naverCalls += 1;
      return new Response(JSON.stringify({ items }), { status: 200 });
    }
    // Gemini 등 그 뒤 단계는 실패시켜도 무방하다 — sink 는 이미 호출된 뒤다.
    return new Response("{}", { status: 500 });
  }) as typeof fetch;

  // 정적 import 는 env 주입보다 먼저 호이스팅돼 supabase admin 싱글톤 생성에서 죽는다(실측).
  // 실제 production 모듈을 그대로 태우되 로드 시점만 늦춘다.
  const { buildTeamClipping } = await import("../../src/lib/news-clipping");

  let captured: { meta: RawCandidateMeta; itemCount: number } | null = null;
  try {
    await buildTeamClipping(1, "LG", "LG 트윈스", null, (_teamId, items, meta) => {
      captured = { meta, itemCount: items.length };
    });
  } catch {
    // 요약 단계 실패는 이 검사와 무관하다.
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(captured, "실제 수집 경로가 sink 를 호출하지 않았다");
  return captured!;
}

async function verifyTruncationSignal(): Promise<void> {
  // (a) 2페이지를 다 채우고도 마지막이 어제치 → 못 본 기사가 남았다 = truncated.
  const truncated = await captureSinkMeta({ lastItemIsYesterday: true });
  assert.equal(
    truncated.meta.truncated,
    true,
    "페이지 상한까지 어제 기사가 이어지는데 truncated=false 다 — 근거 누락을 사후에 알 수 없다",
  );
  assert.equal(truncated.meta.pagesFetched, 2, "가져온 페이지 수가 기록되지 않았다");

  // (b) 페이지1 끝에서 어제보다 오래된 기사가 나오면 그날치를 다 본 것 = not truncated.
  const complete = await captureSinkMeta({ lastItemIsYesterday: false });
  assert.equal(
    complete.meta.truncated,
    false,
    "그날 기사를 다 봤는데 truncated=true 면 신호가 상시 참이라 무의미하다",
  );
  assert.equal(complete.meta.pagesFetched, 1, "조기 종료가 pagesFetched 에 반영되지 않았다");
  pass("절단 신호 — 실제 수집 경로 실행으로 truncated 양방향 관측");
}

// ── 3. 발송 보호 (실제 함수 실행) ────────────────────────────────────────────

function collection(teamId: number, count: number, keyPrefix = "k"): TeamCollection {
  const rows: NewsArticleRow[] = Array.from({ length: count }, (_, i) => ({
    article_key: `${keyPrefix}-${teamId}-${i}`,
    team_ids: [teamId],
    title: `제목 ${i}`,
    description: `발췌 ${i}`,
    link: `https://n.news.naver.com/${keyPrefix}-${teamId}-${i}`,
    original_link: `https://n.news.naver.com/${keyPrefix}-${teamId}-${i}`,
    press_host: "n.news.naver.com",
    published_at: NOW.toISOString(),
    content_hash: `h-${teamId}-${i}`,
  }));
  return { teamId, rows, truncated: false, pagesFetched: 2 };
}

function recordingClient(
  behavior: (fn: string, calls: number) => { data: unknown; error: { message: string } | null } | "throw",
): { client: NewsIngestClient; calls: { fn: string; rows: unknown[] }[] } {
  const calls: { fn: string; rows: unknown[] }[] = [];
  const client: NewsIngestClient = {
    rpc(fn, args) {
      calls.push({ fn, rows: args.p_rows as unknown[] });
      const outcome = behavior(fn, calls.filter((c) => c.fn === fn).length);
      if (outcome === "throw") return Promise.reject(new Error("boom"));
      return Promise.resolve(outcome);
    },
  };
  return { client, calls };
}

async function verifySendProtection(): Promise<void> {
  // (a) upsert 가 매번 던져도 ingestNewsArticles 는 던지지 않는다.
  const thrower = recordingClient((fn) =>
    fn === "upsert_baseball_genius_news_articles" ? "throw" : { data: 2, error: null },
  );
  const thrown = await ingestNewsArticles(
    thrower.client,
    [collection(1, 3), collection(2, 2)],
    CLIP_DATE,
  );
  assert.equal(thrown.failedRows, 5, "실패한 행이 집계되지 않았다");
  assert.equal(thrown.inserted, 0);
  assert.ok(thrown.errors.length > 0, "실패가 조용히 삼켜지면 진단이 불가능하다");
  assert.equal(thrown.coverageWritten, 2, "적재가 전부 실패해도 커버리지는 남아야 한다");
  const coverageRows = thrower.calls.find((c) => c.fn === "record_baseball_genius_news_coverage")
    ?.rows as { team_id: number; status: string }[];
  assert.ok(
    coverageRows.every((r) => r.status === "ingest_failed"),
    "적재 실패가 커버리지에 ingest_failed 로 남지 않았다",
  );
  pass("발송 보호 (a) — 적재 실패가 throw 되지 않고 커버리지에 기록됨");

  // (b) 커버리지 write 까지 던져도 throw 하지 않는다(호출측이 try 를 잊어도 발송이 산다).
  const allThrow = recordingClient(() => "throw");
  const survived = await ingestNewsArticles(allThrow.client, [collection(1, 1)], CLIP_DATE);
  assert.equal(survived.coverageWritten, 0);
  assert.ok(survived.errors.some((e) => e.startsWith("coverage:")), "커버리지 실패가 보고되지 않았다");
  pass("발송 보호 (b) — 커버리지 write 실패도 throw 하지 않음");

  // (c) 예산 초과 — 남은 청크를 버리고 timedOut 으로 보고한다(무한 지연으로 발송을 잡아먹지 않는다).
  let clock = 0;
  const slow = recordingClient(() => {
    clock += 10_000; // RPC 1회당 10초
    return { data: [{ inserted: 1, updated: 0, reembed_queued: 1 }], error: null };
  });
  const many = collection(1, NEWS_UPSERT_CHUNK * 3);
  const timed = await ingestNewsArticles(slow.client, [many], CLIP_DATE, {
    budgetMs: 15_000,
    now: () => clock,
  });
  assert.equal(timed.timedOut, true, "예산을 넘겼는데 계속 돌았다 — 발송 뒤라도 함수가 매달린다");
  const upsertCalls = slow.calls.filter((c) => c.fn === "upsert_baseball_genius_news_articles").length;
  assert.ok(upsertCalls < 3, `예산 초과 후에도 청크를 계속 보냈다 (${upsertCalls}회)`);
  assert.ok(timed.failedRows > 0, "버린 행이 집계되지 않았다");
  const timeoutCoverage = slow.calls.find((c) => c.fn === "record_baseball_genius_news_coverage")
    ?.rows as { status: string }[];
  assert.ok(
    timeoutCoverage.some((r) => r.status === "ingest_timeout"),
    "예산 초과가 커버리지에 ingest_timeout 으로 남지 않았다",
  );
  pass("발송 보호 (c) — 예산 초과 시 중단 + ingest_timeout 기록");

  // (d) 수집 실패 팀도 행이 남아야 "0건" 과 구분된다.
  const ok = recordingClient(() => ({ data: [{ inserted: 1, updated: 0, reembed_queued: 1 }], error: null }));
  await ingestNewsArticles(
    ok.client,
    [
      collection(1, 1),
      { teamId: 2, rows: [], truncated: false, pagesFetched: 0, error: "naver 500" },
      { teamId: 3, rows: [], truncated: true, pagesFetched: 2 },
    ],
    CLIP_DATE,
  );
  const rows = ok.calls.find((c) => c.fn === "record_baseball_genius_news_coverage")?.rows as {
    team_id: number;
    status: string;
    collected: number;
    truncated: boolean;
  }[];
  assert.equal(rows.length, 3, "팀 3개 전부 커버리지 행이 있어야 한다");
  assert.equal(rows.find((r) => r.team_id === 2)!.status, "collect_failed", "수집 실패가 0건과 뒤섞였다");
  assert.equal(rows.find((r) => r.team_id === 3)!.status, "ok");
  assert.equal(rows.find((r) => r.team_id === 3)!.truncated, true, "페이지 상한 절단이 기록되지 않았다");
  assert.equal(rows.find((r) => r.team_id === 3)!.collected, 0);
  pass("커버리지 원장 — 0건 / 수집실패 / 절단 구분");
}

// ── 4. DB 계약 (실제 migration 적용) ─────────────────────────────────────────

function fixtureVector(seed: number): string {
  return JSON.stringify(Array.from({ length: RAG_EMBEDDING_DIM }, (_, i) => Math.sin(seed + i) * 0.01));
}

function dbRow(key: string, teamIds: number[], hash = `hash-${key}`) {
  return {
    article_key: key,
    team_ids: teamIds,
    title: `제목 ${key}`,
    description: `발췌 ${key}`,
    link: `https://n.news.naver.com/${key}`,
    original_link: `https://n.news.naver.com/${key}`,
    press_host: "n.news.naver.com",
    published_at: NOW.toISOString(),
    content_hash: hash,
  };
}

async function verifyDbContract(): Promise<void> {
  const db = new PGlite({ extensions: { vector } });
  await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;");
  // Supabase 실제 형상 재현 — public 스키마의 default privileges 가 anon/authenticated 에
  // 자동으로 부여된다. 이걸 안 켜면 REVOKE 를 지워도 권한이 애초에 없어서 ACL 검사가
  // 항상 통과한다(=검출력 0). 실측으로 확인한 뒤 넣었다.
  await db.exec(
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;",
  );
  const migration = readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
  await db.exec(migration);
  await db.exec(migration); // 재적용 멱등
  pass("migration 멱등 적용");

  const rpc = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

  // ── 서빙 뷰 ACL (삼순 P0) ────────────────────────────────────────────────
  // security-definer 뷰는 소유자 권한으로 읽어 기저 테이블의 RLS 를 **우회**한다.
  // 그래서 테이블에 RLS 를 켠 것만으로는 보호가 안 된다 — 뷰에 직접 SELECT 하면 읽힌다.
  // service_role 전용 계약을 뷰 자체 ACL 로 자립시킨다.
  for (const role of ["anon", "authenticated"]) {
    const acl = await rpc<{ can: boolean }>(
      "SELECT has_table_privilege($1, 'public.genius_news_serving_articles', 'SELECT') AS can",
      [role],
    );
    assert.equal(
      acl[0].can,
      false,
      `${role} 이 서빙 뷰를 직접 SELECT 할 수 있다 — security-definer 뷰라 RLS 를 우회해 기사 원장이 그대로 노출된다`,
    );
  }
  const serviceAcl = await rpc<{ can: boolean }>(
    "SELECT has_table_privilege('service_role', 'public.genius_news_serving_articles', 'SELECT') AS can",
  );
  assert.equal(serviceAcl[0].can, true, "service_role 까지 막혔다 — 서버가 근거를 못 읽는다");

  // 기저 테이블도 같은 계약이어야 한다(뷰만 막고 테이블이 열려 있으면 우회 경로가 남는다).
  for (const role of ["anon", "authenticated"]) {
    const tableRls = await rpc<{ relrowsecurity: boolean }>(
      "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.genius_news_articles'::regclass",
    );
    assert.equal(tableRls[0].relrowsecurity, true, `기저 테이블 RLS 가 꺼져 있다 (${role} 관점)`);
  }
  pass("서빙 뷰 ACL — anon/authenticated SELECT 차단, service_role 만 허용");

  // ── 원자 병합 (P0) ────────────────────────────────────────────────────────
  // 1차: LG 쿼리로 잠실 더비 기사 적재.
  const first = await rpc<{ inserted: number; updated: number; reembed_queued: number }>(
    "SELECT * FROM public.upsert_baseball_genius_news_articles($1::jsonb)",
    [JSON.stringify([dbRow("derby", [1])])],
  );
  assert.deepEqual(
    { i: first[0].inserted, u: first[0].updated, r: first[0].reembed_queued },
    { i: 1, u: 0, r: 1 },
    "신규 적재 통계가 어긋난다",
  );

  // 벡터를 붙여 "이미 임베딩된 행" 을 만든다.
  await db.query(
    "UPDATE public.genius_news_articles SET embedding = $1::extensions.vector, embedded_at = now() WHERE article_key = 'derby'",
    [fixtureVector(1)],
  );

  // 2차: 두산 쿼리로 **같은 기사·같은 본문**이 다시 들어온다.
  const second = await rpc<{ inserted: number; updated: number; reembed_queued: number }>(
    "SELECT * FROM public.upsert_baseball_genius_news_articles($1::jsonb)",
    [JSON.stringify([dbRow("derby", [2])])],
  );
  assert.deepEqual(
    { i: second[0].inserted, u: second[0].updated, r: second[0].reembed_queued },
    { i: 0, u: 1, r: 0 },
    "본문이 그대로인데 재임베딩 대상이 되면 매일 전량 재임베딩이 돈다",
  );

  const merged = await rpc<{ team_ids: number[]; embedding: string | null }>(
    "SELECT team_ids, embedding::text FROM public.genius_news_articles WHERE article_key = 'derby'",
  );
  assert.deepEqual(merged[0].team_ids, [1, 2], "team_ids 가 합집합이 아니다 — 한쪽 팀 근거가 사라진다");
  assert.ok(merged[0].embedding !== null, "본문이 안 바뀌었는데 임베딩이 날아갔다");
  pass("원자 병합 — DB 안에서 team_ids 합집합 (조회 없음) + 임베딩 보존");

  // 본문이 바뀌면 임베딩 무효화 + 재임베딩 대기열 복귀.
  const changed = await rpc<{ reembed_queued: number }>(
    "SELECT * FROM public.upsert_baseball_genius_news_articles($1::jsonb)",
    [JSON.stringify([dbRow("derby", [3], "hash-changed")])],
  );
  assert.equal(changed[0].reembed_queued, 1, "본문 변경이 재임베딩 대기열로 돌아가지 않았다");
  const afterChange = await rpc<{ team_ids: number[]; embedding: string | null; embed_attempts: number }>(
    "SELECT team_ids, embedding::text, embed_attempts FROM public.genius_news_articles WHERE article_key = 'derby'",
  );
  assert.deepEqual(afterChange[0].team_ids, [1, 2, 3], "본문 변경 시에도 team_ids 는 합집합이어야 한다");
  assert.equal(afterChange[0].embedding, null, "본문이 바뀌었는데 옛 벡터가 남았다");
  assert.equal(afterChange[0].embed_attempts, 0, "재임베딩 시도 카운터가 초기화되지 않았다");
  pass("본문 변경 — 임베딩 무효화 + attempts 초기화 + team_ids 유지");

  // 같은 배치 안 중복 article_key — 합쳐지지 않으면 ON CONFLICT 가 배치 전체를 죽인다.
  const dup = await rpc<{ inserted: number }>(
    "SELECT * FROM public.upsert_baseball_genius_news_articles($1::jsonb)",
    [JSON.stringify([dbRow("dup", [1]), dbRow("dup", [5])])],
  );
  assert.equal(dup[0].inserted, 1, "배치 내 중복이 한 행으로 합쳐지지 않았다");
  const dupRow = await rpc<{ team_ids: number[] }>(
    "SELECT team_ids FROM public.genius_news_articles WHERE article_key = 'dup'",
  );
  assert.deepEqual(dupRow[0].team_ids, [1, 5], "배치 내 중복의 team_ids 가 합집합이 아니다");
  pass("배치 내 중복 article_key — 한 행으로 병합");

  // 잘못된 입력은 조용한 0행이 아니라 예외.
  await assert.rejects(
    db.query("SELECT * FROM public.upsert_baseball_genius_news_articles($1::jsonb)", [JSON.stringify({})]),
    /jsonb array/,
  );
  await assert.rejects(
    db.query("SELECT * FROM public.upsert_baseball_genius_news_articles($1::jsonb)", [
      JSON.stringify(Array.from({ length: 501 }, (_, i) => dbRow(`bulk-${i}`, [1]))),
    ]),
    /batch too large/,
    "상한 없는 배치는 한 번의 실수로 트랜잭션을 무한정 키운다",
  );
  pass("upsert RPC fail-close — 비배열 / 배치 상한");

  // ── 커버리지 원장 ─────────────────────────────────────────────────────────
  const coveragePayload = JSON.stringify([
    { clip_date: CLIP_DATE, team_id: 1, collected: 12, ingested: 12, truncated: false, pages_fetched: 2, status: "ok", detail: null },
    { clip_date: CLIP_DATE, team_id: 2, collected: 0, ingested: 0, truncated: false, pages_fetched: 0, status: "collect_failed", detail: "naver 500" },
  ]);
  const written = await rpc<{ record_baseball_genius_news_coverage: number }>(
    "SELECT public.record_baseball_genius_news_coverage($1::jsonb)",
    [coveragePayload],
  );
  assert.equal(written[0].record_baseball_genius_news_coverage, 2);
  await db.query("SELECT public.record_baseball_genius_news_coverage($1::jsonb)", [coveragePayload]);
  const coverageCount = await rpc<{ c: number }>(
    "SELECT count(*)::int AS c FROM public.genius_news_ingest_coverage",
  );
  assert.equal(coverageCount[0].c, 2, "커버리지가 재실행마다 누적되면 원장이 아니라 로그가 된다");
  await assert.rejects(
    db.query(
      "INSERT INTO public.genius_news_ingest_coverage (clip_date, team_id, status) VALUES ($1, 1, 'bogus')",
      [CLIP_DATE],
    ),
    /status/,
    "임의 status 가 들어가면 사후 분류가 무의미해진다",
  );
  pass("커버리지 원장 — 팀×날짜 멱등 upsert + status 폐쇄집합");

  // ── content_hash CAS (SQL 행동) ───────────────────────────────────────────
  await db.query("SELECT public.upsert_baseball_genius_news_articles($1::jsonb)", [
    JSON.stringify([dbRow("cas", [1], "hash-old")]),
  ]);
  // 임베딩하는 사이에 적재 cron 이 본문을 갱신했다.
  await db.query("SELECT public.upsert_baseball_genius_news_articles($1::jsonb)", [
    JSON.stringify([dbRow("cas", [1], "hash-new")]),
  ]);
  // 옛 hash 를 조건으로 한 write 는 0행이어야 한다.
  const staleWrite = await db.query(
    `UPDATE public.genius_news_articles
       SET embedding = $1::extensions.vector, embedded_at = now()
     WHERE article_key = 'cas' AND content_hash = 'hash-old'
     RETURNING article_key`,
    [fixtureVector(3)],
  );
  assert.equal(staleWrite.rows.length, 0, "옛 본문의 벡터가 새 본문 행에 붙었다");
  const casRow = await rpc<{ embedding: string | null }>(
    "SELECT embedding::text FROM public.genius_news_articles WHERE article_key = 'cas'",
  );
  assert.equal(casRow[0].embedding, null, "CAS 가 막았어야 할 write 가 통과했다");
  pass("content_hash CAS — 본문 변경 후 옛 벡터 write 0행");

  // ── 서빙/보유기간/RPC ────────────────────────────────────────────────────
  const insertServing = async (key: string, teamIds: number[], daysAgo: number, embedded = true) => {
    await db.query(
      `INSERT INTO public.genius_news_articles
         (article_key, team_ids, title, description, link, original_link, press_host,
          published_at, content_hash, embedding, embedded_at)
       VALUES ($1,$2,$3,$4,$5,$5,'n.news.naver.com', now() - ($6 || ' days')::interval, $7,
               $8::extensions.vector, $9::timestamptz)`,
      [
        key, teamIds, `제목 ${key}`, `발췌 ${key}`, `https://n.news.naver.com/${key}`,
        String(daysAgo), `hash-${key}`,
        embedded ? fixtureVector(1) : null,
        embedded ? new Date().toISOString() : null,
      ],
    );
  };
  await db.exec("DELETE FROM public.genius_news_articles");
  await insertServing("fresh-lg", [1], 1);
  await insertServing("fresh-doosan", [2], 2);
  await insertServing("cross-derby", [1, 2], 1);
  await insertServing("stale", [1], NEWS_RETENTION_DAYS + 2);
  await insertServing("unembedded", [1], 1, false);

  const served = await rpc<{ article_key: string }>(
    "SELECT article_key FROM public.genius_news_serving_articles ORDER BY article_key",
  );
  assert.deepEqual(
    served.map((r) => r.article_key),
    ["cross-derby", "fresh-doosan", "fresh-lg"],
    "서빙 뷰가 30일 초과분 또는 임베딩 전 행을 노출하고 있다",
  );
  pass("서빙 뷰 이중 차단 — 30일 초과 + embedding NULL 제외");

  // purge — 기사와 커버리지를 같은 창으로 정리하되 반환값은 기사 삭제 수.
  await db.query(
    "INSERT INTO public.genius_news_ingest_coverage (clip_date, team_id, status) VALUES ((now() - interval '40 days')::date, 1, 'ok')",
  );
  const purged = await rpc<{ purge_baseball_genius_news_articles: number }>(
    "SELECT public.purge_baseball_genius_news_articles()",
  );
  assert.equal(purged[0].purge_baseball_genius_news_articles, 1, "30일 초과 기사 1건이 삭제돼야 한다");
  const staleCoverage = await rpc<{ c: number }>(
    "SELECT count(*)::int AS c FROM public.genius_news_ingest_coverage WHERE clip_date < (now() - interval '30 days')::date",
  );
  assert.equal(staleCoverage[0].c, 0, "커버리지 원장이 무한 성장한다");
  pass("purge — 기사 물리 삭제 + 커버리지 동일 창 정리");

  await assert.rejects(
    db.query(
      `INSERT INTO public.genius_news_articles
         (article_key, team_ids, title, description, link, original_link, published_at, content_hash, embedding)
       VALUES ('pair-broken', ARRAY[1], 't', 'd', 'l', 'l', now(), 'h', $1::extensions.vector)`,
      [fixtureVector(2)],
    ),
    /genius_news_articles_embedding_pairing/,
  );
  await assert.rejects(
    db.query(
      `INSERT INTO public.genius_news_articles
         (article_key, team_ids, title, description, link, original_link, published_at, content_hash)
       VALUES ('no-team', ARRAY[]::integer[], 't', 'd', 'l', 'l', now(), 'h')`,
    ),
    /team_ids/,
  );
  await assert.rejects(
    db.query(
      `INSERT INTO public.genius_news_articles
         (article_key, team_ids, title, description, link, original_link, published_at, content_hash)
       VALUES ('bad-team', ARRAY[99], 't', 'd', 'l', 'l', now(), 'h')`,
    ),
    /team_ids/,
  );
  pass("행 계약 fail-close — embedding 짝 / 빈 team_ids / 범위 밖 구단");

  const hits = await rpc<{ article_key: string }>(
    "SELECT article_key FROM public.search_baseball_genius_news_articles($1, $2, 40)",
    [[2], fixtureVector(1)],
  );
  assert.deepEqual(
    hits.map((r) => r.article_key).sort(),
    ["cross-derby", "fresh-doosan"],
    "팀 귀속 필터가 잘못됐다",
  );
  pass("RPC — team_ids 교차 필터 (교차기사 포함)");

  await assert.rejects(
    db.query("SELECT * FROM public.search_baseball_genius_news_articles($1, $2, 40)", [[], fixtureVector(1)]),
    /team_ids is required/,
  );
  await assert.rejects(
    db.query("SELECT * FROM public.search_baseball_genius_news_articles($1, $2, 40)", [[99], fixtureVector(1)]),
    /unsupported team id/,
  );
  await assert.rejects(
    db.query("SELECT * FROM public.search_baseball_genius_news_articles($1, $2, 40)", [[1], "  "]),
    /query embedding is required/,
  );
  await assert.rejects(
    db.query("SELECT * FROM public.search_baseball_genius_news_articles($1, $2, 40)", [
      [1],
      JSON.stringify(new Array(RAG_EMBEDDING_DIM).fill(0)),
    ]),
    /degenerate/,
  );
  pass("RPC fail-close 4종 — 빈/범위밖 team_ids, 빈 embedding, 영벡터");

  const clamped = await rpc<{ c: number }>(
    "SELECT count(*)::int AS c FROM public.search_baseball_genius_news_articles($1, $2, 9999)",
    [[1], fixtureVector(1)],
  );
  assert.ok(clamped[0].c <= 50, "limit clamp 가 동작하지 않는다");
  pass("RPC limit clamp");

  await assert.rejects(
    db.query(
      `INSERT INTO public.genius_news_articles
         (article_key, team_ids, title, description, link, original_link, published_at, content_hash, embed_attempts)
       VALUES ('over-attempts', ARRAY[1], 't', 'd', 'l', 'l', now(), 'h', $1)`,
      [NEWS_EMBED_MAX_ATTEMPTS + 1],
    ),
    /embed_attempts/,
  );
  pass(`embed_attempts 상한 결속 (${NEWS_EMBED_MAX_ATTEMPTS})`);

  await db.close();
}

// ── 5. 백필 (발송 무접촉 + 날짜별 커버리지 + 깊이 한계) ──────────────────────

const BACKFILL_ROUTE = "src/app/api/cron/news-rag-backfill/route.ts";

function verifyBackfillIsolation(): void {
  const program = loadProgram([BACKFILL_ROUTE]);
  const source = program.getSourceFile(path.join(process.cwd(), BACKFILL_ROUTE));
  assert.ok(source, "백필 route 소스를 찾지 못했다");

  // 발송/요약/썸네일 경로를 하나라도 부르면 백필 1회에 과거 쪽지가 유저에게 나간다.
  const forbidden = ["buildTeamClipping", "sendTeamClipping", "selectAndSummarize", "fetchThumbnailUrl"];
  const calls = callPositions(source!, [...forbidden, "collectBackfillCandidates", "ingestNewsArticles"]);
  for (const name of forbidden) {
    assert.equal(
      calls.get(name),
      undefined,
      `백필 route 가 '${name}' 을 호출한다 — 발송 경로를 재사용하면 과거 쪽지가 유저에게 발송된다`,
    );
  }
  assert.ok(calls.get("collectBackfillCandidates") !== undefined, "백필 route 가 수집 함수를 호출하지 않는다");
  assert.ok(calls.get("ingestNewsArticles") !== undefined, "백필 route 가 적재를 호출하지 않는다");

  // dm_messages 직접 insert 도 금지 — 우회 발송 경로.
  assert.ok(
    !source!.getFullText().includes("dm_messages"),
    "백필 route 가 dm_messages 를 건드린다 — 어떤 형태로든 발송이면 안 된다",
  );
  pass("백필 격리 — 발송/요약/썸네일 경로 미호출, dm_messages 무접촉");

  // vercel.json cron 에 등록되면 안 된다(수동 실행 전용). 자동으로 돌면 매일 1,000건씩 재수집한다.
  const vercelConfig = JSON.parse(readFileSync(path.join(process.cwd(), "vercel.json"), "utf8")) as {
    crons?: { path: string }[];
  };
  const registered = (vercelConfig.crons ?? []).map((c) => c.path);
  assert.ok(
    !registered.includes("/api/cron/news-rag-backfill"),
    "백필이 cron 에 등록됐다 — 수동 실행 전용이며 자동 반복은 네이버 호출만 태운다",
  );
  // 반대로 일일 적재·임베딩 cron 은 반드시 등록돼 있어야 한다.
  assert.ok(registered.includes("/api/cron/news-clipping"), "일일 적재 cron 이 사라졌다");
  assert.ok(registered.includes("/api/cron/news-rag-embed"), "임베딩 cron 이 사라졌다");
  pass("cron 등록 — 백필 미등록 / 일일 적재·임베딩 등록");
}

/**
 * 깊이 한계 신호와 fan-out 을 **실제 collectBackfillCandidates 실행**으로 관측한다.
 *
 * AST/문자열 검사로는 `reachedApiLimit = true` 를 죽여도 GREEN 이었다(M16 실측).
 * 네이버 응답만 스텁으로 갈아끼우고 production 함수를 그대로 태운다.
 */
interface BackfillProbe {
  reachedApiLimit: boolean;
  pagesFetched: number;
  oldestReached: string | null;
  dayCount: number;
  queriesUsed: number;
  /** 실제로 호출된 쿼리 문자열(중복 없이, 호출 순서대로). */
  queries: string[];
  /** 쿼리별 요청 페이지 수 — start 상한 초과를 쿼리 단위로 검증한다. */
  pagesByQuery: Map<string, number>;
}

/**
 * @param depth 쿼리별로 "창을 덮었는지" 를 정한다. covered=true 인 쿼리는 창보다 오래된
 *              기사를 섞어 조기 종료시킨다. 실측 형상(broad 는 얕고 좁은 쿼리가 깊다)을 재현한다.
 */
async function captureBackfill(depth: (query: string) => boolean): Promise<BackfillProbe> {
  const { collectBackfillCandidates, NAVER_BACKFILL_MAX_START } = await import(
    "../../src/lib/news-clipping"
  );

  const untilDate = "2026-08-06";
  const sinceDate = "2026-07-24"; // 14일 창
  const maxPagesPerQuery = Math.floor(NAVER_BACKFILL_MAX_START / 100) + 1;
  const toPubDate = (kstDay: string, hh: number) =>
    new Date(`${kstDay}T${String(hh).padStart(2, "0")}:00:00+09:00`).toUTCString();

  const queries: string[] = [];
  const pagesByQuery = new Map<string, number>();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("openapi.naver.com")) return new Response("{}", { status: 500 });
    const parsed = new URL(url);
    const query = parsed.searchParams.get("query") ?? "";
    const start = Number(parsed.searchParams.get("start") ?? "1");
    if (!queries.includes(query)) queries.push(query);
    const page = (pagesByQuery.get(query) ?? 0) + 1;
    pagesByQuery.set(query, page);

    // 창을 덮는 쿼리는 2페이지째에 창보다 오래된 기사를 낸다 = 조기 종료.
    const beyondWindow = depth(query) && page === 2;
    const items = Array.from({ length: 100 }, (_, i) => ({
      title: `LG 트윈스 기사 ${page}-${i}`,
      description: "발췌 문장",
      link: `https://n.news.naver.com/mnews/article/001/${encodeURIComponent(query)}p${page}i${i}`,
      originallink: `https://www.chosun.com/${page}-${i}`,
      pubDate: beyondWindow
        ? toPubDate("2026-07-10", 3)
        : toPubDate(page === 1 ? untilDate : "2026-08-05", i % 20),
    }));
    return new Response(JSON.stringify({ items }), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await collectBackfillCandidates("LG", sinceDate, untilDate);
    // start 상한은 **쿼리 단위**다. 넘기면 네이버가 400 SE03 을 돌려준다.
    for (const [query, pages] of pagesByQuery) {
      assert.ok(
        pages <= maxPagesPerQuery,
        `쿼리 '${query}' 가 ${pages}페이지를 요청했다 — start 상한 초과 구간(400 SE03)이다`,
      );
    }
    return {
      reachedApiLimit: result.reachedApiLimit,
      pagesFetched: result.pagesFetched,
      oldestReached: result.oldestReached,
      dayCount: result.days.length,
      queriesUsed: result.queriesUsed,
      queries,
      pagesByQuery,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/**
 * 백필 경로의 근거 오염 가드 — **백필 함수를 직접 태운다.**
 *
 * M21 은 일일 sink 만 태워서 백필 scanQuery 의 relevance 누락을 GREEN 으로 통과시켰다(삼순 NO-GO).
 * 백필은 한 번에 수천 건을 밀어넣으므로 오염 규모가 오히려 더 크다.
 */
async function verifyBackfillRelevanceGuard(): Promise<void> {
  const { collectBackfillCandidates } = await import("../../src/lib/news-clipping");
  const untilDate = "2026-08-06";
  const sinceDate = "2026-07-24";
  const pubDate = new Date(`${untilDate}T05:00:00+09:00`).toUTCString();

  const naverItem = (title: string, description: string, id: string) => ({
    title,
    description,
    link: `https://n.news.naver.com/mnews/article/001/${id}`,
    originallink: `https://www.chosun.com/${id}`,
    pubDate,
  });

  const result = await withNaverResponse(
    () =>
      new Response(
        JSON.stringify({
          items: [
            naverItem("선두 KT, 한화 12-1 완파…(종합)", "두산 베어스는 잠실에서 LG 트윈스를 8-3으로 제압했다.", "keep1"),
            naverItem("LG 주가 급등, 코스피 상승 견인", "LG 트윈스 후원사 실적도 개선됐다.", "drop1"),
            naverItem("여자골프 박성현, 시즌 2승 도전", "국내 대회 최종 라운드가 열린다.", "drop2"),
          ],
        }),
        { status: 200 },
      ),
    () => collectBackfillCandidates("LG", sinceDate, untilDate),
  );

  const titles = result.days.flatMap((d) => d.items.map((i) => i.title));
  assert.ok(
    titles.some((t) => t.includes("(종합)")),
    "백필이 종합기사를 버렸다 — 근거로 필요한 기사가 빠진다",
  );
  assert.ok(
    !titles.some((t) => t.includes("주가")),
    "백필이 non-baseball negative(주가) 기사를 원장에 넣는다 — 일일 경로만 고쳐진 상태다",
  );
  assert.ok(
    !titles.some((t) => t.includes("여자골프")),
    "백필이 비야구 기사를 원장에 넣는다 — 2026-07-19 실재 회귀가 백필 경로로 재현된다",
  );
  pass(`백필 관련성 가드 — 종합기사 통과 / negative·비야구 차단 (${titles.length}건)`);
}

/**
 * 페이지 종료 판정은 **원응답 개수** 기준이어야 한다.
 * 필터 후 개수로 판정하면 비네이버 1건 탈락에 조기 종료해 과거를 통째로 놓친다(삼순 NO-GO).
 *
 * ⚠️ 총 페이지 수로 판정하면 안 된다 — 조기 종료해도 fan-out 쿼리가 그 숫자를 대신 채워
 *    GREEN 이 난다(실측). **쿼리 하나가 몇 페이지를 읽었는지**로 봐야 한다.
 */
async function verifyPageTerminationUsesRawCount(): Promise<void> {
  const { collectBackfillCandidates } = await import("../../src/lib/news-clipping");
  const untilDate = "2026-08-06";
  const sinceDate = "2026-07-24";
  const toPubDate = (d: string) => new Date(`${d}T05:00:00+09:00`).toUTCString();

  const pagesByQuery = new Map<string, number>();
  await withNaverResponse(
    (url) => {
      const parsed = new URL(url);
      const query = parsed.searchParams.get("query") ?? "";
      const start = Number(parsed.searchParams.get("start") ?? "1");
      pagesByQuery.set(query, (pagesByQuery.get(query) ?? 0) + 1);
      // 원응답은 항상 100건이지만 그 중 1건이 비네이버라 필터 후에는 99건이 된다.
      // 4페이지째에만 창 밖 날짜를 내보내 정상 종료시킨다.
      const day = start >= 301 ? "2026-07-01" : untilDate;
      const items = Array.from({ length: 100 }, (_, i) => ({
        title: `LG 트윈스 기사 ${start}-${i}`,
        description: "발췌",
        link:
          i === 0
            ? "https://sports.chosun.com/not-naver" // 필터에서 탈락 → items.length = 99
            : `https://n.news.naver.com/mnews/article/001/s${start}i${i}`,
        originallink: `https://www.chosun.com/${start}-${i}`,
        pubDate: toPubDate(day),
      }));
      return new Response(JSON.stringify({ items }), { status: 200 });
    },
    () => collectBackfillCandidates("LG", sinceDate, untilDate),
  );

  // broad 쿼리가 창을 덮으므로 fan-out 은 돌지 않아야 하고, 그 하나가 4페이지를 읽어야 한다.
  const broadQuery = [...pagesByQuery.keys()].find((q) => q.startsWith("프로야구"));
  assert.ok(broadQuery, "broad 쿼리가 호출되지 않았다");
  const broadPages = pagesByQuery.get(broadQuery!)!;
  assert.ok(
    broadPages >= 4,
    `필터 후 개수(99)로 조기 종료했다 — broad 쿼리가 ${broadPages}페이지만 읽었다. 비네이버 1건에 과거 수백 건을 놓친다`,
  );
  assert.equal(
    pagesByQuery.size,
    1,
    `창을 덮었는데 fan-out 쿼리가 추가로 돌았다 (${[...pagesByQuery.keys()].join(", ")}) — 조기 종료를 fan-out 이 가리고 있다`,
  );
  pass(`페이지 종료 판정 — 원응답 개수 기준 (broad ${broadPages}페이지, fan-out 0)`);
}

/**
 * sparse fan-out 이 건너뛴 날짜는 "기사 0건" 이 아니라 "안 본 날" 이어야 한다.
 * 200 `{}` 도 빈 성공이 아니라 malformed 다.
 */
async function verifyObservedDaysAndEmptyBody(): Promise<void> {
  const { collectBackfillCandidates, fetchNaverNews } = {
    ...(await import("../../src/lib/news-clipping")),
    ...(await import("../../src/lib/naver-news")),
  };
  const untilDate = "2026-08-06";
  const sinceDate = "2026-07-24";
  const toPubDate = (d: string) => new Date(`${d}T05:00:00+09:00`).toUTCString();

  // 08-06 과 07-25 만 있고 그 사이는 통째로 비어 있는 sparse 응답(실제 fan-out 형상).
  const sparseDays = ["2026-08-06", "2026-07-25"];
  const result = await withNaverResponse(
    () =>
      new Response(
        JSON.stringify({
          items: sparseDays.map((d, i) => ({
            title: `LG 트윈스 승리 ${i}`,
            description: "발췌",
            link: `https://n.news.naver.com/mnews/article/001/sparse${i}`,
            originallink: `https://www.chosun.com/${i}`,
            pubDate: toPubDate(d),
          })),
        }),
        { status: 200 },
      ),
    () => collectBackfillCandidates("LG", sinceDate, untilDate),
  );

  assert.deepEqual(
    [...result.observedDays].sort(),
    [...sparseDays].sort(),
    "관측한 날짜 집합이 기록되지 않았다 — 건너뛴 날짜를 '기사 0건' 과 구분할 수 없다",
  );
  const middleDay = "2026-07-30"; // 두 관측일 사이, 창 안쪽
  assert.ok(
    !result.observedDays.has(middleDay),
    `안 본 날짜(${middleDay})가 관측된 것으로 기록됐다 — 미관측이 0건으로 위장된다`,
  );

  // 200 이지만 items 가 없는 응답 — 빈 성공으로 받으면 커버리지가 'ok/0건' 이 된다.
  await assert.rejects(
    withNaverResponse(
      () => new Response("{}", { status: 200 }),
      () => fetchNaverNews("빈 바디", 1, 100),
    ),
    (e: unknown) => (e as { reason?: string }).reason === "malformed",
    "200 `{}` 를 빈 성공으로 받았다 — 게이트웨이 응답이 '그날 기사 0건' 으로 둔갑한다",
  );
  pass(`관측 날짜 추적 — sparse fan-out 미관측 구분 + 200 빈 바디 fail-close`);
}

/** RPC 타임아웃은 ingest_failed 가 아니라 ingest_timeout + timedOut=true 여야 한다. */
async function verifyRpcTimeoutIsRecordedAsTimeout(): Promise<void> {
  const hanging: NewsIngestClient = {
    rpc(fn) {
      // 커버리지 write 는 통과시켜야 상태 기록을 관측할 수 있다.
      if (fn === "record_baseball_genius_news_coverage") {
        return Promise.resolve({ data: 2, error: null });
      }
      return new Promise(() => {});
    },
  };

  const calls: unknown[][] = [];
  const spy: NewsIngestClient = {
    rpc(fn, args) {
      if (fn === "record_baseball_genius_news_coverage") calls.push(args.p_rows as unknown[]);
      // query-guard: bounded -- test double; forwards to an in-memory stub, never reaches a database
      return hanging.rpc(fn, args);
    },
  };

  const result = await ingestNewsArticles(
    spy,
    [collection(1, NEWS_UPSERT_CHUNK + 5), collection(2, 3)],
    CLIP_DATE,
  );

  assert.equal(
    result.timedOut,
    true,
    "RPC 타임아웃인데 timedOut=false 다 — 원장만 보고는 재시도가 필요한 상태인지 알 수 없다",
  );
  const rows = calls[0] as { status: string }[];
  assert.ok(rows, "커버리지가 기록되지 않았다");
  assert.ok(
    rows.every((r) => r.status === "ingest_timeout"),
    `타임아웃이 ingest_failed 로 오기록됐다 (${rows.map((r) => r.status).join(",")})`,
  );
  assert.ok(
    result.errors.some((e) => e.includes("timed out")),
    "타임아웃 사유가 보고되지 않았다",
  );
  pass("RPC 타임아웃 — ingest_timeout + timedOut=true 로 기록 (ingest_failed 아님)");
}

/** 백필 수집 단계에 전체 deadline 이 있어야 route 가 maxDuration 에 통째로 죽지 않는다. */
/**
 * 수집 deadline 은 **페이지 루프 안**에서 걸려야 한다.
 *
 * 앞선 판(M31)은 정규식으로 `Date.now() >= collectDeadline` 존재만 봤다. 그 검사는
 * 팀 *시작 전*에만 있었고, 한 팀이 일단 들어가면 7쿼리 × 10페이지를 끝까지 돌아
 * route maxDuration 을 넘길 수 있었다 — 정규식은 그걸 통과시켰다(삼순 NO-GO).
 * 그래서 이 판정은 **실제로 collectBackfillCandidates 를 느린 응답과 함께 실행**해서 한다.
 */
async function verifyBackfillCollectDeadline(): Promise<void> {
  const { collectBackfillCandidates } = await import("../../src/lib/news-clipping");
  const untilDate = "2026-08-06";
  const sinceDate = "2026-07-24";
  const toPubDate = (d: string) => new Date(`${d}T05:00:00+09:00`).toUTCString();

  // 창을 절대 못 덮는 응답(항상 오늘 날짜 100건) → 가드가 없으면 10페이지 × 7쿼리를 다 돈다.
  let calls = 0;
  const PER_CALL_MS = 25;
  const started = Date.now();
  // 3번째 호출 직후 예산이 끝나도록 잡는다.
  const deadlineAt = started + PER_CALL_MS * 3;

  const result = await withNaverResponse(
    async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, PER_CALL_MS));
      const items = Array.from({ length: 100 }, (_, i) => ({
        title: `LG 트윈스 승리 ${calls}-${i}`,
        description: "발췌",
        link: `https://n.news.naver.com/mnews/article/001/c${calls}i${i}`,
        originallink: `https://www.chosun.com/${calls}-${i}`,
        pubDate: toPubDate(untilDate),
      }));
      return new Response(JSON.stringify({ items }), { status: 200 });
    },
    () => collectBackfillCandidates("LG", sinceDate, untilDate, deadlineAt),
  );

  // 가드가 없으면 7쿼리 × 10페이지 = 70호출까지 간다.
  assert.ok(
    calls <= 6,
    `deadline 이 페이지 루프 안에서 안 걸린다 — ${calls}회 호출했다. 한 팀이 route 전체를 잡아먹는다`,
  );
  assert.equal(
    result.deadlineHit,
    true,
    "예산에 끊겼는데 deadlineHit=false 다 — 부분 결과가 완주로 보고된다",
  );

  // ── collector → 칸 편성 → 회차 판정까지 **실제 사슬**을 태운다.
  // deadlineHit 을 팀 리포트에만 남기면 판정은 collections 만 보므로 못 보고
  // `range_covered` 가 나온다. 그 결속이 살아 있는지는 여기서만 확인된다(삼순 NO-GO).
  const { buildBackfillCells, judgeBackfillOutcome } = await import(
    "../../src/lib/baseball-qa/rag/news-backfill-outcome"
  );
  const judgeBackfillOutcomeProbe = (cs: { apiUnreached?: boolean; error?: string }[]) =>
    judgeBackfillOutcome(cs, { failedRows: 0, timedOut: false, coverageWritten: cs.length });
  // KST 날짜 문자열을 그대로 더한다. `T00:00+09:00` + toISOString 은 UTC 로 되돌아가
  // 하루씩 밀린다(이 게이트를 처음 돌렸을 때 실제로 밀려서 관측칸이 0개가 됐다).
  const windowDates = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(`${sinceDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  assert.ok(
    windowDates.includes(untilDate),
    `창 계산이 어긋났다 — ${untilDate} 가 windowDates 에 없다 (${windowDates[0]}~${windowDates.at(-1)})`,
  );
  const cellInput = {
    teamId: 1,
    windowDates,
    result,
    rowsByDate: new Map(result.days.map((d) => [d.clipDate, d.items])),
  };
  const cells = buildBackfillCells({ ...cellInput, deadlineDetail: "budget exceeded" });
  assert.ok(
    cells.every((c) => c.error),
    "예산에 끊긴 팀인데 확인 완료로 표시된 칸이 있다 — 부분 수집이 완주로 위장된다",
  );

  // **사유 문구는 마커가 아니다.** 호출측이 빈 문구를 넘겨도(또는 아예 안 넘겨도)
  // deadlineHit 이 true 면 칸은 실패여야 한다. 게이트가 자기 문구만 태우면 route 가
  // 빈 값을 넘기는 결함을 놓친다 — M37 이 실제로 GREEN 이었다.
  for (const [label, detail] of [["빈 문자열", ""], ["공백", "   "], ["미지정", undefined]] as const) {
    const degraded = buildBackfillCells({ ...cellInput, deadlineDetail: detail });
    assert.ok(
      degraded.every((c) => c.error),
      `사유 문구가 ${label} 일 때 결속이 끊긴다 — 문구 하나로 부분 수집이 완주로 위장된다`,
    );
    assert.equal(
      judgeBackfillOutcomeProbe(degraded).ok,
      false,
      `사유 문구가 ${label} 인데 회차가 성공으로 판정된다`,
    );
  }

  // 관측된 날짜가 섞여 있어도(= apiUnreached 만으로는 안 잡히는 칸) 판정은 실패여야 한다.
  const observedCells = cells.filter((c) => !c.apiUnreached);
  assert.ok(
    observedCells.length > 0,
    "이 시나리오는 관측된 칸이 있어야 의미가 있다(그 칸이 deadline 을 통과하는지가 쟁점)",
  );
  const judged = judgeBackfillOutcome(cells, {
    failedRows: 0, timedOut: false, coverageWritten: cells.length,
  });
  assert.equal(
    judged.ok,
    false,
    "예산에 끊긴 회차인데 ok=true 다 — deadlineHit 이 판정 입력에 결속되지 않았다",
  );
  assert.equal(judged.label, "range_partial");
  // 실제 수집 결과는 error 와 apiUnreached 가 **겹친다**. 차감식이면 여기서 음수가 나온다.
  assert.ok(
    judged.coveredCells >= 0 && judged.coveredCells <= judged.cells,
    `coveredCells=${judged.coveredCells} 가 [0, ${judged.cells}] 밖이다 — 겹친 칸을 두 번 뺐다`,
  );
  assert.equal(judged.coveredCells, 0, "예산에 끊겼는데 확인된 칸이 있다고 보고한다");

  // route 가 이 사슬을 실제로 쓰는지 — 인라인으로 되돌아가면 이 결속이 다시 끊긴다.
  const routeText = readFileSync(path.join(process.cwd(), BACKFILL_ROUTE), "utf8");
  assert.ok(
    /buildBackfillCells\(/.test(routeText),
    "route 가 공용 칸 편성 함수를 쓰지 않는다 — 게이트가 검증한 결속이 production 과 다르다",
  );
  pass(
    `백필 deadline — 페이지 루프 차단(${calls}호출) + 관측칸 ${observedCells.length}개 포함 전 칸 range_partial`,
  );
}

/**
 * 회차 성공 판정 fail-close.
 *
 * 앞선 판은 `apiUnreached` 만 셌다. `collect_failed` 는 그 플래그를 달지 않으므로
 * 수집이 통째로 실패한 팀이 있어도 `ok:true + range_covered` 가 나왔다(삼순 NO-GO).
 * route 와 **같은 함수**를 직접 호출해 판정한다 — 게이트가 로직을 재구현하면 검출력이 0이다.
 */
async function verifyBackfillOutcomeFailClose(): Promise<void> {
  const { judgeBackfillOutcome } = await import("../../src/lib/baseball-qa/rag/news-backfill-outcome");
  const clean = Array.from({ length: 140 }, () => ({}));
  const okIngest = { failedRows: 0, timedOut: false, coverageWritten: 140 };

  // 파생 카운트는 **항상** 불변식을 만족해야 한다. ok/label 만 보면 음수 covered 가
  // GREEN 으로 통과한다 — 실제로 -13 이 나온 채 게이트가 통과했다(삼순 NO-GO).
  const assertCounts = (o: ReturnType<typeof judgeBackfillOutcome>, label: string) => {
    assert.ok(
      o.coveredCells >= 0 && o.coveredCells <= o.cells,
      `${label}: coveredCells=${o.coveredCells} 가 [0, ${o.cells}] 범위 밖이다 — 겹친 칸을 두 번 뺐다`,
    );
    assert.ok(o.unobservedCells >= 0 && o.unobservedCells <= o.cells, `${label}: unobservedCells 범위 밖`);
    assert.ok(o.failedCells >= 0 && o.failedCells <= o.cells, `${label}: failedCells 범위 밖`);
    assert.equal(
      o.ok,
      o.coveredCells === o.cells && !o.ingestFailed,
      `${label}: ok 와 covered/ingest 상태가 어긋난다`,
    );
  };

  const good = judgeBackfillOutcome(clean, okIngest);
  assert.equal(good.ok, true, "완전한 회차인데 ok=false 다");
  assert.equal(good.label, "range_covered");
  assert.equal(good.coveredCells, 140);
  assertCounts(good, "완전한 회차");

  // **겹친 칸** — 예산에 끊긴 팀은 14칸 전부 error 이고 그중 13칸은 apiUnreached 이기도 하다.
  // 차감식이면 14-13-14 = -13. 직접 세면 0 이어야 한다.
  const overlapped = [
    { error: "deadline", apiUnreached: false },
    ...Array.from({ length: 13 }, () => ({ error: "deadline", apiUnreached: true })),
  ];
  const overlapJudged = judgeBackfillOutcome(overlapped, {
    failedRows: 0, timedOut: false, coverageWritten: overlapped.length,
  });
  assertCounts(overlapJudged, "겹친 칸");
  assert.equal(
    overlapJudged.coveredCells,
    0,
    `겹친 칸에서 coveredCells=${overlapJudged.coveredCells} — 확인된 칸이 하나도 없는데 0 이 아니다`,
  );
  assert.equal(overlapJudged.ok, false);

  // ① 수집 실패 팀 하나(14칸) — apiUnreached 플래그는 없다.
  const withFailed = judgeBackfillOutcome(
    [...clean.slice(14), ...Array.from({ length: 14 }, () => ({ error: "collect failed" }))],
    okIngest,
  );
  assert.equal(
    withFailed.ok,
    false,
    "수집이 통째로 실패한 팀이 있는데 ok=true 다 — apiUnreached 만 세면 이렇게 된다",
  );
  assert.equal(withFailed.failedCells, 14);
  assert.equal(withFailed.label, "range_partial");
  assertCounts(withFailed, "수집 실패 팀");

  // ② 못 본 날짜
  const withUnobserved = judgeBackfillOutcome(
    [...clean.slice(1), { apiUnreached: true }],
    okIngest,
  );
  assert.equal(withUnobserved.ok, false, "미관측 칸이 있는데 ok=true 다");
  assert.equal(withUnobserved.unobservedCells, 1);
  assertCounts(withUnobserved, "미관측 칸");

  // ③ 적재 실패 3종은 각각 독립적으로 성공을 막아야 한다.
  for (const [label, ingest] of [
    ["행 적재 실패", { failedRows: 3, timedOut: false, coverageWritten: 140 }],
    ["예산 초과", { failedRows: 0, timedOut: true, coverageWritten: 140 }],
    ["커버리지 미기록", { failedRows: 0, timedOut: false, coverageWritten: 139 }],
  ] as const) {
    const judged = judgeBackfillOutcome(clean, ingest);
    assert.equal(judged.ok, false, `${label} 인데 ok=true 다`);
    assert.equal(judged.ingestFailed, true, `${label} 가 ingestFailed 로 안 잡힌다`);
    assertCounts(judged, label);
  }

  // route 가 이 함수를 실제로 쓰는지 — 자체 계산으로 돌아가면 판정이 갈라진다.
  const routeText = readFileSync(path.join(process.cwd(), BACKFILL_ROUTE), "utf8");
  assert.ok(
    /judgeBackfillOutcome\(/.test(routeText),
    "route 가 공용 판정 함수를 호출하지 않는다 — 게이트와 다른 판정을 하게 된다",
  );
  assert.ok(
    /status:\s*coverage\.ok\s*\?/.test(routeText),
    "판정 결과가 HTTP status 에 반영되지 않는다 — 실패한 회차가 200 으로 나간다",
  );
  pass("회차 판정 fail-close — collect_failed / 미관측 / 적재실패 3종 + 겹친 칸 카운트 불변식");
}

async function verifyBackfillDepthSignal(): Promise<void> {
  // (a) 어떤 쿼리도 창을 못 덮는다 → fan-out 을 다 써도 reachedApiLimit 이 참이어야 한다.
  const capped = await captureBackfill(() => false);
  assert.equal(
    capped.reachedApiLimit,
    true,
    "모든 쿼리가 창을 못 덮었는데 reachedApiLimit=false 다 — 미커버를 커버로 오인한다",
  );
  assert.ok(capped.queriesUsed > 1, `fan-out 이 동작하지 않았다 (queriesUsed=${capped.queriesUsed})`);
  assert.ok(capped.dayCount > 0, "창 안쪽 기사를 하나도 못 담았다");

  // (b) broad 하나로 창을 덮으면 fan-out 을 아예 쓰지 않아야 한다(불필요한 네이버 호출 0).
  const broadOnly = await captureBackfill((q) => q.startsWith("프로야구"));
  assert.equal(broadOnly.reachedApiLimit, false, "창을 덮었는데 reachedApiLimit=true 다");
  assert.equal(
    broadOnly.queriesUsed,
    1,
    `broad 로 창을 덮었는데 fan-out 쿼리를 더 썼다 (${broadOnly.queriesUsed}개) — 호출 낭비다`,
  );

  // (c) broad 는 얕고 좁은 쿼리가 깊은 실측 형상 — fan-out 이 실제로 창을 채워야 한다.
  //     LG 실측: `프로야구 LG 트윈스` 는 07-29 에서 끝나고 `LG 트윈스 부상` 은 07-09 까지 간다.
  const fannedOut = await captureBackfill((q) => q.includes("부상"));
  assert.equal(
    fannedOut.reachedApiLimit,
    false,
    "좁은 쿼리가 창을 덮었는데도 미커버로 보고했다 — fan-out 결과가 반영되지 않는다",
  );
  assert.ok(
    fannedOut.queriesUsed > 1 && fannedOut.queries.some((q) => q.includes("부상")),
    "창을 못 덮었는데 fan-out 쿼리를 추가하지 않았다",
  );
  pass(
    `백필 깊이/fan-out — 실제 수집 실행 관측 (미커버 ${capped.queriesUsed}q / broad 1q / fan-out ${fannedOut.queriesUsed}q)`,
  );
}

// ── 5-b. 삼순 P0 4건 actual RED ────────────────────────────────────────────
//
// 코드만 고치고 게이트를 안 묶으면 되돌려도 아무도 모른다(M19~M22 가 실제로 GREEN 이었다).
// 넷 다 문자열이 아니라 **실제 함수 실행**으로 관측한다.

/** 네이버 응답을 통째로 갈아끼운 채 fn 을 실행한다. */
async function withNaverResponse<T>(
  responder: (url: string) => Response | Promise<Response> | Promise<never>,
  fn: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("openapi.naver.com")) return new Response("{}", { status: 500 });
    return responder(url);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifyNaverFailureIsNotEmptiness(): Promise<void> {
  const { fetchNaverNews, NaverNewsError } = await import("../../src/lib/naver-news");

  // (a) 429/500 — 네이버는 실패에도 JSON 본문을 준다. items 가 없다고 "그날 기사 0건" 이 아니다.
  for (const status of [429, 500, 401]) {
    await assert.rejects(
      withNaverResponse(
        () => new Response(JSON.stringify({ errorMessage: "quota", errorCode: "SE99" }), { status }),
        () => fetchNaverNews("프로야구 LG 트윈스", 1, 100),
      ),
      (e: unknown) => e instanceof NaverNewsError && e.reason === "http" && e.status === status,
      `HTTP ${status} 가 빈 결과로 위장됐다 — 커버리지에 'ok/0건' 으로 남아 장애를 못 본다`,
    );
  }

  // (b) 스키마가 깨진 응답도 0건과 구분돼야 한다.
  await assert.rejects(
    withNaverResponse(
      () => new Response(JSON.stringify({ items: "not-an-array" }), { status: 200 }),
      () => fetchNaverNews("프로야구 LG 트윈스", 1, 100),
    ),
    (e: unknown) => e instanceof NaverNewsError && e.reason === "malformed",
  );
  await assert.rejects(
    withNaverResponse(
      () => new Response("<html>gateway timeout</html>", { status: 200 }),
      () => fetchNaverNews("프로야구 LG 트윈스", 1, 100),
    ),
    (e: unknown) => e instanceof NaverNewsError && e.reason === "malformed",
  );

  // (c) 네트워크 지연/중단도 마찬가지다.
  await assert.rejects(
    withNaverResponse(
      () => Promise.reject(new Error("socket hang up")),
      () => fetchNaverNews("프로야구 LG 트윈스", 1, 100),
    ),
    (e: unknown) => e instanceof NaverNewsError && e.reason === "timeout",
  );

  // (d) 정상 200 은 그대로 동작해야 한다(fail-close 가 과해서 정상까지 막으면 안 된다).
  const okItems = await withNaverResponse(
    () =>
      new Response(
        JSON.stringify({
          items: [
            {
              title: "LG 트윈스 승리",
              description: "발췌",
              link: "https://n.news.naver.com/mnews/article/001/1",
              originallink: "https://www.chosun.com/1",
              pubDate: new Date().toUTCString(),
            },
          ],
        }),
        { status: 200 },
      ),
    () => fetchNaverNews("프로야구 LG 트윈스", 1, 100),
  );
  assert.equal(okItems.length, 1, "정상 응답까지 막혔다");

  // (e) 수집이 던지면 sink 는 호출되지 않는다 → route 기본값 'not_collected' 가 남아
  //     커버리지가 collect_failed 로 기록된다(0건이 아니라).
  const { buildTeamClipping } = await import("../../src/lib/news-clipping");
  let sinkCalled = false;
  await assert.rejects(
    withNaverResponse(
      () => new Response("{}", { status: 429 }),
      () =>
        buildTeamClipping(1, "LG", "LG 트윈스", null, () => {
          sinkCalled = true;
        }),
    ),
  );
  assert.equal(sinkCalled, false, "수집이 실패했는데 sink 가 호출됐다 — 빈 수집이 성공으로 기록된다");
  pass("네이버 실패 fail-close — http/malformed/timeout 이 0건과 구분됨 (정상 200 무영향)");
}

async function verifyNaverRatePacing(): Promise<void> {
  const { fetchNaverNews, NAVER_MIN_INTERVAL_MS } = await import("../../src/lib/naver-news");

  // (a) 동시에 여러 호출을 던져도 게이트가 간격을 강제해야 한다.
  //     2026-08-07 실측: 팀 동시성 3으로 백필을 돌리자 첫 팀에서 바로 429 가 났다.
  //     일 한도(25,000)가 아니라 **초당 제한**이었다 — 전체 호출은 99회뿐이었다.
  const stamps: number[] = [];
  await withNaverResponse(
    () => {
      stamps.push(Date.now());
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    },
    () => Promise.all([1, 2, 3, 4].map((i) => fetchNaverNews(`페이싱 ${i}`, 1, 100))),
  );
  assert.equal(stamps.length, 4, "호출이 전부 나가지 않았다");
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
  const tooFast = gaps.filter((g) => g < NAVER_MIN_INTERVAL_MS * 0.8);
  assert.equal(
    tooFast.length,
    0,
    `동시 호출이 간격 없이 나갔다 (gaps=${gaps.join(",")}ms) — 실제 백필에서 429 로 절반쯤 빈 채 끝난다`,
  );

  // (b) 429 는 짧게 물러섰다가 재시도해서 살아나야 한다(일시적 초당 제한).
  let attempts = 0;
  const recovered = await withNaverResponse(
    () => {
      attempts += 1;
      if (attempts === 1) return new Response(JSON.stringify({ errorCode: "SE99" }), { status: 429 });
      return new Response(
        JSON.stringify({
          items: [
            {
              title: "LG 트윈스 승리",
              description: "발췌",
              link: "https://n.news.naver.com/mnews/article/001/1",
              originallink: "https://www.chosun.com/1",
              pubDate: new Date().toUTCString(),
            },
          ],
        }),
        { status: 200 },
      );
    },
    () => fetchNaverNews("재시도", 1, 100),
  );
  assert.ok(attempts >= 2, "429 를 재시도하지 않았다 — 일시적 제한에 수집이 통째로 실패한다");
  assert.equal(recovered.length, 1, "재시도 후에도 결과를 못 받았다");

  // (c) 계속 429 면 결국 throw 해야 한다. 조용한 부분 수집이 가장 나쁜 결과다.
  await assert.rejects(
    withNaverResponse(
      () => new Response(JSON.stringify({ errorCode: "SE99" }), { status: 429 }),
      () => fetchNaverNews("영구 429", 1, 100),
    ),
    (e: unknown) => (e as { status?: number }).status === 429,
    "429 가 지속되는데 빈 결과로 반환됐다 — 커버리지가 'ok/0건' 으로 위장된다",
  );
  pass(`네이버 호출 페이싱 — 동시 호출 간격 강제 + 429 재시도/최종 throw (min ${NAVER_MIN_INTERVAL_MS}ms)`);
}

async function verifyBackfillIsSequential(): Promise<void> {
  // 백필 route 가 팀을 병렬로 돌리면 위 페이싱 게이트를 통과해도 실제로는 429 를 유발한다.
  // 실측 형상(동시성 1)이 코드에 남아 있는지 AST 로 고정한다.
  const program = loadProgram([BACKFILL_ROUTE]);
  const source = program.getSourceFile(path.join(process.cwd(), BACKFILL_ROUTE));
  assert.ok(source, "백필 route 소스를 찾지 못했다");

  let concurrency: number | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "TEAM_CONCURRENCY" &&
      node.initializer &&
      ts.isNumericLiteral(node.initializer)
    ) {
      concurrency = Number(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source!);

  assert.notEqual(concurrency, null, "백필 route 의 TEAM_CONCURRENCY 를 찾지 못했다");
  assert.equal(
    concurrency,
    1,
    `백필이 팀을 ${concurrency}개씩 병렬 수집한다 — 2026-08-07 실측에서 동시성 3은 첫 팀부터 429 였다`,
  );
  pass("백필 순차 수집 — TEAM_CONCURRENCY=1 (429 실측 반영)");
}

async function verifyRelevanceGuardAtSink(): Promise<void> {
  const { buildTeamClipping } = await import("../../src/lib/news-clipping");
  const yesterday = (await import("../../src/lib/news-clipping")).kstDateString(-1);
  const pubDate = new Date(`${yesterday}T05:00:00+09:00`).toUTCString();

  const naverItem = (title: string, description: string, id: string) => ({
    title,
    description,
    link: `https://n.news.naver.com/mnews/article/001/${id}`,
    originallink: `https://www.chosun.com/${id}`,
    pubDate,
  });

  // 실재 회귀 표본(2026-07-19 하린아빠 제보 계열) + 핫클릭 묶음기사.
  const items = [
    // 통과해야 하는 것 — 카드에서는 타팀 제목으로 탈락하지만 근거로는 필요하다.
    naverItem(
      "선두 KT, 한화 12-1 완파…(종합)",
      "두산 베어스는 잠실에서 LG 트윈스를 8-3으로 제압했다.",
      "keep1",
    ),
    // 막아야 하는 것 1 — 제목에 non-baseball negative(주가). 야구 기사가 아니다.
    naverItem("LG 주가 급등, 코스피 상승 견인", "LG 트윈스 후원사 실적도 개선됐다.", "drop1"),
    // 막아야 하는 것 2 — 마스코트가 어디에도 없다. 야구 관련성 자체가 없다.
    naverItem("여자골프 박성현, 시즌 2승 도전", "국내 대회 최종 라운드가 열린다.", "drop2"),
  ];

  let captured: { title: string }[] = [];
  await withNaverResponse(
    () => new Response(JSON.stringify({ items }), { status: 200 }),
    async () => {
      try {
        await buildTeamClipping(1, "LG", "LG 트윈스", null, (_t, got) => {
          captured = got.map((i) => ({ title: i.title }));
        });
      } catch {
        // Gemini 요약 단계 실패는 이 검사와 무관하다 — sink 는 그 앞에서 호출된다.
      }
    },
  );

  const titles = captured.map((c) => c.title);
  assert.ok(
    titles.some((t) => t.includes("(종합)")),
    "카드에서 탈락하는 종합기사가 근거에서도 빠졌다 — 3피트 논란의 실제 근거가 사라진다",
  );
  assert.ok(
    !titles.some((t) => t.includes("주가")),
    "non-baseball negative(주가) 기사가 RAG 원장에 들어간다 — 야잘알봇이 증시 기사를 야구 근거로 인용한다",
  );
  assert.ok(
    !titles.some((t) => t.includes("여자골프")),
    "야구 관련성 없는 기사가 RAG 원장에 들어간다 — 2026-07-19 실재 회귀가 근거 계층에서 재현된다",
  );
  pass(`sink 관련성 가드 — 종합기사 통과 / negative·비야구 차단 (${titles.length}건 통과)`);
}

async function verifyRpcHardTimeout(): Promise<void> {
  // 응답을 영원히 안 주는 RPC. 예산 검사는 호출 **전**에만 도므로 이걸 못 끊으면
  // route 가 maxDuration 까지 끌려가 응답 자체가 죽는다.
  const hanging: NewsIngestClient = {
    rpc() {
      return new Promise(() => {});
    },
  };

  const started = Date.now();
  const result = await Promise.race([
    ingestNewsArticles(hanging, [collection(1, 3)], CLIP_DATE),
    new Promise<"never-returned">((resolve) => setTimeout(() => resolve("never-returned"), 40_000)),
  ]);
  const elapsed = Date.now() - started;

  assert.notEqual(
    result,
    "never-returned",
    "멈춘 RPC 를 못 끊는다 — 적재가 route 를 maxDuration 까지 끌고 가 응답이 통째로 죽는다",
  );
  assert.ok(elapsed < 40_000, `유한 시간에 끝나지 않았다 (${elapsed}ms)`);
  const ingest = result as Awaited<ReturnType<typeof ingestNewsArticles>>;
  assert.ok(ingest.failedRows > 0, "타임아웃된 청크가 실패로 집계되지 않았다");
  assert.ok(
    ingest.errors.some((e) => e.includes("timed out")),
    "타임아웃이 조용히 삼켜졌다 — 진단이 불가능해진다",
  );
  pass(`RPC hard timeout — 멈춘 호출을 ${elapsed}ms 에 끊고 실패로 보고`);
}

// ── 6. 백필 커버리지 원장 (날짜별 분리 + API미도달 구분) ────────────────

function backfillDay(
  d: string,
  teamId: number,
  n: number,
  extra: Partial<TeamCollection> = {},
): TeamCollection {
  return {
    teamId,
    clipDate: d,
    rows: Array.from({ length: n }, (_, i) => ({
      article_key: `${d}-${teamId}-${i}`,
      team_ids: [teamId],
      title: `제목 ${i}`,
      description: `발추 ${i}`,
      link: `https://n.news.naver.com/${d}-${teamId}-${i}`,
      original_link: `https://n.news.naver.com/${d}-${teamId}-${i}`,
      press_host: "n.news.naver.com",
      published_at: NOW.toISOString(),
      content_hash: `h-${d}-${teamId}-${i}`,
    })),
    truncated: false,
    pagesFetched: 10,
    ...extra,
  };
}

async function verifyBackfillCoverage(): Promise<void> {
  // 같은 팀이 여러 날짜에 걸린 백필. 날짜별로 커버리지가 분리돼야 한다.
  const ok = recordingClient(() => ({ data: [{ inserted: 1, updated: 0, reembed_queued: 1 }], error: null }));
  await ingestNewsArticles(
    ok.client,
    [
      backfillDay("2026-08-04", 1, 2, { queriesUsed: 1 }),
      backfillDay("2026-08-05", 1, 3, { queriesUsed: 1 }),
      // API 결과창 밖 — 기사가 없는 게 아니라 못 닿은 날짜다.
      backfillDay("2026-08-03", 1, 0, {
        apiUnreached: true,
        reachedApiLimit: true,
        oldestReached: "2026-08-04",
        queriesUsed: 7,
      }),
    ],
    "2026-08-06",
  );
  const rows = ok.calls.find((c) => c.fn === "record_baseball_genius_news_coverage")?.rows as {
    clip_date: string;
    collected: number;
    ingested: number;
    status: string;
    reached_api_limit: boolean;
    oldest_reached: string | null;
    queries_used: number;
  }[];
  assert.equal(rows.length, 3, "같은 팀의 서로 다른 날짜가 한 행으로 뭉개졌다");
  assert.deepEqual(
    rows.map((r) => r.clip_date).sort(),
    ["2026-08-03", "2026-08-04", "2026-08-05"],
    "커버리지가 기본 clipDate 로 덮어셬다 — 날짜별 근거량을 사후에 알 수 없다",
  );
  assert.equal(rows.find((r) => r.clip_date === "2026-08-05")!.collected, 3);
  assert.equal(rows.find((r) => r.clip_date === "2026-08-04")!.ingested, 2, "날짜별 적재 수가 섞였다");

  // 핵심 — 0건(ok) 과 API미도달을 구분해야 "N일 범위 확보" 를 증명할 수 있다.
  const unreached = rows.find((r) => r.clip_date === "2026-08-03")!;
  assert.equal(
    unreached.status,
    "api_unreached",
    "결과창 밖 날짜가 'ok/0건' 으로 기록됐다 — 근거가 없는 것과 못 가져온 것이 섞인다",
  );
  assert.equal(unreached.reached_api_limit, true, "결과창 한계 도달이 DB 에 보존되지 않았다");
  assert.equal(unreached.oldest_reached, "2026-08-04", "닿은 최고점이 DB 에 보존되지 않았다");
  assert.equal(unreached.queries_used, 7, "fan-out 쿼리 수가 DB 에 보존되지 않았다");
  pass("백필 커버리지 — (날짜, 팀) 분리 + api_unreached 구분 + 증명 컬럼 DB 보존");

  // 날짜별 실패가 격리되는지 — 한 청크 실패가 다른 날짜를 오염하면 안 된다.
  let call = 0;
  const partial = recordingClient((fn) => {
    if (fn !== "upsert_baseball_genius_news_articles") return { data: 3, error: null };
    call += 1;
    return call === 1 ? "throw" : { data: [{ inserted: 1, updated: 0, reembed_queued: 1 }], error: null };
  });
  await ingestNewsArticles(
    partial.client,
    [backfillDay("2026-08-04", 1, NEWS_UPSERT_CHUNK), backfillDay("2026-08-05", 2, 5)],
    "2026-08-06",
  );
  const partialRows = partial.calls.find((c) => c.fn === "record_baseball_genius_news_coverage")?.rows as {
    clip_date: string;
    status: string;
  }[];
  const statuses = new Set(partialRows.map((r) => r.status));
  assert.ok(statuses.has("ingest_failed"), "실패한 날짜가 표시되지 않았다");
  assert.ok(statuses.has("ok"), "한 청크 실패가 성공한 날짜까지 오염시켰다");
  pass("백필 — 청크 실패가 날짜별로 격리됨");
}

// ── run ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  verifyIngestFilters();
  verifyIdentity();
  verifyWiring();
  verifyBackfillIsolation();
  await verifyTruncationSignal();
  await verifySendProtection();
  await verifyNaverFailureIsNotEmptiness();
  await verifyNaverRatePacing();
  await verifyBackfillIsSequential();
  await verifyRelevanceGuardAtSink();
  await verifyRpcHardTimeout();
  await verifyBackfillRelevanceGuard();
  await verifyPageTerminationUsesRawCount();
  await verifyObservedDaysAndEmptyBody();
  await verifyRpcTimeoutIsRecordedAsTimeout();
  await verifyBackfillCollectDeadline();
  await verifyBackfillOutcomeFailClose();
  await verifyBackfillDepthSignal();
  await verifyBackfillCoverage();
  await verifyDbContract();
  console.log(`\n${passed} PASS — 기사 근거 적재 계약`);
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
