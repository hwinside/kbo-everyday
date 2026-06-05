/**
 * 히어로샷 자동 배치 오케스트레이터.
 *
 * 파이프라인 (선수별, 실패 격리):
 *   1. detect      roster ∖ allowlist = 히어로 미보유 선수
 *   2. cross-check seed 사진(public/players/{kbo}.jpg) ↔ 네이버 후보 동일인 대조
 *                  → **≥2개 독립 도메인 후보 합치** 시에만 통과 (매핑 오류 1차 게이트)
 *   3. generate    PASS분만 generate-cutout.mjs(Gemini 3 Pro Image)로 cutout 생성 (non-dry)
 *   4. removebg    remove.bg HD → 투명 PNG                                      (non-dry)
 *   5. face-crop   face-crop.py v5 → 752x944 RGBA                              (non-dry)
 *   6. webp        cwebp lossless alpha                                        (non-dry)
 *   7. verify      생성물 webp ↔ seed 재대조 (생성 모델 hallucination 차단)    (non-dry)
 *   8. publish     players-hero/ + players-hero-v2/webp/ 복사 + allowlist append (non-dry)
 *   9. report      /tmp 결과 JSON (워크플로 PR/머지/Slack 단계가 소비)
 *
 * 안전 불변식: 검증 미통과 선수는 절대 자동 반영 안 됨 (skip + 플래그).
 *   세 게이트(cross-check / post-gen 재검증 / post-deploy QA) 중 하나라도 미통과 → prod 미노출.
 *
 * 사용:
 *   node scripts/hero-batch/run-batch.mjs --dry-run            # 검출+검증 판정만 (생성/커밋 X)
 *   node scripts/hero-batch/run-batch.mjs --dry-run --limit 5
 *   node scripts/hero-batch/run-batch.mjs --ids AQ010,AQ011 --dry-run
 *   node scripts/hero-batch/run-batch.mjs --limit 5           # 실배치 (생성+반영)
 *
 * env: GEMINI_API_KEY_HERO, NAVER_CLIENT_ID/SECRET, (실배치) REMOVE_BG_API_KEY
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { verifyIdentity } from "./verify-identity.mjs";
import { collectNaverCandidates } from "./collect-naver-candidates.mjs";
import { generateCutout } from "./generate-cutout.mjs";
import { startJob, finishJob } from "./admin-job-log.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const ROSTER = path.join(ROOT, "src/lib/constants/players-roster.json");
const ALLOWLIST = path.join(ROOT, "src/lib/constants/hero-approved-kboids.json");
const SEED_DIR = path.join(ROOT, "public/players");
const HERO_DIR = path.join(ROOT, "public/players-hero");
const V2_WEBP_DIR = path.join(ROOT, "public/players-hero-v2/webp");
const WORK_DIR = "/tmp/hero-batch";
const FACE_CROP_PY = path.join(__dirname, "face-crop.py");

// ── 교차검증 파라미터 (스펙 §4.1 — 단일 기준 0.85) ──
const NAVER_COUNT = 6; // 후보 수집 개수
const PASS_SIM = 0.85; // 후보 한 장이 "동일인"으로 인정되는 유사도
const FAIL_SIM = 0.5; // 최고 유사도가 이 값 미만 = 매핑 오류 의심 → 즉시 fail
const MIN_AGREE = 2; // 통과 조건: ≥2개 독립 *도메인* 후보가 PASS_SIM 이상 (오염 이미지 1장 통과 차단)
const POSTGEN_SIM = 0.85; // 생성물 재검증 임계값

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
 * 후보 link 에서 등록 도메인(eTLD+1 근사)을 추출 — 독립 소스 판별용.
 * 동일 이미지가 여러 사이트에 신디케이트돼도 *서로 다른 도메인* 2곳 이상이 일치해야 통과.
 */
