/**
 * proxy-matcher-slim-gate (npm run qa:proxy-matcher-slim / :selftest)
 *
 * 계약(2026-08-20, Vercel 비용 3순위 — proxy matcher 슬림, 삼순 #1263 1차 반영):
 *  1. /api/* 는 middleware(proxy)에 매칭되지 않는다 — 0.73M+회/일(8/12 역사적 baseline)
 *     no-op 호출 제거. 예외는 **exact `/api/standings` 하나뿐**: `/api`·trailing slash·
 *     하위경로는 전부 제외다(classifyWatchPlatform 이 pathname 엄격 비교라 경계가 계약).
 *  2. 문서/페이지 경로는 계속 매칭 — canonical 308 redirect + top-level 세션 갱신(#890) 보존.
 *  3. 함수 본문의 `/api/` 패스스루 분기는 방어 계약(마처가 회귀해도 행동 동일) — 소스 검사가
 *     아니라 **실제 `proxy()` 를 실행**해 API 요청이 redirect·쿠키 변경 없이 통과함을 증명한다.
 *
 * 판정 도구(삼순 1차 ①): custom RegExp 재구현 금지 — Next 공식
 * `unstable_doesMiddlewareMatch`(next/experimental/testing/server, 16.1.6 실제 export 명.
 * 삼순이 언급한 doesProxyMatch 의 이 버전 명칭)를 실제 `config` 모듈로 실행한다.
 *
 * --selftest: 파일 변이(백업·복원) 후 게이트를 자식 프로세스로 재실행해 RED 를 증명한다.
 */
// ⚠️ 첫 import 여야 한다 — next/server(← src/proxy 포함) 로드 전에 전역 AsyncLocalStorage 주입.
//   next 내부는 로드 시점에 한 번만 캡처하므로 늦으면 Invariant 로 죽는다(실측).
import "./support/als-global-shim";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest, type NextFetchEvent } from "next/server";
import { config as proxyConfig, proxy } from "../../src/proxy";

type DoesMatch = (args: { config: { matcher?: string[] }; url: string }) => boolean;
async function loadDoesMiddlewareMatch(): Promise<DoesMatch> {
  const mod = await import("next/experimental/testing/server");
  return mod.unstable_doesMiddlewareMatch as DoesMatch;
}

const PROXY_FILE = "src/proxy.ts";

type Failure = string;

/** [경로, 매칭 기대값, 이유] */
const MATRIX: Array<[string, boolean, string]> = [
  // 문서/페이지 — canonical redirect + 세션 갱신 보존
  ["/", true, "홈 문서"],
  ["/players/12345", true, "선수 페이지"],
  ["/posts/abc", true, "게시글 페이지"],
  ["/login", true, "로그인 페이지"],
  // 워치 계측 예외 — exact 만 매칭
  ["/api/standings", true, "워치 UA 계측(proxy 전량 캡처) — 유일 예외"],
  // exact 경계(삼순 1차 ②) — 예외가 새면 안 된다
  ["/api", false, "api 루트 자체"],
  ["/api/standings/", false, "trailing slash"],
  ["/api/standings/sub", false, "하위경로"],
  ["/api/standingsx", false, "접두사 유사 경로"],
  // 고빈도 폴링/읽기 API — 매칭 제외(비용 축)
  ["/api/game-events", false, "폴링"],
  ["/api/game-relay-events", false, "폴링"],
  ["/api/game-relay", false, "폴링"],
  ["/api/game-live", false, "폴링"],
  ["/api/stats", false, "고빈도 읽기"],
  ["/api/player-stats", false, "고빈도 읽기"],
  ["/api/news/discussion/counts", false, "고빈도 읽기"],
  // 인증/쓰기 API — proxy 는 원래 no-op 패스스루(본문 분기)라 제외해도 행동 동일
  ["/api/me", false, "route handler 자체 인증"],
  ["/api/dm/threads", false, "route handler 자체 인증"],
  ["/api/posts", false, "route handler 자체 인증"],
  // 기존 제외 유지
  ["/_next/static/chunks/app.js", false, "정적"],
  ["/_next/image", false, "정적"],
  ["/favicon.ico", false, "정적"],
  ["/logo.png", false, "이미지 확장자"],
];

