#!/usr/bin/env node
/**
 * prebuild QA 게이트 병렬 러너 (#infra Vercel 빌드 18분 개선 트랙 A)
 *
 * 문제: prebuild가 165개 게이트를 `&&` 직렬 체인으로 돌려 Vercel 빌드
 * 1,000~1,180초 중 984초(89%)가 게이트에 소모된다. `next build` 자체는 108초.
 *
 * 설계:
 *  - 게이트 목록(GATES)은 종전 prebuild `&&` 체인과 set-equality — 게이트 추가/삭제는
 *    이 파일에서만 한다(순서 = 종전 체인 순서 보존).
 *  - lane 분류:
 *      serial — 브라우저/CDP/포트 바인딩/dev 서버 기동 흔적이 있는 게이트.
 *               한 번에 1개씩, 종전 순서대로(포트·프로필 충돌 방지).
 *      pool   — 정적 분석·fixture 스모크. 워커 N개 병렬.
 *  - 패밀리 체인: 같은 베이스 이름의 변형(`X` → `X:mutations`/`:selftest`/`:db` 등)은
 *    하나의 체인으로 묶어 체인 내부는 직렬 실행(잠재적 선후 의존 보존).
 *  - fail-fast: 첫 실패 시 신규 스케줄 중단, 실행 중인 게이트는 완료 대기,
 *    실패 게이트의 전체 로그를 출력하고 exit 1.
 *  - 출력: 게이트별 버퍼링 후 완료 시점에 [PASS|FAIL name 12.3s]만 출력(로그 폭주 방지),
 *    FAIL일 때만 전체 로그 덤프. 종료 시 최장 게이트 top 10 요약.
 *
 * 사용:
 *  node scripts/ci/prebuild-gates.mjs            # 전체 실행 (prebuild)
 *  node scripts/ci/prebuild-gates.mjs --selftest # 러너 자체 검증(아래) — 실패 시 exit 1
 *  node scripts/ci/prebuild-gates.mjs --list     # 게이트·lane 목록 출력
 *
 * selftest 계약:
 *  ① GATES 전 항목이 package.json scripts에 실존
 *  ② lane 값 유효 + 중복 게이트 0
 *  ③ RED 능력 증명: 실패하는 합성 게이트를 주입한 풀 실행이 exit≠0
 *  ④ GREEN 능력 증명: 성공 합성 게이트 2개(pool+serial) 실행이 exit 0
 */

