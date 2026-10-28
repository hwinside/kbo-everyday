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

export async function fetchRegularSeasonHtml(
  url: string, season: number, signal: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!Number.isInteger(season) || season < 1982 || season > 2100) throw new Error("KBO invalid season");
  const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: url };
  const selectionUrl = url.replace("/Hitter/Basic2.aspx", "/Hitter/Basic1.aspx");
  const initial = await fetchImpl(selectionUrl, { headers, signal, cache: "no-store" });
  if (!initial.ok) throw new Error(`KBO GET HTTP ${initial.status}`);
  let html = await initial.text();
  const state = form(html);
  if (selectionUrl === url && state.body.get(state.seasonName) === String(season) && state.body.get(state.seriesName) === "0") return html;
  if (!state.body.get("__VIEWSTATE") || !state.body.get("__EVENTVALIDATION")) throw new Error("KBO form tokens missing");
  state.body.set(state.seasonName, String(season));
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
  html = await response.text();
  const selected = form(html);
  if (selected.body.get(selected.seasonName) !== String(season) || selected.body.get(selected.seriesName) !== "0") {
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
    html = await detail.text();
    const detailState = form(html);
    if (detailState.body.get(detailState.seasonName) !== String(season) || detailState.body.get(detailState.seriesName) !== "0") throw new Error("KBO detail season/series mismatch");
  }
  return html;
}