/** 주석을 공백 치환(오프셋 보존) — 주석 문구가 본문 계약을 대신 만족시키는 false-green 차단. */
function blankComments(source: string): string {
  let out = "";
  let i = 0;
  let mode: string = "code";
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === "code") {
      if (ch === "'" || ch === '"' || ch === "`") { mode = ch; out += ch; i += 1; continue; }
      if (ch === "/" && next === "/") { mode = "line"; out += "  "; i += 2; continue; }
      if (ch === "/" && next === "*") { mode = "block"; out += "  "; i += 2; continue; }
      out += ch; i += 1; continue;
    }
    if (mode === "line") { out += ch === "\n" ? "\n" : " "; if (ch === "\n") mode = "code"; i += 1; continue; }
    if (mode === "block") {
      if (ch === "*" && next === "/") { mode = "code"; out += "  "; i += 2; }
      else { out += ch === "\n" ? "\n" : " "; i += 1; }
      continue;
    }
    out += ch;
    if (ch === "\\") { out += source[i + 1] ?? ""; i += 2; continue; }
    if (ch === mode) mode = "code";
    i += 1;
  }
  return out;
}

const fetchEventStub = { waitUntil: () => undefined } as unknown as NextFetchEvent;

function makeRequest(path: string, host: string, cookies?: Record<string, string>): NextRequest {
  const headers: Record<string, string> = {
    host,
    "sec-fetch-dest": "document",
  };
  if (cookies) {
    headers.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }
  return new NextRequest(`https://${host}${path}`, { headers });
}

async function checkProxyBehavior(failures: Failure[]): Promise<void> {
  // 실행 환경 고정: production 판정 + 비-canonical 호스트 → 문서 경로는 308, API 는 통과가 계약.
  const savedVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  try {
    // A) API 경로: early-return 패스스루 — redirect 없음·Set-Cookie 없음 (mutant M4 검출 축).
    //    canonical redirect 분기 **앞**의 /api 분기가 살아있어야 vercel.app 호스트에서도 308 이 안 난다.
    const api = await proxy(makeRequest("/api/game-events", "kbo-everyday.vercel.app"), fetchEventStub);
    if (api.status !== 200) {
      failures.push(`[B] /api early-return: 기대 200(통과) ↔ 실제 ${api.status} — API 가 canonical redirect/세션 경로를 탄다`);
    }
    if (api.headers.get("location")) {
      failures.push(`[B] /api early-return: location=${api.headers.get("location")} — API redirect 금지`);
    }
    if (api.cookies.getAll().length !== 0) {
      failures.push(`[B] /api early-return: 응답 쿠키 ${api.cookies.getAll().length}개 — 쿠키 무변경 계약 위반`);
    }

    // A') 인증 쿠키가 있어도 API 는 세션 경로를 타지 않는다(쿠키 무변경 유지).
    const apiWithCookie = await proxy(
      makeRequest("/api/game-events", "kbo-everyday.vercel.app", { "sb-test-auth-token": "x" }),
      fetchEventStub,
    );
    if (apiWithCookie.status !== 200 || apiWithCookie.cookies.getAll().length !== 0) {
      failures.push("[B] /api early-return(쿠키 동반): 통과·쿠키 무변경 계약 위반");
    }

    // B) 문서 경로: canonical 308 유지(매칭 경로의 기존 행동 보존 증거).
    const doc = await proxy(makeRequest("/players/12345", "kbo-everyday.vercel.app"), fetchEventStub);
    if (doc.status !== 308 || !(doc.headers.get("location") ?? "").includes("keubo.fan")) {
      failures.push(`[B] 문서 canonical redirect: 기대 308→keubo.fan ↔ 실제 ${doc.status} ${doc.headers.get("location")}`);
    }
  } finally {
    if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = savedVercelEnv;
  }
}

