import { normalizeCorpusTitle, verifyCorpusPlayerIdentity } from "./corpus-identity";

export const CORPUS_KINDS = ["player", "team", "baseball_general", "kbo_league"] as const;
export type CorpusKind = typeof CORPUS_KINDS[number];

export type CorpusRecord = {
  doc: string;
  kind: CorpusKind;
  entity: string;
  depth: number;
  title: string;
  canonical: string;
  len: number;
  text: string;
  fetchedAt: string;
};

export type CorpusSourcePlan = {
  sourceKey: string;
  entityType: "player" | "team" | "league";
  entityId: string;
  pageTitle: string;
  root: CorpusRecord;
  documents: CorpusRecord[];
};

type RosterPlayer = { kboId: string; name: string; birthDate?: string };
type NamuManifestSource = {
  sourceKey: string;
  entityType: string;
  entityId: string;
  requestedTitle: string;
  canonicalTitle: string;
};

export type CorpusInputCounts = {
  physical: number;
  parsed: number;
  parseRejected: number;
  schemaValid: number;
  schemaRejected: number;
};

export function validateCorpusRecord(value: unknown):
  | { ok: true; record: CorpusRecord }
  | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "not_object" };
  }
  const row = value as Record<string, unknown>;
  for (const key of ["doc", "kind", "entity", "title", "canonical", "text", "fetchedAt"] as const) {
    if (typeof row[key] !== "string" || row[key].trim().length === 0) {
      return { ok: false, reason: `${key}_absent` };
    }
  }
  if (!CORPUS_KINDS.includes(row.kind as CorpusKind)) {
    return { ok: false, reason: "kind_unsupported" };
  }
  if (!Number.isInteger(row.depth) || (row.depth as number) < 1) {
    return { ok: false, reason: "depth_invalid" };
  }
  if (!Number.isInteger(row.len) || (row.len as number) < 1) {
    return { ok: false, reason: "len_invalid" };
  }
  if (!Number.isFinite(Date.parse(row.fetchedAt as string))) {
    return { ok: false, reason: "fetched_at_invalid" };
  }
  let canonicalTitle: string;
  try {
    const canonical = new URL(row.canonical as string);
    if (canonical.protocol !== "https:" || canonical.hostname !== "namu.wiki") {
      return { ok: false, reason: "canonical_host_invalid" };
    }
    if (!canonical.pathname.startsWith("/w/") || canonical.pathname.length <= 3) {
      return { ok: false, reason: "canonical_path_invalid" };
    }
    canonicalTitle = decodeURIComponent(canonical.pathname.slice(3)).replace(/_/g, " ").trim();
  } catch {
    return { ok: false, reason: "canonical_invalid" };
  }
  if (normalizeCorpusTitle(row.title as string) !== canonicalTitle) {
    return { ok: false, reason: "title_canonical_mismatch" };
  }
  if ((row.text as string).length !== row.len) {
    return { ok: false, reason: "text_length_mismatch" };
  }
  return { ok: true, record: row as CorpusRecord };
}

export function parseCorpusJsonl(raw: string): {
  records: CorpusRecord[];
  counts: CorpusInputCounts;
  reasons: Record<string, number>;
} {
  const physicalLines = raw.split("\n").filter((line) => line.trim().length > 0);
  const parsed: unknown[] = [];
  let parseRejected = 0;
  for (const line of physicalLines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      parseRejected += 1;
    }
  }
  const records: CorpusRecord[] = [];
  const reasons: Record<string, number> = {};
  for (const value of parsed) {
    const verdict = validateCorpusRecord(value);
    if (verdict.ok) records.push(verdict.record);
    else reasons[verdict.reason] = (reasons[verdict.reason] ?? 0) + 1;
  }
  const counts = {
    physical: physicalLines.length,
    parsed: parsed.length,
    parseRejected,
    schemaValid: records.length,
    schemaRejected: parsed.length - records.length,
  };
  if (
    counts.physical !== counts.parsed + counts.parseRejected
    || counts.parsed !== counts.schemaValid + counts.schemaRejected
  ) {
    throw new Error(`corpus count invariant violated: ${JSON.stringify(counts)}`);
  }
  if (counts.parseRejected > 0 || counts.schemaRejected > 0) {
    throw new Error(`corpus input rejected: counts=${JSON.stringify(counts)} reasons=${JSON.stringify(reasons)}`);
  }
  return { records, counts, reasons };
}

