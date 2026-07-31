/**
 * 야잘알봇 v2 Hybrid RAG — 소스 인벤토리 시드 (rev0.7 §12).
 *
 * 무엇을 하는가: "무엇을 수집 대상으로 삼을지"의 전수 목록을 결정론적으로 생성한다.
 *   - KBO 기록실 범주(tier1, 정량 정본)
 *   - KBO 리그 나무위키 1페이지(tier2)
 *   - 10개 구단 나무위키(tier2, 전량)
 *   - players-roster.json 878명 각각의 나무위키(tier2, 전수 등재)
 *
 * 무엇을 하지 않는가: 실제 크롤/검증을 하지 않는다. 그래서 신규 시드는 대부분
 * `pending`(아직 확인 안 됨)이고, 동명이인은 `ambiguous`로 분리된다.
 * **크롤 검증 전에 `resolved`로 올리지 않는다** — 확인 안 된 것을 확인됐다고 쓰지 않기 위함.
 *
 * 전수 완료 판정(§12): status에 `pending`이 1건이라도 남아 있으면 전수 완료가 아니다.
 */

import playersRoster from "@/lib/constants/players-roster.json";
import { TEAMS } from "@/lib/constants/teams";
import type { RosterPlayer } from "@/types/api";
import {
  gradeForSourceKind,
  type InventoryStatus,
  type RagEntityType,
  type RagSourceKind,
  type SourceGrade,
} from "./contracts";
import { includedRecordSources, kboRecordUrl } from "./kbo-record-universe";

export interface InventorySeedRow {
  entityType: RagEntityType;
  entityId: string;
  entityName: string;
  sourceKind: RagSourceKind;
  sourceGrade: SourceGrade;
  /** ambiguous/missing이면 null — 임의 후보를 canonical로 승격하지 않는다. */
  canonicalUrl: string | null;
  status: InventoryStatus;
  statusReason: string | null;
}

const NAMU_BASE = "https://namu.wiki/w/";

/** 나무위키 canonical page URL 후보. 문서 제목만 알 뿐 존재 여부는 크롤 전까지 미확인. */
export function namuwikiUrl(pageTitle: string): string {
  return `${NAMU_BASE}${encodeURIComponent(pageTitle)}`;
}

/**
 * KBO 기록실 수집 범주 (tier1 정본).
 *
 * 목록을 이 파일에 직접 쓰지 않고 `kbo-record-universe`의 included 항목에서 파생한다
 * (삼순 재리뷰 #6: 상수 자기참조 게이트 제거). universe는 공식 navigation 전수 실측 SSOT이고,
 * 이 상수는 그중 수집 대상만 투영한 뷰다. 파싱 스키마 확정은 S1b 범위.
 */
export const KBO_RECORD_BOOK_SOURCES: { id: string; name: string; url: string }[] =
  includedRecordSources().map((entry) => ({
    id: entry.id,
    name: entry.name,
    url: kboRecordUrl(entry.path),
  }));

/** KBO 리그 나무위키 문서 제목. */
const KBO_LEAGUE_PAGE_TITLE = "KBO 리그";

function rosterPlayers(): RosterPlayer[] {
  return playersRoster as RosterPlayer[];
}

/** 이름 → kboId 목록. 동명이인 판정에 사용. */
function nameToKboIds(players: RosterPlayer[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const player of players) {
    const ids = map.get(player.name);
    if (ids) ids.push(player.kboId);
    else map.set(player.name, [player.kboId]);
  }
  return map;
}

/**
 * 전수 인벤토리 시드 생성.
 * 결정론적(입력 = roster JSON + TEAMS 상수)이라 같은 입력이면 같은 결과가 나온다.
 */
