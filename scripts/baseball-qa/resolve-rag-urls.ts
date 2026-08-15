/**
 * tier2 canonical URL을 해석해 resolution_status를 확정한다.
 *
 * ⚠️ **범위 계약 (2026-08-15)** — 종전엔 `S2B_TARGET_PLAYERS`(16명)만 돌았다. 그러는 사이
 * 로스터 나머지는 별도 벌크 경로(`w/{이름}` 단일 시도)로 수집돼, 이 파일이 가진
 * 괄호 표제어·동음이의 재해석이 **대다수에게 적용된 적이 없다.**
 * 실측(2026-08-15): 김재환은 `w/김재환`(동명이인 목록 페이지)를 받아 신원 게이트가 격리했고,
 * 그 다음 후보가 없어 그대로 끝났다 — corpus에 김재환 선수 문서가 0건이 된 이유다.
 * 그래서 기본 범위를 **로스터 전체**로 바꿈. `--scope=targets`는 S2b 슬라이스 재현용으로만 남긴다.
 *
 * 실행: `npm run rag:resolve-urls`  (수동. GitHub Actions 직접 수집은 나무 IP 차단으로 부적합,
 *        맥미니 LaunchAgent 금지 — P0)
 *   옵션: `--dry-run` DB 쓰기 없이 판정만 출력
 *         `--source=wikipedia|namu` 해석할 소스 (기본 wikipedia)
 *         `--scope=snapshot|roster|targets` 해석 대상 (기본 snapshot = 0단계 나무 공백 스냅샷의
 *                  해석 필요 버킷. roster = 로스터 전체, targets = S2b 16명 재현)
 *         `--fetcher=chrome|cdp` 나무 fetch 경로 (기본 chrome = 로컬 headed Chrome 재기동.
 *                  cdp = A17 폰 Chrome CDP — `NAMU_CDP_URL`/`--cdp-url`, adb forward 전제)
 *         `--interval-ms=<N>` 요청 간 최소 간격. 기본 5000 + 0~2000ms 지터.
 *                  ⚠️ 2026-08-15 하린아빠 지시로 기본을 10초 미만(5초+지터)으로 낮췄다.
 *                  실측 하한(데스크톱 2.5초 연타 403)을 감안해 바닥 3000ms 미만은 거부한다.
 *                  안전선은 간격이 아니라 **첫 blocked 전역 즉시 중단**이다(삼순 계약).
 *         `--checkpoint=<path>` kboId 단위 진행 원장(JSONL). 있으면 이어받기(resume)한다.
 *         `--name=<이름>` 특정 선수만 (반복 가능, 검증·재시도용)
 *         `--limit=<N>` 앞에서 N명만 (bounded rate 때문에 분할 실행이 필요하다)
 *         `--out=<path>` 판정 결과 JSON 저장 (ingest 스크립트 입력)
 *
 * 소스 우선순위 (하린아빠 지시, R3): **위키피디아가 기본, 나무위키는 보조**다.
 *   - wikipedia: 공식 API + 정직한 UA plain fetch. 서버 런타임에서도 가능한 경로다. revid가 정본.
 *   - namu: Playwright 실크롤(요청마다 브라우저 재기동 + 10초 간격). 별명·팬덤 서술 보충용.
 *
 * 판정 계약 (spec rev0.7 §12 / §12.2 d):
 *   resolved   — 후보 중 **정확히 하나가 identity 게이트를 통과**하고 동명이인 위험이 없음.
 *                identity 게이트 = 최종 URL + rel=canonical(나무위키) + **문서 분류 대조**
 *                (동음이의 아님 / 야구 선수 분류 / 생년 일치 / 제목에 이름 포함).
 *                **HTTP 200 단독으로는 canonical을 단정하지 않는다.**
 *   ambiguous  — 로스터에 동명이인이 있거나 후보 여럿이 서로 다른 문서로 동시에 통과
 *   missing    — 후보 전부 부재
 *   blocked    — 봇차단 등으로 확인 자체가 불가능
 *
 * §12.2(b): 차단을 만나면 그 선수에 대한 추가 요청을 중단한다. 우회하지 않는다.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  CANONICAL_GATE_VERSION,
  expectedPlayerTitles,
  extractDisambiguationCandidates,
  verifyCanonicalIdentity,
  type PlayerDocumentIdentity,
} from "../../src/lib/baseball-qa/rag/canonical";
import { assertRobotsAllowed } from "../../src/lib/baseball-qa/rag/fetch-namu";
import { fetchWikipediaDocument } from "../../src/lib/baseball-qa/rag/fetch-wikipedia";
import { buildResolutionSourceRow } from "../../src/lib/baseball-qa/rag/source-resolution";
import { S2B_TARGET_PLAYERS } from "../../src/lib/baseball-qa/rag/targets";
import { fetchNamuDocumentViaBrowser } from "./rag/fetch-namu-browser";
import { fetchNamuDocumentViaCdp } from "./rag/fetch-namu-cdp";

type Resolution = "resolved" | "missing" | "ambiguous" | "blocked" | "budget_exhausted";

/** checkpoint 행 — probe(요청 1건)와 verdict(선수 최종 판정) 두 종류. (kboId, candidateUrl) 단위로
 * 요청을 기록해 재시작 시 같은 URL을 다시 두드리지 않는다(삼순 계약). */
export interface CheckpointProbeRow {
  t: "probe";
  kboId: string;
  title: string;
  url: string;
  kind: "canonical" | "rejected" | "missing";
  reason?: string;
  canonicalUrl?: string;
  pageTitle?: string;
  redirected?: boolean;
  /** 동음이의 문서에서 뽑았던 파생 후보 — replay 시 재요청 없이 그대로 이어받는다. */
  candidates?: string[];
  at: string;
}

/**
 * checkpoint run fingerprint (P0, 2026-08-15 삼순) — 다른 source/scope/스냅샷/예산으로 만든
 * checkpoint를 이어받으면 대상이 잘못 skip된다. 첫 줄에 박아 넣고 resume 시 일치 검증한다.
 */
