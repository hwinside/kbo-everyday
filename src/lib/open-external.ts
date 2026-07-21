/**
 * 외부 링크 인앱 브라우저 오픈 헬퍼
 *
 * 네이티브 앱(iOS/Android)에서는 @capacitor/browser로
 * SFSafariViewController(iOS) / Custom Tab(Android)을 띄워 앱 이탈 없이 원문을 보여준다.
 * 웹에서는 기존과 동일하게 새 탭(window.open)으로 연다.
 *
 * 원문 페이지를 그대로 렌더하므로 뉴스 본문 재배포(저작권/뉴스 API 약관) 이슈 없음.
 *
 * ⚠️ 원격 로드(server.url) Capacitor 앱에서 npm core isNativePlatform()이 false로
 * 오판되는 케이스가 있어 주입된 window.Capacitor 브릿지도 OR로 판정한다
 * (native-app-review.ts / native-meta-app-events.ts와 동일 패턴).
 */
import { isNative } from "@/lib/capacitor/platform";
import { registerPlugin } from "@capacitor/core";
import type { NewsArticleDiscussion } from "@/lib/news/article-discussion";

interface InjectedCapacitor {
  isNativePlatform?: () => boolean;
}

function isNativeRuntime(): boolean {
  if (isNative) return true;
  if (typeof window === "undefined") return false;
  const injected = (window as unknown as { Capacitor?: InjectedCapacitor })
    .Capacitor;
  try {
    return injected?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

function openInNewTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

interface NewsArticleBrowserPlugin {
  open(options: { url: string; commentsUrl?: string }): Promise<void>;
}

const NewsArticleBrowser = registerPlugin<NewsArticleBrowserPlugin>(
  "NewsArticleBrowser",
);

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function buildNewsCommentsUrl(article: NewsArticleDiscussion): string {
  const params = new URLSearchParams({
    url: article.url,
    title: article.title,
  });
  if (article.canonicalUrl) params.set("canonicalUrl", article.canonicalUrl);
  if (article.source) params.set("source", article.source);
  if (article.thumbnailUrl) params.set("thumbnailUrl", article.thumbnailUrl);
  if (article.teamId) params.set("teamId", String(article.teamId));
  return `https://keubo.fan/native/news-comments?${params.toString()}`;
}

async function openLegacyNativeBrowser(url: string): Promise<void> {
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url });
  } catch {
    openInNewTab(url);
  }
}

/** 외부 URL 열기 — 네이티브는 인앱 브라우저, 웹은 새 탭. */
export function openExternalUrl(url: string): void {
  if (!url) return;
  if (isNativeRuntime()) {
    import("@capacitor/browser")
      .then(({ Browser }) => Browser.open({ url }))
      .catch(() => openInNewTab(url));
    return;
  }
  openInNewTab(url);
}

/** 뉴스 원문 전용 — 새 앱은 자체 WebView, 구버전 앱은 기존 인앱 브라우저. */
export function openNewsArticle(
  article: NewsArticleDiscussion,
  commentsEnabled: boolean,
): void {
  if (!isHttpUrl(article.url)) return;
  if (!isNativeRuntime()) {
    openInNewTab(article.url);
    return;
  }

  const commentsUrl = commentsEnabled ? buildNewsCommentsUrl(article) : undefined;
  NewsArticleBrowser.open({ url: article.url, commentsUrl })
    .catch(() => openLegacyNativeBrowser(article.url));
}

/**
 * `<a target="_blank">` 앵커용 onClick 핸들러.
 * 웹에선 no-op이라 기존 앵커 동작(새 탭·미들클릭·복사) 그대로,
 * 네이티브에서만 기본 내비게이션을 막고 인앱 브라우저로 연다.
 */
export function handleExternalAnchorClick(
  e: { preventDefault: () => void },
  url: string | undefined | null,
): void {
  if (!url || !isNativeRuntime()) return;
  e.preventDefault();
  openExternalUrl(url);
}

export function handleNewsArticleAnchorClick(
  e: { preventDefault: () => void },
  article: NewsArticleDiscussion,
  commentsEnabled: boolean,
): void {
  if (!isNativeRuntime()) return;
  e.preventDefault();
  openNewsArticle(article, commentsEnabled);
}