import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── 게이트 SSOT (순서 = 종전 prebuild && 체인) ─────────────────────
// lane: "serial" = 브라우저/CDP/포트/서버 기동 게이트, "pool" = 병렬 안전
export const GATES = [
  { name: "qa:fav-player-interview", lane: "pool" },
  { name: "qa:fav-player-interview:mutations", lane: "pool" },
  { name: "qa:genius-thinking-bubble", lane: "pool" },
  { name: "qa:genius-thinking-bubble:workflow", lane: "pool" },
  { name: "qa:genius-thinking-bubble:mutations", lane: "exclusive" },
  { name: "qa:genius-mascot-motion", lane: "pool" },
  { name: "qa:genius-mascot-motion:mutations", lane: "exclusive" },
  { name: "qa:genius-mascot-visual", lane: "pool" },
  { name: "qa:genius-mascot-visual:selftest", lane: "pool" },
  { name: "qa:genius-mascot-assets:mutations", lane: "exclusive" },
  { name: "qa:genius-mascot-render", lane: "exclusive" },
  { name: "qa:genius-mascot-render:selftest", lane: "exclusive" },
  { name: "qa:genius-motion-cooldown:db", lane: "pool" },
  { name: "qa:genius-motion-cooldown:db:mutations", lane: "exclusive" },
  { name: "qa:btree-gist-schema", lane: "pool" },
  { name: "qa:css-build-parse", lane: "pool" },
  { name: "qa:bottom-safe-inset", lane: "exclusive" },
  { name: "qa:query-guard", lane: "pool" },
  { name: "qa:shorts-player-route", lane: "pool" },
  { name: "qa:naver-existing-user", lane: "pool" },
  { name: "qa:baseball-source-inventory", lane: "pool" },
  { name: "qa:baseball-rag-contract", lane: "pool" },
  { name: "qa:baseball-rag-serving", lane: "serial" },
  { name: "qa:baseball-news-rag", lane: "pool" },
  { name: "qa:baseball-rag-full-retention", lane: "pool" },
  { name: "qa:baseball-corpus-identity", lane: "pool" },
  { name: "qa:baseball-corpus-identity:mutations", lane: "exclusive" },
  { name: "qa:baseball-corpus-loader", lane: "exclusive" },
  { name: "qa:namu-cdp-raw", lane: "serial" },
  { name: "qa:baseball-official-loader", lane: "pool" },
  { name: "qa:baseball-official-rag", lane: "pool" },
  { name: "qa:baseball-qa", lane: "exclusive" },
  { name: "qa:genius-stat-clarify", lane: "pool" },
  { name: "qa:genius-nonstat-focus", lane: "pool" },
  { name: "qa:genius-nonstat-focus:selftest", lane: "pool" },
  { name: "qa:genius-tone-ssot", lane: "pool" },
  { name: "qa:genius-team-copy", lane: "pool" },
  { name: "qa:genius-team-copy:mutations", lane: "exclusive" },
  { name: "qa:genius-tone-migration", lane: "pool" },
  { name: "qa:genius-terms-log-gap", lane: "pool" },
  { name: "qa:genius-terms-log-gap:selftest", lane: "pool" },
  { name: "qa:baseball-genius-context", lane: "exclusive" },
  { name: "qa:baseball-genius-context:mutations", lane: "exclusive" },
  { name: "qa:genius-match-path-db", lane: "pool" },
  { name: "qa:foreign-photo", lane: "pool" },
  { name: "qa:photos-helper-signature", lane: "pool" },
  { name: "qa:feed-scroll-restore", lane: "pool" },
  { name: "qa:roster-count-consistency", lane: "pool" },
  { name: "qa:roster-derived-sync", lane: "exclusive" },
  { name: "qa:roster-preservation", lane: "pool" },
  { name: "qa:roster-crawl-completion", lane: "exclusive" },
  { name: "qa:roster-scope-trust", lane: "exclusive" },
  { name: "qa:starter-era", lane: "pool" },
  { name: "qa:game-detail-bounded-fallback", lane: "pool" },
  { name: "qa:game-detail-sub-merge:mutations", lane: "exclusive" },
  { name: "qa:stats-snapshot-guard", lane: "pool" },
  { name: "qa:atomic-promote", lane: "exclusive" },
  { name: "qa:kbo-pagination", lane: "pool" },
  { name: "qa:source-row-stability", lane: "pool" },
  { name: "qa:kbo-select", lane: "serial" },
  { name: "qa:stats-gate-trigger", lane: "pool" },
  { name: "qa:stats-kboid-identity", lane: "pool" },
  { name: "qa:stats-2025-integrity", lane: "pool" },
  { name: "qa:stats-2025-integrity:mutations", lane: "exclusive" },
  { name: "qa:war-benchmark-coverage", lane: "pool" },
  { name: "qa:videos-rss-status", lane: "pool" },
  { name: "qa:diary-contrast", lane: "exclusive" },
  { name: "qa:genius-typing", lane: "pool" },
  { name: "qa:genius-avatar-static", lane: "exclusive" },
  { name: "qa:next-game-date-badge", lane: "pool" },
  { name: "qa:exclusive-badges", lane: "pool" },
  { name: "qa:player-popularity-order", lane: "exclusive" },
  { name: "qa:venue-stats-s1b-aggregate", lane: "pool" },
  { name: "qa:venue-stats-expected", lane: "pool" },
  { name: "qa:home-header-signup-button", lane: "pool" },
  { name: "qa:venue-stats-s2-effect-guard", lane: "pool" },
  { name: "qa:venue-stats-s2-header-guard", lane: "pool" },
  { name: "qa:venue-diary-public", lane: "pool" },
  { name: "qa:venue-diary-season", lane: "exclusive" },
  { name: "qa:venue-diary-viewer-chrome", lane: "exclusive" },
  { name: "qa:venue-diary-games-fold", lane: "exclusive" },
  { name: "qa:venue-stats-s2-browser", lane: "exclusive" },
  { name: "qa:game-chat-visibility", lane: "pool" },
  { name: "qa:venue-game-errors", lane: "pool" },
  { name: "qa:venue-error-tags", lane: "pool" },
  { name: "qa:nickname-api", lane: "exclusive" },
  { name: "qa:post-detail-header-nowrap", lane: "serial" },
  { name: "qa:post-detail-header-nowrap-browser", lane: "serial" },
  { name: "qa:genius-entry", lane: "pool" },
  { name: "qa:genius-reply-mascot", lane: "pool" },
  { name: "qa:genius-provenance-privacy", lane: "serial" },
  { name: "qa:genius-picker-disabled", lane: "pool" },
  { name: "qa:genius-feedback-db", lane: "pool" },
  { name: "qa:genius-answer-feedback", lane: "pool" },
  { name: "qa:genius-feedback-mutation", lane: "exclusive" },
  { name: "qa:team-fullname-routing", lane: "pool" },
  { name: "qa:team-rag-wiring", lane: "serial" },
  { name: "qa:team-rag-audit:self-test", lane: "pool" },
  { name: "qa:genius-served-metrics", lane: "pool" },
  { name: "qa:genius-push-exclusion", lane: "pool" },
  { name: "qa:genius-reply-payload-db", lane: "pool" },
  { name: "qa:venue-attendance", lane: "pool" },
  { name: "qa:venue-attendance-crud:db", lane: "pool" },
  { name: "qa:venue-multi-pick", lane: "pool" },
  { name: "qa:venue-story-video-poster", lane: "pool" },
  { name: "qa:venue-story-progress-waapi", lane: "pool" },
  { name: "qa:venue-story-chrome-tap", lane: "serial" },
  { name: "qa:venue-story-media-flash", lane: "pool" },
  { name: "qa:static-asset-cache-headers", lane: "serial" },
  { name: "qa:live-edge-cache", lane: "pool" },
  { name: "qa:post-scope-label", lane: "pool" },
  { name: "qa:post-scope-db-trigger", lane: "pool" },
  { name: "qa:news-rag-wiring", lane: "pool" },
  { name: "qa:genius-refusal-scope", lane: "pool" },
  { name: "qa:genius-unbound-name", lane: "pool" },
  { name: "qa:genius-unbound-name:mutations", lane: "exclusive" },
  { name: "qa:genius-draft-year", lane: "pool" },
  { name: "qa:genius-draft-year:mutations", lane: "exclusive" },
  { name: "qa:genius-glossary-map", lane: "pool" },
  { name: "qa:genius-question-normalize", lane: "pool" },
  { name: "qa:genius-question-normalize:mutations", lane: "exclusive" },
  { name: "qa:genius-question-correction-db", lane: "pool" },
  { name: "qa:genius-correction-dm-race", lane: "pool" },
  { name: "qa:genius-today-starters", lane: "pool" },
  { name: "qa:collector-author-team", lane: "serial" },
  { name: "qa:collector-player-tags:mutations", lane: "exclusive" },
  { name: "qa:relay-gameid-guard", lane: "pool" },
  { name: "qa:active-users-contract", lane: "pool" },
  { name: "qa:active-users-hybrid", lane: "pool" },
  { name: "qa:player-link-prefetch", lane: "pool" },
  { name: "qa:player-link-prefetch:selftest", lane: "pool" },
  { name: "qa:player-stats-parser", lane: "pool" },
  { name: "qa:readonly-api-edge-cache", lane: "pool" },
  { name: "qa:readonly-api-edge-cache:selftest", lane: "pool" },
  { name: "qa:baseball-leaderboard", lane: "pool" },
  { name: "qa:baseball-leaderboard:mutations", lane: "exclusive" },
  { name: "qa:genius-career-metric-leak", lane: "pool" },
  { name: "qa:genius-career-metric-leak:mutations", lane: "exclusive" },
  { name: "qa:career-metrics", lane: "pool" },
  { name: "qa:career-metrics:mutations", lane: "exclusive" },
  { name: "qa:event-records", lane: "pool" },
  { name: "qa:event-records:mutations", lane: "exclusive" },
  { name: "qa:auth-token-precheck", lane: "serial" },
  { name: "qa:auth-es256-e2e", lane: "pool" },
  { name: "qa:advisor-step1-migration", lane: "pool" },
  { name: "qa:content-views", lane: "pool" },
  { name: "qa:content-views:news-wiring", lane: "exclusive" },
  { name: "qa:content-views:news-wiring:mutations", lane: "pool" },
  { name: "qa:advisor-step2-rls", lane: "pool" },
  { name: "qa:native-push-deeplink", lane: "pool" },
  { name: "qa:featured-card-contrast", lane: "pool" },
  { name: "qa:featured-card-contrast:selftest", lane: "pool" },
  { name: "qa:live-detail-provenance", lane: "pool" },
  { name: "qa:live-detail-provenance:selftest", lane: "pool" },
  { name: "qa:brand-icon-clip:selftest", lane: "pool" },
  { name: "qa:genius-discard-reason", lane: "pool" },
  { name: "qa:genius-discard-reason:mutations", lane: "exclusive" },
  { name: "qa:post-scope-all-teams-confirm", lane: "pool" },
  { name: "qa:visibility-poller-adoption", lane: "pool" },
  { name: "qa:game-detail-parse-memo", lane: "pool" },
  { name: "qa:client-dedupe", lane: "pool" },
  { name: "qa:client-dedupe:selftest", lane: "pool" },
  { name: "qa:self-fetch-internal", lane: "exclusive" },
  { name: "qa:self-fetch-internal:selftest", lane: "exclusive" },
  { name: "qa:self-fetch-internal:cleanup", lane: "exclusive" },
];