const TWO_LEVEL_SUFFIX = new Set(["co", "or", "ne", "go", "pe", "re", "ac", "com", "net", "org"]);
export function registrableDomain(link) {
  let host;
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    return link; // 파싱 불가 시 원문을 고유키로 (보수적으로 별개 취급)
  }
  host = host.replace(/^www\./, "");
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const sld = labels[labels.length - 2];
  // 예: news.osen.co.kr → osen.co.kr (co 가 2-level suffix면 3 labels 사용)
  if (TWO_LEVEL_SUFFIX.has(sld)) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

/**
 * 순수 판정 함수 (API 의존 없음 — 단위 테스트 대상).
 * @param {Array<{similarity:number, domain:string}>} results
 * @returns {{verdict:'pass'|'fail'|'uncertain', maxSim:number, agree:number, domains:number}}
 *
 * 통과: PASS_SIM 이상인 후보가 ≥MIN_AGREE 건 AND 그 후보들이 ≥2개 독립 도메인에 분산.
 *       → 오염된 동일 이미지 1장만 일치해도 통과되던 구멍 차단 (삼순 NO-GO #2 반영).
 * 실패: 최고 유사도 < FAIL_SIM (아무도 닮지 않음 = seed 가 다른 사람일 의심).
 * 보류: 그 사이 (한 장만 일치 / 단일 도메인만 일치 / 애매) → skip + 플래그.
 */
export function decideCrossCheck(results) {
  if (!results.length) return { verdict: "uncertain", maxSim: 0, agree: 0, domains: 0 };
  const maxSim = Math.max(...results.map((r) => r.similarity));
  const agreers = results.filter((r) => r.similarity >= PASS_SIM);
  const domains = new Set(agreers.map((r) => r.domain));
  if (agreers.length >= MIN_AGREE && domains.size >= 2) {
    return { verdict: "pass", maxSim, agree: agreers.length, domains: domains.size };
  }
  if (maxSim < FAIL_SIM) return { verdict: "fail", maxSim, agree: agreers.length, domains: domains.size };
  return { verdict: "uncertain", maxSim, agree: agreers.length, domains: domains.size };
}

/** seed ↔ 네이버 후보 다중 대조 → decideCrossCheck. */
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
  if (!cands.length) {
    return { verdict: "uncertain", maxSim: 0, checked: 0, detail: "네이버 후보 0건" };
  }

  const results = [];
  for (const c of cands) {
    try {
      const r = await verifyIdentity(seed, c.link);
      results.push({ similarity: r.similarity, domain: registrableDomain(c.link) });
    } catch {
      // 후보 한 장 로드/대조 실패는 무시 (다른 후보로 판정)
    }
  }
  if (!results.length) return { verdict: "uncertain", maxSim: 0, checked: 0, detail: "후보 전부 대조 실패" };

  const d = decideCrossCheck(results);
  const sims = results.map((r) => `${r.similarity.toFixed(2)}@${r.domain}`).join(", ");
  const detail = `최고 ${d.maxSim.toFixed(2)} | PASS≥${PASS_SIM} 합치 ${d.agree}건/${d.domains}도메인 (${results.length}대조: ${sims})`;
  return { ...d, checked: results.length, detail };
}