export interface CheckpointFingerprint {
  t: "fingerprint";
  source: string;
  scope: string;
  snapshotSha256: string;
  budget: number;
  schedule: string;
  /** 판정 로직 리비전 — 코드 판정이 바뀜 뒤 구 checkpoint 재사용 차단(삼순 P1). */
  resolverRevision: string;
  canonicalGateVersion: string;
}

/**
 * resolver 판정 로직 리비전 — 후보 생성·판정 규칙의 의미가 바뀌면 올린다.
 * canonical 게이트 버전과 함께 fingerprint에 들어가 구 판정 checkpoint 재사용을 막는다(삼순 P1).
 */
export const RESOLVER_REVISION = "2026-08-15.r3";

export function buildCheckpointFingerprint(input: {
  source: string; scope: string; snapshotSha256: string;
}): CheckpointFingerprint {
  return {
    t: "fingerprint",
    source: input.source,
    scope: input.scope,
    snapshotSha256: input.snapshotSha256,
    budget: MAX_PROBES_PER_PLAYER,
    schedule: INTERVAL_PROBE_SCHEDULE_MS.join("-"),
    resolverRevision: RESOLVER_REVISION,
    canonicalGateVersion: CANONICAL_GATE_VERSION,
  };
}

export interface ParsedCheckpoint {
  /** 완료된 선수의 full 판정 행 — resume 후 최종 판정표에 병합된다(삼순 P0: 유실 금지). */
  doneRows: ResultRow[];
  probedByKboId: Map<string, CheckpointProbeRow[]>;
}

/** 판정 결과 1행 — checkpoint·--out·DB 경로가 전부 이 모양을 쓴다. */
export interface ResultRow {
  sourceKey: string;
  kboId: string;
  name: string;
  source: SourceName;
  status: Resolution;
  canonicalUrl: string | null;
  pageTitle: string | null;
  candidateUrls: string[];
  note: string;
}

const CHECKPOINT_VERDICT_STATUSES = new Set(["resolved", "missing", "ambiguous", "budget_exhausted"]);
const CHECKPOINT_PROBE_KINDS = new Set(["canonical", "rejected", "missing"]);

/**
 * checkpoint 본문 파싱 — 손상·스키마 오류·fingerprint 불일치는 전부 **throw(fail-close)**한다.
 * 손상된 파일을 "신규 생성"으로 삼켜 진행하면 기록되었던 요청을 재발사하거나 엉뚱한 대상을 skip한다.
 */
export function parseCheckpointText(text: string, expected: CheckpointFingerprint): ParsedCheckpoint {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("checkpoint가 비어 있다(헤더 부재) — fail-close");
  let header: CheckpointFingerprint;
  try {
    header = JSON.parse(lines[0]) as CheckpointFingerprint;
  } catch {
    throw new Error("checkpoint 헤더 JSON 손상 — fail-close");
  }
  if (header.t !== "fingerprint") throw new Error("checkpoint 첫 줄이 fingerprint가 아니다 — fail-close");
  for (const key of ["source", "scope", "snapshotSha256", "budget", "schedule", "resolverRevision", "canonicalGateVersion"] as const) {
    if (String(header[key]) !== String(expected[key])) {
      throw new Error(`checkpoint fingerprint 불일치: ${key}=${String(header[key])} (기대 ${String(expected[key])}) — fail-close`);
    }
  }
  const doneRows: ResultRow[] = [];
  const probedByKboId = new Map<string, CheckpointProbeRow[]>();
  for (const [index, line] of lines.slice(1).entries()) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`checkpoint ${index + 2}번 줄 JSON 손상 — fail-close`);
    }
    if (row.t === "probe") {
      const probe = row as unknown as CheckpointProbeRow;
      if (typeof probe.kboId !== "string" || typeof probe.title !== "string" || typeof probe.url !== "string"
        || !CHECKPOINT_PROBE_KINDS.has(probe.kind)) {
        throw new Error(`checkpoint ${index + 2}번 줄 probe 스키마 오류 — fail-close`);
      }
      const list = probedByKboId.get(probe.kboId) ?? [];
      list.push(probe);
      probedByKboId.set(probe.kboId, list);
    } else if (row.t === "verdict") {
      // verdict는 **full ResultRow**를 품는다(삼순 P0) — resume 후 최종 판정표에 그대로 복원된다.
      const result = row.row as ResultRow | undefined;
      if (!result || typeof result.kboId !== "string" || typeof result.name !== "string"
        || typeof result.sourceKey !== "string" || !Array.isArray(result.candidateUrls)
        || !CHECKPOINT_VERDICT_STATUSES.has(String(result.status))) {
        throw new Error(`checkpoint ${index + 2}번 줄 verdict 스키마 오류(status=${String((result ?? row as { status?: unknown }).status)}) — fail-close`);
      }
      doneRows.push(result);
    } else {
      throw new Error(`checkpoint ${index + 2}번 줄 알 수 없는 행 타입(t=${String(row.t)}) — fail-close`);
    }
  }
  return { doneRows, probedByKboId };
}

/**
 * 최종 판정표 병합(삼순 P0) — resume 이전 완료분 + 이번 run 신규분. kboId 중복은 버그
 * 신호다(done은 target에서 제외되므로) — 조용히 덮지 않고 던진다.
 */
export function mergeResultRows(done: readonly ResultRow[], fresh: readonly ResultRow[]): ResultRow[] {
  const merged = [...done, ...fresh];
  const seen = new Set<string>();
  for (const row of merged) {
    if (seen.has(row.kboId)) throw new Error(`판정표 kboId 중복: ${row.kboId} — resume 병합 결함(fail-close)`);
    seen.add(row.kboId);
  }
  return merged;
}
type SourceName = "wikipedia" | "namu";
type ResolveScope = "snapshot" | "roster" | "targets";
type FetcherName = "chrome" | "cdp";

/** 0단계 나무 공백 스냅샷(2026-08-15) — resolver 해석 대상의 SSOT. */
const GAP_SNAPSHOT_PATH = "scripts/qa/fixtures/corpus-gap-snapshot-20260815.json";
/** 스냅샷 버킷 중 외부 해석이 필요한 것들. `적재만(기존 corpus 재사용)`은 재크롤 대상이 아니다. */
const SNAPSHOT_RESOLVE_BUCKETS = new Set(["외부 해석 필요", "원장 미등록"]);