const POOL_CONCURRENCY = Math.max(2, Math.min(6, os.cpus().length - 1));

// ── 패밀리 체인: 베이스 이름이 같은 변형은 직렬 체인으로 묶는다 ────
function baseName(name) {
  // qa:foo:mutations → qa:foo / qa:foo:db:mutations → qa:foo
  return name.replace(/:(mutations|selftest|self-test|workflow|cleanup|db|news-wiring|pg17)(:.*)?$/, "");
}

export function buildChains(gates) {
  const chains = []; // { lane, gates: [names] } — 등장 순서 보존
  const byKey = new Map();
  for (const g of gates) {
    const key = `${g.lane}\u0000${baseName(g.name)}`;
    if (byKey.has(key)) {
      byKey.get(key).gates.push(g.name);
    } else {
      const chain = { lane: g.lane, gates: [g.name] };
      byKey.set(key, chain);
      chains.push(chain);
    }
  }
  return chains;
}

// ── 단일소유 lock + 자식 process-group 종료 (삼순 blocker ② 반영) ─────
// lock 은 node_modules 아래(gitignored)라 verify-clean 을 오염시키지 않는다.
const LOCK_FILE = path.join(ROOT, "node_modules", ".prebuild-gates.lock");
const activeChildren = new Set(); // 실행 중 게이트 child pid (detached process-group leader)

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const prev = Number(readFileSync(LOCK_FILE, "utf8").trim());
      if (Number.isFinite(prev) && prev > 0 && pidAlive(prev)) {
        console.error(`[prebuild-gates] lock FAIL — 다른 러너(pid ${prev})가 같은 checkout 에서 실행 중이다. 동시 실행은 in-place mutation 게이트를 서로 오염시킨다.`);
        process.exit(1);
      }
      // stale lock — 소유 pid 가 죽었으면 회수
    }
    writeFileSync(LOCK_FILE, String(process.pid));
  } catch (err) {
    console.error(`[prebuild-gates] lock FAIL — lock 파일을 만들 수 없다: ${err.message}`);
    process.exit(1);
  }
}

