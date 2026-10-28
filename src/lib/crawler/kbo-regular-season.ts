/** KBO WebForms ignores season/series query parameters; use its selection form. */
function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map((m) => [
    m[1].toLowerCase(), m[3].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
  ]));
}

function form(html: string) {
  const body = new URLSearchParams();
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const a = attributes(match[0]);
    if (a.type?.toLowerCase() === "hidden" && a.name) body.set(a.name, a.value ?? "");
  }
  let seasonName = "", seriesName = "";
  for (const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const a = attributes(match[1]);
    if (!a.name) continue;
    const options = [...match[2].matchAll(/<option\b([^>]*)>/gi)];
    const selected = options.find((o) => /\bselected\b/i.test(o[1])) ?? options[0];
    body.set(a.name, selected ? attributes(selected[1]).value ?? "" : "");
    if (/\$ddlSeason(?:\$ddlSeason)?$/.test(a.name)) seasonName = a.name;
    if (/\$ddlSeries(?:\$ddlSeries)?$/.test(a.name)) seriesName = a.name;
  }
  if (!seasonName || !seriesName) throw new Error("KBO season/series controls missing");
  return { body, seasonName, seriesName };
}

async function readHtml(response: Response, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    response.text().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Which regular season to read.
 *
 * "latest" = whatever KBO itself has selected on the page, i.e. the last season
 * with regular-season records. A wall-clock year must never be assumed: on
 * January 1st the new season does not exist yet, so `new Date().getFullYear()`
 * would ask KBO for an empty season and fail for the whole off-season.
 */
export type RegularSeason = number | "latest";

/** The season KBO reports as selected on a records page. */
export function regularSeasonOf(html: string): number {
  const state = form(html);
  const value = Number(state.body.get(state.seasonName));
  if (!Number.isInteger(value) || value < 1982 || value > 2100) throw new Error("KBO season unreadable");
  return value;
}

export async function fetchRegularSeasonHtml(
  url: string, season: RegularSeason, signal: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (season !== "latest" && (!Number.isInteger(season) || season < 1982 || season > 2100)) {
    throw new Error("KBO invalid season");
  }
  const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: url };
  const selectionUrl = url.replace("/Hitter/Basic2.aspx", "/Hitter/Basic1.aspx");
  const initial = await fetchImpl(selectionUrl, { headers, signal, cache: "no-store" });
  if (!initial.ok) throw new Error(`KBO GET HTTP ${initial.status}`);
  let html = await readHtml(initial, signal);
  const state = form(html);
  // "latest" adopts KBO's own selection instead of guessing a year.
  const wanted = season === "latest" ? Number(state.body.get(state.seasonName)) : season;
  if (!Number.isInteger(wanted) || wanted < 1982 || wanted > 2100) throw new Error("KBO season unreadable");
  if (selectionUrl === url && state.body.get(state.seasonName) === String(wanted) && state.body.get(state.seriesName) === "0") return html;
  if (!state.body.get("__VIEWSTATE") || !state.body.get("__EVENTVALIDATION")) throw new Error("KBO form tokens missing");
  state.body.set(state.seasonName, String(wanted));
  state.body.set(state.seriesName, "0");
  state.body.set("__EVENTTARGET", state.seriesName);
  state.body.set("__EVENTARGUMENT", "");
  // Keep the ASP.NET session scoped to this one page, never shared across requests.
  const cookie = initial.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
  const response = await fetchImpl(selectionUrl, {
    method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
    body: state.body.toString(), signal, cache: "no-store",
  });
  if (!response.ok) throw new Error(`KBO POST HTTP ${response.status}`);
  html = await readHtml(response, signal);
  const selected = form(html);
  if (selected.body.get(selected.seasonName) !== String(wanted) || selected.body.get(selected.seriesName) !== "0") {
    throw new Error("KBO season/series selection mismatch");
  }
  if (selectionUrl !== url) {
    const cookies = new Map<string, string>();
    for (const value of [...initial.headers.getSetCookie(), ...response.headers.getSetCookie()]) {
      const pair = value.split(";")[0];
      cookies.set(pair.split("=")[0], pair);
    }
    const detail = await fetchImpl(url, { headers: { ...headers, Cookie: [...cookies.values()].join("; ") }, signal, cache: "no-store" });
    if (!detail.ok) throw new Error(`KBO detail HTTP ${detail.status}`);
    html = await readHtml(detail, signal);
    const detailState = form(html);
    if (detailState.body.get(detailState.seasonName) !== String(wanted) || detailState.body.get(detailState.seriesName) !== "0") throw new Error("KBO detail season/series mismatch");
  }
  return html;
}

/** Collect every page in one verified regular-season WebForms session.
 * A missing/looping pager or season change fails the entire collection.
 */
export async function fetchRegularSeasonPages(
  url: string, season: RegularSeason, signal: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const cookies = new Map<string, string>();
  const sessionFetch: typeof fetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      cookies.set(pair.split('=')[0], pair);
    }
    return response;
  };
  let html = await fetchRegularSeasonHtml(url, season, signal, sessionFetch);
  // Pin the resolved season once: every later page must stay on this very season,
  // so "latest" cannot drift mid-collection.
  const pinnedSeason = season === "latest" ? regularSeasonOf(html) : season;
  const pages: string[] = [];
  const seenPlayerIds = new Set<string>();
  while (pages.length < 40) {
    signal.throwIfAborted();
    const state = form(html);
    if (state.body.get(state.seasonName) !== String(pinnedSeason) || state.body.get(state.seriesName) !== '0') {
      throw new Error('KBO paged season/series mismatch');
    }
    const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(m => ({ a: attributes(m[1]), label: m[2].replace(/<[^>]+>/g, '').trim() }));
    const current = links.find(link => /ucPager_btnNo/.test(link.a.id ?? '') && /(?:^|\s)on(?:\s|$)/.test(link.a.class ?? ''));
    if (!current || Number(current.label) !== pages.length + 1) throw new Error('KBO pager missing, skipped or repeated');
    const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
    if (!tbody || !/<tr\b/i.test(tbody)) throw new Error('KBO page table empty');
    for (const match of tbody.matchAll(/playerId=(\d+)/g)) {
      if (seenPlayerIds.has(match[1])) throw new Error('KBO duplicate player across pages');
      seenPlayerIds.add(match[1]);
    }
    pages.push(html);
    const next = links.find(link => /ucPager_btnNo/.test(link.a.id ?? '') && Number(link.label) === pages.length + 1)
      ?? links.find(link => /ucPager_btnNext$/.test(link.a.id ?? '') && link.a.href?.includes('__doPostBack'));
    if (!next) return pages;
    const target = next.a.href?.match(/__doPostBack\('([^']+)'/)?.[1];
    if (!target || !cookies.size) throw new Error('KBO pager target/session missing');
    state.body.set('__EVENTTARGET', target);
    state.body.set('__EVENTARGUMENT', '');
    const response = await sessionFetch(url, {
      method: 'POST', signal, cache: 'no-store',
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: url, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: [...cookies.values()].join('; ') },
      body: state.body.toString(),
    });
    if (!response.ok) throw new Error(`KBO page HTTP ${response.status}`);
    html = await readHtml(response, signal);
  }
  throw new Error('KBO page limit exceeded');
}
