import { firstContentIssue } from "@/lib/moderation/content-filter";
import type { ReviewPolicy } from "./policy";

export const REVIEW_LIMIT = 100;
export const COMMENT_LIMIT = 200;
export const EDIT_WINDOW_MS = 600_000;
export const REPORT_REASONS = ["욕설·비하·혐오", "광고·도배", "개인정보 노출", "기타 운영정책"] as const;

const segmenter = new Intl.Segmenter("ko", { granularity: "grapheme" });
export function textLength(text: string): number { return [...segmenter.segment(text)].length; }
export function validateText(raw: unknown, limit = REVIEW_LIMIT): string {
  if (typeof raw !== "string" || raw.length > limit * 32) throw new Error(`내용은 1~${limit}자로 입력해 주세요`);
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (!text.replace(/[\s\u200B-\u200F\uFEFF]/g, "") || textLength(text) > limit) throw new Error(`내용은 1~${limit}자로 입력해 주세요`);
  if (firstContentIssue({ content: text })) throw new Error("사용할 수 없는 표현이 있어요");
  return text;
}
export function canEdit(createdAt: string, editCount: number, now: number): boolean {
  return editCount === 0 && now >= Date.parse(createdAt) && now < Date.parse(createdAt) + EDIT_WINDOW_MS;
}
export interface ReviewRow {
  id: number; author_id: string; team_id: number | null; nickname: string;
  content: string; created_at: string; edit_count: number; like_count: number;
  liked: boolean; comment_count: number; player_key: string | null; player_name: string | null;
}
export interface ReviewFeed {
  policy: ReviewPolicy;
  rows: ReviewRow[]; best: ReviewRow[]; total: number;
  team_counts: Record<string, number>;
  own: { id: number; deleted: boolean; hidden: boolean } | null;
  ownReview: ReviewRow | null; next: number | null; server_now: string;
}
export interface ReviewContext {
  gameId: string; awayTeamId: number; homeTeamId: number; winnerTeamId: number | null;
  players: { key: string; name: string; label: string }[];
  score: string; final: boolean;
}