function latestByCanonical(records: CorpusRecord[]): CorpusRecord[] {
  const latest = new Map<string, CorpusRecord>();
  for (const record of records) {
    const previous = latest.get(record.canonical);
    if (!previous || previous.fetchedAt < record.fetchedAt) latest.set(record.canonical, record);
  }
  return [...latest.values()];
}

export function buildCorpusSourcePlan(
  input: CorpusRecord[],
  roster: RosterPlayer[],
  manifest: NamuManifestSource[],
): {
  plans: CorpusSourcePlan[];
  quarantinedPlayers: number;
  quarantinedDocuments: number;
  assignedDocuments: number;
  deduplicated: number;
} {
  const records = latestByCanonical(input);
  const byName = new Map<string, RosterPlayer[]>();
  for (const player of roster) byName.set(player.name, [...(byName.get(player.name) ?? []), player]);
  const plans: CorpusSourcePlan[] = [];
  const assigned = new Set<string>();
  const quarantined = new Set<string>();
  let quarantinedPlayers = 0;

  const playerRecords = records.filter((record) => record.kind === "player");
  for (const root of playerRecords.filter((record) => record.depth === 1)) {
    const documents = playerRecords.filter((record) =>
      record.entity === root.entity
      && (record.doc === root.doc || record.doc.startsWith(`${root.doc}/`))
    );
    const candidates = byName.get(root.entity) ?? [];
    if (candidates.length !== 1) {
      quarantinedPlayers += 1;
      for (const document of documents) quarantined.add(document.canonical);
      continue;
    }
    const player = candidates[0];
    const identity = verifyCorpusPlayerIdentity({
      text: root.text,
      rosterBirthYear: player.birthDate?.slice(0, 4),
      seedName: root.entity,
      documentTitle: root.title,
    });
    if (!identity.ok) {
      quarantinedPlayers += 1;
      for (const document of documents) quarantined.add(document.canonical);
      continue;
    }
    for (const document of documents) assigned.add(document.canonical);
    plans.push({
      sourceKey: `namu:player:${player.kboId}`,
      entityType: "player",
      entityId: player.kboId,
      pageTitle: normalizeCorpusTitle(root.title),
      root,
      documents,
    });
  }

  for (const team of manifest.filter((source) => source.entityType === "team")) {
    const documents = records.filter((record) =>
      record.kind === "team"
      && (record.entity === team.requestedTitle || record.entity === team.canonicalTitle)
    );
    const root = documents.find((record) => record.depth === 1);
    if (!root || documents.length === 0) throw new Error(`team source root absent: ${team.sourceKey}`);
    for (const document of documents) assigned.add(document.canonical);
    plans.push({
      sourceKey: team.sourceKey,
      entityType: "team",
      entityId: team.entityId,
      pageTitle: normalizeCorpusTitle(root.title),
      root,
      documents,
    });
  }

  const leagueManifest = manifest.find((source) => source.sourceKey === "namu:league:kbo");
  if (!leagueManifest) throw new Error("namu:league:kbo manifest absent");
  const leagueDocuments = records.filter((record) =>
    record.kind === "baseball_general" || record.kind === "kbo_league"
  );
  const leagueRoot = leagueDocuments.find((record) =>
    record.kind === "kbo_league" && record.doc === "KBO 리그"
  ) ?? leagueDocuments.find((record) => record.depth === 1);
  if (!leagueRoot || leagueDocuments.length === 0) throw new Error("league corpus root absent");
  for (const document of leagueDocuments) assigned.add(document.canonical);
  plans.push({
    sourceKey: leagueManifest.sourceKey,
    entityType: "league",
    entityId: leagueManifest.entityId,
    pageTitle: leagueManifest.canonicalTitle,
    root: leagueRoot,
    documents: leagueDocuments,
  });

  const unassignedNonPlayer = records.filter((record) =>
    record.kind !== "player" && !assigned.has(record.canonical)
  );
  if (unassignedNonPlayer.length > 0) {
    throw new Error(`non-player corpus unassigned: ${unassignedNonPlayer.length}`);
  }
  const unaccountedPlayers = playerRecords.filter((record) =>
    !assigned.has(record.canonical) && !quarantined.has(record.canonical)
  );
  if (unaccountedPlayers.length > 0) {
    throw new Error(`player corpus unaccounted: ${unaccountedPlayers.length}`);
  }
  if (assigned.size + quarantined.size !== records.length) {
    throw new Error(
      `corpus accounting mismatch: assigned=${assigned.size} quarantined=${quarantined.size} total=${records.length}`,
    );
  }
  return {
    plans,
    quarantinedPlayers,
    quarantinedDocuments: quarantined.size,
    assignedDocuments: assigned.size,
    deduplicated: records.length,
  };
}
