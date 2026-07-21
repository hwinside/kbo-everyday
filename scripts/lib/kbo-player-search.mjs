import crypto from "node:crypto";

const SEARCH_URL = "https://www.koreabaseball.com/Player/Search.aspx";

const PHOTO_SEASON = "2026";

export const KBO_TEAM_CODES = ["LG", "OB", "KT", "SK", "NC", "HT", "LT", "SS", "HH", "WO"];

const TEAM_META = {
  LG: { teamId: 1, team: "LG" },
  OB: { teamId: 2, team: "두산" },
  KT: { teamId: 3, team: "KT" },
  SK: { teamId: 4, team: "SSG" },
  NC: { teamId: 5, team: "NC" },
  HT: { teamId: 6, team: "KIA" },
  LT: { teamId: 7, team: "롯데" },
  SS: { teamId: 8, team: "삼성" },
  HH: { teamId: 9, team: "한화" },
  WO: { teamId: 10, team: "키움", sourceTeamAliases: ["키움", "고양"] },
};

const FORM_PREFIX = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$";
const TEAM_FIELD = `${FORM_PREFIX}ddlTeam`;
const POSITION_FIELD = `${FORM_PREFIX}ddlPosition`;
const NAME_FIELD = `${FORM_PREFIX}txtSearchPlayerName`;
const PAGE_FIELD = `${FORM_PREFIX}hfPage`;
const TEAM_EVENT = `${FORM_PREFIX}ddlTeam`;
const PAGER_PREFIX = `${FORM_PREFIX}ucPager$btnNo`;
const PAGER_NEXT = `${FORM_PREFIX}ucPager$btnNext`;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  Referer: SEARCH_URL,
};

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

export function extractHiddenFields(html) {
  const fields = {};
  for (const id of ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION"]) {
    const match = html.match(new RegExp(`id=["']${id}["'][^>]*value=["']([^"']*)["']`, "i"));
    fields[id] = match?.[1] ?? "";
  }
  if (!fields.__VIEWSTATE || !fields.__EVENTVALIDATION) {
    throw new Error("Player/Search.aspx ASP.NET form token missing");
  }
  return fields;
}

