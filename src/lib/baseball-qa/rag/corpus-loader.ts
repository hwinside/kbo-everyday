import { createHash } from "node:crypto";

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

export type CorpusSourceIdentity = {
  sourceKey: string;
  sourceKind: "namu_document";
  entityType: CorpusSourcePlan["entityType"];
  entityId: string;
  pageTitle: string;
  candidateUrls: string[];
  canonicalUrl: string;
  identityFingerprint: string;
};

export type CorpusLedgerRow = {
  rowIndex: number;
  record: CorpusRecord;
  recordHash: string;
  disposition: "assigned" | "quarantined";
  isLatestOwnerRevision: boolean;
};

type RosterPlayer = { kboId: string; name: string; birthDate?: string };
type NamuManifestSource = {
  sourceKey: string;
  entityType: string;
  entityId: string;
  requestedTitle: string;
  canonicalTitle: string;
  canonicalUrl: string;
};

export type CorpusInputCounts = {
  physical: number;
  parsed: number;
  parseRejected: number;
  schemaValid: number;
  schemaRejected: number;
};

/** PostgreSQL char_length(text)와 같은 Unicode code point 단위다. */
export function corpusContentLength(text: string): number {
  return Array.from(text).length;
}

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

export function buildCorpusSourceIdentity(plan: CorpusSourcePlan): CorpusSourceIdentity {
  const candidateUrls = [plan.root.canonical];
  const identity = {
    sourceKey: plan.sourceKey,
    sourceKind: "namu_document" as const,
    entityType: plan.entityType,
    entityId: plan.entityId,
    pageTitle: plan.pageTitle,
    candidateUrls,
    canonicalUrl: plan.root.canonical,
  };
  const identityFingerprint = createHash("sha256").update(JSON.stringify({
    sourceKey: identity.sourceKey,
    sourceKind: identity.sourceKind,
    entityType: identity.entityType,
    entityId: identity.entityId,
    pageTitle: identity.pageTitle,
    candidateUrls: identity.candidateUrls,
    canonicalUrl: identity.canonicalUrl,
    resolutionStatus: "resolved",
  })).digest("hex");
  return { ...identity, identityFingerprint };
}

export function corpusRecordHash(record: CorpusRecord): string {
  return createHash("sha256").update(JSON.stringify({
    doc: record.doc,
    kind: record.kind,
    entity: record.entity,
    depth: record.depth,
    title: record.title,
    canonical: record.canonical,
    len: record.len,
    text: record.text,
    fetchedAt: record.fetchedAt,
  })).digest("hex");
}

export type CorpusPreparedSnapshotChunk = {
  canonicalUrl: string;
  revision: string;
  sectionPath: string;
  contentHash: string;
  documentContentHash: string;
  collector: "a17_self_cdp" | "mac_direct_recovery";
};

/** READY skip은 root가 아니라 실제 serving snapshot 전체가 같을 때만 허용한다. */
export function buildCorpusPreparedSnapshotFingerprint(
  chunks: readonly CorpusPreparedSnapshotChunk[],
): string {
  return createHash("sha256").update(JSON.stringify(chunks.map((chunk, chunkIndex) => ({
    chunkIndex,
    ...chunk,
  })))).digest("hex");
}

function corpusOwnerKey(record: CorpusRecord): string {
  return `${record.kind}\u0000${record.entity}\u0000${record.canonical}`;
}

function latestByOwnerCanonical(records: CorpusRecord[]): CorpusRecord[] {
  const latest = new Map<string, CorpusRecord>();
  for (const record of records) {
    const key = corpusOwnerKey(record);
    const previous = latest.get(key);
    if (!previous || previous.fetchedAt < record.fetchedAt) latest.set(key, record);
  }
  return [...latest.values()];
}

