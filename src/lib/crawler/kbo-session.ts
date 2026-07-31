const KBO_GAME_CENTER_URL =
  "https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx";
const SESSION_TTL_MS = 5 * 60 * 1000;
const KBO_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let cachedSession: { cookie: string; expiresAt: number } | null = null;
let pendingSession: Promise<string | null> | null = null;

export function parseKboSessionCookie(setCookie: string | null): string | null {
  return setCookie?.match(/(?:^|,\s*)(ASP\.NET_SessionId=[^;,]+)/i)?.[1] ?? null;
}

export async function fetchKboSessionCookie(
  signal?: AbortSignal,
): Promise<string | null> {
  if (cachedSession && cachedSession.expiresAt > Date.now()) {
    return cachedSession.cookie;
  }
  if (pendingSession) return pendingSession;

  pendingSession = fetch(KBO_GAME_CENTER_URL, {
    headers: {
      "User-Agent": KBO_BROWSER_USER_AGENT,
    },
    cache: "no-store",
    signal,
  })
    .then((response) => {
      if (!response.ok) return null;
      const cookie = parseKboSessionCookie(response.headers.get("set-cookie"));
      if (cookie) {
        cachedSession = {
          cookie,
          expiresAt: Date.now() + SESSION_TTL_MS,
        };
      }
      return cookie;
    })
    .catch(() => null)
    .finally(() => {
      pendingSession = null;
    });

  return pendingSession;
}

export function withKboSessionCookie(
  headers: Record<string, string>,
  cookie: string | null,
): Record<string, string> {
  return {
    ...headers,
    "User-Agent": KBO_BROWSER_USER_AGENT,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}
