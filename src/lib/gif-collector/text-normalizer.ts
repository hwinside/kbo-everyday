import { decodeSlackEmojiShortcodes } from "./slack-parser";

export function normalizeQueueTextForPost(row: {
  source_title: string | null;
  source_content: string | null;
  matched_board_id: string | null;
}): { title: string; sourceContent: string } {
  const fallbackTitle = row.matched_board_id ? `${row.matched_board_id} 움짤` : "움짤";
  return {
    title: decodeSlackEmojiShortcodes(row.source_title || fallbackTitle),
    sourceContent: decodeSlackEmojiShortcodes(row.source_content ?? ""),
  };
}
