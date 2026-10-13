import { NEWS_RECENT_WINDOW_DAYS, resolveNewsRecency } from "../rag/news-recency";

const WINDOW_LABELS = ["오늘", "어제", "그저께", "최근"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = NEWS_RECENT_WINDOW_DAYS * DAY_MS;
export interface RosterRemovalContext {
  version: 1;
  kind: "roster_removal";
  teamId?: number;
  window?: { label: typeof WINDOW_LABELS[number]; since: string; until: string };
}
export interface RemovalTeam { id: number; aliases: readonly string[] }

/** Request operands only; no player names, answers, facts or free-form instructions. */
export function readRosterRemovalContext(value: unknown): RosterRemovalContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || row.kind !== "roster_removal") return undefined;
  if (row.teamId !== undefined && (!Number.isInteger(row.teamId) || Number(row.teamId) < 1 || Number(row.teamId) > 10)) return undefined;
  let window: RosterRemovalContext["window"];
  if (row.window !== undefined) {
    if (!row.window || typeof row.window !== "object" || Array.isArray(row.window)) return undefined;
    const w = row.window as Record<string, unknown>;
    if (!WINDOW_LABELS.includes(w.label as typeof WINDOW_LABELS[number]) || typeof w.since !== "string" || typeof w.until !== "string") return undefined;
    const since = Date.parse(w.since), until = Date.parse(w.until);
    if (!Number.isFinite(since) || !Number.isFinite(until) || until < since || until - since > MAX_WINDOW_MS
      || new Date(since).toISOString() !== w.since || new Date(until).toISOString() !== w.until) return undefined;
    const atKstMidnight = (time: number) => (time + 9 * 60 * 60 * 1000) % DAY_MS === 0;
    if (w.label === "최근" ? until - since !== MAX_WINDOW_MS
      : w.label === "오늘" ? !atKstMidnight(since) || until - since >= DAY_MS
        : !atKstMidnight(since) || !atKstMidnight(until) || until - since !== DAY_MS) return undefined;
    window = { label: w.label as typeof WINDOW_LABELS[number], since: w.since, until: w.until };
  }
  return { version: 1, kind: "roster_removal", ...(typeof row.teamId === "number" ? { teamId: row.teamId } : {}), ...(window ? { window } : {}) };
}

const compact = (s: string) => s.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, "").replace(/[?!.~]+$/, "");
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TIME = "(?:오늘|어제|그저께|그제|최근(?:에)?|요즘|요새|근래)?";
const PREFIX = "(?:아니|그럼|그러면)?";
const TAIL = "(?:은|는|을|를)?(?:좀)?(?:알려줘|알려주세요|보여줘|보여주세요|누구야|누구인가요|누구)?";
function teamPattern(team?: RemovalTeam): string {
  return team ? `(?:${team.aliases.map(compact).sort((a, b) => b.length - a.length).map(escaped).join("|")})(?:에서|의|은|는|이요|요)?` : "";
}
function explicitRemoval(question: string, team: RemovalTeam | undefined, now: number): RosterRemovalContext | null {
  // Full request grammar: definitions, reasons, player-specific questions,
  // counts, older seasons and multi-club requests stay with their old owners.
  const club = teamPattern(team);
  if ((compact(question).match(/그저께|그제|오늘|어제|최근(?:에)?|요즘|요새|근래/g) ?? []).length > 1) return null;
  const shape = new RegExp(`^${PREFIX}${TIME}(?:${club})?${TIME}(?:1군|일군)?(?:엔트리(?:에서)?)?말소(?:된|한|됐던)?(?:선수들?(?:명단)?|사람들?|명단)${TAIL}$`);
  if (!shape.test(compact(question))) return null;
  const recency = resolveNewsRecency(question, now);
  if (recency.kind === "out_of_window") return null;
  const window = recency.kind === "fresh" ? {
    label: recency.label as typeof WINDOW_LABELS[number], since: recency.since.toISOString(), until: recency.until.toISOString(),
  } : undefined;
  return readRosterRemovalContext({ version: 1, kind: "roster_removal", ...(team ? { teamId: team.id } : {}), ...(window ? { window } : {}) }) ?? null;
}

/** Caller supplies only its already-qualified exact previous turn (TTL/source/barrier). */
export function resolveRosterRemovalRequest(
  question: string,
  previous: { question: string; rosterRemovalContext?: RosterRemovalContext } | null,
  now: number,
  currentTeam?: RemovalTeam,
  previousTeam?: RemovalTeam,
): RosterRemovalContext | null {
  const explicit = explicitRemoval(question, currentTeam, now);
  const prior = previous ? readRosterRemovalContext(previous.rosterRemovalContext)
    ?? explicitRemoval(previous.question, previousTeam, now) : null;
  const bareTeam = currentTeam && new RegExp(`^${PREFIX}${teamPattern(currentTeam)}$`).test(compact(question));
  const bareTime = /^(?:오늘|어제|그저께|그제|최근|요즘)(?:이요|요)?$/.test(compact(question));
  if (!explicit && !(prior && (bareTeam || bareTime))) return null;
  const recency = bareTime ? resolveNewsRecency(question, now) : null;
  const window = explicit?.window ?? (recency?.kind === "fresh" ? {
    label: recency.label as typeof WINDOW_LABELS[number], since: recency.since.toISOString(), until: recency.until.toISOString(),
  } : prior?.window);
  if (window && Date.parse(window.until) > now) return null;
  return readRosterRemovalContext({ version: 1, kind: "roster_removal",
    teamId: currentTeam?.id ?? explicit?.teamId ?? prior?.teamId,
    ...(window ? { window } : {}),
  }) ?? null;
}
