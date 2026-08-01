import { createHash } from "node:crypto";

import kboRecordCategoryUniverse from "./kbo-record-category-universe.json";
import namuCoreManifest from "./namu-core-manifest.json";

export type RagSourceKind =
  | "kbo_structured"
  | "namu_document"
  | "wikipedia_document"
  | "kbo_ebook";
export type RagEntityType =
  | "record_category"
  | "league"
  | "team"
  | "player"
  | "document";
export type RagResolutionStatus = "resolved" | "missing" | "ambiguous" | "blocked";
export type RagIngestionStatus =
  | "not_started"
  | "ingesting"
  | "ready"
  | "failed"
  | "stale"
  | "tombstoned";

export interface RosterSourcePlayer {
  name: string;
  kboId: string;
  teamId: number;
  team: string;
}

export interface RagSourceInventoryItem {
  sourceKey: string;
  sourceKind: RagSourceKind;
  entityType: RagEntityType;
  entityId: string;
  pageTitle: string;
  candidateUrls: string[];
  canonicalUrl: string | null;
  resolutionStatus: RagResolutionStatus | null;
  resolutionNote: string | null;
  sourceGrade: "tier1" | "tier2";
  ingestionStatus: RagIngestionStatus;
  revision: string | null;
  contentHash: string | null;
  crawledAt: string | null;
  ingestedAt: string | null;
  staleAfter: string | null;
  tombstonedAt: string | null;
  questionCount: number;
  lastQuestionAt: string | null;
  identityFingerprint: string;
  metadata: Record<string, string | number | boolean | string[]>;
}

export interface RagSourceInventory {
  schemaVersion: 1;
  inventoryVersion: string;
  sources: RagSourceInventoryItem[];
}

const KBO_BASE = "https://www.koreabaseball.com";
const NAMU_BASE = "https://namu.wiki/w/";

