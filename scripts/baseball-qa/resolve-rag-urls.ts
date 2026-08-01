/**
 * S2b: 대상 선수(16명)의 나무위키 canonical URL을 해석해 resolution_status를 확정한다.
 *
 * 실행: `npm run rag:resolve-urls`  (수동/GitHub Actions. 맥미니 LaunchAgent 금지 — P0)
 *   옵션: `--dry-run` DB 쓰기 없이 판정만 출력
 *
 * 판정 계약 (spec rev0.7 §12):
 *   resolved   — 후보 URL 중 정확히 하나가 HTTP 200이고 동명이인 위험이 없음
 *   ambiguous  — 로스터에 동명이인이 있거나 후보 여럿이 동시에 살아있음 (이름 단독 연결 금지)
 *   missing    — 후보 전부 404/410
 *   blocked    — 봇차단(403/429/503) 등으로 확인 자체가 불가능
 *
 * ⚠️ 2026-08-01 실측: namu.wiki는 Cloudflare가 프로그래매틱 요청을 전면 차단해 모든 후보가
 * HTTP 403을 반환한다. 계약상 우회는 금지(§12.2 b)이므로 정상 결과는 `blocked`다.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { assertRobotsAllowed, RAG_FETCH_INTERVAL_MS, RAG_USER_AGENT, RAG_FETCH_TIMEOUT_MS } from "../../src/lib/baseball-qa/rag/fetch-namu";
import { S2B_TARGET_PLAYERS } from "../../src/lib/baseball-qa/rag/targets";

type Resolution = "resolved" | "missing" | "ambiguous" | "blocked";

interface RosterPlayer { name: string; kboId: string; team: string }

const DRY_RUN = process.argv.includes("--dry-run");

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

async function headStatus(url: string): Promise<number> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": RAG_USER_AGENT, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(RAG_FETCH_TIMEOUT_MS),
    });
    return response.status;
  } catch {
    return 0;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const env = loadEnv();
  const robots = await assertRobotsAllowed();
  if (!robots.ok) {
    console.error(`robots.txt 확인 실패(${robots.reason}) — 확인기록 없는 수집은 금지다(§12.2 a).`);
    process.exit(1);
  }
  console.log(`robots.txt OK: "${robots.allowRule}" (checked ${robots.checkedAt})`);

  const roster = JSON.parse(
    readFileSync(path.join(process.cwd(), "src/lib/constants/players-roster.json"), "utf8"),
  ) as RosterPlayer[];
  const nameCounts = new Map<string, number>();
  for (const player of roster) nameCounts.set(player.name, (nameCounts.get(player.name) ?? 0) + 1);

  const results: { sourceKey: string; name: string; status: Resolution; canonicalUrl: string | null; note: string }[] = [];

  for (const target of S2B_TARGET_PLAYERS) {
    const sourceKey = `namu:player:${target.kboId}`;
    if ((nameCounts.get(target.name) ?? 0) > 1) {
      results.push({
        sourceKey, name: target.name, status: "ambiguous", canonicalUrl: null,
        note: `로스터 동명이인 ${nameCounts.get(target.name)}건 — 이름 단독 연결 금지(§12)`,
      });
      continue;
    }
    const candidates = [
      `https://namu.wiki/w/${encodeURIComponent(`${target.name}(야구선수)`)}`,
      `https://namu.wiki/w/${encodeURIComponent(target.name)}`,
      `https://namu.wiki/w/${encodeURIComponent(`${target.name}(야구)`)}`,
    ];
    const statuses: { url: string; status: number }[] = [];
    for (const url of candidates) {
      statuses.push({ url, status: await headStatus(url) });
      await sleep(RAG_FETCH_INTERVAL_MS);
    }
    const alive = statuses.filter(({ status }) => status === 200);
    const bot = statuses.filter(({ status }) => [403, 429, 503, 0].includes(status));
    let verdict: { status: Resolution; canonicalUrl: string | null; note: string };
    if (alive.length === 1) {
      verdict = { status: "resolved", canonicalUrl: alive[0].url, note: `${new Date().toISOString().slice(0, 10)} canonical URL HTTP 200 확인` };
    } else if (alive.length > 1) {
      verdict = { status: "ambiguous", canonicalUrl: null, note: `후보 ${alive.length}건 동시 200 — 동일인 확정 불가` };
    } else if (bot.length > 0) {
      verdict = { status: "blocked", canonicalUrl: null, note: `봇차단으로 확인 불가 (${statuses.map((entry) => entry.status).join("/")}) — 우회 금지(§12.2 b)` };
    } else {
      verdict = { status: "missing", canonicalUrl: null, note: `후보 전부 부재 (${statuses.map((entry) => entry.status).join("/")})` };
    }
    results.push({ sourceKey, name: target.name, ...verdict });
    console.log(`${target.name.padEnd(6)} ${verdict.status.padEnd(10)} ${verdict.note}`);
  }

  const summary = results.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log("\n판정 요약:", summary);

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
  for (const row of results) {
    const response = await fetch(`${url}/rest/v1/genius_rag_sources?source_key=eq.${encodeURIComponent(row.sourceKey)}`, {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        resolution_status: row.status,
        canonical_url: row.canonicalUrl,
        resolution_note: row.note,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!response.ok) {
      console.error(`${row.sourceKey} 갱신 실패: HTTP ${response.status} ${await response.text()}`);
      process.exitCode = 1;
    }
  }
  console.log(`resolution_status 갱신 완료 (${results.length}건)`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