/** 생성 → removebg → face-crop → webp → 재검증 → 산출물 경로 반환. (실패 시 throw) */
async function buildCutout(player) {
  const seed = path.join(SEED_DIR, `${player.kboId}.jpg`);
  const rawPng = path.join(WORK_DIR, `${player.kboId}.raw.png`);
  const tmpTransparent = path.join(WORK_DIR, `${player.kboId}.nobg.png`);
  const heroPng = path.join(WORK_DIR, `${player.kboId}.hero.png`);
  const webp = path.join(WORK_DIR, `${player.kboId}.webp`);
  fs.mkdirSync(WORK_DIR, { recursive: true });

  // 1. generate (Gemini 3 Pro Image)
  await generateCutout({
    srcJpg: seed,
    outPng: rawPng,
    name: player.name,
    team: player.team,
    position: player.position || "선수",
  });

  // 2. remove.bg HD
  await removeBg(rawPng, tmpTransparent);

  // 3. face-crop v5 (python)
  const cropOut = execFileSync("python3", [FACE_CROP_PY, tmpTransparent, heroPng, rawPng], {
    encoding: "utf8",
  }).trim();
  if (!cropOut.startsWith("OK:")) throw new Error(`face-crop: ${cropOut}`);

  // 4. cwebp lossless alpha
  execFileSync("cwebp", ["-quiet", "-q", "85", "-alpha_q", "100", "-exact", "-metadata", "none", heroPng, "-o", webp]);
  if (!fs.existsSync(webp)) throw new Error("cwebp produced no output");

  // 5. 생성물 ↔ seed 재검증 (hallucination 차단)
  const rv = await verifyIdentity(seed, webp);
  if (rv.similarity < POSTGEN_SIM) {
    fs.rmSync(webp, { force: true });
    throw new Error(`post-gen 재검증 실패 sim=${rv.similarity.toFixed(2)}<${POSTGEN_SIM} (${rv.reason})`);
  }
  return { webp, postGenSim: rv.similarity };
}