/** 해석 대상 한 명. `S2B_TARGET_PLAYERS`와 로스터 행을 같은 모양으로 받는다. */
interface ResolveTarget { kboId: string; name: string }

interface RosterPlayer { name: string; kboId: string; team: string; birthDate?: string }

const DRY_RUN = process.argv.includes("--dry-run");
const SOURCE = (process.argv.find((arg) => arg.startsWith("--source="))?.split("=")[1] ?? "wikipedia") as SourceName;
const OUT_PATH = process.argv.find((arg) => arg.startsWith("--out="))?.split("=")[1] ?? null;
const SCOPE = (process.argv.find((arg) => arg.startsWith("--scope="))?.split("=")[1] ?? "snapshot") as ResolveScope;
const FETCHER = (process.argv.find((arg) => arg.startsWith("--fetcher="))?.split("=")[1] ?? "chrome") as FetcherName;
const CDP_URL = process.argv.find((arg) => arg.startsWith("--cdp-url="))?.split("=").slice(1).join("=") ?? undefined;
const CHECKPOINT_PATH = process.argv.find((arg) => arg.startsWith("--checkpoint="))?.split("=")[1] ?? null;

/**
 * 오실행 가드 (P0, 2026-08-15 삼순) — main() 첫 줄에서만 호출한다.
 * top-level에 두면 스모크의 순수 함수 import만으로 process.exit이 터진다(실측).
 */
function enforceRunContract(): void {
  // (a) enum 값 오타는 기본값 폴백이 아니라 즉시 실패다 — 조용한 오실행 금지.
  if (!(["wikipedia", "namu"] as const).includes(SOURCE)) {
    console.error(`--source 값이 잘못됐다: ${SOURCE} (wikipedia|namu)`);
    process.exit(1);
  }
  if (!(["snapshot", "roster", "targets"] as const).includes(SCOPE)) {
    console.error(`--scope 값이 잘못됐다: ${SCOPE} (snapshot|roster|targets)`);
    process.exit(1);
  }
  if (!(["chrome", "cdp"] as const).includes(FETCHER)) {
    console.error(`--fetcher 값이 잘못됐다: ${FETCHER} (chrome|cdp)`);
    process.exit(1);
  }
  // (b) A17(cdp) 경로는 나무 전용이다 — wiki로 잘못 실행되면 즉시 실패.
  if (FETCHER === "cdp" && SOURCE !== "namu") {
    console.error(`--fetcher=cdp는 --source=namu 전용이다 (현재 source=${SOURCE}) — 즉시 실패`);
    process.exit(1);
  }
  // (c) snapshot 모드(488명 실전 해석)는 승인된 실행 형태를 전부 강제한다:
  // source=namu + fetcher=cdp + --dry-run + --checkpoint + --out. 하나라도 빠지면 시작하지 않는다.
  // (DB 쓰기는 3단계 별도 승인 — snapshot 모드에서는 구조적으로 불가능하다.)
  if (SCOPE === "snapshot") {
    const violations: string[] = [];
    if (SOURCE !== "namu") violations.push(`--source=namu 필수 (현재 ${SOURCE})`);
    if (FETCHER !== "cdp") violations.push(`--fetcher=cdp 필수 (현재 ${FETCHER})`);
    if (!DRY_RUN) violations.push("--dry-run 필수 (snapshot 모드 DB 쓰기 금지)");
    if (!CHECKPOINT_PATH) violations.push("--checkpoint=<path> 필수 (재시작 중복 요청 차단)");
    if (!OUT_PATH) violations.push("--out=<path> 필수 (판정표 산출)");
    if (violations.length > 0) {
      console.error(`snapshot 모드 실행 계약 위반 — 시작하지 않는다:\n  ${violations.join("\n  ")}`);
      process.exit(1);
    }
  }
}
/**
 * 간격 계약 (2026-08-15 하린아빠 "10초보다 더 짧게" + 삼순 "5초 하드코딩 금지, 8→6→4→2초 probe").
 *
 * 기본은 **probe 스케줄**이다: 8초에서 시작해 연속 성공이 쌓일 때마다 6→4→2초로 내린다.
 * 내려가다 blocked를 만나면 back-off가 아니라 **전역 즉시 중단**이다(안전선은 간격이 아니라 중단).
 * `--interval-ms=N`은 고정 간격 override다(재시도·검증용). 바닥 2초 미만은 승인 밖 — fail-close.
 */
export const INTERVAL_PROBE_SCHEDULE_MS = [8_000, 6_000, 4_000, 2_000] as const;
/** 스케줄 한 단계를 내리기 위해 필요한 연속 성공 수. */
export const INTERVAL_PROBE_STEP_SUCCESSES = 25;
export const INTERVAL_FLOOR_MS = 2_000;
export const INTERVAL_JITTER_MS = 2_000;
const FIXED_INTERVAL_MS = (() => {
  const raw = process.argv.find((arg) => arg.startsWith("--interval-ms="))?.split("=")[1];
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < INTERVAL_FLOOR_MS) {
    console.error(`--interval-ms 값이 잘못됐다: ${raw} (${INTERVAL_FLOOR_MS}ms 이상 정수만 허용)`);
    process.exit(1);
  }
  return parsed;
})();

/** 성공 횟수 → probe 스케줄 간격. 순수 함수 — 스모크가 직접 태운다. */
export function intervalForSuccessCount(successes: number): number {
  const step = Math.min(
    Math.floor(Math.max(0, successes) / INTERVAL_PROBE_STEP_SUCCESSES),
    INTERVAL_PROBE_SCHEDULE_MS.length - 1,
  );
  return INTERVAL_PROBE_SCHEDULE_MS[step];
}

/** 인당 요청 예산 — 기본 후보 3 + 동음이의 파생 후보 상한 6 = 9 (삼순 계약: 상한을 명시한다).
 * 예산 소진은 `budget_exhausted`로 기록하며 **missing과 구분한다** — "문서가 없다"와
 * "더 볼 예산이 없었다"를 썮으면 재시도 대상을 영영 잃는다. */