function releaseLock() {
  try {
    if (existsSync(LOCK_FILE) && readFileSync(LOCK_FILE, "utf8").trim() === String(process.pid)) unlinkSync(LOCK_FILE);
  } catch { /* 종료 경로 — 무시 */ }
}

function killChildGroups(signal) {
  for (const pid of activeChildren) {
    try { process.kill(-pid, signal); } catch { /* 이미 종료 */ }
  }
}

let terminating = false;
function installSignalHandlers() {
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      if (terminating) return;
      terminating = true;
      console.error(`[prebuild-gates] ${sig} — 자식 게이트 process-group 전체에 SIGTERM 전파 후 종료한다`);
      killChildGroups("SIGTERM");
      // 유예 후 SIGKILL — mutation 게이트의 restore 핸들러가 돌 시간을 준다
      setTimeout(() => {
        killChildGroups("SIGKILL");
        releaseLock();
        process.exit(130);
      }, 3000);
    });
  }
  process.on("exit", releaseLock);
}

// ── 실행 ───────────────────────────────────────────────────────────
function runGate(name) {
  return new Promise((resolve) => {
    const start = Date.now();
    // selftest 전용 합성 게이트 — 실코드 경로(runAll/runChain/report)를 그대로 태운다
    const isSynthetic = name.startsWith("__synthetic_");
    const syntheticBody =
      name === "__synthetic_fail__" ? "process.exit(1)"
      : name === "__synthetic_sleep__"
        ? "require('fs').writeFileSync(process.env.SYNTH_PID_FILE, String(process.pid)); setTimeout(() => process.exit(0), 30000)"
        : "process.exit(0)";
    const [cmd, args] = isSynthetic ? [process.execPath, ["-e", syntheticBody]] : ["npm", ["run", name]];
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // 자기 process-group 리더로 — 러너 중단 시 그룹째 종료 가능
    });
    if (child.pid) activeChildren.add(child.pid);
    let buf = "";
    const cap = (d) => {
      buf += d.toString();
      if (buf.length > 2_000_000) buf = buf.slice(-1_000_000); // 로그 폭주 방어
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    child.on("close", (code) => {
      if (child.pid) activeChildren.delete(child.pid);
      resolve({ name, code: code ?? 1, secs: (Date.now() - start) / 1000, log: buf });
    });
    child.on("error", (err) => {
      resolve({ name, code: 1, secs: (Date.now() - start) / 1000, log: `${buf}\n[runner] spawn error: ${err.message}` });
    });
  });
}

