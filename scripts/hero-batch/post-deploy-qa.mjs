/**
 * 배포 후 QA + 자동 롤백 판정 (스펙 §4.1 3번째 게이트).
 *
 * 자동 머지·배포 *후* prod 에서 새 히어로가 (1) 200 으로 서빙되고 (2) seed 와 동일인인지
 * 재대조한다. 실패분은 **allowlist 에서 제거**(로컬 파일 수정) → 워크플로가 롤백 PR 을
 * 생성·자동머지하게 한다.
 *
 *   node scripts/hero-batch/post-deploy-qa.mjs --ids AQ010,AQ011
 *   node scripts/hero-batch/post-deploy-qa.mjs           # /tmp/hero-batch/report.json 의 generated 사용
 *
 * env: PROD_BASE(기본 https://keubo.fan), GEMINI_API_KEY_HERO
 * 출력: GITHUB_OUTPUT 에 rolled_back_count, 그리고 allowlist 파일을 in-place 수정.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { verifyIdentity } from "./verify-identity.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const ALLOWLIST = path.join(ROOT, "src/lib/constants/hero-approved-kboids.json");
const SEED_DIR = path.join(ROOT, "public/players");
const PROD_BASE = process.env.PROD_BASE || "https://keubo.fan";
const QA_SIM = 0.85;
// 배포/캐시 전파 대기 — 단발 체크는 false rollback 위험(삼순 NO-GO #3).
// asset 200 을 timeout 까지 polling 한 뒤에야 동일인 재검증/롤백 판정.
const DEPLOY_TIMEOUT_MS = Number(process.env.QA_DEPLOY_TIMEOUT_MS) || 360000; // 6분
const POLL_INTERVAL_MS = Number(process.env.QA_POLL_INTERVAL_MS) || 15000; // 15초

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * url 이 200 으로 서빙될 때까지 polling. 성공 시 {ok:true, status, buf}.
 * timeout 까지 한 번도 200 이 아니면 {ok:false, status} (= 진짜 미전파/실패 → 롤백).
 */
async function fetchUntilLive(url) {
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  let lastStatus = 0;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "kbo-hero-qa" } });
      lastStatus = res.status;
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        return { ok: true, status: res.status, buf, attempt };
      }
    } catch (e) {
      lastStatus = `err:${e.message}`;
    }
    if (Date.now() + POLL_INTERVAL_MS >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, status: lastStatus, attempt };
}

function targetIds() {
  const a = process.argv.slice(2);
  const i = a.indexOf("--ids");
  if (i >= 0 && a[i + 1]) return a[i + 1].split(",").map((s) => s.trim());
  try {
    const rep = JSON.parse(fs.readFileSync("/tmp/hero-batch/report.json", "utf8"));
    return (rep.generated || []).map((g) => String(g.kboId));
  } catch {
    return [];
  }
}

async function main() {
  const ids = targetIds();
  if (!ids.length) {
    console.log("QA 대상 없음 — skip.");
    return;
  }
  console.log(`[post-deploy QA] 대상 ${ids.length}명 @ ${PROD_BASE}\n`);

  const rollback = [];
  for (const kbo of ids) {
    const url = `${PROD_BASE}/players-hero/${kbo}.webp`;
    let reason = "";
    // 1) asset 200 polling (전파 지연은 대기, timeout 까지 미전파면 진짜 실패)
    const live = await fetchUntilLive(url);
    if (!live.ok) {
      reason = `미전파/HTTP ${live.status} (${Math.round(DEPLOY_TIMEOUT_MS / 1000)}s 내 200 실패, ${live.attempt}회 시도)`;
    } else {
      // 2) 200 확인 후에만 동일인 재검증
      const tmp = `/tmp/hero-batch/.qa.${kbo}.webp`;
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.writeFileSync(tmp, live.buf);
      const seed = path.join(SEED_DIR, `${kbo}.jpg`);
      if (fs.existsSync(seed)) {
        try {
          const r = await verifyIdentity(seed, tmp);
          if (r.similarity < QA_SIM) reason = `재대조 sim=${r.similarity.toFixed(2)}<${QA_SIM}`;
        } catch (e) {
          reason = `재대조 실패: ${e.message}`;
        }
      }
    }
    if (reason) {
      console.log(`❌ ${kbo} — ${reason} → 롤백 대상`);
      rollback.push(kbo);
    } else {
      console.log(`✅ ${kbo} — 200 + 재대조 OK`);
    }
  }

  if (rollback.length) {
    const allow = JSON.parse(fs.readFileSync(ALLOWLIST, "utf8")).map(String);
    const rb = new Set(rollback);
    const kept = allow.filter((id) => !rb.has(id)).sort();
    fs.writeFileSync(ALLOWLIST, JSON.stringify(kept, null, 2) + "\n");
    console.log(`\nallowlist 롤백: -${rollback.length} (${rollback.join(",")}) → 총 ${kept.length}명`);
  } else {
    console.log("\n전원 통과 — 롤백 없음.");
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `rolled_back_count=${rollback.length}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `rolled_back_ids=${rollback.join(",")}\n`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
