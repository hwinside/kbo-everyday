/**
 * 직관 다이어리 통계 S1a — 적재 완전성(완료 증거) 순수 로직.
 * spec: Notion "[기획] 직관 다이어리 통계 v1" rev5 §11(ledger)·§12(canonical hash / fail-closed)
 *
 * 이 모듈은 네트워크·DB 없이 순수 함수만 둔다:
 *  - canonicalPayloadHash: PlayerGameLogRow 20필드 전체 canonical 직렬화 sha256 (§12)
 *  - buildGameIngestion: 결측→0 강등 금지(fail-closed) strict row 빌드 + raw/resolved 계수 (§12)
 *  - evaluateIngestion: complete|incomplete 판정 (§11 적재 순서의 마지막 단계)
 *  - verifyLedgerCompleteness: 집계 시점 runtime 재검증 (ledger complete만으로 신뢰 금지, §11)
 *
 * ⚠️ 기존 ingest.ts buildGameLogRows의 n(v)=Number(v)||0 강등 경로는 §12가 금지한
 *    바로 그 경로다. 완료 증거 파이프라인은 반드시 이 모듈의 strict 빌더를 쓴다.
 */
import { createHash } from "node:crypto";
import { resolvePlayer } from "@/lib/utils/resolve-player";
import type { KboGame } from "@/lib/crawler/kbo-api";
import {
  TEAM_ID_TO_CODE,
  type GameBoxscore,
  type PlayerGameLogRow,
  type UnresolvedBoxScorePlayer,
} from "@/lib/game-logs/ingest";
import { extractErrorText, reconcileGameErrors } from "@/lib/game-logs/errors";

/** §12 canonical row tuple — PlayerGameLogRow 실제 20필드 전체(메타 9 + 스탯 11). 부분 tuple 금지. */
export const CANONICAL_ROW_FIELDS = [
  "kbo_id", "player_type", "game_id", "game_date", "team_id", "team_code",
  "opponent_team_id", "is_home", "result",
  "ab", "h", "hr", "rbi", "bb", "so",
  "ip_outs", "er", "h_allowed", "k", "bb_allowed",
] as const;

export type CanonicalRowField = (typeof CANONICAL_ROW_FIELDS)[number];
/** hash 입력 행 — DB 재조회 행/빌드 행 모두 이 shape로 받는다. */
export type CanonicalRowInput = Partial<Record<CanonicalRowField, unknown>>;

/** §12: null/결측 리터럴 "∅" — 0·빈문자열과 구분. */
export const CANONICAL_NULL = "\u2205";

function serializeValue(v: unknown): string {
  if (v === null || v === undefined) return CANONICAL_NULL;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v); // 10진 문자열
  return String(v);
}

/**
 * §12 canonical payload hash.
 * (kbo_id asc, player_type asc) 행 정렬 → 필드 순서 CANONICAL_ROW_FIELDS 고정 →
 * 필드 "," / 행 "|" join → sha256 hex. 행 순서와 무관하게 동일 payload면 동일 hash.
 */