function gitPorcelain() {
  // -uall: untracked를 개별 파일 단위까지 전부 나열 (디렉터리 축약 방지)
  return execSync("git status --porcelain -uall", { cwd: ROOT, encoding: "utf8" }).trim();
}

const CANONICAL_FILE = path.join(ROOT, "scripts", "ci", "prebuild-gates-canonical.json");

/** GATES ↔ canonical 목록 set+순서 equality — 실행마다 인라인 검증(삼순 blocker ③) */
function assertCanonicalEquality(gates) {
  let canonical;
  try {
    canonical = JSON.parse(readFileSync(CANONICAL_FILE, "utf8"));
  } catch (err) {
    console.error(`[prebuild-gates] canonical FAIL — ${CANONICAL_FILE} 읽기 불가: ${err.message}`);
    process.exit(1);
  }
  const names = gates.map((g) => g.name);
  const same = names.length === canonical.length && names.every((n, i) => n === canonical[i]);
  if (!same) {
    const a = new Set(names), b = new Set(canonical);
    const missing = canonical.filter((n) => !a.has(n));
    const extra = names.filter((n) => !b.has(n));
    console.error(`[prebuild-gates] canonical FAIL — GATES ↔ canonical set+순서 불일치 (canonical에만: ${missing.join(",") || "-"} / GATES에만: ${extra.join(",") || "-"} / 순서 불일치 여부 포함)`);
    console.error("게이트 추가·삭제·재배열은 GATES 와 prebuild-gates-canonical.json 을 함께 바꿔야 한다.");
    process.exit(1);
  }
}

