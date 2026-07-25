import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildNewsCommentsUrl,
  openNewsArticleWithFallback,
} from "../../src/lib/open-external";

const root = process.cwd();
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");

async function main() {
  const commentsUrl = new URL(
    buildNewsCommentsUrl({
      url: "https://n.news.naver.com/article/001/123?sid=104",
      canonicalUrl: "https://example.com/news/123",
      title: "테스트 기사 & 제목",
      source: "테스트일보",
      teamId: 1,
    }),
  );
  assert.equal(commentsUrl.origin, "https://keubo.fan");
  assert.equal(commentsUrl.pathname, "/native/news-comments");
  assert.equal(
    commentsUrl.searchParams.get("url"),
    "https://n.news.naver.com/article/001/123?sid=104",
  );
  assert.equal(commentsUrl.searchParams.get("title"), "테스트 기사 & 제목");

  const iosPlugin = read("ios/App/App/NewsArticleBrowserPlugin.swift");
  const iosSupport = read("ios/App/App/NewsArticleBrowserSupport.swift");
  assert.match(iosSupport, /scheme == "http" \|\| scheme == "https"/);
  assert.match(iosSupport, /url\.host\?\.lowercased\(\) == commentsHost/);
  assert.match(
    iosPlugin,
    /controller\.add\(WeakNewsCommentsMessageHandler\(self\), name: "NewsCommentsBridge"\)/,
  );
  assert.doesNotMatch(
    iosPlugin,
    /controller\.add\(self, name: "NewsCommentsBridge"\)/,
  );
  assert.match(iosPlugin, /webView\.navigationDelegate = self/);
  assert.match(iosPlugin, /webView === commentsWebView/);
  assert.match(iosSupport, /weak var delegate: WKScriptMessageHandler\?/);

  const fallbackCalls: string[] = [];
  await openNewsArticleWithFallback(
    { url: "https://news.example/article" },
    async () => {
      fallbackCalls.push("core");
      throw new Error("UNIMPLEMENTED");
    },
    async () => {
      fallbackCalls.push("injected");
    },
    async () => {
      fallbackCalls.push("legacy");
    },
  );
  assert.deepEqual(fallbackCalls, ["core", "injected"]);

  const legacyCalls: string[] = [];
  await openNewsArticleWithFallback(
    { url: "https://news.example/article" },
    async () => {
      legacyCalls.push("core");
      throw new Error("UNIMPLEMENTED");
    },
    async () => {
      legacyCalls.push("injected");
      throw new Error("UNIMPLEMENTED");
    },
    async () => {
      legacyCalls.push("legacy");
    },
  );
  assert.deepEqual(legacyCalls, ["core", "injected", "legacy"]);

  const androidActivity = read(
    "android/app/src/main/java/fan/keubo/app/NewsArticleBrowserActivity.java",
  );
  assert.equal(
    (
      androidActivity.match(
        /NewsArticleBrowserUrlPolicy\.isAllowedCommentsUrl/g,
      ) ?? []
    ).length,
    2,
    "initial and redirected comments URLs must share the same origin policy",
  );
  const androidUrlPolicy = read(
    "android/app/src/main/java/fan/keubo/app/NewsArticleBrowserUrlPolicy.java",
  );
  assert.match(androidUrlPolicy, /uri\.getRawUserInfo\(\) == null/);
  assert.match(androidUrlPolicy, /port == -1 \|\| port == 443/);
  assert.match(
    androidActivity,
    /addJavascriptInterface\(new CommentsBridge\(\), "NewsCommentsBridge"\)/,
  );
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
  assert.match(
    read("ios/App/App/MainViewController.swift"),
    /NewsArticleBrowserPlugin\(\)/,
  );
  assert.match(
    read("android/app/src/main/java/fan/keubo/app/MainActivity.java"),
    /NewsArticleBrowserPlugin\.class/,
  );

  const nativePage = read("src/app/native/news-comments/page.tsx");
  // 네이티브 댓글 오버레이는 로그인 유저 전용(admin-only 해제 = 전체 로그인 유저, 익명 아님).
  // 미로그인은 웹/네이티브 CTA 단계에서 LoginSheet로 유도되므로 이 페이지까지 도달하면
  // 로그인 상태다. admin 게이트(isNewsDiscussionAdmin)에서 유저 게이트(isNewsDiscussionUser)로 전환.
  assert.match(nativePage, /isNewsDiscussionUser/);
  assert.doesNotMatch(nativePage, /isNewsDiscussionAdmin/);
  assert.match(nativePage, /notFound\(\)/);

  console.log("news WebView comments smoke: 23 assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
