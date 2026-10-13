const GIPHY_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Own popularity catalog: strictly bounded IDs, never saved media URLs. */
export function normalizePopularGiphyIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string =>
    typeof id === "string" && id.length <= 78 && GIPHY_ID_RE.test(id),
  ))].slice(0, 24);
}


/** GIPHY API id를 크관 120자 제한 안에 들어오는 compact media URL로 변환한다. */
export function buildCanonicalGiphyUrl(gifId: string): string | null {
  const id = gifId.trim();
  if (!GIPHY_ID_RE.test(id)) return null;
  const url = `https://media.giphy.com/media/${id}/giphy.gif`;
  return url.length <= 120 ? url : null;
}

/** Failure/empty catalog falls back to a labelled baseball search, not Trending. */
export async function loadPopularGiphyIds(signal: AbortSignal): Promise<string[]> {
  if (signal.aborted) return [];
  const lookup = new AbortController();
  const abort = () => lookup.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 4_000);
  try {
    const response = await fetch("/api/game-chat/popular-gifs", {
      signal: lookup.signal, cache: "no-store",
    });
    if (!response.ok) return [];
    return normalizePopularGiphyIds((await response.json()).ids);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
