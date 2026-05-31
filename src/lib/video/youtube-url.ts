const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "youtu.be" ||
    host === "www.youtu.be" ||
    host === "youtube.com" ||
    host === "www.youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com" ||
    host === "youtube-nocookie.com" ||
    host === "www.youtube-nocookie.com"
  );
}

export function extractYouTubeVideoId(input: string | URL): string | null {
  let u: URL;
  try {
    u = input instanceof URL ? input : new URL(input);
  } catch {
    return null;
  }

  const host = u.hostname.toLowerCase();
  if (!isYouTubeHost(host)) return null;

  if (host === "youtu.be" || host === "www.youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return YOUTUBE_ID_RE.test(id) ? id : null;
  }

  const v = u.searchParams.get("v");
  if (v && YOUTUBE_ID_RE.test(v)) return v;

  const pathMatch = u.pathname.match(/^\/(?:embed|shorts|v|live)\/([a-zA-Z0-9_-]{11})/);
  return pathMatch?.[1] && YOUTUBE_ID_RE.test(pathMatch[1]) ? pathMatch[1] : null;
}

export function isYouTubeShortUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return isYouTubeHost(u.hostname) && /^\/shorts\/[a-zA-Z0-9_-]{11}/.test(u.pathname);
  } catch {
    return false;
  }
}

export function toCanonicalYouTubeUrl(input: string): string | null {
  const id = extractYouTubeVideoId(input);
  if (!id) return null;
  return isYouTubeShortUrl(input)
    ? `https://www.youtube.com/shorts/${id}`
    : `https://www.youtube.com/watch?v=${id}`;
}

export function toYouTubeEmbedUrl(input: string): string | null {
  const id = extractYouTubeVideoId(input);
  return id ? `https://www.youtube.com/embed/${id}?controls=1&rel=0&playsinline=1` : null;
}