async function runAll(gates, { verifyClean = false, canonical = false } = {}) {
  if (canonical) assertCanonicalEquality(gates);
  if (verifyClean) {
    // 삼순 교정(2026-08-20): 전후 snapshot "동일" 비교는 시작부터 dirty인 파일의
    // 내용 변화·untracked 덮어쓰기를 못 본다(같은 M/?? 경로로 통과).
    // 시작 시 빈 값이 아니면 즉시 FAIL, 종료 시에도 빈 값 exact를 요구한다.
    const before = gitPorcelain();
    if (before !== "") {
      console.error("[prebuild-gates] verify-clean FAIL — 시작 시 worktree가 clean이 아니다 (porcelain -uall):");
      console.error(before);
      process.exit(1);
    }
  }
  const chains = buildChains(gates);
  const poolChains = chains.filter((c) => c.lane === "pool");
  const serialChains = chains.filter((c) => c.lane === "serial");
  const exclusiveChains = chains.filter((c) => c.lane === "exclusive");
  const results = [];
  let failed = false;
  const t0 = Date.now();

  const report = (r) => {
    results.push(r);
    const mark = r.code === 0 ? "PASS" : "FAIL";
    console.log(`[gate ${mark}] ${r.name} ${r.secs.toFixed(1)}s`);
    if (r.code !== 0) {
      failed = true;
      console.error(`\n───── ${r.name} 실패 로그 시작 ─────`);
      console.error(r.log);
      console.error(`───── ${r.name} 실패 로그 끝 ─────\n`);
    }
  };

  async function runChain(chain) {
    for (const name of chain.gates) {
      if (failed) return; // fail-fast: 체인 내 후속도 중단
      const r = await runGate(name);
      report(r);
      if (r.code !== 0) return;
    }
  }

  // serial lane: 전용 워커 1개 (순서 보존)
  const serialWorker = (async () => {
    for (const chain of serialChains) {
      if (failed) return;
      await runChain(chain);
    }
  })();

  // pool lane: 워커 N개, FIFO
  let next = 0;
  const poolWorker = async () => {
    while (!failed && next < poolChains.length) {
      const chain = poolChains[next++];
      await runChain(chain);
    }
  };
  const workers = Array.from({ length: POOL_CONCURRENCY }, () => poolWorker());

  await Promise.all([serialWorker, ...workers]);

  // phase 2 — exclusive: repo 파일을 in-place 변이/생성하는 게이트.
  // 다른 게이트가 같은 파일을 읽는 순간을 원리적으로 제거하기 위해
  // 모든 병렬 레인이 끝난 뒤 한 번에 1개씩만 돈다.
  for (const chain of exclusiveChains) {
    if (failed) break;
    await runChain(chain);
  }

  const total = (Date.now() - t0) / 1000;
  const ran = results.length;
  const failures = results.filter((r) => r.code !== 0);
  const top = [...results].sort((a, b) => b.secs - a.secs).slice(0, 10);
  console.log(`\n[prebuild-gates] ${failed ? "FAIL" : "PASS"} — ${ran}/${gates.length} 실행, ${total.toFixed(1)}s, pool 워커 ${POOL_CONCURRENCY}, exclusive ${exclusiveChains.reduce((n, c) => n + c.gates.length, 0)}개`);
  console.log("[prebuild-gates] 최장 게이트 top10: " + top.map((r) => `${r.name}=${r.secs.toFixed(0)}s`).join(", "));
  if (failed) {
    console.error("[prebuild-gates] 실패 게이트: " + failures.map((r) => r.name).join(", "));
    process.exit(1);
  }
  if (verifyClean) {
    const after = gitPorcelain();
    if (after !== "") {
      console.error("[prebuild-gates] verify-clean FAIL — 종료 시 worktree가 clean이 아니다 (게이트 잔재/오염, porcelain -uall):");
      console.error(after);
      process.exit(1);
    }
    console.log("[prebuild-gates] verify-clean PASS — 시작·종료 모두 porcelain -uall 빈 값 exact");
  }
}

