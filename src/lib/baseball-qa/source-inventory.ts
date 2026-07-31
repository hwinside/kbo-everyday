import { createHash } from "node:crypto";

import { TEAMS } from "@/lib/constants/teams";

export type RagSourceKind = "kbo_structured" | "namu_document";
export type RagEntityType = "record_category" | "league" | "team" | "player";
export type RagResolutionStatus = "resolved" | "missing" | "ambiguous" | "blocked";
export type RagIngestionStatus =
  | "not_started"
  | "queued"
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
  sourceGrade: "official" | "secondary";
  ingestionStatus: RagIngestionStatus;
  revision: string | null;
  contentHash: string | null;
  crawledAt: string | null;
  ingestedAt: string | null;
  staleAfter: string | null;
  tombstonedAt: string | null;
  questionCount: number;
  lastQuestionAt: string | null;
  metadata: Record<string, string | number | boolean | string[]>;
}

export interface RagSourceInventory {
  schemaVersion: 1;
  inventoryVersion: string;
  sources: RagSourceInventoryItem[];
}

const KBO_BASE = "https://www.koreabaseball.com";
const NAMU_BASE = "https://namu.wiki/w/";

export const KBO_STRUCTURED_SOURCES: RagSourceInventoryItem[] = [
  ["player-hitter", "선수 타자 기록", "/Record/Player/HitterBasic/Basic1.aspx"],
  ["player-pitcher", "선수 투수 기록", "/Record/Player/PitcherBasic/Basic1.aspx"],
  ["team-hitter-basic1", "팀 타자 기본 기록", "/Record/Team/Hitter/Basic1.aspx"],
  ["team-hitter-basic2", "팀 타자 세부 기록", "/Record/Team/Hitter/Basic2.aspx"],
  ["team-runner", "팀 주루 기록", "/Record/Team/Runner/Basic.aspx"],
  ["team-pitcher", "팀 투수 기록", "/Record/Team/Pitcher/Basic1.aspx"],
  ["team-rank", "팀 순위", "/Record/TeamRank/TeamRank.aspx"],
].map(([id, title, path]) => {
  const canonicalUrl = `${KBO_BASE}${path}`;
  return {
    sourceKey: `kbo:record:${id}`,
    sourceKind: "kbo_structured",
    entityType: "record_category",
    entityId: id,
    pageTitle: title,
    candidateUrls: [canonicalUrl],
    canonicalUrl,
    resolutionStatus: "resolved",
    resolutionNote: "크보팬 structured retrieval에서 사용 중인 KBO 공식 기록실 경로",
    sourceGrade: "official",
    ingestionStatus: "not_started",
    revision: null,
    contentHash: null,
    crawledAt: null,
    ingestedAt: null,
    staleAfter: null,
    tombstonedAt: null,
    questionCount: 0,
    lastQuestionAt: null,
    metadata: { retrievalMode: "structured", embeddingAllowed: false },
  };
});

function namuUrl(title: string): string {
  return `${NAMU_BASE}${encodeURIComponent(title)}`;
}

export const NAMU_CORE_SOURCES: RagSourceInventoryItem[] = [
  {
    sourceKey: "namu:league:kbo",
    entityType: "league" as const,
    entityId: "kbo",
    pageTitle: "KBO 리그",
    metadata: { scope: "league" },
  },
  ...TEAMS.map((team) => ({
    sourceKey: `namu:team:${team.id}`,
    entityType: "team" as const,
    entityId: String(team.id),
    pageTitle: team.name,
    metadata: { teamId: team.id, teamSlug: team.slug },
  })),
].map((seed) => {
  const canonicalUrl = namuUrl(seed.pageTitle);
  return {
    ...seed,
    sourceKind: "namu_document",
    candidateUrls: [canonicalUrl],
    canonicalUrl,
    resolutionStatus: "resolved",
    resolutionNote: "2026-07-31 canonical URL HTTP 200 확인",
    sourceGrade: "secondary",
    ingestionStatus: "not_started",
    revision: null,
    contentHash: null,
    crawledAt: null,
    ingestedAt: null,
    staleAfter: null,
    tombstonedAt: null,
    questionCount: 0,
    lastQuestionAt: null,
  };
});

function playerCandidateTitles(name: string): string[] {
  return [`${name}(야구선수)`, name, `${name}(야구)`];
}

function playerSource(player: RosterSourcePlayer): RagSourceInventoryItem {
  const candidateTitles = playerCandidateTitles(player.name);
  return {
    sourceKey: `namu:player:${player.kboId}`,
    sourceKind: "namu_document",
    entityType: "player",
    entityId: player.kboId,
    pageTitle: player.name,
    candidateUrls: candidateTitles.map(namuUrl),
    canonicalUrl: null,
    resolutionStatus: null,
    resolutionNote: null,
    sourceGrade: "secondary",
    ingestionStatus: "not_started",
    revision: null,
    contentHash: null,
    crawledAt: null,
    ingestedAt: null,
    staleAfter: null,
    tombstonedAt: null,
    questionCount: 0,
    lastQuestionAt: null,
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
  if (!previous) return current;
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
    .update(JSON.stringify(sources.map(({ sourceKey, candidateUrls, metadata }) => ({
      sourceKey,
      candidateUrls,
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
