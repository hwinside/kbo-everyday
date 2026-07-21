import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildNewsCommentsUrl } from "../../src/lib/open-external";

const root = process.cwd();
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");

const commentsUrl = new URL(buildNewsCommentsUrl({
  url: "https://n.news.naver.com/article/001/123?sid=104",
  canonicalUrl: "https://example.com/news/123",
  title: "테스트 기사 & 제목",
  source: "테스트일보",
  teamId: 1,
}));
assert.equal(commentsUrl.origin, "https://keubo.fan");
assert.equal(commentsUrl.pathname, "/native/news-comments");
assert.equal(commentsUrl.searchParams.get("url"), "https://n.news.naver.com/article/001/123?sid=104");
assert.equal(commentsUrl.searchParams.get("title"), "테스트 기사 & 제목");

const iosPlugin = read("ios/App/App/NewsArticleBrowserPlugin.swift");
assert.match(iosPlugin, /scheme == "http" \|\| scheme == "https"/);
assert.match(iosPlugin, /url\.host\?\.lowercased\(\) == commentsHost/);
assert.match(iosPlugin, /controller\.add\(self, name: "NewsCommentsBridge"\)/);
assert.match(iosPlugin, /webView === commentsWebView/);

const androidActivity = read("android/app/src/main/java/fan/keubo/app/NewsArticleBrowserActivity.java");
assert.match(androidActivity, /COMMENTS_HOST\.equalsIgnoreCase\(uri\.getHost\(\)\)/);
assert.match(androidActivity, /COMMENTS_PATH\.equals\(uri\.getPath\(\)\)/);
assert.match(androidActivity, /addJavascriptInterface\(new CommentsBridge\(\), "NewsCommentsBridge"\)/);
assert.equal(
  (androidActivity.match(/addJavascriptInterface/g) ?? []).length,
  1,
  "external article WebView must not receive a JavaScript bridge",
);

const manifest = read("android/app/src/main/AndroidManifest.xml");
assert.match(
  manifest,
  /android:name="\.NewsArticleBrowserActivity"[\s\S]*?android:exported="false"/,
);
assert.match(read("ios/App/App/MainViewController.swift"), /NewsArticleBrowserPlugin\(\)/);
assert.match(read("android/app/src/main/java/fan/keubo/app/MainActivity.java"), /NewsArticleBrowserPlugin\.class/);

const nativePage = read("src/app/native/news-comments/page.tsx");
assert.match(nativePage, /isNewsDiscussionAdmin/);
assert.match(nativePage, /notFound\(\)/);

console.log("news WebView comments smoke: 17 assertions passed");