export function canonicalPayloadHash(rows: CanonicalRowInput[]): string {
  const sorted = [...rows].sort((a, b) => {
    const ka = serializeValue(a.kbo_id);
    const kb = serializeValue(b.kbo_id);
    if (ka !== kb) return ka < kb ? -1 : 1;
    const pa = serializeValue(a.player_type);
    const pb = serializeValue(b.player_type);
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  const payload = sorted
    .map((row) => CANONICAL_ROW_FIELDS.map((f) => serializeValue(row[f])).join(","))
    .join("|");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** §12 필수필드 strict 파싱: 결측/공백/비숫자 → null (0 강등 금지). */
export function parseStrictStat(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 이닝 표기 strict 파싱 → 총 아웃. 실제 공급자 형식 화이트리스트만 허용:
 *  - KBO 소수 표기: "N", "N.1"(⅓), "N.2"(⅔) — 예) "6.1" → 19
 *  - Naver record API 유니코드 분수 표기: "N ⅓"(U+2153)/"N ⅔"(U+2154), 공백 유무 변형 포함 —
 *    예) "0 ⅓" → 1, "1 ⅔" → 5 (삼순 재리뷰 P0: 2026 final 480경기 중 416경기 ip_outs 1,690행이 이 표기)
 * 그 외 형식/결측 → null (§12 fail-closed — 0 강등 금지).
 */
export function parseStrictIpOuts(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  const decimal = /^(\d+)(?:\.([0-2]))?$/.exec(s);
  if (decimal) return parseInt(decimal[1], 10) * 3 + (decimal[2] ? parseInt(decimal[2], 10) : 0);
  const unicodeFrac = /^(\d+)\s*([\u2153\u2154])$/.exec(s);
  if (unicodeFrac) return parseInt(unicodeFrac[1], 10) * 3 + (unicodeFrac[2] === "\u2153" ? 1 : 2);
  return null;
}

/** raw row에서 필수 stat 필드를 읽지 못한 케이스 (§12 missing_required_field). */
export interface MissingRequiredField {
  name: string;
  teamId: number;
  playerType: "batter" | "pitcher";
  field: string;
}

/** 테스트/특수 경로용 resolver 주입 지점 — 기본은 SSOT resolvePlayer. */
export type PlayerResolver = (q: { name: string; teamId: number }) => { kboId: string } | null;

/**
 * 수비 실책 enrichment — 하린아빠 2026-08-02 `발암경기 인내형` 트랙.
 *
 * ⚠️ **canonical payload hash 에 넣지 않는다.** `CANONICAL_ROW_FIELDS` 20필드는 운영
 * 원장 468건의 `expected_payload_hash` 기준이라, 필드를 추가하면 그 468건이 전부
 * `payload_hash_mismatch` 로 뒤집혀 직관 통계가 전 유저 fail-close 된다(= P0 장애).
 * 그래서 실책은 hash 계약 **바깥의** 부수 정보로 싣고, 완전성은 자체 신호로 판정한다.
 */
export interface GameErrorEnrichment {
  /** `(kbo_id, player_type)` → 실책 수. 검증 통과분만. */
  byKey: Map<string, number>;
  /** 이 경기의 실책을 신뢰할 수 있는가. false 면 DB 에 NULL(미상)로 남긴다. */
  verified: boolean;
}

export interface GameIngestionBuild {
  /** strict 검증·resolve를 통과한 canonical row set. missingFields가 있으면 비운다(부분 적재 금지). */
  rows: PlayerGameLogRow[];
  /** 수비 실책 enrichment (canonical hash 바깥). verified=false 면 DB 에 NULL(미상). */
  errors: GameErrorEnrichment;
  /** 크롤 raw row 수 = 박스스코어 타자+투수 이름 있는 행 전부 (§12 1:1 가드의 좌변). */
  rawRowCount: number;
  /** kbo_id 매핑 성공 행 수. */
  resolvedRowCount: number;
  unresolved: UnresolvedBoxScorePlayer[];
  missingFields: MissingRequiredField[];
}

/** YYYYMMDD → YYYY-MM-DD */
function toIsoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function resultFor(myScore: number, oppScore: number): "W" | "L" | "D" {
  if (myScore > oppScore) return "W";
  if (myScore < oppScore) return "L";
  return "D";
}

/**
 * 완료 증거용 strict row 빌드 (§11 적재 순서 1~3단계).
 * - 필수 stat 필드(타자 ab/hit/hr/rbi/bb/kk, 투수 inn/er/hit/kk/bb)를 못 읽으면
 *   그 필드를 0으로 강등하지 않고 missingFields에 기록한다 (§12 fail-closed).
 * - missingFields가 1건이라도 있으면 rows는 비운다 — 부분 적재로 오염된 canonical set 금지.
 * - resolve 실패 행은 unresolved에 기록 (rawRowCount ≠ resolvedRowCount → incomplete).
 * - 같은 (kbo_id, player_type) 중복은 1행만 유지하되 rawRowCount에는 계수 → 1:1 가드로 감지.
 */
export function buildGameIngestion(
  game: KboGame,
  box: GameBoxscore,
  resolver: PlayerResolver = (q) =>
    resolvePlayer({ name: q.name, teamId: q.teamId }, undefined, { context: "venue-stats:ledger" }),
): GameIngestionBuild {
  const build: GameIngestionBuild = {
    rows: [], rawRowCount: 0, resolvedRowCount: 0, unresolved: [], missingFields: [],
    errors: { byKey: new Map(), verified: false },
  };
  if (game.awayScore == null || game.homeScore == null) return build;

  const gameDate = toIsoDate(game.date);
  const seen = new Set<string>();

  const sides = [
    {
      batters: box.homeBatters, pitchers: box.homePitchers,
      teamId: game.homeTeamId, oppId: game.awayTeamId, isHome: true,
      myScore: game.homeScore, oppScore: game.awayScore,
    },
    {
      batters: box.awayBatters, pitchers: box.awayPitchers,
      teamId: game.awayTeamId, oppId: game.homeTeamId, isHome: false,
      myScore: game.awayScore, oppScore: game.homeScore,
    },
  ];

  for (const side of sides) {
    if (!side.teamId) continue;
    const teamCode = TEAM_ID_TO_CODE[side.teamId] ?? "";
    const result = resultFor(side.myScore, side.oppScore);
    const base = {
      game_id: game.gameId, game_date: gameDate,
      team_id: side.teamId, team_code: teamCode, opponent_team_id: side.oppId,
      is_home: side.isHome, result,
    };

    for (const b of side.batters) {
      const name = String(b.name ?? "").trim();
      if (!name) continue;
      build.rawRowCount++;
      const stats = {
        ab: parseStrictStat(b.ab), h: parseStrictStat(b.hit), hr: parseStrictStat(b.hr),
        rbi: parseStrictStat(b.rbi), bb: parseStrictStat(b.bb), so: parseStrictStat(b.kk),
      };
      const missing = (Object.entries(stats) as Array<[string, number | null]>).filter(([, v]) => v === null);
      if (missing.length > 0) {
        for (const [field] of missing) {
          build.missingFields.push({ name, teamId: side.teamId, playerType: "batter", field });
        }
        continue;
      }
      const resolved = resolver({ name, teamId: side.teamId });
      if (!resolved) {
        build.unresolved.push({ name, teamId: side.teamId, teamCode, playerType: "batter" });
        continue;
      }
      build.resolvedRowCount++;
      const key = `${resolved.kboId}|batter`;
      if (seen.has(key)) continue;
      seen.add(key);
      build.rows.push({
        ...base, kbo_id: resolved.kboId, player_type: "batter",
        ab: stats.ab!, h: stats.h!, hr: stats.hr!, rbi: stats.rbi!, bb: stats.bb!, so: stats.so!,
        ip_outs: 0, er: 0, h_allowed: 0, k: 0, bb_allowed: 0,
      });
    }

    for (const p of side.pitchers) {
      const name = String(p.name ?? "").trim();
      if (!name) continue;
      build.rawRowCount++;
      const stats = {
        ip_outs: parseStrictIpOuts(p.inn), er: parseStrictStat(p.er),
        h_allowed: parseStrictStat(p.hit), k: parseStrictStat(p.kk), bb_allowed: parseStrictStat(p.bb),
      };
      const missing = (Object.entries(stats) as Array<[string, number | null]>).filter(([, v]) => v === null);
      if (missing.length > 0) {
        for (const [field] of missing) {
          build.missingFields.push({ name, teamId: side.teamId, playerType: "pitcher", field });
        }
        continue;
      }
      const resolved = resolver({ name, teamId: side.teamId });
      if (!resolved) {
        build.unresolved.push({ name, teamId: side.teamId, teamCode, playerType: "pitcher" });
        continue;
      }
      build.resolvedRowCount++;
      const key = `${resolved.kboId}|pitcher`;
      if (seen.has(key)) continue;
      seen.add(key);
      build.rows.push({
        ...base, kbo_id: resolved.kboId, player_type: "pitcher",
        ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, so: 0,
        ip_outs: stats.ip_outs!, er: stats.er!, h_allowed: stats.h_allowed!,
        k: stats.k!, bb_allowed: stats.bb_allowed!,
      });
    }
  }

  // ── 수비 실책 enrichment (하린아빠 2026-08-02) ────────────────────────────
  // 선수별 실책은 타자/투수 박스스코어가 아니라 `etcRecords`(주요기록)에만 있다.
  // 이름 → 팀 판정은 **이 경기에 실제로 출전한 선수**로만 한다(로스터 전역 조회 금지) —
  // 같은 이름이 다른 팀에 있어도 이 경기 출전자 기준이면 배분이 흔들리지 않는다.
  {
    const nameToSide = new Map<string, "away" | "home" | "ambiguous">();
    const nameToKey = new Map<string, string>();
    for (const side of sides) {
      if (!side.teamId) continue;
      const sideLabel: "away" | "home" = side.isHome ? "home" : "away";
      for (const b of side.batters) {
        const name = String(b.name ?? "").trim();
        if (!name) continue;
        const prev = nameToSide.get(name);
        // 같은 이름이 양 팀에 출전 → 배분 불가로 표시(전체 fail-close 유도).
        nameToSide.set(name, prev && prev !== sideLabel ? "ambiguous" : sideLabel);
        const resolved = resolver({ name, teamId: side.teamId });
        if (resolved) nameToKey.set(name, `${resolved.kboId}|batter`);
      }
    }
    const record = reconcileGameErrors({
      errorText: extractErrorText(box.etcRecords),
      rheb: box.rheb,
      resolveTeam: (name) => {
        const side = nameToSide.get(name);
        return side === "away" || side === "home" ? side : null;
      },
    });
    if (record) {
      let allMapped = true;
      const byKey = new Map<string, number>();
      for (const [name, count] of record.byPlayerName) {
        const key = nameToKey.get(name);
        // 실책 선수가 우리 원장 행으로 매핑되지 않으면(미등록 등) 이 경기는 미상 처리.
        if (!key) { allMapped = false; break; }
        byKey.set(key, (byKey.get(key) ?? 0) + count);
      }
      if (allMapped) build.errors = { byKey, verified: true };
    }
  }

  // missing_required_field fail-closed: 부분 row set을 canonical 증거로 쓰지 않는다.
  if (build.missingFields.length > 0) {
    build.rows = [];
    build.resolvedRowCount = 0;
    // 행이 없으면 실책도 붙일 곳이 없다 — 완전성 신호도 함께 내린다.
    build.errors = { byKey: new Map(), verified: false };
  }
  return build;
}

export type IngestionFailureReason =
  | "missing_required_field"
  | "unresolved_player"
  | "row_count_mismatch"
  | "payload_hash_mismatch"
  | "boxscore_unavailable"
  | "score_unavailable";

export interface IngestionEvidence {
  rawRowCount: number;
  resolvedRowCount: number;
  persistedRowCount: number;
  unresolvedCount: number;
  missingFieldCount: number;
  expectedRowCount: number;
  expectedPayloadHash: string;
  actualPayloadHash: string | null;
}

/**
 * §11 complete 판정: unresolved=0 AND raw=resolved=persisted(=expected) AND
 * expected hash=actual hash일 때만 complete. 그 외 전부 incomplete.
 */
export function evaluateIngestion(
  e: IngestionEvidence,
): { status: "complete" | "incomplete"; failureReason: IngestionFailureReason | null } {
  if (e.missingFieldCount > 0) return { status: "incomplete", failureReason: "missing_required_field" };
  if (e.unresolvedCount > 0) return { status: "incomplete", failureReason: "unresolved_player" };
  if (
    e.rawRowCount !== e.resolvedRowCount ||
    e.resolvedRowCount !== e.expectedRowCount ||
    e.expectedRowCount !== e.persistedRowCount
  ) {
    return { status: "incomplete", failureReason: "row_count_mismatch" };
  }
  if (e.actualPayloadHash === null || e.actualPayloadHash !== e.expectedPayloadHash) {
    return { status: "incomplete", failureReason: "payload_hash_mismatch" };
  }
  return { status: "complete", failureReason: null };
}

export interface LedgerRecord {
  status: "complete" | "incomplete";
  expected_row_count: number | null;
  expected_payload_hash: string | null;
}

export type LedgerVerifyReason =
  | "ledger_missing"
  | "ledger_incomplete"
  | "row_count_mismatch"
  | "payload_hash_mismatch";

/**
 * §11 runtime completeness: ledger complete만으로 신뢰하지 않고 매 집계 시점에
 * 현재 player_game_logs 행의 actual count + canonical payload hash를 ledger와 대조한다.
 * 행 누락·단일 필드 0 오염 drift·metadata-only 오염(team_id/result 변조) 전부 여기서 감지.
 * ledger 없음은 heuristic fallback 없이 incomplete (§11).
 */
export function verifyLedgerCompleteness(
  ledger: LedgerRecord | null | undefined,
  rows: CanonicalRowInput[],
): { complete: boolean; reason: LedgerVerifyReason | null } {
  if (!ledger) return { complete: false, reason: "ledger_missing" };
  if (ledger.status !== "complete" || ledger.expected_row_count === null || ledger.expected_payload_hash === null) {
    return { complete: false, reason: "ledger_incomplete" };
  }
  if (rows.length !== ledger.expected_row_count) {
    return { complete: false, reason: "row_count_mismatch" };
  }
  if (canonicalPayloadHash(rows) !== ledger.expected_payload_hash) {
    return { complete: false, reason: "payload_hash_mismatch" };
  }
  return { complete: true, reason: null };
}