export const MAX_PROBES_PER_PLAYER = 9;
const ONLY_NAMES = process.argv
  .filter((arg) => arg.startsWith("--name="))
  .map((arg) => arg.split("=").slice(1).join("=").trim())
  .filter((name) => name.length > 0);
const LIMIT = (() => {
  const raw = process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1];
  if (raw === undefined) return null;
  const parsed = Number(raw);
  // 잘못된 `--limit`을 조용히 무시하면 "전체 돌았다"는 착각을 만든다 — fail-close.
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`--limit 값이 잘못됐다: ${raw} (양의 정수만 허용)`);
    process.exit(1);
  }
  return parsed;
})();

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  try {
    for (const line of readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...rest] = trimmed.split("=");
      if (!env[key]) env[key] = rest.join("=").trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // .env.local 없음 — CI에서는 환경변수로 주입된다.
  }
  return env;
}

type CandidateProbe =
  | { kind: "canonical"; url: string; canonicalUrl: string; pageTitle: string; redirected: boolean }
  | { kind: "rejected"; url: string; reason: string; disambiguationHtml?: string }
  | { kind: "missing"; url: string; reason: string }
  | { kind: "blocked"; url: string; reason: string };

function namuUrl(title: string): string {
  return `https://namu.wiki/w/${encodeURIComponent(title)}`;
}

/** 런 누적 성공 수 — probe 스케줄 입력. blocked는 전역 중단이라 감산할 일이 없다. */
let namuSuccessCount = 0;

/** 나무 fetch 경로 선택 — 판정(verifyCanonicalIdentity)은 경로와 무관하게 동일하다. */
async function fetchNamuDocument(url: string) {
  const minIntervalMs = intervalWithJitter(FIXED_INTERVAL_MS ?? intervalForSuccessCount(namuSuccessCount));
  const fetched = FETCHER === "cdp"
    ? await fetchNamuDocumentViaCdp(url, { cdpUrl: CDP_URL, minIntervalMs })
    : await fetchNamuDocumentViaBrowser(url, { minIntervalMs });
  if (fetched.ok) namuSuccessCount += 1;
  return fetched;
}

/** 지터 포함 간격 — 고정 주기는 패턴 탐지를 돕기 때문에 지터를 더한다(#1153 계약 재사용). */
export function intervalWithJitter(base: number, jitter = INTERVAL_JITTER_MS): number {
  return base + Math.floor(Math.random() * (jitter + 1));
}

/** 나무위키 후보 1건 판정 — 응답이 와도 identity 대조를 통과하지 못하면 canonical이 아니다. */
async function probeNamu(title: string, identity: PlayerDocumentIdentity): Promise<CandidateProbe> {
  const url = namuUrl(title);
  const fetched = await fetchNamuDocument(url);
  if (!fetched.ok) return { kind: fetched.status, url, reason: fetched.reason };
  const verdict = verifyCanonicalIdentity({
    requestedUrl: fetched.requestedUrl,
    finalUrl: fetched.url,
    html: fetched.html,
    playerIdentity: identity,
  });
  if (!verdict.ok) {
    // 동음이의 문서는 "실패"가 아니라 **후보 목록**이다 — 링크를 따라 진짜 문서를 찾는다.
    return verdict.reason === "disambiguation_document"
      ? { kind: "rejected", url, reason: verdict.reason, disambiguationHtml: fetched.html }
      : { kind: "rejected", url, reason: verdict.reason };
  }
  return {
    kind: "canonical",
    url,
    canonicalUrl: verdict.canonicalUrl,
    pageTitle: verdict.pageTitle,
    redirected: verdict.redirected,
  };
}

