/**
 * S2b: 대상 선수(16명)의 tier2 canonical URL을 해석해 resolution_status를 확정한다.
 *
 * 실행: `npm run rag:resolve-urls`  (수동/GitHub Actions. 맥미니 LaunchAgent 금지 — P0)
 *   옵션: `--dry-run` DB 쓰기 없이 판정만 출력
 *         `--source=wikipedia|namu` 해석할 소스 (기본 wikipedia)
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

import { readFileSync, writeFileSync } from "node:fs";
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

type Resolution = "resolved" | "missing" | "ambiguous" | "blocked";
type SourceName = "wikipedia" | "namu";

interface RosterPlayer { name: string; kboId: string; team: string; birthDate?: string }

const DRY_RUN = process.argv.includes("--dry-run");
const SOURCE = (process.argv.find((arg) => arg.startsWith("--source="))?.split("=")[1] ?? "wikipedia") as SourceName;
const OUT_PATH = process.argv.find((arg) => arg.startsWith("--out="))?.split("=")[1] ?? null;

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

/** 나무위키 후보 1건 판정 — 응답이 와도 identity 대조를 통과하지 못하면 canonical이 아니다. */
async function probeNamu(title: string, identity: PlayerDocumentIdentity): Promise<CandidateProbe> {
  const url = namuUrl(title);
  const fetched = await fetchNamuDocumentViaBrowser(url);
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
  const byKboId = new Map<string, RosterPlayer>();
  for (const player of roster) {
    nameCounts.set(player.name, (nameCounts.get(player.name) ?? 0) + 1);
    byKboId.set(player.kboId, player);
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

  for (const target of S2B_TARGET_PLAYERS) {
    const sourceKey = `${SOURCE === "namu" ? "namu" : "wikipedia"}:player:${target.kboId}`;
    const rosterRow = byKboId.get(target.kboId);
    const birthYear = rosterRow?.birthDate?.slice(0, 4) ?? "";
    const candidateTitles = SOURCE === "namu"
      ? [...expectedPlayerTitles(target.name)]
      : wikipediaCandidateTitles(target.name, birthYear);
    const candidateUrls = candidateTitles.map((title) => SOURCE === "namu" ? namuUrl(title) : wikipediaUrl(title));
    const base = { sourceKey, kboId: target.kboId, name: target.name, source: SOURCE, candidateUrls };

    if ((nameCounts.get(target.name) ?? 0) > 1) {
      results.push({
        ...base, status: "ambiguous", canonicalUrl: null, pageTitle: null,
        note: `로스터 동명이인 ${nameCounts.get(target.name)}건 — 이름 단독 연결 금지(§12)`,
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

    while (queue.length > 0 && !blocked) {
      const title = queue.shift()!;
      if (seen.has(title)) continue;
      seen.add(title);
      const probe = SOURCE === "namu" ? await probeNamu(title, identity) : await probeWikipedia(title, identity);
      if (SOURCE !== "namu") await sleep(WIKIPEDIA_INTERVAL_MS);
      probes.push(probe);
      if (probe.kind === "blocked") {
        // §12.2(b): 차단은 우회 대상이 아니다. 이 선수에 대한 추가 요청을 즉시 중단한다.
        blocked = true;
        break;
      }
      if (probe.kind === "rejected" && probe.disambiguationHtml) {
        for (const candidate of extractDisambiguationCandidates(probe.disambiguationHtml, target.name)) {
          if (!seen.has(candidate)) queue.push(candidate);
        }
      }
      if (probe.kind === "canonical") break; // identity가 확정되면 더 두들기지 않는다(bounded).
    }

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
    } else {
      verdict = { status: "missing", canonicalUrl: null, pageTitle: null, note: `identity 확정 후보 없음 (${trace})` };
    }
    results.push({ ...base, ...verdict });
    console.log(`${target.name.padEnd(6)} ${verdict.status.padEnd(10)} ${verdict.note}`);
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
      resolutionStatus: row.status,
      resolutionNote: row.note,
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

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