async function check(): Promise<Failure[]> {
  const failures: Failure[] = [];

  // ① 공식 매처 판정 — 실제 config 모듈로 실행(문자열 재구현 0).
  const doesMiddlewareMatch = await loadDoesMiddlewareMatch();
  for (const [path, expected, why] of MATRIX) {
    const actual = doesMiddlewareMatch({
      config: proxyConfig,
      url: path,
    });
    if (actual !== expected) {
      failures.push(`[M] ${path}: 기대 ${expected ? "매칭" : "제외"}(${why}) ↔ 실제 ${actual ? "매칭" : "제외"}`);
    }
  }

  // ② 실제 proxy() 실행 계약.
  await checkProxyBehavior(failures);

  // ③ 본문 방어 계약(주석 blank 후 소스 검사).
  const source = blankComments(readFileSync(PROXY_FILE, "utf8"));
  if (!/pathname\.startsWith\("\/api\/"\)/.test(source)) {
    failures.push("[S] 함수 본문의 /api/ 패스스루 분기 소실");
  }
  if (!/pathname !== "\/api\/standings"\) return null/.test(source)) {
    failures.push("[S] classifyWatchPlatform 의 standings 전용 가드 소실");
  }
  return failures;
}

function runSelfTest(): void {
  const backupDir = mkdtempSync(join(tmpdir(), "proxy-matcher-slim-"));
  const backup = join(backupDir, "proxy.ts.bak");
  copyFileSync(PROXY_FILE, backup);
  const original = readFileSync(PROXY_FILE, "utf8");

  const restore = () => {
    copyFileSync(backup, PROXY_FILE);
    if (readFileSync(PROXY_FILE, "utf8") !== original) {
      console.error("복원 실패 — 백업 보존:", backupDir);
      process.exit(1);
    }
  };

  const mutate = (from: string, to: string, label: string) => {
    if (!original.includes(from)) throw new Error(`${label}: mutation anchor not found`);
    writeFileSync(PROXY_FILE, original.replaceAll(from, to));
  };

  const runGateChild = (): boolean => {
    try {
      execFileSync("npx", ["tsx", "scripts/qa/proxy-matcher-slim-gate.ts"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      return false; // GREEN = 검출 실패
    } catch {
      return true; // RED
    }
  };

  const mutations: Array<[string, () => void]> = [
    [
      "M1 matcher api 제외 제거 — 전체 /api 가 다시 middleware 를 탄다(비용 회귀)",
      () => mutate("api(?:$|/(?!standings$))|", "", "M1"),
    ],
    [
      "M2 standings 예외 제거 — 워치 계측이 middleware 에서 소실",
      () => mutate("api(?:$|/(?!standings$))", "api(?:$|/)", "M2"),
    ],
    [
      "M3 문서 경로 제외 — canonical redirect·세션 갱신 소실",
      () => mutate("_next/static", "players", "M3"),
    ],
    [
      "M4 본문 /api early-return 제거 — API 가 redirect/세션 경로를 탄다(행동 검출)",
      () => mutate('pathname.startsWith("/api/")', 'pathname.startsWith("/__never__/")', "M4"),
    ],
  ];

  let ok = true;
  try {
    for (const [name, apply] of mutations) {
      restore();
      apply();
      const red = runGateChild();
      console.log(`${red ? "RED(기대대로 검출)" : "MISS(검출 실패)"} — ${name}`);
      if (!red) ok = false;
    }
  } finally {
    restore();
    rmSync(backupDir, { recursive: true, force: true });
  }

  // 베이스 GREEN 재확인(변이 복원 후).
  const base = runGateChild();
  if (base) {
    console.error("BASE NOT GREEN(복원 후 게이트 FAIL)");
    ok = false;
  }
  process.exit(ok ? 0 : 1);
}

async function main(): Promise<void> {
  if (process.argv.includes("--selftest")) {
    runSelfTest();
    return;
  }
  const failures = await check();
  if (failures.length > 0) {
    console.error(`proxy-matcher-slim-gate FAIL (${failures.length}건)`);
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
  console.log(
    `proxy-matcher-slim-gate PASS — 공식 matcher 판정 ${MATRIX.length}경로 + 실 proxy() 행동(API 통과·쿠키 무변경·문서 308) + 본문 방어 계약`,
  );
}

void main();