// ── selftest ───────────────────────────────────────────────────────
async function selftest() {
  const errors = [];
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const scripts = pkg.scripts ?? {};
  // ① 실존
  for (const g of GATES) {
    if (!scripts[g.name]) errors.push(`package.json scripts에 없음: ${g.name}`);
  }
  // ② lane 유효 + 중복 0
  const seen = new Set();
  for (const g of GATES) {
    if (g.lane !== "pool" && g.lane !== "serial" && g.lane !== "exclusive") errors.push(`lane 값 invalid: ${g.name}=${g.lane}`);
    if (seen.has(g.name)) errors.push(`중복 게이트: ${g.name}`);
    seen.add(g.name);
  }
  // ②' prebuild가 이 러너를 쓰는지 (직렬 체인 부활 방지)
  if (!/prebuild-gates\.mjs/.test(String(scripts.prebuild ?? ""))) {
    errors.push("package.json prebuild가 prebuild-gates.mjs를 호출하지 않음");
  }
  // ③/④ RED·GREEN 능력: 합성 게이트로 자기 자신을 서브프로세스 실행
  const synth = async (fixture, expectFail) => {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--synthetic", fixture], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => {
        const failedAsExpected = expectFail ? code !== 0 : code === 0;
        if (!failedAsExpected) errors.push(`synthetic ${fixture}: exit=${code} (기대 ${expectFail ? "≠0" : "0"})\n${out.slice(-500)}`);
        resolve();
      });
    });
  };
  await synth("red-pool", true);
  await synth("red-serial", true);
  await synth("red-exclusive", true);
  await synth("green", false);

  // 중단-잔존 회귀 (삼순 blocker ②): 러너를 SIGTERM 으로 중단하면
  // 실행 중이던 자식 게이트 process-group 까지 함께 죽어야 한다.
  await (async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const pidFile = path.join(os.tmpdir(), `prebuild-gates-synth-${process.pid}.pid`);
    try { fs.unlinkSync(pidFile); } catch { /* 없으면 통과 */ }
    const runner = spawn(process.execPath, [fileURLToPath(import.meta.url), "--synthetic", "sleep"], {
      cwd: ROOT,
      env: { ...process.env, SYNTH_PID_FILE: pidFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // 자식 게이트가 떠서 pid 를 쓸 때까지 대기 (최대 10초)
    const deadline = Date.now() + 10_000;
    let childPid = 0;
    while (Date.now() < deadline) {
      try {
        childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
        if (childPid > 0) break;
      } catch { /* 아직 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!(childPid > 0)) {
      errors.push("interrupt: synthetic sleep 게이트가 뜨지 않았다");
      runner.kill("SIGKILL");
      return;
    }
    runner.kill("SIGTERM");
    await new Promise((resolve) => runner.on("close", resolve));
    // 유예 포함 최대 6초 안에 자식이 죽어야 한다
    const killDeadline = Date.now() + 6_000;
    let alive = true;
    while (Date.now() < killDeadline) {
      alive = pidAlive(childPid);
      if (!alive) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (alive) {
      errors.push(`interrupt: 러너 SIGTERM 후에도 자식 게이트(pid ${childPid})가 살아있다 — process-group 전파 실패`);
      try { process.kill(childPid, "SIGKILL"); } catch { /* 정리 */ }
    }
    try { fs.unlinkSync(pidFile); } catch { /* 정리 */ }
  })();

  if (errors.length) {
    console.error("[prebuild-gates selftest] FAIL");
    for (const e of errors) console.error(" - " + e);
    process.exit(1);
  }
  console.log(`[prebuild-gates selftest] PASS — 게이트 ${GATES.length}개 실존·중복0·prebuild 결속·RED/GREEN 증명`);
}

// ── entry ──────────────────────────────────────────────────────────
// main 가드: 다른 게이트가 GATES 를 import 할 때 실행되면 안 된다
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
installSignalHandlers();
const argv = process.argv.slice(2);
// lock 은 실게이트 풀런에만 — selftest 의 synthetic 픽스처는 repo 파일을 건드리지 않고,
// selftest 가 lock 을 쥐면 자기 synthetic 서브프로세스가 lock FAIL 로 죽는다.
const isRealRun = argv[0] === undefined || argv[0] === "--verify-clean";
if (isRealRun) acquireLock();
if (argv[0] === "--selftest") {
  await selftest();
} else if (argv[0] === "--list") {
  for (const g of GATES) console.log(`${g.lane}\t${g.name}`);
  console.log(`total=${GATES.length} pool=${GATES.filter((g) => g.lane === "pool").length} serial=${GATES.filter((g) => g.lane === "serial").length} exclusive=${GATES.filter((g) => g.lane === "exclusive").length}`);
} else if (argv[0] === "--synthetic") {
  // selftest 전용 합성 픽스처 — 실게이트 이름은 받지 않는다(검사 강도 선택자 차단)
  const fixture = argv[1];
  if (fixture === "red" || fixture === "red-pool") {
    await runAll([
      { name: "__synthetic_pass__", lane: "pool" },
      { name: "__synthetic_fail__", lane: "pool" },
      { name: "__synthetic_pass2__", lane: "serial" },
    ]);
  } else if (fixture === "red-serial") {
    await runAll([
      { name: "__synthetic_pass__", lane: "pool" },
      { name: "__synthetic_fail__", lane: "serial" },
      { name: "__synthetic_pass2__", lane: "exclusive" },
    ]);
  } else if (fixture === "red-exclusive") {
    await runAll([
      { name: "__synthetic_pass__", lane: "pool" },
      { name: "__synthetic_pass2__", lane: "serial" },
      { name: "__synthetic_fail__", lane: "exclusive" },
    ]);
  } else if (fixture === "sleep") {
    await runAll([
      { name: "__synthetic_sleep__", lane: "pool" },
      { name: "__synthetic_pass__", lane: "pool" },
    ]);
  } else if (fixture === "green") {
    await runAll([
      { name: "__synthetic_pass__", lane: "pool" },
      { name: "__synthetic_pass2__", lane: "serial" },
      { name: "__synthetic_pass3__", lane: "exclusive" },
    ]);
  } else {
    console.error("unknown synthetic fixture: " + fixture);
    process.exit(1);
  }
} else {
  await runAll(GATES, { verifyClean: argv.includes("--verify-clean"), canonical: true });
}
}
