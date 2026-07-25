import { readFileSync } from "node:fs";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const reelViewer = readFileSync("src/components/home/ReelViewer.tsx", "utf8");
const homeHighlights = readFileSync("src/components/home/HomeHighlights.tsx", "utf8");
const mapper = readFileSync("src/lib/news/youtube-shorts-discussion.ts", "utf8");

assert(
  reelViewer.includes("{!commentsOpen && (") && reelViewer.includes("<iframe"),
  "ReelViewer must unmount the YouTube iframe while comments are open",
);
assert(
  reelViewer.includes("commentsOpen && commentPostId !== null") && reelViewer.includes("<CommentSheet"),
  "ReelViewer must render comments separately from the player surface",
);
assert(
  reelViewer.includes('postCmd("pauseVideo")') && reelViewer.includes("setCommentsOpen(true)"),
  "ReelViewer must pause before switching into comments mode",
);
assert(
  homeHighlights.includes("if (!user || videos.length === 0)") &&
    homeHighlights.includes("videos.slice(0, 10)") &&
    homeHighlights.includes("(commentCounts[v.id] ?? 0) > 0"),
  "Shorts list counts must follow the logged-in UI contract and hide zero/unfetched badges",
);
assert(
  mapper.includes("youtube.com/watch?v=") && mapper.includes("import type"),
  "YouTube discussion mapper must be client-safe and preserve the video id in the watch URL",
);

console.log("shorts-comments-ui smoke PASS");
