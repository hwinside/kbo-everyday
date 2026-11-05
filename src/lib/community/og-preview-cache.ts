/** Public link metadata shared across mounted previews; never cache failures/empty OG. */
export interface OGPreviewData {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string;
}

const MAX_ENTRIES = 200;
const SUCCESS_TTL_MS = 5 * 60 * 1000;
type Entry = { promise: Promise<OGPreviewData>; expiresAt: number };
const entries = new Map<string, Entry>();

export function loadOGPreview(url: string): Promise<OGPreviewData> {
  const cached = entries.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    entries.delete(url);
    entries.set(url, cached);
    return cached.promise;
  }
  entries.delete(url);
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);

  const entry: Entry = { promise: undefined!, expiresAt: Infinity };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  // Defer fetch to also turn synchronous fetch failures into a rejected promise.
  entry.promise = Promise.resolve()
    .then(() => fetch(`/api/og-meta?url=${encodeURIComponent(url)}&v=2`, {
      signal: controller.signal,
    }))
    .then(async (response) => {
      if (!response.ok) throw new Error("OG request failed");
      const data = await response.json() as OGPreviewData;
      if (entries.get(url) === entry) {
        if (data && (data.title || data.image)) entry.expiresAt = Date.now() + SUCCESS_TTL_MS;
        else entries.delete(url);
      }
      return data;
    })
    .catch((error: unknown) => {
      if (entries.get(url) === entry) entries.delete(url);
      throw error;
    })
    .finally(() => clearTimeout(timeout));
  entries.set(url, entry);
  return entry.promise;
}