/** remove.bg HD — 투명 PNG. (1회 재시도) */
async function removeBg(inPng, outPng) {
  const apiKey = process.env.REMOVE_BG_API_KEY;
  if (!apiKey) throw new Error("REMOVE_BG_API_KEY missing");
  for (let attempt = 1; attempt <= 2; attempt++) {
    const form = new FormData();
    form.append("image_file", new Blob([fs.readFileSync(inPng)]), "raw.png");
    form.append("size", "hd");
    form.append("format", "png");
    const res = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: { "X-Api-Key": apiKey },
      body: form,
    });
    if (res.ok) {
      fs.writeFileSync(outPng, Buffer.from(await res.arrayBuffer()));
      return;
    }
    const status = res.status;
    if (status === 402) throw new Error("remove.bg 크레딧 부족(402)");
    if (attempt === 2) throw new Error(`remove.bg HTTP ${status}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** 산출물 반영: hero + v2/webp 복사 + allowlist append (메모리). */
function publish(player, webp, allowSet) {
  fs.mkdirSync(HERO_DIR, { recursive: true });
  fs.mkdirSync(V2_WEBP_DIR, { recursive: true });
  fs.copyFileSync(webp, path.join(HERO_DIR, `${player.kboId}.webp`));
  fs.copyFileSync(webp, path.join(V2_WEBP_DIR, `${player.kboId}.webp`));
  allowSet.add(String(player.kboId));
}

async function main() {
  const { dryRun, limit, ids } = parseArgs();
  let missing = loadMissing(ids);
  if (limit) missing = missing.slice(0, limit);

  console.log(
    `[hero-batch] 대상 ${missing.length}명 | dryRun=${dryRun} | PASS≥${PASS_SIM} 합치≥${MIN_AGREE}(독립 2도메인) FAIL<${FAIL_SIM}\n`
  );

  // 어드민 모니터링: 실배치 실행을 admin_job_logs 에 기록 (dry-run 은 제외).
  // GH Action 이라 Vercel cron job-logger 를 못 쓰므로 service_role REST 로 직접 기록.
  // CI 에서는 여기서 *열어만* 두고, 워크플로 마지막 finalize 단계가 PR/머지/QA/롤백
  // 최종 결과까지 반영해 닫는다 (삼순 NO-GO #1). 로컬 수동 실행(비 GH Action)은
  // finalize 단계가 없으므로 이 스크립트가 배치 결과로 직접 닫는다.
  const inCI = Boolean(process.env.GITHUB_ACTIONS);
  const logId = dryRun ? null : await startJob("hero-shot-batch");
  if (logId) {
    // finalize 가 배치 throw 후에도 찾을 수 있게 즉시 파일에 기록.
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORK_DIR, "job-log-id.txt"), String(logId));
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `log_id=${logId}\n`);
    }
  }

  try {
    const allowArr = JSON.parse(fs.readFileSync(ALLOWLIST, "utf8")).map(String);
    const allowSet = new Set(allowArr);

    const generated = []; // 실제 반영된 선수
    const passedGate = []; // cross-check 통과 (dry-run 집계용)
    const skipped = [];

    for (const p of missing) {
      const cc = await crossCheck(p);
      const tag = { pass: "✅PASS", fail: "❌FAIL", uncertain: "⚠️ HOLD" }[cc.verdict];
      console.log(`${tag} ${p.kboId} ${p.name}(${p.team}) — ${cc.detail}`);

      if (cc.verdict !== "pass") {
        skipped.push({ kboId: p.kboId, name: p.name, team: p.team, reason: `${cc.verdict}: ${cc.detail}` });
        continue;
      }
      passedGate.push({ kboId: p.kboId, name: p.name, team: p.team });
      if (dryRun) continue;

      // 실배치: 생성 → 재검증 → 반영
      try {
        const { webp, postGenSim } = await buildCutout(p);
        publish(p, webp, allowSet);
        generated.push({ kboId: p.kboId, name: p.name, team: p.team, postGenSim });
        console.log(`   → 생성·반영 완료 (post-gen sim=${postGenSim.toFixed(2)})`);
      } catch (e) {
        skipped.push({ kboId: p.kboId, name: p.name, team: p.team, reason: `generate/verify 실패: ${e.message}` });
        console.log(`   → ❌ ${e.message}`);
      }
    }

    // allowlist 갱신 (실배치 + 실제 생성분이 있을 때만)
    if (!dryRun && generated.length) {
      const sorted = [...allowSet].sort();
      fs.writeFileSync(ALLOWLIST, JSON.stringify(sorted, null, 2) + "\n");
      console.log(`\nallowlist 갱신: +${generated.length} → 총 ${sorted.length}명`);
    }

    const report = { dryRun, detected: missing.length, generated, passedGate, skipped, ts: process.env.BATCH_TS || null };
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORK_DIR, "report.json"), JSON.stringify(report, null, 2));

    console.log(
      `\n=== 결과: ${dryRun ? `통과 ${passedGate.length}` : `생성·반영 ${generated.length}`} / 보류·실패 ${skipped.length} ===`
    );
    console.log(`리포트: ${path.join(WORK_DIR, "report.json")}`);

    // GH Action 출력 (산출물 변경 여부 → PR/머지 게이트)
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `generated_count=${generated.length}\n`);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `skipped_count=${skipped.length}\n`);
    }

    // 어드민 한 줄 요약: 탐지 / 검증통과 / 생성·반영(=자동머지 대상) / 보류·플래그.
    // 보류·실패가 있으면 warning(애매한 건 알림), 전부 깔끔하면 success.
    // CI 에서는 닫지 않고 finalize 단계에 위임(PR/머지/QA/롤백까지 반영) — 삼순 NO-GO #1.
    if (!inCI) {
      const summary =
        `탐지 ${missing.length} · 검증통과 ${passedGate.length} · ` +
        `생성·반영 ${generated.length}(PR 자동머지 대상) · 보류·플래그 ${skipped.length}`;
      await finishJob(logId, skipped.length ? "warning" : "success", summary);
    }
  } catch (e) {
    // 배치 throw — finalize 가 BATCH_OUTCOME=failure 로 닫도록 사유를 report 에 남긴다.
    try {
      fs.mkdirSync(WORK_DIR, { recursive: true });
      const reportPath = path.join(WORK_DIR, "report.json");
      const prev = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : {};
      fs.writeFileSync(reportPath, JSON.stringify({ ...prev, batchError: `배치 실패: ${e.message}` }, null, 2));
    } catch {
      /* report 기록 실패는 무시 */
    }
    // 로컬(비 CI)은 finalize 단계가 없으므로 여기서 직접 error 로 닫는다.
    if (!inCI) await finishJob(logId, "error", `배치 실패: ${e.message}`, e.stack?.slice(0, 800));
    throw e;
  }
}

// 직접 실행 시에만 main (import 시엔 순수 함수만 노출 — 단위 테스트용)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
