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

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
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
interface CheckpointProbeRow {
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
// A17(cdp) 경로는 나무 전용이다 — wiki로 잘못 실행되면 즉시 실패(삼순 계약: 조용한 오실행 금지).
if (FETCHER === "cdp" && SOURCE !== "namu") {
  console.error(`--fetcher=cdp는 --source=namu 전용이다 (현재 source=${SOURCE}) — 즉시 실패`);
  process.exit(1);
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

async function main(): Promise<void> {
  const env = loadEnv();
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

  const snapshotPlayers = SCOPE === "snapshot"
    ? (JSON.parse(readFileSync(path.join(process.cwd(), GAP_SNAPSHOT_PATH), "utf8")) as {
        players: { kboId: string; name: string; bucket: string }[];
      }).players
    : undefined;

  // checkpoint resume — verdict가 있는 kboId는 통째로 skip, probe만 있는 kboId는
  // 기록된 (kboId, candidateUrl) 요청을 replay해 같은 URL 재요청을 차단한다(삼순 계약).
  const doneKboIds = new Set<string>();
  const probedByKboId = new Map<string, CheckpointProbeRow[]>();
  if (CHECKPOINT_PATH) {
    try {
      for (const line of readFileSync(CHECKPOINT_PATH, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const row = JSON.parse(trimmed) as { t?: string; kboId?: string; status?: string };
        if (!row.kboId) continue;
        if (row.t === "probe") {
          const probeRow = row as unknown as CheckpointProbeRow;
          const list = probedByKboId.get(probeRow.kboId) ?? [];
          list.push(probeRow);
          probedByKboId.set(probeRow.kboId, list);
        } else if (row.t === "verdict" || row.status) {
          // 구형(무타입) 행은 verdict로 취급 — 이미 끝난 선수를 다시 두드리지 않는다.
          doneKboIds.add(row.kboId);
        }
      }
      console.log(
        `checkpoint 이어받기: ${CHECKPOINT_PATH} — 판정 완료 ${doneKboIds.size}명 skip, `
        + `probe 기록 보유 ${probedByKboId.size}명 replay`,
      );
    } catch {
      console.log(`checkpoint 신규 생성: ${CHECKPOINT_PATH}`);
    }
  }

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

  interface ResultRow {
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
  const results: ResultRow[] = [];

  for (const target of targets) {
    const sourceKey = `${SOURCE === "namu" ? "namu" : "wikipedia"}:player:${target.kboId}`;
    const rosterRow = byKboId.get(target.kboId);
    const birthYear = rosterRow?.birthDate?.slice(0, 4) ?? "";
    const candidateTitles = SOURCE === "namu"
      ? [...expectedPlayerTitles(target.name)]
      : wikipediaCandidateTitles(target.name, birthYear);
    const candidateUrls = candidateTitles.map((title) => SOURCE === "namu" ? namuUrl(title) : wikipediaUrl(title));
    const base = { sourceKey, kboId: target.kboId, name: target.name, source: SOURCE, candidateUrls };

    // 동명이인(§12 + 2026-08-15 삼순 계약): 이름 중복 자체로는 즉시 ambiguous하지 않는다 —
    // identity 게이트가 생년 분류(`{생년}년 출생`)로 개인을 가른다. 단, 이름+생년이 모두 같은
    // 로스터 쌍은 문서 쪽 근거로 구별할 축이 없다 → fail-close 유지. 팀·포지션은 이적/문서
    // 지연 때문에 hard gate로 쓰지 않고 note 보조 근거로만 남긴다.
    if ((nameBirthCounts.get(`${target.name}|${birthYear}`) ?? 0) > 1) {
      results.push({
        ...base, status: "ambiguous", canonicalUrl: null, pageTitle: null,
        note: `로스터 동명·동생년 ${nameBirthCounts.get(`${target.name}|${birthYear}`)}건 — 문서 근거로 구별 불능(fail-close)`,
      });
      continue;
    }
    if (!/^\d{4}$/.test(birthYear)) {
      // 생년이 없으면 동명이인을 가려낼 축이 없다 — 확인되지 않은 것을 확인된 것으로 만들지 않는다.
      results.push({
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

    while (queue.length > 0 && !blocked && probes.length < MAX_PROBES_PER_PLAYER) {
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

      const probe = SOURCE === "namu" ? await probeNamu(title, identity) : await probeWikipedia(title, identity);
      if (SOURCE !== "namu") await sleep(WIKIPEDIA_INTERVAL_MS);
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
      if (CHECKPOINT_PATH) {
        const probeRow: CheckpointProbeRow = {
          t: "probe", kboId: target.kboId, title, url: probe.url, kind: probe.kind,
          ...(probe.kind !== "canonical" ? { reason: probe.reason } : {}),
          ...(probe.kind === "canonical" ? { canonicalUrl: probe.canonicalUrl, pageTitle: probe.pageTitle, redirected: probe.redirected } : {}),
          ...(derivedCandidates.length > 0 ? { candidates: derivedCandidates } : {}),
          at: new Date().toISOString(),
        };
        appendFileSync(CHECKPOINT_PATH, `${JSON.stringify(probeRow)}\n`, "utf8");
      }
      for (const candidate of derivedCandidates) {
        if (!seen.has(candidate)) queue.push(candidate);
      }
      if (probe.kind === "canonical") break; // identity가 확정되면 더 두들기지 않는다(bounded).
    }
    // 예산 소진 판정 — 볼 후보가 남았는데 상한(9)에 닿은 것은 "문서 부재(missing)"가 아니다.
    const budgetExhausted = !blocked && queue.length > 0 && probes.length >= MAX_PROBES_PER_PLAYER
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
        note: `요청 예산 소진(인당 ${MAX_PROBES_PER_PLAYER}) — 미확인 후보 ${queue.length}건 잔존, missing 아님 (${trace})`,
      };
    } else {
      verdict = { status: "missing", canonicalUrl: null, pageTitle: null, note: `identity 확정 후보 없음 (${trace})` };
    }
    const isRosterDupName = (nameCounts.get(target.name) ?? 0) > 1;
    if (isRosterDupName && verdict.status === "resolved") {
      // 보조 근거 기록 — 판정은 생년 분류가 했고, 팀은 검수자가 대조할 참고칸이다(hard gate 아님).
      verdict.note += ` [동명이인 주의: 로스터 동명 ${nameCounts.get(target.name)}명, 이 판정은 kboId ${target.kboId}(${rosterRow?.team ?? "?"}) 생년 ${birthYear} 기준]`;
    }
    results.push({ ...base, ...verdict });
    if (CHECKPOINT_PATH && verdict.status !== "blocked") {
      // blocked는 판정 확정이 아니라 중단 사유다 — verdict로 봉인하면 resume이 이 선수를 영영 건너뛴다.
      appendFileSync(
        CHECKPOINT_PATH,
        `${JSON.stringify({ t: "verdict", kboId: target.kboId, name: target.name, status: verdict.status, canonicalUrl: verdict.canonicalUrl, note: verdict.note, at: new Date().toISOString() })}\n`,
        "utf8",
      );
    }
    console.log(`${target.name.padEnd(6)} ${verdict.status.padEnd(10)} ${verdict.note}`);
    if (verdict.status === "blocked") {
      // 전역 즉시 중단(2026-08-15 삼순 계약) — 첫 차단은 "다음 선수로 넘어갈 일"이 아니라 run 종료 사유다.
      // checkpoint에 진행분이 남아 있으므로 재개는 원인 해소 후 resume으로 한다.
      console.error(`차단 감지 — 전역 즉시 중단. 진행 ${results.length}명/${targets.length}명, checkpoint=${CHECKPOINT_PATH ?? "(없음)"}`);
      if (OUT_PATH) {
        writeFileSync(OUT_PATH, JSON.stringify(results, null, 2), "utf8");
        console.log(`부분 판정 결과 저장: ${OUT_PATH}`);
      }
      process.exit(2);
    }
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
