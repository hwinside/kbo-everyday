// 야잘알봇 기사 근거 적재 실행부 — **발송 경로에서 격리된** 부가 작업.
//
// 이 파일이 지키는 세 가지 (삼순 P0)
//   1. 발송 보호. 적재는 유저 쪽지 발송이 **끝난 뒤** 남은 예산 안에서만 돈다.
//      던지지 않고(모든 경로 try/catch), 예산을 넘기면 스스로 멈춘다. 적재가 느리거나
//      죽어도 쪽지가 안 나가는 일은 구조적으로 생길 수 없다.
//   2. 원자 병합. team_ids 합집합은 DB(ON CONFLICT DO UPDATE) 안에서 계산한다.
//      read→union→write 가 없으므로 "조회 실패 후 덮어쓰기"·"동시 실행 lost update" 상태가
//      존재할 수 없다. 조회 실패라는 단계 자체가 사라졌다.
//   3. 커버리지 원장. 팀×날짜로 무엇이 얼마나 들어왔는지·왜 못 들어왔는지를 남긴다.
//      "어제 롯데 기사 0건" 과 "수집 실패" 와 "페이지 상한 절단" 이 사후에 구분된다.

import type { NewsArticleRow } from "./news-articles";

/** RPC 한 번에 보내는 행 수. DB 함수의 batch 상한(500)과 결속돼 있다. */
export const NEWS_UPSERT_CHUNK = 200;

/** 적재 전체 예산(ms). 이 시간을 넘기면 남은 청크를 버리고 커버리지에 기록한다. */
export const NEWS_INGEST_BUDGET_MS = 25_000;

/**
 * RPC 하나가 멈췄을 때 끊어내는 상한(ms).
 *
 * 왜 전체 예산만으로는 부족한가 (삼순 NO-GO)
 *   예산 검사는 RPC 를 보내기 **전**에만 일어난다. 첫 번째 RPC 가 응답을 안 주면
 *   `await` 에서 무한정 매달려 예산 로직은 다시 실행되지도 않는다. 그러면 route 가
 *   maxDuration 까지 끌려가 응답이 통째로 죽는다. 호출 단위로도 스스로 끊어야 한다.
 */
export const NEWS_RPC_TIMEOUT_MS = 10_000;

export type CoverageStatus =
  | "ok"
  | "collect_failed"
  | "ingest_failed"
  | "ingest_timeout"
  /** 검색 API 결과창 때문에 그날까지 닿지도 못했다. 기사가 없어 0건인 'ok' 과 다르다. */
  | "api_unreached";

export interface CoverageRow {
  clip_date: string;
  team_id: number;
  collected: number;
  ingested: number;
  truncated: boolean;
  pages_fetched: number;
  status: CoverageStatus;
  detail: string | null;
  reached_api_limit: boolean;
  oldest_reached: string | null;
  queries_used: number;
}

/** 팀별 수집 결과. 수집이 실패한 팀도 행이 남아야 사후에 0건과 구분된다. */
export interface TeamCollection {
  teamId: number;
  rows: NewsArticleRow[];
  truncated: boolean;
  pagesFetched: number;
  error?: string;
  /**
   * 커버리지 원장에 기록할 날짜. 생략하면 호출 시 넘긴 기본 clipDate 를 쓴다.
   * 일일 cron 은 "어제" 하나라 생략하고, 백필은 기사 발행일별로 나눠 넘긴다 —
   * 그래야 "7/31 롯데 근거가 몇 건이냐" 를 사후에 답할 수 있다.
   */
  clipDate?: string;
  /** 수집은 돌았으나 검색 API 결과창 때문에 이 날짜에 닿지 못했다. 0건과 구분된다. */
  apiUnreached?: boolean;
  reachedApiLimit?: boolean;
  oldestReached?: string | null;
  queriesUsed?: number;
}

export interface NewsIngestResult {
  collected: number;
  inserted: number;
  updated: number;
  reembedQueued: number;
  failedRows: number;
  timedOut: boolean;
  coverageWritten: number;
  errors: string[];
}

interface UpsertRpcRow {
  inserted: number | null;
  updated: number | null;
  reembed_queued: number | null;
}

/**
 * 적재에 필요한 최소 인터페이스만 요구한다 — 게이트가 실제 함수를 그대로 태울 수 있게.
 * Supabase 클라이언트의 rpc 는 thenable builder 라 Promise 가 아니므로 PromiseLike 로 받는다.
 */