function identityFingerprint(source: {
  sourceKey: string;
  sourceKind: RagSourceKind;
  entityType: RagEntityType;
  entityId: string;
  pageTitle: string;
  candidateUrls: string[];
}): string {
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

export const KBO_STRUCTURED_SOURCES: RagSourceInventoryItem[] = kboRecordCategoryUniverse.map(({ id, title, path }) => {
  const canonicalUrl = `${KBO_BASE}${path}`;
  const identity = {
    sourceKey: `kbo:record:${id}`,
    sourceKind: "kbo_structured" as const,
    entityType: "record_category" as const,
    entityId: id,
    pageTitle: title,
    candidateUrls: [canonicalUrl],
  };
  return {
    ...identity,
    canonicalUrl,
    resolutionStatus: "resolved",
    resolutionNote: "크보팬 structured retrieval에서 사용 중인 KBO 공식 기록실 경로",
    sourceGrade: "tier1",
    ingestionStatus: "not_started",
    revision: null,
    contentHash: null,
    crawledAt: null,
    ingestedAt: null,
    staleAfter: null,
    tombstonedAt: null,
    questionCount: 0,
    lastQuestionAt: null,
    identityFingerprint: identityFingerprint(identity),
    metadata: { retrievalMode: "structured", embeddingAllowed: false },
  };
});

function namuUrl(title: string): string {
  return `${NAMU_BASE}${encodeURIComponent(title)}`;
}

export const NAMU_CORE_SOURCES: RagSourceInventoryItem[] = namuCoreManifest.map((seed) => {
  const requestedUrl = namuUrl(seed.requestedTitle);
  const candidateUrls = requestedUrl === seed.canonicalUrl
    ? [requestedUrl]
    : [requestedUrl, seed.canonicalUrl];
  const identity = {
    sourceKey: seed.sourceKey,
    sourceKind: "namu_document" as const,
    entityType: seed.entityType as "league" | "team",
    entityId: seed.entityId,
    pageTitle: seed.canonicalTitle,
    candidateUrls,
  };
  return {
    ...identity,
    canonicalUrl: seed.canonicalUrl,
    resolutionStatus: "resolved",
    resolutionNote: "2026-07-31 canonical URL HTTP 200 확인",
    sourceGrade: "tier2",
    ingestionStatus: "not_started",
    revision: null,
    contentHash: null,
    crawledAt: null,
    ingestedAt: null,
    staleAfter: null,
    tombstonedAt: null,
    questionCount: 0,
    lastQuestionAt: null,
    identityFingerprint: identityFingerprint(identity),
    metadata: {
      requestedTitle: seed.requestedTitle,
      canonicalTitle: seed.canonicalTitle,
      canonicalVerifiedAt: "2026-07-31",
    },
  };
});

function playerCandidateTitles(name: string): string[] {
  return [`${name}(야구선수)`, name, `${name}(야구)`];
}

function playerSource(player: RosterSourcePlayer): RagSourceInventoryItem {
  const candidateTitles = playerCandidateTitles(player.name);
  const identity = {
    sourceKey: `namu:player:${player.kboId}`,
    sourceKind: "namu_document" as const,
    entityType: "player" as const,
    entityId: player.kboId,
    pageTitle: player.name,
    candidateUrls: candidateTitles.map(namuUrl),
  };
  return {
    ...identity,
    canonicalUrl: null,
    resolutionStatus: null,
    resolutionNote: null,
    sourceGrade: "tier2",
    ingestionStatus: "not_started",
    revision: null,
    contentHash: null,
    crawledAt: null,
    ingestedAt: null,
    staleAfter: null,
    tombstonedAt: null,
    questionCount: 0,
    lastQuestionAt: null,
    identityFingerprint: identityFingerprint(identity),
    metadata: {
      teamId: player.teamId,
      team: player.team,
      candidateTitles,
    },
  };
}

const PRESERVED_FIELDS = [
  "canonicalUrl",
  "resolutionStatus",
  "resolutionNote",
  "ingestionStatus",
  "revision",
  "contentHash",
  "crawledAt",
  "ingestedAt",
  "staleAfter",
  "tombstonedAt",
  "questionCount",
  "lastQuestionAt",
] as const;

function preserveOperationalState(
  current: RagSourceInventoryItem,
  previous: RagSourceInventoryItem | undefined,
): RagSourceInventoryItem {
  if (!previous || previous.identityFingerprint !== current.identityFingerprint) return current;
  const merged = { ...current };
  for (const field of PRESERVED_FIELDS) {
    if (previous[field] !== null && previous[field] !== undefined) {
      (merged as unknown as Record<string, unknown>)[field] = previous[field];
    }
  }
  return merged;
}

export function buildSourceInventory(
  roster: RosterSourcePlayer[],
  previous?: RagSourceInventory,
): RagSourceInventory {
  const previousByKey = new Map(previous?.sources.map((source) => [source.sourceKey, source]));
  const sources = [
    ...KBO_STRUCTURED_SOURCES,
    ...NAMU_CORE_SOURCES,
    ...roster.map(playerSource),
  ]
    .map((source) => preserveOperationalState(source, previousByKey.get(source.sourceKey)))
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
  const inventoryVersion = createHash("sha256")
    .update(JSON.stringify(sources.map(({ sourceKey, sourceKind, entityType, entityId, pageTitle,
      candidateUrls, canonicalUrl, resolutionStatus, sourceGrade, identityFingerprint, metadata }) => ({
      sourceKey,
      sourceKind,
      entityType,
      entityId,
      pageTitle,
      candidateUrls,
      canonicalUrl,
      resolutionStatus,
      sourceGrade,
      identityFingerprint,
      metadata,
    }))))
    .digest("hex");
  return { schemaVersion: 1, inventoryVersion, sources };
}

export function selectDemandOrderedIngestionBatch(
  sources: RagSourceInventoryItem[],
  limit: number,
): RagSourceInventoryItem[] {
  if (!Number.isInteger(limit) || limit < 1) return [];
  return sources
    .filter((source) =>
      source.sourceKind === "namu_document" &&
      source.resolutionStatus === "resolved" &&
      source.tombstonedAt === null &&
      ["not_started", "failed", "stale"].includes(source.ingestionStatus))
    .sort((a, b) =>
      b.questionCount - a.questionCount ||
      (b.lastQuestionAt ?? "").localeCompare(a.lastQuestionAt ?? "") ||
      a.sourceKey.localeCompare(b.sourceKey))
    .slice(0, limit);
}

export function inventoryCoverage(inventory: RagSourceInventory) {
  const players = inventory.sources.filter((source) => source.entityType === "player");
  const counts = { resolved: 0, missing: 0, ambiguous: 0, blocked: 0, pending: 0 };
  for (const source of players) {
    if (source.resolutionStatus === null) counts.pending++;
    else counts[source.resolutionStatus]++;
  }
  return {
    total: players.length,
    counts,
    classificationComplete: counts.pending === 0,
  };
}
