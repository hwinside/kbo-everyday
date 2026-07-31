import assert from "node:assert/strict";

import { KBO_STRUCTURED_SOURCES, NAMU_CORE_SOURCES } from "../../src/lib/baseball-qa/source-inventory";

function htmlMeta(html: string, kind: "canonical" | "og:title"): string | null {
  if (kind === "canonical") {
    return html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)?.[1]
      ?? html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical/i)?.[1]
      ?? null;
  }
  return html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
    ?? null;
}

async function fetchHtml(url: string): Promise<{ html: string; effectiveUrl: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.koreabaseball.com/" },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, 200, `${url} returned ${response.status}`);
      return { html: await response.text(), effectiveUrl: response.url };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`canonical fetch failed: ${url}`, { cause: lastError });
}

async function main() {
  for (const source of KBO_STRUCTURED_SOURCES) {
    await fetchHtml(source.canonicalUrl!);
  }

  for (const source of NAMU_CORE_SOURCES) {
    const { html, effectiveUrl } = await fetchHtml(source.candidateUrls[0]);
    const canonical = htmlMeta(html, "canonical");
    const title = htmlMeta(html, "og:title");
    assert.equal(canonical, source.canonicalUrl, `${source.sourceKey} canonical mismatch (${effectiveUrl})`);
    assert.equal(title, source.pageTitle, `${source.sourceKey} identity/title mismatch`);
  }

  console.log(`baseball QA canonical verification PASS (KBO ${KBO_STRUCTURED_SOURCES.length}, Namu ${NAMU_CORE_SOURCES.length})`);
}

void main();
