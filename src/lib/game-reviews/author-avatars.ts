import { supabaseAdmin } from "@/lib/supabase/admin";

type AuthorRow = { author_id: string; avatar_url?: string | null };
type VisibleFeed = { rows: AuthorRow[]; best?: AuthorRow[]; ownReview?: AuthorRow | null; review?: AuthorRow | null };

/** Enrich only rows already visibility-filtered by gr_feed; never query hidden authors separately. */
export async function withAuthorAvatars<T extends VisibleFeed>(feed: T): Promise<T> {
  const rows = [...feed.rows, ...(feed.best ?? []), ...(feed.ownReview ? [feed.ownReview] : []), ...(feed.review ? [feed.review] : [])];
  const authorIds = [...new Set(rows.map(row => row.author_id))];
  if (!authorIds.length) return feed;
  // gr_feed returns at most 25 page authors + 2 BEST authors + the viewer (28).
  const { data, error } = await supabaseAdmin.from("profiles").select("id, avatar_url").in("id", authorIds).limit(authorIds.length);
  // A missing image must not make the reviews or participation unavailable.
  const avatars = new Map((error ? [] : data ?? []).map(profile => [profile.id, profile.avatar_url]));
  const enrich = <R extends AuthorRow>(row: R): R => ({ ...row, avatar_url: avatars.get(row.author_id) ?? null });
  return { ...feed, rows: feed.rows.map(enrich),
    ...(feed.best ? { best: feed.best.map(enrich) } : {}),
    ...(feed.ownReview ? { ownReview: enrich(feed.ownReview) } : {}),
    ...(feed.review ? { review: enrich(feed.review) } : {}) };
}
