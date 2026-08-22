#!/usr/bin/env node
/**
 * send-guard 게이트 — 3축 검증 (삼순 8차 요청):
 *   A. evaluator selftest: GREEN 1 + RED 축별 정확한 reason code (strict hostname 포함)
 *   B. 실제 런타임 차단: 자식 프로세스가 `assertSendAllowed()` 를 실행해
 *      production URL 에서 exit 3 으로 실제 죽는지 (문면이 아니라 프로세스 실측)
 *   C. mutant 검출력: production 차단 상수를 무력화한 사본은 차단하지 못함을
 *      실증 — B 의 PASS 가 바로 그 상수에서 나온다는 증명 (결함주입 RED)
 * write 0 — 이 게이트는 네트워크·DB 를 건드리지 않는다.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateSend, selftestCases, REASONS, evaluateChatWrite, roomIdOfChatInsertBody, WRITE_REASONS } from "./send-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD_PATH = join(HERE, "send-guard.mjs");
let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ── A. evaluator selftest
for (const c of selftestCases()) {
  const v = evaluateSend(c.ctx, c.opts);
  check(`[selftest] ${c.name}`, v.reason === c.expect && v.allowed === (c.expect === REASONS.OK), `got ${v.reason}/allowed=${v.allowed}, want ${c.expect}`);
}

// ── B. 실제 assertSendAllowed() 프로세스 차단 (exit 3 실측)
function runChild(guardFileUrl, supabaseUrl, roomId) {
  const code = `import { assertSendAllowed } from ${JSON.stringify(guardFileUrl)};\nassertSendAllowed({ supabaseUrl: ${JSON.stringify(supabaseUrl)}, roomId: ${JSON.stringify(roomId)}, purpose: "gate probe" });\nconsole.log("REACHED_AFTER_GUARD");`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
}
const realUrl = pathToFileURL(GUARD_PATH).href;
const prod = runChild(realUrl, "https://lbmbdjgsnenqjwjotoei.supabase.co", "qa-fixture:abcd");
check("[actual] production URL → exit 3 실차단", prod.status === 3 && !prod.stdout.includes("REACHED_AFTER_GUARD"), `status=${prod.status}`);
check("[actual] production 차단 사유 = PRODUCTION_REF", /RED PRODUCTION_REF/.test(prod.stderr), prod.stderr.slice(0, 120));
const evil = runChild(realUrl, "https://lbmbdjgsnenqjwjotoei.supabase.co.evil", "qa-fixture:abcd");
check("[actual] suffix 위장 호스트 → exit 3 (REF_UNRESOLVED)", evil.status === 3 && /RED REF_UNRESOLVED/.test(evil.stderr), `status=${evil.status}`);
const stagingLike = runChild(realUrl, "https://qastaginginjected.supabase.co", "qa-fixture:abcd");
check("[actual] 런타임 allowlist 빈 상태 — staging 유사 URL 도 exit 3", stagingLike.status === 3 && /RED REF_NOT_ALLOWLISTED/.test(stagingLike.stderr), `status=${stagingLike.status}`);
const game = runChild(realUrl, "https://qastaginginjected.supabase.co", "game:20260821LGHH0");
check("[actual] 실경기방 room → exit 3", game.status === 3, `status=${game.status}`);

// ── C. mutant: production 차단 무력화 사본은 통과해버림을 실증 (검출력 증명)
const src = readFileSync(GUARD_PATH, "utf8");
const mutated = src
  .replace('const PRODUCTION_PROJECT_REFS = Object.freeze(["lbmbdjgsnenqjwjotoei"]);', "const PRODUCTION_PROJECT_REFS = Object.freeze([]);")
  .replace("const STAGING_PROJECT_REFS = Object.freeze([]);", 'const STAGING_PROJECT_REFS = Object.freeze(["lbmbdjgsnenqjwjotoei"]);');
if (mutated === src) {
  check("[mutant] 소스 패치 적용", false, "mutation 대상 상수 문면을 찾지 못함 — 게이트/가드 문면 불일치");
} else {
  const tmp = mkdtempSync(join(tmpdir(), "send-guard-mutant-"));
  try {
    const mutantPath = join(tmp, "send-guard.mjs");
    writeFileSync(mutantPath, mutated);
    const mutant = runChild(pathToFileURL(mutantPath).href, "https://lbmbdjgsnenqjwjotoei.supabase.co", "qa-fixture:abcd");
    check(
      "[mutant] production 차단 상수 무력화 시 통과해버림 (B 의 차단이 그 상수에서 나옴을 실증)",
      mutant.status === 0 && mutant.stdout.includes("REACHED_AFTER_GUARD"),
      `status=${mutant.status}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── D. write-target 단일 결속 (삼순 9·10차: room 축 + ref 축, 실제 BrowserContext 실증)
{
  const w = (b, g, u, r) => evaluateChatWrite(b, g, u, r);
  check("[write-bind] room+ref 완전 일치만 허용", w("qa-fixture:abcd", "qa-fixture:abcd", "https://qastaginginjected.supabase.co/rest/v1/chat_messages", "qastaginginjected").reason === WRITE_REASONS.OK);
  check("[write-bind] 실경기방 write 는 room 불일치로 차단", w("game:20260821LGHH0", "qa-fixture:abcd", "https://qastaginginjected.supabase.co/rest/v1/chat_messages", "qastaginginjected").reason === WRITE_REASONS.WRITE_TARGET_MISMATCH);
  check("[write-bind] Production ref 로 향하는 요청은 별도 사유로 영구 차단", w("qa-fixture:abcd", "qa-fixture:abcd", "https://lbmbdjgsnenqjwjotoei.supabase.co/rest/v1/chat_messages", "qastaginginjected").reason === WRITE_REASONS.PRODUCTION_WRITE_TARGET);
  check("[write-bind] 요청 ref ≠ expected staging ref 차단", w("qa-fixture:abcd", "qa-fixture:abcd", "https://otherstaging.supabase.co/rest/v1/chat_messages", "qastaginginjected").reason === WRITE_REASONS.REF_MISMATCH);
  check("[write-bind] expected ref 부재 시 모든 write 차단", w("qa-fixture:abcd", "qa-fixture:abcd", "https://qastaginginjected.supabase.co/x", null).reason === WRITE_REASONS.GUARD_REF_MISSING);
  check("[write-bind] 요청 URL ref 판정 불능 차단 (production page 등 비-supabase host)", w("qa-fixture:abcd", "qa-fixture:abcd", "https://keubo.fan/api/chat", "qastaginginjected").reason === WRITE_REASONS.URL_REF_UNRESOLVED);
  check("[write-bind] guarded room 부재 시 모든 write 차단", w("game:x", null).reason === WRITE_REASONS.GUARD_ROOM_MISSING);
  check("[write-bind] body room 판정 불능은 차단(fail-close)", w(null, "qa-fixture:abcd").reason === WRITE_REASONS.BODY_ROOM_UNRESOLVED);
  check("[write-bind] 배열 insert 혼합 room 은 판정 불능(null)", roomIdOfChatInsertBody(JSON.stringify([{ room_id: "r1" }, { room_id: "r2" }])) === null);
  check("[write-bind] 배열 insert 단일 room 은 그 room", roomIdOfChatInsertBody(JSON.stringify([{ room_id: "r1" }, { room_id: "r1" }])) === "r1");
  // 하니스 결속 실재 확인
  const HARNESSES = ["e2e-1274-ab-measure.mjs", "e2e-1274-paired.mjs", "e2e-1274-chat-preview.mjs", "e2e-1256-chat-realtime.mjs"];
  for (const h of HARNESSES) {
    const src2 = readFileSync(join(HERE, h), "utf8");
    check(`[write-bind] ${h} 가 installChatWriteInterceptor(context, ROOM_ID) 결속`, /installChatWriteInterceptor\(context, ROOM_ID\)/.test(src2));
    check(`[sw-block] ${h} context 가 serviceWorkers: "block" 고정`, /serviceWorkers:\s*"block"/.test(src2));
  }

  // ── actual: 실제 Playwright BrowserContext + POST 실측 (스텁 아님) + 결속 제거 mutant
  const { chromium } = await import("playwright");
  const { installChatWriteInterceptor } = await import("./send-guard.mjs");
  const browser = await chromium.launch({ headless: true });
  const STG_URL = "https://qastaginginjected.supabase.co/rest/v1/chat_messages";
  const PROD_URL = "https://lbmbdjgsnenqjwjotoei.supabase.co/rest/v1/chat_messages";
  // simple-request(text/plain)로 preflight 없이 POST 를 확정 발화시킨다.
  async function firePost(page, url, room) {
    return page.evaluate(async (a) => {
      try {
        const r = await fetch(a.url, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ room_id: a.room }) });
        return { fetched: true, status: r.status };
      } catch (e) { return { fetched: false, msg: String(e) }; }
    }, { url, room });
  }
  function trackFailures(page, sink) {
    page.on("requestfailed", (req) => { if (req.method() === "POST") sink.push({ url: req.url(), err: req.failure()?.errorText ?? "" }); });
  }
  try {
    // (1) guard 설치 컨텍스트 — mock 을 먼저 등록해 abort 되지 않은 요청이 production 실네트워크로 나가지 않게 한다.
    const guarded = await browser.newContext({ serviceWorkers: "block" });
    const mockHits = [];
    await guarded.route("**/rest/v1/chat_messages*", (route) => { mockHits.push(route.request().url()); return route.fulfill({ status: 200, contentType: "application/json", body: "[]" }); });
    const blockedEvents = [];
    await installChatWriteInterceptor(guarded, "qa-fixture:abcd", (info) => blockedEvents.push(info), "qastaginginjected");
    const gp = await guarded.newPage();
    const gFails = [];
    trackFailures(gp, gFails);
    await gp.goto("about:blank");
    // RED a: production ref + qa-fixture body — ref 축이 차단해야 하고 production 네트워크/mock 도달 0
    const ra = await firePost(gp, PROD_URL, "qa-fixture:abcd");
    check("[actual-browser] production ref POST 는 abort (fetch 실패)", ra.fetched === false, JSON.stringify(ra));
    check("[actual-browser] production ref abort 사유 = ERR_BLOCKED_BY_CLIENT", gFails.some((f) => f.url.startsWith(PROD_URL) && /BLOCKED_BY_CLIENT/.test(f.err)), JSON.stringify(gFails));
    check("[actual-browser] production ref 차단 콜백 = PRODUCTION_WRITE_TARGET", blockedEvents.at(-1)?.reason === WRITE_REASONS.PRODUCTION_WRITE_TARGET, JSON.stringify(blockedEvents.at(-1)));
    // RED b: staging ref + 실경기방 body — room 축 차단
    const rb = await firePost(gp, STG_URL, "game:20260821LGHH0");
    check("[actual-browser] 실경기방 body POST 는 abort", rb.fetched === false, JSON.stringify(rb));
    check("[actual-browser] 실경기방 차단 콜백 = WRITE_TARGET_MISMATCH", blockedEvents.at(-1)?.reason === WRITE_REASONS.WRITE_TARGET_MISMATCH, JSON.stringify(blockedEvents.at(-1)));
    check("[actual-browser] RED 요청은 mock/네트워크에 도달하지 않음 (abort 가 경계)", mockHits.length === 0, `mockHits=${mockHits.length}`);
    // GREEN: staging ref + guarded fixture body — fallback 체인으로 mock 에 실도달해야 한다.
    // (continue 는 mock 을 우회해 DNS/CORS 실패도 '차단 아님' 으로 오독시킨다 — 삼순 11차)
    const blockedBefore = blockedEvents.length;
    check("[actual-browser] GREEN 발화 전 mock 도달 0 (RED 가 mock 앞에서 끊겼음을 고정)", mockHits.length === 0, `mockHits=${mockHits.length}`);
    const g1 = await firePost(gp, STG_URL, "qa-fixture:abcd");
    check("[actual-browser] guarded room+ref POST 는 status 200 + mock 실도달 1건 (fallback 체인 증명)", g1.fetched === true && g1.status === 200 && mockHits.length === 1 && mockHits[0].startsWith(STG_URL), JSON.stringify({ g1, mockHits }));
    check("[actual-browser] GREEN 은 차단 콜백을 만들지 않음", blockedEvents.length === blockedBefore, JSON.stringify(blockedEvents.slice(blockedBefore)));
    await guarded.close();
    // (2) mutant: 결속 제거(인터셉터 미설치) 컨텍스트 — 같은 production POST 가 통과해버린다 (검출력 실증)
    const naked = await browser.newContext({ serviceWorkers: "block" });
    const nakedHits = [];
    await naked.route("**/rest/v1/chat_messages*", (route) => { nakedHits.push(route.request().url()); return route.fulfill({ status: 200, contentType: "application/json", body: "[]" }); });
    const np = await naked.newPage();
    await np.goto("about:blank");
    const mut = await firePost(np, PROD_URL, "qa-fixture:abcd");
    check("[actual-browser mutant] 인터셉터 제거 시 production POST 가 통과 (차단이 결속에서 나옴을 실증)", mut.fetched === true && nakedHits.length === 1, JSON.stringify({ mut, nakedHits: nakedHits.length }));
    await naked.close();
  } finally {
    await browser.close();
  }
}

console.log(`\nsend-guard-gate: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
