const GIPHY_ID_RE = /^[A-Za-z0-9_-]+$/;

/** GIPHY API id를 크관 120자 제한 안에 들어오는 compact media URL로 변환한다. */
export function buildCanonicalGiphyUrl(gifId: string): string | null {
  const id = gifId.trim();
  if (!GIPHY_ID_RE.test(id)) return null;
  const url = `https://media.giphy.com/media/${id}/giphy.gif`;
  return url.length <= 120 ? url : null;
}