/** DB validate_baseball_genius_rag_chunk_owner()의 Namu root/child 계약과 동일한 판정. */
export function isCorpusCanonicalOwnedByRoot(rootCanonical: string, documentCanonical: string): boolean {
  if (/\s|[\u0000-\u001f\u007f]/.test(rootCanonical + documentCanonical)) return false;
  const rootPath = rootCanonical.match(/^https:\/\/namu[.]wiki(\/w\/[^?#]+)$/)?.[1];
  const documentPath = documentCanonical.match(/^https:\/\/namu[.]wiki(\/w\/[^?#]+)$/)?.[1];
  if (!rootPath || !documentPath) return false;
  for (const value of [rootPath, documentPath]) {
    if (
      value.includes("\\")
      || /(^|\/)[.]{1,2}(\/|$)/.test(value)
      || /%(2e|2f|5c|25)/i.test(value)
    ) return false;
  }
  return documentPath === rootPath || documentPath.startsWith(`${rootPath}/`);
}

export function buildCorpusSourcePlan(
  input: CorpusRecord[],
  roster: RosterPlayer[],
  manifest: NamuManifestSource[],
): {
  plans: CorpusSourcePlan[];
  ledger: CorpusLedgerRow[];
  quarantinedPlayers: number;
  quarantinedDocuments: number;
  assignedDocuments: number;
  deduplicated: number;
} {
  // canonical 전역 dedup은 같은 경기 문서를 서로 다른 구단 seed가 발견한 관계를 지운다.
  // owner(kind+entity)+canonical 단위로만 최신본을 고르고, 최종 source 안에서만 canonical을 합친다.
  const records = latestByOwnerCanonical(input);
  const byName = new Map<string, RosterPlayer[]>();
  for (const player of roster) byName.set(player.name, [...(byName.get(player.name) ?? []), player]);
  const plans: CorpusSourcePlan[] = [];
  const assigned = new Set<string>();
  const quarantined = new Set<string>();
  let quarantinedPlayers = 0;

  const playerRecords = records.filter((record) => record.kind === "player");
  for (const root of playerRecords.filter((record) => record.depth === 1)) {
    const ownerDocuments = playerRecords.filter((record) =>
      record.entity === root.entity
      && (record.doc === root.doc || record.doc.startsWith(`${root.doc}/`))
    );
    const candidates = byName.get(root.entity) ?? [];
    if (candidates.length !== 1) {
      quarantinedPlayers += 1;
      for (const document of ownerDocuments) quarantined.add(corpusOwnerKey(document));
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
      for (const document of ownerDocuments) quarantined.add(corpusOwnerKey(document));
      continue;
    }
    const ownedDocuments = ownerDocuments.filter((document) =>
      isCorpusCanonicalOwnedByRoot(root.canonical, document.canonical)
    );
    const mismatchedDocuments = ownerDocuments.filter((document) =>
      !isCorpusCanonicalOwnedByRoot(root.canonical, document.canonical)
    );
    for (const document of ownedDocuments) assigned.add(corpusOwnerKey(document));
    for (const document of mismatchedDocuments) quarantined.add(corpusOwnerKey(document));
    plans.push({
      sourceKey: `namu:player:${player.kboId}`,
      entityType: "player",
      entityId: player.kboId,
      pageTitle: normalizeCorpusTitle(root.title),
      root,
      documents: latestByCanonical(ownedDocuments),
    });
  }

  for (const team of manifest.filter((source) => source.entityType === "team")) {
    const ownerDocuments = records.filter((record) =>
      record.kind === "team"
      && (record.entity === team.requestedTitle || record.entity === team.canonicalTitle)
    );
    const root = ownerDocuments.find((record) => record.canonical === team.canonicalUrl)
      ?? ownerDocuments.find((record) => record.depth === 1);
    if (!root || ownerDocuments.length === 0) throw new Error(`team source root absent: ${team.sourceKey}`);
    const ownedDocuments = ownerDocuments.filter((document) =>
      isCorpusCanonicalOwnedByRoot(root.canonical, document.canonical)
    );
    const mismatchedDocuments = ownerDocuments.filter((document) =>
      !isCorpusCanonicalOwnedByRoot(root.canonical, document.canonical)
    );
    for (const document of ownedDocuments) assigned.add(corpusOwnerKey(document));
    for (const document of mismatchedDocuments) quarantined.add(corpusOwnerKey(document));
    plans.push({
      sourceKey: team.sourceKey,
      entityType: "team",
      entityId: team.entityId,
      pageTitle: normalizeCorpusTitle(root.title),
      root,
      documents: latestByCanonical(ownedDocuments),
    });
  }

  const leagueManifest = manifest.find((source) => source.sourceKey === "namu:league:kbo");
  if (!leagueManifest) throw new Error("namu:league:kbo manifest absent");
  const leagueOwnerDocuments = records.filter((record) =>
    record.kind === "baseball_general" || record.kind === "kbo_league"
  );
  const leagueRoot = leagueOwnerDocuments.find((record) =>
    record.canonical === leagueManifest.canonicalUrl
  );
  if (!leagueRoot || leagueOwnerDocuments.length === 0) throw new Error("league corpus root absent");
  const leagueDocuments = leagueOwnerDocuments.filter((document) =>
    isCorpusCanonicalOwnedByRoot(leagueRoot.canonical, document.canonical)
  );
  const leagueMismatches = leagueOwnerDocuments.filter((document) =>
    !isCorpusCanonicalOwnedByRoot(leagueRoot.canonical, document.canonical)
  );
  for (const document of leagueDocuments) assigned.add(corpusOwnerKey(document));
  for (const document of leagueMismatches) quarantined.add(corpusOwnerKey(document));
  plans.push({
    sourceKey: leagueManifest.sourceKey,
    entityType: "league",
    entityId: leagueManifest.entityId,
    pageTitle: leagueManifest.canonicalTitle,
    root: leagueRoot,
    documents: latestByCanonical(leagueDocuments),
  });

  const unassignedNonPlayer = records.filter((record) =>
    record.kind !== "player"
    && !assigned.has(corpusOwnerKey(record))
    && !quarantined.has(corpusOwnerKey(record))
  );
  if (unassignedNonPlayer.length > 0) {
    throw new Error(`non-player corpus unassigned: ${unassignedNonPlayer.length}`);
  }
  const unaccountedPlayers = playerRecords.filter((record) =>
    !assigned.has(corpusOwnerKey(record)) && !quarantined.has(corpusOwnerKey(record))
  );
  if (unaccountedPlayers.length > 0) {
    throw new Error(`player corpus unaccounted: ${unaccountedPlayers.length}`);
  }
  if (assigned.size + quarantined.size !== records.length) {
    throw new Error(
      `corpus accounting mismatch: assigned=${assigned.size} quarantined=${quarantined.size} total=${records.length}`,
    );
  }
  const latestRecords = new Map(records.map((record) => [corpusOwnerKey(record), record]));
  const ledger = input.map((record, rowIndex): CorpusLedgerRow => {
    const ownerKey = corpusOwnerKey(record);
    const disposition = assigned.has(ownerKey) ? "assigned" : quarantined.has(ownerKey) ? "quarantined" : null;
    if (!disposition) throw new Error(`physical corpus row unaccounted: ${rowIndex}`);
    const recordHash = corpusRecordHash(record);
    return {
      rowIndex,
      record,
      recordHash,
      disposition,
      isLatestOwnerRevision: latestRecords.get(ownerKey) === record,
    };
  });
  if (ledger.filter((row) => row.isLatestOwnerRevision).length !== records.length) {
    throw new Error("physical corpus latest-relation accounting mismatch");
  }
  return {
    plans,
    ledger,
    quarantinedPlayers,
    quarantinedDocuments: quarantined.size,
    assignedDocuments: assigned.size,
    deduplicated: records.length,
  };
}