export interface NewsIngestClient {
  rpc(
    fn: "upsert_baseball_genius_news_articles" | "record_baseball_genius_news_coverage",
    args: { p_rows: unknown },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * RPC 호출에 hard timeout 을 씨운다. 남은 예산과 호출 상한 중 **짧은 쪽**을 쓴다 —
 * 전체 예산이 3초 남았는데 10초짜리 RPC 를 기다리면 예산이 무의미해진다.
 *
 * 타임아웃된 호출은 버리는 것이지 취소하는 게 아니다(PostgREST 에는 취소 수단이 없다).
 * 적재는 멱등(article_key upsert)이라 다음 회차가 다시 집어도 안전하다.
 */
/**
 * RPC 가 상한 안에 응답하지 않은 경우. 일반 실패(ingest_failed)와 **반드시 구분**한다 —
 * 타임아웃은 "적재가 거부됐다" 가 아니라 "시간이 없어 못 끝냈다" 이고, 다음 회차가 이어받는다.
 * 이걸 ingest_failed 로 접으면 원장만 보고는 재시도가 필요한 상태인지 알 수 없다(삼순 NO-GO).
 */
export class NewsRpcTimeoutError extends Error {
  constructor(fn: string, limitMs: number) {
    super(`rpc ${fn} timed out after ${limitMs}ms`);
    this.name = "NewsRpcTimeoutError";
  }
}

async function rpcWithTimeout(
  client: NewsIngestClient,
  fn: "upsert_baseball_genius_news_articles" | "record_baseball_genius_news_coverage",
  rows: unknown,
  remainingMs: number,
): Promise<{ data: unknown; error: { message: string } | null }> {
  const limit = Math.max(1, Math.min(NEWS_RPC_TIMEOUT_MS, remainingMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // query-guard: bounded -- both callees are allowlisted bounded RPCs (upsert returns exactly one summary row; coverage returns a single integer) and the caller chunks rows to NEWS_UPSERT_CHUNK
      Promise.resolve(client.rpc(fn, { p_rows: rows })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NewsRpcTimeoutError(fn, limit)), limit);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 팀별 수집분을 원장에 적재하고 커버리지를 남긴다.
 *
 * 계약
 *   · **절대 throw 하지 않는다.** 호출측이 try/catch 를 잊어도 발송이 죽지 않아야 한다.
 *   · 예산(now + budgetMs) 초과 시 남은 청크를 버리고 timedOut=true 로 보고한다.
 *   · 실패한 청크의 행은 failedRows 로만 잡히고, 그 팀 커버리지는 ingest_failed 가 된다.
 *   · 커버리지 기록은 적재가 전부 실패해도 시도한다 — 실패 사실 자체가 원장의 존재 이유다.
 */
export async function ingestNewsArticles(
  client: NewsIngestClient,
  collections: TeamCollection[],
  clipDate: string,
  options: { budgetMs?: number; now?: () => number } = {},
): Promise<NewsIngestResult> {
  const budgetMs = options.budgetMs ?? NEWS_INGEST_BUDGET_MS;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + budgetMs;

  const result: NewsIngestResult = {
    collected: 0,
    inserted: 0,
    updated: 0,
    reembedQueued: 0,
    failedRows: 0,
    timedOut: false,
    coverageWritten: 0,
    errors: [],
  };

  // 상태는 (날짜, 팀) 단위다 — 백필은 한 팀이 여러 날짜에 걸친다. 팀 단위로 잡으면
  // 날짜가 섞여 한 날의 실패가 다른 날을 덮어버린다. 수집 실패 칸도 반드시 행을 남긴다.
  const coverageKey = (dateValue: string, teamId: number) => `${dateValue}:${teamId}`;
  const status = new Map<string, { ingested: number; status: CoverageStatus; detail: string | null }>();
  for (const collection of collections) {
    status.set(coverageKey(collection.clipDate ?? clipDate, collection.teamId), {
      ingested: 0,
      status: collection.error
        ? "collect_failed"
        : collection.apiUnreached
          ? "api_unreached"
          : "ok",
      detail: collection.error ?? (collection.apiUnreached ? "search result window exhausted" : null),
    });
  }

  // 한 기사가 여러 팀에 걸리므로 article_key 로 묶어 한 번만 보낸다.
  // 어떤 커버리지 칸의 몫인지는 성공/실패를 되돌리기 위해 함께 들고 간다.
  const byKey = new Map<string, { row: NewsArticleRow; keys: Set<string> }>();
  for (const collection of collections) {
    const key = coverageKey(collection.clipDate ?? clipDate, collection.teamId);
    for (const row of collection.rows) {
      const existing = byKey.get(row.article_key);
      if (existing) {
        existing.keys.add(key);
        for (const teamId of row.team_ids) {
          if (!existing.row.team_ids.includes(teamId)) existing.row.team_ids.push(teamId);
        }
        continue;
      }
      byKey.set(row.article_key, {
        row: { ...row, team_ids: [...row.team_ids] },
        keys: new Set([key]),
      });
    }
  }
  const entries = [...byKey.values()];
  for (const entry of entries) entry.row.team_ids.sort((a, b) => a - b);
  result.collected = entries.length;

  for (let i = 0; i < entries.length; i += NEWS_UPSERT_CHUNK) {
    const chunk = entries.slice(i, i + NEWS_UPSERT_CHUNK);

    if (now() >= deadline) {
      // 예산 초과 — 남은 행은 다음 회차가 가져간다(수집은 매일 돌고 article_key 는 안정적이다).
      result.timedOut = true;
      result.failedRows += entries.length - i;
      for (let j = i; j < entries.length; j++) {
        for (const key of entries[j].keys) {
          const s = status.get(key);
          if (s && s.status === "ok") {
            s.status = "ingest_timeout";
            s.detail = `budget ${budgetMs}ms exceeded`;
          }
        }
      }
      break;
    }

    try {
      const { data, error } = await rpcWithTimeout(
        client,
        "upsert_baseball_genius_news_articles",
        chunk.map((entry) => entry.row),
        deadline - now(),
      );
      if (error) throw new Error(error.message);

      const stats = (Array.isArray(data) ? data[0] : data) as UpsertRpcRow | null;
      result.inserted += stats?.inserted ?? 0;
      result.updated += stats?.updated ?? 0;
      result.reembedQueued += stats?.reembed_queued ?? 0;

      for (const entry of chunk) {
        for (const key of entry.keys) {
          const s = status.get(key);
          if (s) s.ingested += 1;
        }
      }
    } catch (e) {
      const message = errorMessage(e);
      const timedOut = e instanceof NewsRpcTimeoutError;
      result.failedRows += chunk.length;
      result.errors.push(message);
      // 타임아웃은 진행 불가 신호다. 남은 청크를 계속 밀어봐야 같은 벽에 부딪히고
      // route 만 더 끌고 간다 — 여기서 멈추고 나머지를 ingest_timeout 으로 남긴다.
      if (timedOut) result.timedOut = true;
      console.error("[news-rag-ingest] upsert failed:", message);
      for (const entry of chunk) {
        for (const key of entry.keys) {
          const s = status.get(key);
          if (s && s.status === "ok") {
            s.status = timedOut ? "ingest_timeout" : "ingest_failed";
            s.detail = message;
          }
        }
      }
      if (timedOut) {
        const remaining = entries.length - (i + chunk.length);
        result.failedRows += remaining;
        for (let j = i + chunk.length; j < entries.length; j++) {
          for (const key of entries[j].keys) {
            const s = status.get(key);
            if (s && s.status === "ok") {
              s.status = "ingest_timeout";
              s.detail = message;
            }
          }
        }
        break;
      }
    }
  }

  const coverage: CoverageRow[] = collections.map((collection) => {
    const rowDate = collection.clipDate ?? clipDate;
    const s = status.get(coverageKey(rowDate, collection.teamId))!;
    return {
      clip_date: rowDate,
      team_id: collection.teamId,
      collected: collection.rows.length,
      ingested: s.ingested,
      truncated: collection.truncated,
      pages_fetched: collection.pagesFetched,
      status: s.status,
      detail: s.detail,
      reached_api_limit: collection.reachedApiLimit ?? false,
      oldest_reached: collection.oldestReached ?? null,
      queries_used: collection.queriesUsed ?? 0,
    };
  });

  if (coverage.length > 0) {
    try {
      // 커버리지는 예산을 이미 써버렸어도 반드시 시도한다 — 실패 사실 자체가 원장의 존재 이유다.
      // 다만 그 쓰기도 무한정 매달리면 안 되므로 호출 상한은 그대로 걸어둔다.
      const { data, error } = await rpcWithTimeout(
        client,
        "record_baseball_genius_news_coverage",
        coverage,
        NEWS_RPC_TIMEOUT_MS,
      );
      if (error) throw new Error(error.message);
      result.coverageWritten = typeof data === "number" ? data : coverage.length;
    } catch (e) {
      const message = errorMessage(e);
      result.errors.push(`coverage: ${message}`);
      console.error("[news-rag-ingest] coverage write failed:", message);
    }
  }

  return result;
}
