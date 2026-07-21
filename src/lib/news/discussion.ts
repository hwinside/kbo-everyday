import { createHash } from "node:crypto";

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
]);

const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 200;
const MAX_SOURCE_LENGTH = 100;

export interface NewsDiscussionInput {
  url: string;
  canonicalUrl?: string | null;
  title: string;
  source?: string | null;
  thumbnailUrl?: string | null;
  teamId?: number | null;
}

export interface ParsedNewsDiscussionInput {
  articleKey: string;
  canonicalUrl: string;
  sourceUrl: string;
  title: string;
  source: string | null;
  thumbnailUrl: string | null;
  teamId: number | null;
}

export class NewsDiscussionInputError extends Error {}

function parseHttpUrl(value: unknown, field: string): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw new NewsDiscussionInputError(`${field} must be a valid URL`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new NewsDiscussionInputError(`${field} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NewsDiscussionInputError(`${field} must use http or https`);
  }
  return parsed;
}

/** 같은 기사의 추적 파라미터/fragment 변형을 하나의 댓글방 키로 정규화한다. */
export function normalizeArticleUrl(value: string): string {
  const url = parseHttpUrl(value, "url");
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";

  const kept = [...url.searchParams.entries()]
    .filter(([key]) => {
      const lower = key.toLowerCase();
      return !lower.startsWith("utm_") && !TRACKING_PARAMS.has(lower);
    })
    .sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
  url.search = "";
  for (const [key, val] of kept) url.searchParams.append(key, val);

  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function articleKeyForUrl(normalizedUrl: string): string {
  return createHash("sha256").update(normalizedUrl).digest("hex");
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new NewsDiscussionInputError("invalid text field");
  return value.trim().slice(0, maxLength) || null;
}

export function parseNewsDiscussionInput(value: unknown): ParsedNewsDiscussionInput {
  if (!value || typeof value !== "object") {
    throw new NewsDiscussionInputError("request body must be an object");
  }
  const input = value as Record<string, unknown>;
  const sourceUrl = parseHttpUrl(input.url, "url").toString();
  const canonicalCandidate = input.canonicalUrl || sourceUrl;
  const canonicalUrl = normalizeArticleUrl(String(canonicalCandidate));

  if (typeof input.title !== "string" || !input.title.trim()) {
    throw new NewsDiscussionInputError("title is required");
  }
  const title = input.title.replace(/<[^>]*>/g, "").trim().slice(0, MAX_TITLE_LENGTH);
  if (!title) throw new NewsDiscussionInputError("title is required");

  const source = optionalText(input.source, MAX_SOURCE_LENGTH);
  const thumbnailUrl = optionalText(input.thumbnailUrl, MAX_URL_LENGTH);
  if (thumbnailUrl) parseHttpUrl(thumbnailUrl, "thumbnailUrl");

  let teamId: number | null = null;
  if (input.teamId !== undefined && input.teamId !== null) {
    if (!Number.isInteger(input.teamId) || Number(input.teamId) < 1 || Number(input.teamId) > 10) {
      throw new NewsDiscussionInputError("teamId must be between 1 and 10");
    }
    teamId = Number(input.teamId);
  }

  return {
    articleKey: articleKeyForUrl(canonicalUrl),
    canonicalUrl,
    sourceUrl,
    title,
    source,
    thumbnailUrl,
    teamId,
  };
}

export function parseCountLookups(value: unknown): Array<{ lookupId: string; articleKey: string }> {
  if (!value || typeof value !== "object") throw new NewsDiscussionInputError("request body must be an object");
  const articles = (value as { articles?: unknown }).articles;
  if (!Array.isArray(articles) || articles.length > 10) {
    throw new NewsDiscussionInputError("articles must contain at most 10 items");
  }

  const seen = new Set<string>();
  return articles.map((raw) => {
    if (!raw || typeof raw !== "object") throw new NewsDiscussionInputError("invalid article lookup");
    const item = raw as Record<string, unknown>;
    if (typeof item.lookupId !== "string" || !item.lookupId || item.lookupId.length > 100 || seen.has(item.lookupId)) {
      throw new NewsDiscussionInputError("lookupId must be unique");
    }
    seen.add(item.lookupId);
    const sourceUrl = parseHttpUrl(item.url, "url").toString();
    const canonicalUrl = normalizeArticleUrl(String(item.canonicalUrl || sourceUrl));
    return { lookupId: item.lookupId, articleKey: articleKeyForUrl(canonicalUrl) };
  });
}

export function mapDiscussionCounts(
  lookups: Array<{ lookupId: string; articleKey: string }>,
  rows: Array<{ article_key: string; posts: { comment_count?: number | null } | Array<{ comment_count?: number | null }> | null }>,
): Record<string, number> {
  const byKey = new Map<string, number>();
  for (const row of rows) {
    const relation = Array.isArray(row.posts) ? row.posts[0] : row.posts;
    byKey.set(row.article_key, Math.max(0, Number(relation?.comment_count ?? 0)));
  }
  return Object.fromEntries(lookups.map(({ lookupId, articleKey }) => [lookupId, byKey.get(articleKey) ?? 0]));
}
