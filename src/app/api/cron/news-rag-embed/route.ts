import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as admin } from "@/lib/supabase/admin";
import { embedText } from "@/lib/baseball-qa/rag/embed";
import {
  articleContent,
  NEWS_EMBED_MAX_ATTEMPTS,
  NEWS_RETENTION_DAYS,
} from "@/lib/baseball-qa/rag/news-articles";

// 야잘알봇 기사 근거 임베딩 + 30일 purge cron.
//
// 왜 적재와 분리했나
//   뉴스클리핑 cron(09:00)은 이미 팀 10개 × (네이버 2p + Gemini + OG 5) + 쪽지 bulk insert 로
//   maxDuration 300 을 쓰고 있다. 거기에 수백 건 임베딩까지 얹으면 클리핑 발송이 타임아웃으로
//   죽는다. 유저 발송이 근거 적재보다 우선이므로 임베딩은 별도 cron 으로 뺐다.
//
// 계약
//   · 임베딩 실패는 attempts 를 올리고 다음 회차로 넘긴다. 상한(NEWS_EMBED_MAX_ATTEMPTS) 도달 시
//     대기열에서 빠진다 — 영구 실패 행이 매 회차 예산을 먹지 않게.
//   · purge 는 매 실행마다 돌린다. 서빙 뷰 술어와 이중 방어라 한쪽이 밀려도 낡은 기사는 안 새어나온다.
//   · 임베딩 대상은 published_at DESC — 최신 기사가 먼저 검색 가능해진다.
//   · **벡터 write 는 content_hash CAS.** 임베딩은 수백 ms~초가 걸리고, 그 사이에 적재 cron 이
//     같은 기사의 본문을 갱신할 수 있다(네이버 발췌는 실제로 바뀐다). 읽을 때의 hash 를 조건으로
//     걸지 않으면 **새 본문에 옛 본문의 벡터**가 붙고, content_hash 는 이미 갱신돼 있어
//     불일치를 영원히 발견할 수 없게 된다.

export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET || "";

/** 회차당 임베딩 상한. Gemini rate limit(429) 과 maxDuration 안에서 끝나도록 잡은 값. */
const EMBED_BATCH = 120;
/** 동시 임베딩 수. 나무위키 적재에서 concurrency 4 이상은 http_429 를 유발했다(실측). */
const EMBED_CONCURRENCY = 2;

function authorized(req: NextRequest): boolean {
  // fail-closed — env 미설정이면 전부 거부
  return Boolean(CRON_SECRET) && req.headers.get("authorization") === `Bearer ${CRON_SECRET}`;
}

interface PendingArticle {
  article_key: string;
  title: string;
  description: string;
  embed_attempts: number;
  content_hash: string;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }

  // 1) 30일 초과 물리 삭제. 임베딩보다 먼저 — 버릴 기사를 임베딩하는 낭비를 막는다.
  let purged: number | null = null;
  // query-guard: bounded -- the purge RPC returns a single integer row count, never a row set
  const { data: purgeData, error: purgeError } = await admin.rpc(
    "purge_baseball_genius_news_articles",
  );
  if (purgeError) {
    // purge 실패가 임베딩까지 막을 이유는 없다. 서빙 뷰 술어가 낡은 기사를 이미 차단하고 있다.
    console.error("[news-rag-embed] purge failed:", purgeError.message);
  } else {
    purged = typeof purgeData === "number" ? purgeData : null;
  }

  // 2) 임베딩 대기열 — 보유기간 안 + embedding 없음 + 재시도 여유.
  const retentionFloor = new Date(
    Date.now() - NEWS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  // query-guard: bounded -- EMBED_BATCH caps one run on purpose; the remaining backlog is drained by the next hourly run
  const { data: pending, error: pendingError } = await admin
    .from("genius_news_articles")
    .select("article_key, title, description, embed_attempts, content_hash")
    .is("embedding", null)
    .lt("embed_attempts", NEWS_EMBED_MAX_ATTEMPTS)
    .gte("published_at", retentionFloor)
    .order("published_at", { ascending: false })
    .limit(EMBED_BATCH);

  if (pendingError) {
    return NextResponse.json(
      { error: "pending_query_failed", detail: pendingError.message, purged },
      { status: 500 },
    );
  }

  const rows = (pending ?? []) as PendingArticle[];
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, purged, pending: 0, embedded: 0, failed: 0 });
  }

  let embedded = 0;
  let failed = 0;
  let staleSkipped = 0;

  const results = await mapWithConcurrency(rows, EMBED_CONCURRENCY, async (row) => {
    const content = articleContent(row.title, row.description);
    const result = await embedText(content, "document", fetch, row.title);
    return { row, result };
  });

  for (const { row, result } of results) {
    if (!result.ok) {
      failed += 1;
      const { error } = await admin
        .from("genius_news_articles")
        .update({
          embed_attempts: row.embed_attempts + 1,
          last_embed_error: result.reason,
          updated_at: new Date().toISOString(),
        })
        .eq("article_key", row.article_key);
      if (error) console.error("[news-rag-embed] attempt bump failed:", error.message);
      continue;
    }

    const now = new Date().toISOString();
    // CAS — 임베딩하는 사이에 본문이 바뀌었으면(content_hash 불일치) 쓰지 않는다.
    // 그 행은 적재 cron 이 이미 embedding=NULL 로 되돌렸으므로 다음 회차가 새 본문으로 다시 집는다.
    const { data: written, error } = await admin
      .from("genius_news_articles")
      .update({
        // DB CHECK(embedding IS NULL) = (embedded_at IS NULL) 계약에 맞춰 항상 함께 쓴다.
        embedding: JSON.stringify(result.vector),
        embedded_at: now,
        last_embed_error: null,
        updated_at: now,
      })
      .eq("article_key", row.article_key)
      .eq("content_hash", row.content_hash)
      .select("article_key");
    if (error) {
      failed += 1;
      console.error("[news-rag-embed] embedding write failed:", error.message);
      continue;
    }
    if (!written || written.length === 0) {
      // 손실이 아니다 — 본문이 바뀌었으므로 이 벡터를 붙이는 것 자체가 오류였다.
      staleSkipped += 1;
      continue;
    }
    embedded += 1;
  }

  return NextResponse.json({
    ok: true,
    purged,
    pending: rows.length,
    embedded,
    failed,
    staleSkipped,
  });
}