export function parseSearchPage(html, expectedTeamCode) {
  const meta = TEAM_META[expectedTeamCode];
  if (!meta) throw new Error(`unknown KBO team code: ${expectedTeamCode}`);

  const countMatch = html.match(/검색결과\s*:\s*<span[^>]*class=["']point["'][^>]*>(\d+)<\/span>/i);
  if (!countMatch) throw new Error(`search result count missing (${expectedTeamCode})`);
  const total = Number(countMatch[1]);
  const players = [];
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";

  for (const row of tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 5) continue;
    const link = cells[1].match(/href=["']([^"']*playerId=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const sourceTeam = stripTags(cells[2]);
    const allowedSourceTeams = meta.sourceTeamAliases ?? [meta.team];
    if (!allowedSourceTeams.includes(sourceTeam)) {
      throw new Error(`team mismatch: filter=${meta.team}, row=${sourceTeam}, playerId=${link[2]}`);
    }
    players.push({
      name: stripTags(link[3]),
      kboId: link[2],
      teamCode: expectedTeamCode,
      teamId: meta.teamId,
      team: meta.team,
      sourceTeam,
      position: stripTags(cells[3]),
      backNo: stripTags(cells[0]) || "-",
      birthDate: stripTags(cells[4]) || null,
      detailPath: decodeHtml(link[1]),
    });
  }

  return { total, players };
}

function buildPostbackBody(html, teamCode, eventTarget, page) {
  const hidden = extractHiddenFields(html);
  return new URLSearchParams({
    __EVENTTARGET: eventTarget,
    __EVENTARGUMENT: "",
    __VIEWSTATE: hidden.__VIEWSTATE,
    __VIEWSTATEGENERATOR: hidden.__VIEWSTATEGENERATOR,
    __EVENTVALIDATION: hidden.__EVENTVALIDATION,
    [TEAM_FIELD]: teamCode,
    [POSITION_FIELD]: "",
    [NAME_FIELD]: "",
    [PAGE_FIELD]: String(page),
  });
}

function pageEventTarget(html, page) {
  const numbered = `${PAGER_PREFIX}${page}`;
  if (html.includes(numbered)) return numbered;
  if (html.includes(PAGER_NEXT)) return PAGER_NEXT;
  throw new Error(`pager target missing for page ${page}`);
}

async function fetchWithRetry(url, init, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

function profileLabel(html, label) {
  const match = html.match(new RegExp(`playerProfile_${label}["'][^>]*>([^<]*)`, "i"));
  return match ? stripTags(match[1]) : "";
}

export function normalizePlayerName(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/g, "");
}

export function assertProfileIdentity(player, profile) {
  if (normalizePlayerName(player.name) !== normalizePlayerName(profile.name)) {
    throw new Error(
      `profile name mismatch: search=${player.name}, profile=${profile.name} (playerId=${player.kboId})`,
    );
  }
}

export function photoUrlMatches2026(photoUrl, kboId) {
  try {
    return new URL(photoUrl).pathname === `/KBO_IMAGE/person/middle/${PHOTO_SEASON}/${kboId}.jpg`;
  } catch {
    return false;
  }
}

export function buildCandidateManifest(candidates) {
  const lines = candidates
    .map((candidate) =>
      [
        candidate.teamId,
        candidate.kboId,
        candidate.name,
        candidate.position,
        candidate.backNo,
        candidate.birthDate ?? "",
        crypto.createHash("sha256").update(candidate.photo).digest("hex"),
      ].join(","),
    )
    .sort();
  const sha256 = crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
  return { lines, sha256 };
}

export function parsePlayerDetailPage(html) {
  const photo = html.match(/playerProfile_imgProgile[^>]*src=["']([^"']+)["']/i)?.[1] ?? "";
  const rawPosition = profileLabel(html, "lblPosition");
  return {
    name: profileLabel(html, "lblName"),
    backNo: profileLabel(html, "lblBackNo") || "-",
    position: rawPosition.split("(")[0].trim(),
    draft: profileLabel(html, "lblDraft"),
    photoUrl: photo.startsWith("//") ? `https:${photo}` : photo,
  };
}

export async function fetchPlayerProfileWithPhoto(player) {
  const detailUrl = new URL(player.detailPath, "https://www.koreabaseball.com").toString();
  const html = await fetchWithRetry(detailUrl, { headers: HEADERS });
  const profile = parsePlayerDetailPage(html);
  if (!profile.name) throw new Error(`profile parse failed: ${player.name}(${player.kboId})`);
  assertProfileIdentity(player, profile);
  if (/자유선발/.test(profile.draft)) return { profile, photo: null, excluded: "foreign" };
  if (!["투수", "포수", "내야수", "외야수"].includes(profile.position)) {
    return { profile, photo: null, excluded: "invalid-position" };
  }
  if (!profile.photoUrl) return { profile, photo: null, excluded: "no-photo" };
  if (!photoUrlMatches2026(profile.photoUrl, player.kboId)) {
    return { profile, photo: null, excluded: "stale-photo" };
  }

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(profile.photoUrl, {
        headers: HEADERS,
        signal: AbortSignal.timeout(20_000),
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.includes("image")) {
        return { profile, photo: null, excluded: "no-photo" };
      }
      const photo = Buffer.from(await response.arrayBuffer());
      if (photo.length < 500) return { profile, photo: null, excluded: "no-photo" };
      return { profile, photo, excluded: null };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error(`photo fetch failed after retry: ${player.name}(${player.kboId}) — ${lastError?.message ?? lastError}`);
}

async function postback(html, teamCode, eventTarget, page) {
  const body = buildPostbackBody(html, teamCode, eventTarget, page);
  return fetchWithRetry(SEARCH_URL, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

async function fetchTeamSearchEntriesOnce(teamCode) {
  if (!TEAM_META[teamCode]) throw new Error(`unknown KBO team code: ${teamCode}`);
  let html = await fetchWithRetry(SEARCH_URL, { headers: HEADERS });
  html = await postback(html, teamCode, TEAM_EVENT, 1);

  const first = parseSearchPage(html, teamCode);
  const pageCount = Math.max(1, Math.ceil(first.total / 20));
  const players = [...first.players];

  for (let page = 2; page <= pageCount; page++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    html = await postback(html, teamCode, pageEventTarget(html, page), page);
    players.push(...parseSearchPage(html, teamCode).players);
  }

  const unique = new Map(players.map((player) => [player.kboId, player]));
  if (unique.size !== first.total) {
    throw new Error(
      `${teamCode} incomplete scan: expected=${first.total}, parsed=${players.length}, unique=${unique.size}`,
    );
  }
  return [...unique.values()];
}

export async function fetchTeamSearchEntries(teamCode) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetchTeamSearchEntriesOnce(teamCode);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
    }
  }
  throw lastError;
}

export function selectMissingPlayers(searchPlayers, roster, foreignNumericToAlpha = {}) {
  const rosterIds = new Set(roster.map((player) => String(player.kboId)));
  const rosterNameTeam = new Set(roster.map((player) => `${player.team}\u0000${player.name}`));
  const missing = [];
  const skippedForeignAliases = [];
  const nameTeamCollisions = [];

  for (const player of searchPlayers) {
    if (rosterIds.has(player.kboId)) continue;
    if (foreignNumericToAlpha[player.kboId]) {
      skippedForeignAliases.push({ ...player, canonicalId: foreignNumericToAlpha[player.kboId] });
      continue;
    }
    if (rosterNameTeam.has(`${player.team}\u0000${player.name}`)) {
      nameTeamCollisions.push(player);
      continue;
    }
    missing.push(player);
  }
  if (nameTeamCollisions.length > 0) {
    throw new Error(
      `name+team collision without ID/alias match (동명이인 의심, 수동 audit 필요): ${nameTeamCollisions
        .map((player) => `${player.team}/${player.name}(${player.kboId})`)
        .join(", ")}`,
    );
  }
  return { missing, skippedForeignAliases };
}
