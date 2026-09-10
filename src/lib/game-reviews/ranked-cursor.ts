import { ReviewError } from "./server";

/** Preserve the database timestamp verbatim (including microseconds). */
export function parseReviewCursor(raw: string | null) {
  if (raw === null) return { cursor_likes: null, cursor_created: null, cursor_id: null };
  try {
    if (raw.length > 160) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length !== 3) throw new Error();
    const [likes, created, id] = value;
    if (!Number.isInteger(likes) || likes < 0 || likes > 2147483647 ||
        typeof created !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(created) ||
        !Number.isFinite(Date.parse(created)) || !Number.isSafeInteger(id) || id < 1) throw new Error();
    return { cursor_likes: likes as number, cursor_created: created, cursor_id: id as number };
  } catch {
    throw new ReviewError("목록을 새로고침해 주세요", 400);
  }
}
