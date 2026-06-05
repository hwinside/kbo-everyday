/**
 * 히어로샷 자동 배치 오케스트레이터.
 *
 * 파이프라인 (선수별, 실패 격리):
 *   1. detect      roster ∖ allowlist = 히어로 미보유 선수
 *   2. cross-check seed 사진(public/players/{kbo}.jpg) ↔ 네이버 후보 다수결 동일인 대조
 *                  → 매핑 오류 1차 게이트 (가나쿠보 osen 사고 차단)
 *   3. generate    PASS분만 phase2-pipeline.sh 로 cutout 생성        (non-dry)
 *   4. verify      생성물 ↔ seed 재대조 (생성 모델 hallucination 차단) (non-dry)
 *   5. publish     copy-to-hero + allowlist append                     (non-dry)
 *   6. report      Slack 요약(생성 N / skip M + 사유)
 *
 * 안전 불변식: 검증 미통과 선수는 절대 자동 반영 안 됨 (skip + 플래그).
 *
 * 사용:
 *   node scripts/hero-batch/run-batch.mjs --dry-run            # 검출+검증 판정만 (생성/커밋 X)
 *   node scripts/hero-batch/run-batch.mjs --dry-run --limit 5
 *   node scripts/hero-batch/run-batch.mjs --ids AQ010,AQ011 --dry-run
 *   node scripts/hero-batch/run-batch.mjs                      # 실배치 (생성+반영)
 *
 * env: GEMINI_API_KEY(=HERO 키), NAVER_CLIENT_ID/SECRET, (실배치 시) REMOVE_BG_API_KEY
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { verifyIdentity } from "./verify-identity.mjs";
import { collectNaverCandidates } from "./collect-naver-candidates.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const ROSTER = path.join(ROOT, "src/lib/constants/players-roster.json");
const ALLOWLIST = path.join(ROOT, "src/lib/constants/hero-approved-kboids.json");
const SEED_DIR = path.join(ROOT, "public/players");

// 교차검증 파라미터
const NAVER_COUNT = 6; // 후보 수집 개수 (로드 실패 대비 여유)
const PASS_SIM = 0.85; // 통과: 네이버 후보 중 최고 유사도가 이 값 이상 (강한 독립 확증 1건)
const FAIL_SIM = 0.5; // 실패: 최고 유사도가 이 값 미만 = 매핑 오류 의심
// (PASS_SIM~FAIL_SIM 사이 = uncertain → 보류 + 플래그)

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag) => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    dryRun: a.includes("--dry-run"),
    limit: get("--limit") ? Number(get("--limit")) : undefined,
    ids: get("--ids") ? get("--ids").split(",").map((s) => s.trim()) : undefined,
  };
}

function loadMissing(ids) {
  const roster = JSON.parse(fs.readFileSync(ROSTER, "utf8"));
  const allow = new Set(JSON.parse(fs.readFileSync(ALLOWLIST, "utf8")).map(String));
  let missing = roster.filter((p) => !allow.has(String(p.kboId)));
  if (ids) missing = missing.filter((p) => ids.includes(String(p.kboId)));
  return missing;
}

/**
 * seed 사진을 네이버 후보들과 대조. 최고 유사도로 판정 (네이버 노이즈 내성).
 * 원리: 네이버 상위 결과는 해당 선수가 지배적 → seed 가 진짜 그 선수면 ≥1건 강하게 일치.
 *       0건 일치(최고 유사도 낮음) = seed 가 다른 사람일 의심 (가나쿠보 osen 사고형).
 * @returns {Promise<{verdict:'pass'|'fail'|'uncertain', maxSim:number, checked:number, detail:string}>}
 */
async function crossCheck(player) {
  const seed = path.join(SEED_DIR, `${player.kboId}.jpg`);
  if (!fs.existsSync(seed)) {
    return { verdict: "fail", maxSim: 0, checked: 0, detail: "seed 사진 없음" };
  }
  let cands;
  try {
    cands = await collectNaverCandidates(player.name, { team: player.team, count: NAVER_COUNT });
  } catch (e) {
    return { verdict: "uncertain", maxSim: 0, checked: 0, detail: `네이버 수집 실패: ${e.message}` };
  }
  if (cands.length === 0) {
    return { verdict: "uncertain", maxSim: 0, checked: 0, detail: "네이버 후보 0건" };
  }

  let maxSim = 0;
  let checked = 0;
  const sims = [];
  for (const c of cands) {
    try {
      const r = await verifyIdentity(seed, c.link);
      checked++;
      sims.push(r.similarity.toFixed(2));
      if (r.similarity > maxSim) maxSim = r.similarity;
    } catch {
      // 후보 한 장 로드/대조 실패는 무시 (다른 후보로 판정)
    }
  }
  const detail = `네이버 최고유사도 ${maxSim.toFixed(2)} (${checked}건 대조: ${sims.join(",")})`;
  if (checked === 0) return { verdict: "uncertain", maxSim, checked, detail: "후보 전부 대조 실패" };
  if (maxSim >= PASS_SIM) return { verdict: "pass", maxSim, checked, detail };
  if (maxSim < FAIL_SIM) return { verdict: "fail", maxSim, checked, detail };
  return { verdict: "uncertain", maxSim, checked, detail };
}

async function main() {
  const { dryRun, limit, ids } = parseArgs();
  let missing = loadMissing(ids);
  if (limit) missing = missing.slice(0, limit);

  console.log(`[hero-batch] 대상 ${missing.length}명 | dryRun=${dryRun} | PASS_SIM≥${PASS_SIM} FAIL_SIM<${FAIL_SIM} (네이버 ${NAVER_COUNT}장)\n`);

  const passed = [];
  const skipped = [];

  for (const p of missing) {
    const cc = await crossCheck(p);
    const tag = { pass: "✅PASS", fail: "❌FAIL", uncertain: "⚠️ UNCERTAIN" }[cc.verdict];
    console.log(`${tag} ${p.kboId} ${p.name}(${p.team}) — ${cc.detail}`);
    if (cc.verdict === "pass") passed.push({ ...p, cc });
    else skipped.push({ kboId: p.kboId, name: p.name, team: p.team, reason: `${cc.verdict}: ${cc.detail}` });
  }

  console.log(`\n=== 교차검증 결과: 통과 ${passed.length} / 보류·실패 ${skipped.length} ===`);

  if (dryRun) {
    console.log("\n[dry-run] 생성/반영/머지 생략. 통과 대상:");
    passed.forEach((p) => console.log(`  - ${p.kboId} ${p.name}`));
    // 결과를 JSON 으로도 출력 (워크플로 후속 단계용)
    fs.writeFileSync("/tmp/hero-batch-dryrun.json", JSON.stringify({ passed, skipped }, null, 2));
    console.log("\n결과 저장: /tmp/hero-batch-dryrun.json");
    return;
  }

  // === 실배치: 생성 → 재검증 → 반영 ===
  // (phase2-pipeline.sh 로 cutout 생성, copy-to-hero 로 반영, allowlist append)
  // CI 실행성 검증(face-crop) 완료 후 활성화. 현 단계는 dry-run 으로 검증 게이트만 운영.
  console.log("\n[실배치] generate/verify/publish 단계는 phase2-pipeline CI 검증 후 활성화 예정.");
  console.log("통과 대상을 phase2-todo 형식으로 출력:");
  const todo = passed.map((p) => ({ kboId: p.kboId, name: p.name, teamName: p.team, position: p.position }));
  fs.writeFileSync("/tmp/hero-batch-todo.json", JSON.stringify(todo, null, 2));
  console.log(`  ${todo.length}건 → /tmp/hero-batch-todo.json`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
