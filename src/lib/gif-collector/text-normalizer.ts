import { decodeSlackEmojiShortcodes } from "./slack-parser";

export function normalizeQueueTextForPost(row: {
  source_title: string | null;
  source_content: string | null;
  matched_board_id: string;
}): { title: string; sourceContent: string } {
  return {
    title: decodeSlackEmojiShortcodes(row.source_title || `${row.matched_board_id} 움짤`),
    sourceContent: decodeSlackEmojiShortcodes(row.source_content ?? ""),
  };
}