/** 위키피디아 후보 1건 판정 — API가 redirect/부재/분류를 명시하므로 마크업 파싱이 필요 없다. */
async function probeWikipedia(title: string, identity: PlayerDocumentIdentity): Promise<CandidateProbe> {
  const url = `https://ko.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  const fetched = await fetchWikipediaDocument(title, identity);
  if (!fetched.ok) {
    if (fetched.status === "blocked") return { kind: "blocked", url, reason: fetched.reason };
    if (fetched.status === "missing") return { kind: "missing", url, reason: fetched.reason };
    return { kind: "rejected", url, reason: fetched.reason };
  }
  return {
    kind: "canonical",
    url,
    canonicalUrl: fetched.canonicalUrl,
    pageTitle: fetched.title,
    redirected: fetched.title !== title,
  };
}

/**
 * 해석 대상 선정.
 *
 * `roster`가 기본이다 — S2b 슬라이스는 끝난 지 오래고, 16명만 도는 동안 나머지 로스터는
 * 괄호 표제어 재해석 없이 수집돼 김재환처럼 통째로 빠졌다.
 *
 * ⚠️ 순서를 **kboId 오름차순으로 고정**한다. `--limit` 분할 실행이 전제인데 순서가 흔들리면
 * 회차마다 같은 사람을 다시 두드리거나 영영 안 닿는 사람이 생긴다(무정렬 LIMIT과 같은 함정).
 */
export function selectResolveTargets(
  roster: readonly RosterPlayer[],
  options: {
    scope: ResolveScope;
    onlyNames: readonly string[];
    limit: number | null;
    /** scope=snapshot일 때만 쓴다. 해석 필요 버킷만 통과시킨다. */
    snapshotPlayers?: readonly { kboId: string; name: string; bucket: string }[];
    /** checkpoint에 이미 기록된 kboId — resume 시 건너뛴다. */
    doneKboIds?: ReadonlySet<string>;
  },
): ResolveTarget[] {
  let pool: ResolveTarget[];
  if (options.scope === "targets") {
    pool = S2B_TARGET_PLAYERS.map(({ kboId, name }) => ({ kboId, name }));
  } else if (options.scope === "snapshot") {
    const players = options.snapshotPlayers ?? [];
    if (players.length === 0) {
      throw new Error("scope=snapshot인데 스냅샷 입력이 비었다 — 조용한 전체 통과로 바꾸지 않는다(fail-close)");
    }
    pool = players
      .filter((player) => SNAPSHOT_RESOLVE_BUCKETS.has(player.bucket))
      .map(({ kboId, name }) => ({ kboId, name }))
      .sort((left, right) => left.kboId.localeCompare(right.kboId));
  } else {
    pool = [...roster]
      .map(({ kboId, name }) => ({ kboId, name }))
      .sort((left, right) => left.kboId.localeCompare(right.kboId));
  }
  const done = options.doneKboIds;
  const afterResume = done && done.size > 0 ? pool.filter((target) => !done.has(target.kboId)) : pool;
  const filtered = options.onlyNames.length > 0
    ? afterResume.filter((target) => options.onlyNames.includes(target.name))
    : afterResume;
  return options.limit === null ? filtered : filtered.slice(0, options.limit);
}

/** 위키피디아 후보 제목 — 동명이인은 `이름 (YYYY년)` 형식이 표준이다(실측). */
function wikipediaCandidateTitles(name: string, birthYear: string): string[] {
  return [name, `${name} (${birthYear}년)`, `${name} (야구 선수)`];
}

function wikipediaUrl(title: string): string {
  return `https://ko.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 위키피디아 API bounded rate — 공식 API지만 연속 호출 간격을 둔다(§12.2 b). */
const WIKIPEDIA_INTERVAL_MS = 1_000;

/**
 * 판정 루프 본체 — probe fetcher를 **주입**받는다(삼순 P0: 행동 게이트가 fake fetcher로
 * run1 중단→run2 resume→재요청 0→최종 합본을 실제 실행 경로로 태울 수 있게).
 * main과 스모크가 같은 함수를 태운다 — 게이트가 계약 문자열이 아니라 실행을 검증한다.
 */
export interface ResolveBatchDeps {
  source: SourceName;
  byKboId: Map<string, RosterPlayer>;
  nameCounts: Map<string, number>;
  nameBirthCounts: Map<string, number>;
  probedByKboId: Map<string, CheckpointProbeRow[]>;
  checkpointPath: string | null;
  probe: (title: string, identity: PlayerDocumentIdentity) => Promise<CandidateProbe>;
  maxProbesPerPlayer?: number;
  log?: (line: string) => void;
}

export async function resolvePlayerBatch(
  targets: readonly ResolveTarget[],
  deps: ResolveBatchDeps,
): Promise<{ rows: ResultRow[]; blocked: boolean }> {
  const { source, byKboId, nameCounts, nameBirthCounts, probedByKboId, checkpointPath } = deps;
  const maxProbes = deps.maxProbesPerPlayer ?? MAX_PROBES_PER_PLAYER;
  const log = deps.log ?? ((line: string) => console.log(line));
  const rows: ResultRow[] = [];
  let runBlocked = false;

  for (const target of targets) {
    const sourceKey = `${source === "namu" ? "namu" : "wikipedia"}:player:${target.kboId}`;
    const rosterRow = byKboId.get(target.kboId);
    const birthYear = rosterRow?.birthDate?.slice(0, 4) ?? "";
    const candidateTitles = source === "namu"
      ? [...expectedPlayerTitles(target.name)]
      : wikipediaCandidateTitles(target.name, birthYear);
    const candidateUrls = candidateTitles.map((title) => source === "namu" ? namuUrl(title) : wikipediaUrl(title));
    const base = { sourceKey, kboId: target.kboId, name: target.name, source: source, candidateUrls };

    // 동명이인(§12 + 2026-08-15 삼순 계약): 이름 중복 자체로는 즉시 ambiguous하지 않는다 —
    // identity 게이트가 생년 분류(`{생년}년 출생`)로 개인을 가른다. 단, 이름+생년이 모두 같은
    // 로스터 쌍은 문서 쪽 근거로 구별할 축이 없다 → fail-close 유지. 팀·포지션은 이적/문서
    // 지연 때문에 hard gate로 쓰지 않고 note 보조 근거로만 남긴다.
    if ((nameBirthCounts.get(`${target.name}|${birthYear}`) ?? 0) > 1) {
      rows.push({
        ...base, status: "ambiguous", canonicalUrl: null, pageTitle: null,
        note: `로스터 동명·동생년 ${nameBirthCounts.get(`${target.name}|${birthYear}`)}건 — 문서 근거로 구별 불능(fail-close)`,
      });
      continue;
    }
    if (!/^\d{4}$/.test(birthYear)) {
      // 생년이 없으면 동명이인을 가려낼 축이 없다 — 확인되지 않은 것을 확인된 것으로 만들지 않는다.
      rows.push({
        ...base, status: "ambiguous", canonicalUrl: null, pageTitle: null,
        note: "로스터 생년 결측 — identity 대조 불가(fail-close)",
      });
      continue;
    }
    const identity: PlayerDocumentIdentity = { name: target.name, birthYear };

    const probes: CandidateProbe[] = [];
    const queue = [...candidateTitles];
    const seen = new Set<string>();
    let blocked = false;
    // resume replay 사전 — 이 선수의 기록된 (kboId, candidateUrl) probe는 재요청하지 않는다.
    const replayByTitle = new Map<string, CheckpointProbeRow>();
    for (const row of probedByKboId.get(target.kboId) ?? []) replayByTitle.set(row.title, row);

    while (queue.length > 0 && !blocked && probes.length < maxProbes) {
      const title = queue.shift()!;
      if (seen.has(title)) continue;
      seen.add(title);

      const replay = replayByTitle.get(title);
      if (replay) {
        // 외부 요청 없이 기록된 결과를 그대로 이어받는다. 파생 후보도 기록에서 복원한다.
        const reconstructed: CandidateProbe = replay.kind === "canonical"
          ? { kind: "canonical", url: replay.url, canonicalUrl: replay.canonicalUrl ?? "", pageTitle: replay.pageTitle ?? "", redirected: replay.redirected ?? false }
          : replay.kind === "rejected"
            ? { kind: "rejected", url: replay.url, reason: replay.reason ?? "replayed" }
            : { kind: "missing", url: replay.url, reason: replay.reason ?? "replayed" };
        probes.push(reconstructed);
        for (const candidate of replay.candidates ?? []) {
          if (!seen.has(candidate)) queue.push(candidate);
        }
        if (reconstructed.kind === "canonical") break;
        continue;
      }

      const probe = await deps.probe(title, identity);
      probes.push(probe);
      if (probe.kind === "blocked") {
        // §12.2(b): 차단은 우회 대상이 아니다. 이 선수에 대한 추가 요청을 즉시 중단한다.
        // blocked는 checkpoint에 쓰지 않는다 — 원인 해소 후 resume에서 재시도해야 한다.
        blocked = true;
        break;
      }
      const derivedCandidates = probe.kind === "rejected" && probe.disambiguationHtml
        ? extractDisambiguationCandidates(probe.disambiguationHtml, target.name)
        : [];
      if (checkpointPath) {
        const probeRow: CheckpointProbeRow = {
          t: "probe", kboId: target.kboId, title, url: probe.url, kind: probe.kind,
          ...(probe.kind !== "canonical" ? { reason: probe.reason } : {}),
          ...(probe.kind === "canonical" ? { canonicalUrl: probe.canonicalUrl, pageTitle: probe.pageTitle, redirected: probe.redirected } : {}),
          ...(derivedCandidates.length > 0 ? { candidates: derivedCandidates } : {}),
          at: new Date().toISOString(),
        };
        appendFileSync(checkpointPath, `${JSON.stringify(probeRow)}\n`, "utf8");
      }
      for (const candidate of derivedCandidates) {
        if (!seen.has(candidate)) queue.push(candidate);
      }
      if (probe.kind === "canonical") break; // identity가 확정되면 더 두들기지 않는다(bounded).
    }
    // 예산 소진 판정 — 볼 후보가 남았는데 상한(9)에 닿은 것은 "문서 부재(missing)"가 아니다.
    const budgetExhausted = !blocked && queue.length > 0 && probes.length >= maxProbes
      && !probes.some((probe) => probe.kind === "canonical");

    const canonicalHits = probes.filter(
      (probe): probe is Extract<CandidateProbe, { kind: "canonical" }> => probe.kind === "canonical",
    );
    const distinct = new Set(canonicalHits.map((probe) => probe.canonicalUrl));
    const trace = probes
      .map((probe) => `${probe.kind}${probe.kind === "canonical" ? "" : `(${probe.reason})`}`)
      .join("/");

    let verdict: { status: Resolution; canonicalUrl: string | null; pageTitle: string | null; note: string };
    if (distinct.size === 1) {
      const hit = canonicalHits[0];
      verdict = {
        status: "resolved",
        canonicalUrl: hit.canonicalUrl,
        pageTitle: hit.pageTitle,
        note: `${new Date().toISOString().slice(0, 10)} identity 대조 통과(최종URL+canonical+분류: 야구선수/${birthYear}년 출생, 제목 "${hit.pageTitle}"${hit.redirected ? ", redirect 반영" : ""})`,
      };
    } else if (distinct.size > 1) {
      verdict = { status: "ambiguous", canonicalUrl: null, pageTitle: null, note: `문서 ${distinct.size}건 동시 확정 — 동일인 확정 불가 (${trace})` };
    } else if (blocked) {
      verdict = { status: "blocked", canonicalUrl: null, pageTitle: null, note: `봇차단으로 확인 불가 (${trace}) — 우회 금지(§12.2 b)` };
    } else if (budgetExhausted) {
      verdict = {
        status: "budget_exhausted", canonicalUrl: null, pageTitle: null,
        note: `요청 예산 소진(인당 ${maxProbes}) — 미확인 후보 ${queue.length}건 잔존, missing 아님 (${trace})`,
      };
    } else {
      verdict = { status: "missing", canonicalUrl: null, pageTitle: null, note: `identity 확정 후보 없음 (${trace})` };
    }
    const isRosterDupName = (nameCounts.get(target.name) ?? 0) > 1;
    if (isRosterDupName && verdict.status === "resolved") {
      // 보조 근거 기록 — 판정은 생년 분류가 했고, 팀은 검수자가 대조할 참고칸이다(hard gate 아님).
      verdict.note += ` [동명이인 주의: 로스터 동명 ${nameCounts.get(target.name)}명, 이 판정은 kboId ${target.kboId}(${rosterRow?.team ?? "?"}) 생년 ${birthYear} 기준]`;
    }
    const resultRow: ResultRow = { ...base, ...verdict };
    rows.push(resultRow);
    if (checkpointPath && verdict.status !== "blocked") {
      // blocked는 판정 확정이 아니라 중단 사유다 — verdict로 봉인하면 resume이 이 선수를 영영 건너뛴다.
      // verdict는 full ResultRow를 품는다(삼순 P0) — resume 후 최종 판정표에 그대로 복원된다.
      appendFileSync(
        checkpointPath,
        `${JSON.stringify({ t: "verdict", row: resultRow, at: new Date().toISOString() })}\n`,
        "utf8",
      );
    }
    log(`${target.name.padEnd(6)} ${verdict.status.padEnd(10)} ${verdict.note}`);
    if (verdict.status === "blocked") {
      // 전역 즉시 중단(2026-08-15 삼순 계약) — 보고·저장·종료는 호출자(main)가 한다.
      runBlocked = true;
      break;
    }
  }

  return { rows, blocked: runBlocked };
}


async function main(): Promise<void> {
  // ⚠️ 검증 순서 계약(삼순 P1): 모든 **로컬 계약**(실행형태·roster/스냅샷 해시·checkpoint·out 경로)을
  // 먼저 끝내고, 그 다음에만 외부 요청(robots 포함)으로 넘어간다. 로컬 결함으로 죽을 run이
  // 외부 서버를 먼저 두드리는 것을 막는다.
  enforceRunContract();
  const env = loadEnv();

  const roster = JSON.parse(
    readFileSync(path.join(process.cwd(), "src/lib/constants/players-roster.json"), "utf8"),
  ) as RosterPlayer[];
  const nameCounts = new Map<string, number>();
  // 동명이인 판정 축 — 이름이 같아도 생년이 다르면 identity 게이트(생년 분류 대조)가 가른다.
  // 이름+생년이 모두 같은 쌍만 문서 쪽 근거로는 구별 불능 → 그 경우만 즉시 ambiguous(fail-close).
  const nameBirthCounts = new Map<string, number>();
  const byKboId = new Map<string, RosterPlayer>();
  for (const player of roster) {
    nameCounts.set(player.name, (nameCounts.get(player.name) ?? 0) + 1);
    const birthKey = `${player.name}|${player.birthDate?.slice(0, 4) ?? ""}`;
    nameBirthCounts.set(birthKey, (nameBirthCounts.get(birthKey) ?? 0) + 1);
    byKboId.set(player.kboId, player);
  }

  const snapshotDoc = SCOPE === "snapshot"
    ? JSON.parse(readFileSync(path.join(process.cwd(), GAP_SNAPSHOT_PATH), "utf8")) as {
        rosterSha256?: string;
        players: { kboId: string; name: string; bucket: string }[];
      }
    : undefined;
  const snapshotPlayers = snapshotDoc?.players;

  // 로컬 계약: 스냅샷이 가리키는 로스터와 지금 repo 로스터가 같아야 488 선정이 유효하다.
  // (스모크에만 두면 실제 run이 stale 스냅샷으로 도는 것을 못 막는다 — 삼순 P1 런타임 대조.)
  if (snapshotDoc) {
    const rosterSha = createHash("sha256")
      .update(readFileSync(path.join(process.cwd(), "src/lib/constants/players-roster.json")))
      .digest("hex");
    if (snapshotDoc.rosterSha256 !== rosterSha) {
      console.error(`스냅샷 rosterSha256(${snapshotDoc.rosterSha256?.slice(0, 12)}…) ≠ 현재 로스터(${rosterSha.slice(0, 12)}…) — 스냅샷 재생성 필요(fail-close)`);
      process.exit(1);
    }
  }
  // 로컬 계약: checkpoint와 out은 서로 다른 파일이어야 하고, 디렉터리가 존재해야 한다.
  if (CHECKPOINT_PATH && OUT_PATH && path.resolve(CHECKPOINT_PATH) === path.resolve(OUT_PATH)) {
    console.error("--checkpoint와 --out이 같은 파일이다 — 서로 덮어쓴다(fail-close)");
    process.exit(1);
  }
  for (const [label, target] of [["--checkpoint", CHECKPOINT_PATH], ["--out", OUT_PATH]] as const) {
    if (!target) continue;
    if (!existsSync(path.dirname(path.resolve(target)))) {
      console.error(`${label} 경로의 디렉터리가 없다: ${target} — 쓰기 불가(fail-close)`);
      process.exit(1);
    }
  }

  // checkpoint resume (P0 계약) — fingerprint 일치 + 전 행 스키마 검증을 통과한 파일만 이어받는다.
  // 손상·불일치는 "신규 생성"이 아니라 즉시 실패다. 파일 부재(ENOENT)만 신규로 만든다.
  const snapshotSha256 = SCOPE === "snapshot"
    ? createHash("sha256").update(readFileSync(path.join(process.cwd(), GAP_SNAPSHOT_PATH))).digest("hex")
    : "-";
  const fingerprint = buildCheckpointFingerprint({ source: SOURCE, scope: SCOPE, snapshotSha256 });
  let doneRows: ResultRow[] = [];
  let probedByKboId = new Map<string, CheckpointProbeRow[]>();
  if (CHECKPOINT_PATH) {
    let raw: string | null = null;
    try {
      raw = readFileSync(CHECKPOINT_PATH, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw === null) {
      writeFileSync(CHECKPOINT_PATH, `${JSON.stringify(fingerprint)}\n`, "utf8");
      console.log(`checkpoint 신규 생성(fingerprint 기록): ${CHECKPOINT_PATH}`);
    } else {
      // 파싱 실패는 이 자리에서 던져져 run을 즉시 실패시킨다(catch 없음 — fail-close).
      const parsed = parseCheckpointText(raw, fingerprint);
      doneRows = parsed.doneRows;
      probedByKboId = parsed.probedByKboId;
      console.log(
        `checkpoint 이어받기: ${CHECKPOINT_PATH} — fingerprint 일치, 판정 완료 ${doneRows.length}명 복원·skip, `
        + `probe 기록 보유 ${probedByKboId.size}명 replay`,
      );
    }
  }
  const doneKboIds = new Set(doneRows.map((row) => row.kboId));
  const snapshotResolveCount = snapshotPlayers
    ?.filter((player) => SNAPSHOT_RESOLVE_BUCKETS.has(player.bucket)).length ?? 0;

  const targets = selectResolveTargets(roster, {
    scope: SCOPE,
    onlyNames: ONLY_NAMES,
    limit: LIMIT,
    snapshotPlayers,
    doneKboIds,
  });
  console.log(
    `범위: scope=${SCOPE} → 대상 ${targets.length}명`
    + ` (로스터 ${roster.length}행${SCOPE === "snapshot" ? `, 스냅샷 해석버킷 입력` : ""}`
    + `${doneKboIds.size > 0 ? `, resume skip ${doneKboIds.size}명` : ""}`
    + `${ONLY_NAMES.length > 0 ? `, --name 필터 ${ONLY_NAMES.length}건` : ""}`
    + `${LIMIT === null ? "" : `, --limit ${LIMIT}`})`,
  );
  if (SOURCE === "namu") {
    console.log(
      `fetcher=${FETCHER}, 간격 ${FIXED_INTERVAL_MS !== null
        ? `고정 ${FIXED_INTERVAL_MS}ms`
        : `probe ${INTERVAL_PROBE_SCHEDULE_MS.join("→")}ms(성공 ${INTERVAL_PROBE_STEP_SUCCESSES}회당 하강)`}`
      + `+지터≤${INTERVAL_JITTER_MS}ms, 인당 예산 ${MAX_PROBES_PER_PLAYER}, 첫 blocked 전역 즉시 중단`,
    );
  }
  if (targets.length === 0) {
    console.error("해석 대상 0명 — 범위 옵션을 확인하라(조용한 성공으로 끝내지 않는다).");
    process.exit(1);
  }

  // 로컬 계약이 전부 끝난 뒤에만 첫 외부 요청(robots)으로 넘어간다(삼순 P1 순서 계약).
  if (SOURCE === "namu") {
    const robots = await assertRobotsAllowed();
    if (!robots.ok) {
      console.error(`robots.txt 확인 실패(${robots.reason}) — 확인기록 없는 수집은 금지다(§12.2 a).`);
      process.exit(1);
    }
    console.log(`namu robots.txt OK: "${robots.allowRule}" (checked ${robots.checkedAt})`);
  } else {
    console.log("wikipedia: 공식 API(/w/api.php) 경로. 정직한 UA plain fetch, 우회 없음.");
  }

  const outcome = await resolvePlayerBatch(targets, {
    source: SOURCE,
    byKboId,
    nameCounts,
    nameBirthCounts,
    probedByKboId,
    checkpointPath: CHECKPOINT_PATH,
    probe: async (title, identity) => {
      const probe = SOURCE === "namu" ? await probeNamu(title, identity) : await probeWikipedia(title, identity);
      if (SOURCE !== "namu") await sleep(WIKIPEDIA_INTERVAL_MS);
      return probe;
    },
  });
  // 최종 판정표 = resume 이전 완료분 + 이번 run 신규분(삼순 P0: 중단 전 완료분 유실 금지).
  const results = mergeResultRows(doneRows, outcome.rows);
  if (outcome.blocked) {
    console.error(
      `차단 감지 — 전역 즉시 중단. 누적 판정 ${results.length}명(이전 ${doneRows.length}+이번 ${outcome.rows.length}), `
      + `checkpoint=${CHECKPOINT_PATH ?? "(없음)"}`,
    );
    if (OUT_PATH) {
      writeFileSync(OUT_PATH, JSON.stringify(results, null, 2), "utf8");
      console.log(`부분 판정 결과 저장(누적): ${OUT_PATH}`);
    }
    process.exit(2);
  }
  if (SCOPE === "snapshot" && ONLY_NAMES.length === 0 && LIMIT === null && snapshotResolveCount > 0
    && results.length !== snapshotResolveCount) {
    // 전량 run 완주의 최종 판정표는 정확히 해석 버킷 전원이어야 한다(488 unique 강제).
    console.error(`최종 판정표 ${results.length}명 ≠ 해석 대상 ${snapshotResolveCount}명 — 유실/중복(fail-close)`);
    process.exit(1);
  }
  const summary = results.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log("\n판정 요약:", summary);

  if (OUT_PATH) {
    writeFileSync(OUT_PATH, JSON.stringify(results, null, 2), "utf8");
    console.log(`판정 결과 저장: ${OUT_PATH}`);
  }

  if (DRY_RUN) {
    console.log("--dry-run: DB 쓰기 생략");
    return;
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정 — DB 쓰기 불가");
    process.exit(1);
  }
  // ⚠️ PATCH + `Prefer: return=minimal` 만 쓰면 **행이 없어도 성공(0행 갱신)** 이다.
  // wikipedia:* source 는 migration/seed 에 INSERT 가 0건이라, 예전 코드는 한 행도
  // 만들지 않고 "갱신 완료" 를 출력했다(삼순 R3/R4 P0-2 — 16행 미생성).
  // 그래서 upsert 로 바꾸고, `return=representation` 으로 **실제 반영된 행**을 세어
  // 기대 건수와 대조한다. 하나라도 어긋나면 실패로 종결한다.
  const sourceKind = SOURCE === "namu" ? "namu_document" : "wikipedia_document";
  let affected = 0;
  for (const row of results) {
    const pageTitle = row.pageTitle ?? row.name;
    const payload = buildResolutionSourceRow({
      sourceKey: row.sourceKey,
      sourceKind,
      entityId: String(row.kboId),
      pageTitle,
      candidateUrls: row.candidateUrls,
      canonicalUrl: row.canonicalUrl,
      // DB CHECK는 resolved/missing/ambiguous/blocked 4값만 받는다. budget_exhausted는 판정 JSON·
      // checkpoint에는 그대로 남기되, DB에는 ambiguous로 쓰고 note 접두로 구분한다(재시도 대상 보존).
      resolutionStatus: row.status === "budget_exhausted" ? "ambiguous" : row.status,
      resolutionNote: row.status === "budget_exhausted" ? `budget_exhausted: ${row.note}` : row.note,
      updatedAt: new Date().toISOString(),
    });
    const response = await fetch(`${url}/rest/v1/genius_rag_sources?on_conflict=source_key`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // merge-duplicates = 있으면 UPDATE, 없으면 INSERT. representation = 반영된 행 반환.
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify([payload]),
    });
    if (!response.ok) {
      console.error(`${row.sourceKey} upsert 실패: HTTP ${response.status} ${await response.text()}`);
      process.exitCode = 1;
      continue;
    }
    const returned = (await response.json()) as unknown[];
    if (!Array.isArray(returned) || returned.length !== 1) {
      console.error(`${row.sourceKey}: 반영 행 ${Array.isArray(returned) ? returned.length : "?"}건 (1건 기대)`);
      process.exitCode = 1;
      continue;
    }
    affected += 1;
  }
  if (affected !== results.length) {
    console.error(`source upsert 불일치: 반영 ${affected}건 / 기대 ${results.length}건 — 부분 반영 상태다`);
    process.exit(1);
  }
  console.log(`source upsert + resolution_status 갱신 완료 (반영 ${affected}/${results.length}건)`);
}

// 직접 실행일 때만 main을 태운다 — QA 스모크가 순수 함수(selectResolveTargets 등)를 외부 요청 없이
// import할 수 있게 한다. 가드가 없으면 스모크 import 자체가 외부 조회를 유발한다(금지 축).
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === new URL(`file://${path.resolve(entry)}`).href
    || import.meta.url.endsWith("/resolve-rag-urls.ts") && path.resolve(entry).endsWith("/resolve-rag-urls.ts");
})();

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