export function buildInventorySeed(): InventorySeedRow[] {
  const rows: InventorySeedRow[] = [];

  // 1) KBO 기록실 (tier1)
  for (const source of KBO_RECORD_BOOK_SOURCES) {
    rows.push({
      entityType: "record_book",
      entityId: source.id,
      entityName: source.name,
      sourceKind: "kbo_official",
      sourceGrade: gradeForSourceKind("kbo_official"),
      canonicalUrl: source.url,
      status: "pending",
      statusReason: "awaiting_extractor_verification",
    });
  }

  // 2) KBO 리그 나무위키 (tier2)
  rows.push({
    entityType: "league",
    entityId: "KBO",
    entityName: KBO_LEAGUE_PAGE_TITLE,
    sourceKind: "namuwiki",
    sourceGrade: gradeForSourceKind("namuwiki"),
    canonicalUrl: namuwikiUrl(KBO_LEAGUE_PAGE_TITLE),
    status: "pending",
    statusReason: "awaiting_crawl_verification",
  });

  // 3) 10개 구단 나무위키 (tier2, 전량)
  for (const team of TEAMS) {
    rows.push({
      entityType: "team",
      entityId: String(team.id),
      entityName: team.name,
      sourceKind: "namuwiki",
      sourceGrade: gradeForSourceKind("namuwiki"),
      canonicalUrl: namuwikiUrl(team.name),
      status: "pending",
      statusReason: "awaiting_crawl_verification",
    });
  }

  // 4) 로스터 878명 나무위키 (tier2, 전수 등재)
  const players = rosterPlayers();
  const byName = nameToKboIds(players);
  for (const player of players) {
    const base = {
      entityType: "player" as const,
      entityId: player.kboId,
      entityName: player.name,
      sourceKind: "namuwiki" as const,
      sourceGrade: gradeForSourceKind("namuwiki"),
    };

    // 4-1) 이름 결측 = 문서 제목을 만들 수 없음 → missing(조용히 빠뜨리지 않고 명시 기록)
    if (!player.name || player.name.trim() === "") {
      rows.push({
        ...base,
        entityName: `(unnamed:${player.kboId})`,
        canonicalUrl: null,
        status: "missing",
        statusReason: "roster_name_empty",
      });
      continue;
    }

    // 4-2) 동명이인 = 이름만으로 canonical 문서를 확정할 수 없음 → ambiguous.
    // 나무위키는 동명이인을 괄호 접미사로 분리하므로 임의 선택은 오연결 위험이 크다.
    // 기존 AMBIGUOUS 계약(§6)과 동일하게 임의 선택 대신 분류 보류한다.
    const sameName = byName.get(player.name) ?? [];
    if (sameName.length > 1) {
      rows.push({
        ...base,
        canonicalUrl: null,
        status: "ambiguous",
        statusReason: `duplicate_name_kboIds:${sameName.join("|")}`,
      });
      continue;
    }

    rows.push({
      ...base,
      canonicalUrl: namuwikiUrl(player.name),
      status: "pending",
      statusReason: "awaiting_crawl_verification",
    });
  }

  return rows;
}

export interface InventoryCoverage {
  total: number;
  byStatus: Record<InventoryStatus, number>;
  byEntityType: Record<RagEntityType, number>;
  /** §12 완료 게이트: pending 0일 때만 '분류 100%'. resolved 100%와는 별개 조건이다. */
  fullyClassified: boolean;
}

export function summarizeCoverage(rows: InventorySeedRow[]): InventoryCoverage {
  const byStatus: Record<InventoryStatus, number> = {
    resolved: 0,
    missing: 0,
    ambiguous: 0,
    blocked: 0,
    pending: 0,
  };
  const byEntityType: Record<RagEntityType, number> = {
    league: 0,
    team: 0,
    player: 0,
    record_book: 0,
  };

  for (const row of rows) {
    byStatus[row.status] += 1;
    byEntityType[row.entityType] += 1;
  }

  return {
    total: rows.length,
    byStatus,
    byEntityType,
    fullyClassified: byStatus.pending === 0,
  };
}
