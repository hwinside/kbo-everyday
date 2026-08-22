#!/usr/bin/env node
/**
 * 2026-08-21 라이브 채팅 QA 발송 사고 — 증거 감사 v3 (READ-ONLY, 삼순 8차 교정).
 * v2 대비 교정 사항:
 *   - `216` 은 insert/delete 실측이 아니라 durable 원장의 "발송 시도"(수신 판정 행) 합계다.
 *   - 수신 판정 행 자체의 PASS/FAIL 을 독립 집계한다 (127 PASS / 89 FAIL — timeout 85 · send 실패 4).
 *   - exact insert/delete 는 **미확인**으로 표기한다: 원장 JSON 은 cleanup 전에 저장됐고
 *     before/after 스냅샷이 없어 정확한 insert·delete 수를 증명할 수 없다(부재 명시).
 *   - "잔존 0" 은 감사 실행 시점 스냅샷 한정으로만 주장한다.
 * 오삭제 표기: 'QA UUID 한정 구조 · 오삭제 증거 없음' (v2 와 동일 — before 스냅샷 부재 명시).
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

const QA_DIR = process.env.QA_LEDGER_DIR ?? "/Users/harinclaw/.openclaw/workspace/state/qa";
const ENV_PATH = process.env.KBO_ENV_PATH ?? "/Users/harinclaw/Projects/kbo-everyday/.env.local";
for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── 1) durable artifact manifest (9개 고정 — 누락되면 FAIL)
const expected = [
  "ab-1274-mt2w0wbp.json", "ab-1274-mt2wg51y.json", "ab-1274-mt2x3b8z.json",
  "ab-1274-mt2xo6z8.json", "ab-1274-mt2y7t7h.json", "ab-1274-mt2yt03h.json",
  "ab-1274-mt2yzhy0.json", "ab-1274-mt2z4g2c.json", "paired-1274-mt2zcnoo.json",
];
const present = readdirSync(QA_DIR).filter((f) => /^(ab|paired)-1274-.*\.json$/.test(f)).sort();
const setEqual = JSON.stringify(present) === JSON.stringify([...expected].sort());
const manifest = [];
const stamps = new Set();
let sendAttempts = 0;
let recvPass = 0;
let recvFail = 0;
const failBreakdown = {};
for (const f of expected) {
  const path = `${QA_DIR}/${f}`;
  const raw = readFileSync(path);
  const j = JSON.parse(raw.toString("utf8"));
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const st = statSync(path);
  const recvRows = (j.results ?? []).filter((r) => /수신/.test(r.name));
  const prodRows = recvRows.filter((r) => r.name.startsWith("[PROD]"));
  const otherRows = recvRows.filter((r) => r.name.startsWith("[PREVIEW]") || r.name.startsWith("[A1]"));
  for (const r of recvRows) {
    if (r.ok) recvPass += 1;
    else {
      recvFail += 1;
      const key = /timeout/.test(r.detail ?? "") ? "timeout(수신 누락)" : /send/.test(r.detail ?? "") ? "send 실패" : "기타";
      failBreakdown[key] = (failBreakdown[key] ?? 0) + 1;
    }
  }
  stamps.add(j.stamp);
  sendAttempts += recvRows.length;
  manifest.push({
    file: f, sha256, mtime: st.mtime.toISOString(), stamp: j.stamp, gameId: j.gameId,
    prodSendAttempts: prodRows.length, previewOrA1SendAttempts: otherRows.length,
    recvPass: recvRows.filter((r) => r.ok).length, recvFail: recvRows.filter((r) => !r.ok).length,
  });
}
console.log("=== 1) durable artifact manifest (9개) ===");
console.log(`  set equality (expected 9 == present ${present.length}): ${setEqual ? "PASS" : "FAIL — present: " + present.join(",")}`);
for (const m of manifest)
  console.log(`  ${m.file} stamp=${m.stamp} game=${m.gameId} 발송시도(PROD=${m.prodSendAttempts}, PREVIEW/A1=${m.previewOrA1SendAttempts}) 수신 PASS/FAIL=${m.recvPass}/${m.recvFail} mtime=${m.mtime} sha256=${m.sha256.slice(0, 12)}…`);
console.log(`  stamps(${stamps.size}): ${[...stamps].join(", ")}`);
console.log(`  발송 시도 합계: ${sendAttempts}건 (수신 판정 행 기준 — insert 실측이 아니다)`);
console.log(`  수신 판정: ${recvPass} PASS / ${recvFail} FAIL — ${JSON.stringify(failBreakdown)}`);
console.log(`  ⚠️ exact insert/delete: 미확인 — 원장 JSON 은 cleanup 전 저장, before/after 스냅샷 부재.`);
console.log(`     timeout(수신 누락) 행도 insert 는 성공했을 수 있어 발송 시도 ${sendAttempts}건 전체를 노출 상한으로 간주한다.`);

// ── 2) DB 잔존 재조회 — 감사 시점 스냅샷 한정 판정
const ROOMS = ["game:20260821KTSK0", "game:20260821LGHH0", "game:20260821SSNC0", "game:20260821HTWO0", "game:20260821LTOB0"];
const snapshotAt = new Date().toISOString();
console.log(`\n=== 2) DB 잔존 재조회 (5개 방 × 9 stamps, 스냅샷 ${snapshotAt}) ===`);
let residual = 0;
let queryFailed = false;
const roomAudit = [];
for (const room of ROOMS) {
  // 서버측 exact-stamp 조건 (삼순 10차): 방 전체 like 후 클라이언트 필터가 아니라,
  // stamp 별 정확 prefix 를 서버 where 조건으로 걸어 방×stamp 단위로 조회한다.
  let roomResidual = 0;
  let roomErr = null;
  const perStamp = {};
  for (const stamp of stamps) {
    // query-guard: bounded -- 방 id + 해당 stamp 정확 prefix 서버측 조건, 기대 잔존 0 의 잔존감사 조회다.
    const { data, error, count } = await admin
      .from("chat_messages")
      .select("id,content,created_at", { count: "exact" })
      .eq("room_id", room)
      .like("content", `⚾ ${stamp}-%`)
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) { roomErr = error.message; break; }
    const n = count ?? (data ?? []).length;
    if (n > 0) {
      perStamp[stamp] = n;
      (data ?? []).slice(0, 5).forEach((r) => console.log(`      잔존! ${room} ${r.created_at} ${r.content}`));
    }
    roomResidual += n;
  }
  if (roomErr) { queryFailed = true; roomAudit.push({ room, error: roomErr }); console.log(`  ${room}: 조회 실패 ${roomErr}`); continue; }
  residual += roomResidual;
  roomAudit.push({ room, qaStampResidual: roomResidual, perStamp });
  console.log(`  ${room}: 9-stamp 서버측 exact-prefix 잔존 ${roomResidual}건`);
}
console.log(`  → 감사 스냅샷 잔존 합계: ${residual}건 ${queryFailed ? "(⚠️ 조회 실패 존재 — 판정 불능=FAIL)" : residual === 0 ? "✅ (이 시점 한정)" : "❌"}`);

// ── 3) QA 계정 잔존
console.log("\n=== 3) QA 계정 잔존 ===");
// query-guard: bounded -- qa 닉네임 prefix 4종 잔존검사, QA 계정은 런당 최대 4건이다.
const { data: profs, error: profErr } = await admin
  .from("profiles").select("id,nickname").or("nickname.like.qaAb%,nickname.like.qaPr%,nickname.like.qaChat%,nickname.like.qaA1%");
const profResidual = profErr ? null : profs.length;
if (profErr) { queryFailed = true; console.log(`  조회 실패: ${profErr.message}`); }
else console.log(`  QA 프로필 잔존: ${profs.length}건 ${profs.length === 0 ? "✅" : "❌ " + profs.map((p) => p.nickname).join(",")}`);

// ── 4) 사용자 메시지 — 정확 표기
console.log("\n=== 4) 사용자 메시지 오삭제 판정 표기 ===");
console.log("  판정: 'QA UUID 한정 구조 · 오삭제 증거 없음'");
console.log("  근거: 삭제 쿼리는 room_id=대상 방 AND user_id IN (QA 계정 uuid) 로 구조적으로 타 유저 행 미포함.");
console.log("  한계 명시: 삭제 전 before 스냅샷은 존재하지 않는다(부재). '오삭제 0 증명'이 아니라");
console.log("  '구조상 불가 + 오삭제를 시사하는 증거 없음'까지만 주장한다.");
for (const room of ROOMS) {
  const { count, error } = await admin
    .from("chat_messages").select("id", { count: "exact", head: true }).eq("room_id", room);
  if (error) { console.log(`  ${room}: 조회 실패 ${error.message}`); queryFailed = true; continue; }
  console.log(`  ${room}: 현재 총 ${count}건 (실유저 메시지 보존 관측)`);
}

// ── 5) 발송형 프로세스 0
console.log("\n=== 5) 발송형 프로세스 ===");
let procLines = [];
try {
  procLines = execSync("ps aux | grep -E 'e2e-1274|e2e-1256' | grep -v grep", { encoding: "utf8" }).trim().split("\n").filter(Boolean);
} catch { procLines = []; }
console.log(`  실행 중: ${procLines.length}건 ${procLines.length === 0 ? "✅" : "❌"}`);
procLines.forEach((l) => console.log(`    ${l}`));

// ── 결과 저장 (durable)
const verdictPass = setEqual && !queryFailed && residual === 0 && profResidual === 0 && procLines.length === 0;
const out = {
  generatedAt: snapshotAt,
  manifest, stamps: [...stamps],
  sendAttempts,
  recvPass, recvFail, failBreakdown,
  exactInsertDelete: "미확인 — 원장 JSON 이 cleanup 전 저장됨 · before/after 스냅샷 부재. 발송 시도 전체를 노출 상한으로 간주.",
  rooms: roomAudit,
  qaResidualAtSnapshot: residual,
  qaProfileResidual: profResidual,
  userMessageVerdict: "QA UUID 한정 구조 · 오삭제 증거 없음 (before 스냅샷 부재 명시)",
  sendProcessesRunning: procLines.length,
  verdict: verdictPass
    ? `발송 시도 ${sendAttempts} / exact insert·delete 미확인 / ${snapshotAt} 감사 스냅샷 잔존 0`
    : "FAIL/UNVERIFIED",
};
writeFileSync(`${QA_DIR}/incident-20260821-audit3-result.json`, JSON.stringify(out, null, 2));
console.log(`\n=== 판정 ===\n  ${out.verdict}\n  (result → ${QA_DIR}/incident-20260821-audit3-result.json)`);
process.exit(verdictPass ? 0 : 1);
