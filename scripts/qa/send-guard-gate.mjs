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

// ── D. write-target 단일 결속 (삼순 9차: guard room 과 실제 write room 의 완전 일치 강제)
{
  const w = (b, g) => evaluateChatWrite(b, g);
  check("[write-bind] guarded room 과 완전 일치만 허용", w("qa-fixture:abcd", "qa-fixture:abcd").reason === WRITE_REASONS.OK);
  check("[write-bind] 실경기방 write 는 guarded room 과 불일치로 차단", w("game:20260821LGHH0", "qa-fixture:abcd").reason === WRITE_REASONS.WRITE_TARGET_MISMATCH);
  check("[write-bind] guarded room 부재 시 모든 write 차단", w("game:x", null).reason === WRITE_REASONS.GUARD_ROOM_MISSING);
  check("[write-bind] body room 판정 불능은 차단(fail-close)", w(null, "qa-fixture:abcd").reason === WRITE_REASONS.BODY_ROOM_UNRESOLVED);
  check("[write-bind] 배열 insert 혼합 room 은 판정 불능(null)", roomIdOfChatInsertBody(JSON.stringify([{ room_id: "r1" }, { room_id: "r2" }])) === null);
  check("[write-bind] 배열 insert 단일 room 은 그 room", roomIdOfChatInsertBody(JSON.stringify([{ room_id: "r1" }, { room_id: "r1" }])) === "r1");
  // 하니스 결속 실재 확인: 발송형 하니스 4개 전부 newContext 직후 인터셉터를 설치하는가 (구조 grep)
  const HARNESSES = ["e2e-1274-ab-measure.mjs", "e2e-1274-paired.mjs", "e2e-1274-chat-preview.mjs", "e2e-1256-chat-realtime.mjs"];
  for (const h of HARNESSES) {
    const src2 = readFileSync(join(HERE, h), "utf8");
    check(`[write-bind] ${h} 가 installChatWriteInterceptor(context, ROOM_ID) 결속`, /installChatWriteInterceptor\(context, ROOM_ID\)/.test(src2));
  }
  // actual room mutant: 인터셉터가 route.abort 로 실제 차단하는지 — Playwright 계약을 스텁 route 로 실측
  const { installChatWriteInterceptor } = await import("./send-guard.mjs");
  const calls = [];
  const fakeContext = {
    route: async (_pattern, handler) => { fakeContext._handler = handler; },
  };
  await installChatWriteInterceptor(fakeContext, "qa-fixture:abcd", (info) => calls.push(info));
  const mkRoute = (room) => ({
    request: () => ({ method: () => "POST", postData: () => JSON.stringify({ room_id: room }) }),
    continue: () => { mkRoute.last = "continue"; },
    abort: (r) => { mkRoute.last = `abort:${r}`; },
  });
  const r1 = mkRoute("game:20260821LGHH0");
  await fakeContext._handler(r1);
  check("[write-bind actual] 실경기방 POST 는 abort(blockedbyclient) 실차단", mkRoute.last === "abort:blockedbyclient" && calls.at(-1)?.reason === WRITE_REASONS.WRITE_TARGET_MISMATCH);
  const r2 = mkRoute("qa-fixture:abcd");
  await fakeContext._handler(r2);
  check("[write-bind actual] guarded room POST 는 continue", mkRoute.last === "continue");
}

console.log(`\nsend-guard-gate: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
