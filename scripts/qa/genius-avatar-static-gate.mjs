#!/usr/bin/env node
/**
 * 야잘알봇 마스코트 자산 정적 게이트 — CI 자동 결속용(브라우저·계정·env 무의존).
 *
 * 왜 별도 파일인가(삼순 NO-GO 2026-08-03):
 * `qa:genius-avatar`(genius-avatar-ui-smoke.mjs)는 `--static-only` 경로가 있지만
 * 모듈 최상위에서 `createClient(SUPABASE_URL, SERVICE_ROLE)` 를 만들고 .env.local 을
 * 읽는다. 그래서 CI/prebuild 처럼 시크릿이 없는 환경에서는 정적 검사에 도달하기도 전에
 * 죽는다 — 이것이 저알파 회귀 게이트가 prebuild/required workflow 어디에도 결속되지
 * 못한 실제 원인이었다. 즉 "회귀가 다시 들어와도 CI 는 GREEN" 상태였다.
 *
 * 이 게이트가 잠그는 계약 (ui-smoke 와 동일한 공용 모듈을 쓴다):
 *   ① alpha cutoff 계약: alpha<=8 은 비가시, alpha>8 부터 가시
 *   ② 실제 배포 PNG 의 알파 bbox 가 가로·세로 모두 >= 0.98
 *      (투명 테두리가 넓으면 실제 캐릭터가 작게 렌더돼 "아바타가 안 보임" 으로 돌아간다)
 *   ③ 자산이 알파 채널을 실제로 가지고 있고 가시 픽셀이 0 이 아님
 *
 * 검증력 증명: `--selftest` 는 저알파 자산·cutoff 무력화를 주입해 RED 가 되는지 확인한다.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  GENIUS_ALPHA_CUTOFF,
  measureVisibleAlphaBounds,
} from "./genius-avatar-alpha-contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSET = path.join(HERE, "../../public/mascot/yajalal-avatar.png");
// ui-smoke 와 같은 값. 두 곳이 갈라지면 정적/브라우저 판정이 어긋난다.
const MIN_ALPHA_BBOX_RATIO = 0.98;

let pass = 0;
const fails = [];
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// ── ① cutoff 계약 ───────────────────────────────────────────────────────────
function checkCutoffContract(cutoff = GENIUS_ALPHA_CUTOFF) {
  // 2px: alpha=1(비가시여야 함), alpha=9(가시여야 함)
  const fixture = Buffer.from([0, 0, 0, 1, 0, 0, 0, 9]);
  const meta = { width: 2, height: 1, channels: 4 };
  const strict = measureVisibleAlphaBounds(fixture, meta, cutoff);
  const legacy = measureVisibleAlphaBounds(fixture, meta, 0);
  ok(
    `cutoff 계약: alpha<=${GENIUS_ALPHA_CUTOFF} 비가시 / 초과분만 가시`,
    strict?.minX === 1 && strict?.maxX === 1 && legacy?.minX === 0 && legacy?.maxX === 1,
    `strict=${JSON.stringify(strict)} legacy=${JSON.stringify(legacy)}`,
  );
  ok("cutoff 상수가 8", GENIUS_ALPHA_CUTOFF === 8, String(GENIUS_ALPHA_CUTOFF));
}

// ── ②③ 실제 배포 자산 ───────────────────────────────────────────────────────
async function checkAsset(assetPath = ASSET, cutoff = GENIUS_ALPHA_CUTOFF) {
  ok("마스코트 자산 존재", existsSync(assetPath), assetPath);
  if (!existsSync(assetPath)) return;

  const asset = await sharp(assetPath).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const bounds = measureVisibleAlphaBounds(asset.data, asset.info, cutoff);
  ok(`가시 픽셀 존재(alpha>${cutoff})`, bounds != null);
  if (!bounds) return;

  const wRatio = (bounds.maxX - bounds.minX + 1) / asset.info.width;
  const hRatio = (bounds.maxY - bounds.minY + 1) / asset.info.height;
  ok(
    `알파 bbox 가로 비율 >= ${MIN_ALPHA_BBOX_RATIO}`,
    wRatio >= MIN_ALPHA_BBOX_RATIO,
    wRatio.toFixed(4),
  );
  ok(
    `알파 bbox 세로 비율 >= ${MIN_ALPHA_BBOX_RATIO}`,
    hRatio >= MIN_ALPHA_BBOX_RATIO,
    hRatio.toFixed(4),
  );
  console.log(
    `     (자산 ${asset.info.width}×${asset.info.height}, bbox ${wRatio.toFixed(3)}×${hRatio.toFixed(3)})`,
  );
}

// ── 검증력 증명(--selftest) ─────────────────────────────────────────────────
// 게이트가 실제로 결함을 잡는지 스스로 증명한다. 통과해버리면 exit 1.
async function selftest() {
  console.log("[selftest] 결함주입이 RED 를 만드는지 확인\n");
  let bad = 0;

  // (a) 투명 테두리가 넓은 저알파 자산 → bbox 비율 미달이어야 한다
  const size = 100;
  const inner = 40; // 가운데 40px 만 불투명 → 비율 0.40
  const buf = Buffer.alloc(size * size * 4, 0);
  for (let y = (size - inner) / 2; y < (size + inner) / 2; y += 1) {
    for (let x = (size - inner) / 2; x < (size + inner) / 2; x += 1) {
      const i = (y * size + x) * 4;
      buf[i] = 255; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255;
    }
  }
  const b = measureVisibleAlphaBounds(buf, { width: size, height: size, channels: 4 });
  const ratio = (b.maxX - b.minX + 1) / size;
  if (ratio >= MIN_ALPHA_BBOX_RATIO) {
    console.log(`  ❌ 저알파 자산이 통과함(ratio=${ratio})`);
    bad += 1;
  } else {
    console.log(`  ✅ 투명 테두리 자산 RED (ratio=${ratio.toFixed(2)} < ${MIN_ALPHA_BBOX_RATIO})`);
  }

  // (b) cutoff 를 0 으로 무력화하면 alpha=1 잡티가 가시로 잡혀 계약이 깨져야 한다
  const fixture = Buffer.from([0, 0, 0, 1, 0, 0, 0, 9]);
  const meta = { width: 2, height: 1, channels: 4 };
  const broken = measureVisibleAlphaBounds(fixture, meta, 0);
  if (broken?.minX === 1) {
    console.log("  ❌ cutoff=0 인데도 alpha=1 을 비가시로 처리함");
    bad += 1;
  } else {
    console.log("  ✅ cutoff 무력화 시 계약 위반 검출 (alpha=1 이 가시로 잡힘)");
  }

  // (c) 전부 투명한 자산 → 가시 픽셀 0 으로 검출돼야 한다
  const empty = Buffer.alloc(4 * 4 * 4, 0);
  const none = measureVisibleAlphaBounds(empty, { width: 4, height: 4, channels: 4 });
  if (none !== null) {
    console.log("  ❌ 전투명 자산에서 가시 픽셀을 찾았다고 보고함");
    bad += 1;
  } else {
    console.log("  ✅ 전투명 자산 RED (가시 픽셀 0 검출)");
  }

  console.log(bad === 0 ? "\n[selftest] PASS — 3/3 결함 검출" : `\n[selftest] FAIL ${bad}`);
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  await selftest();
} else {
  console.log("야잘알봇 마스코트 정적 게이트 (브라우저·계정·env 무의존)\n");
  checkCutoffContract();
  await checkAsset();
  console.log(
    fails.length === 0 ? `\nPASS — ${pass}/${pass}` : `\nFAIL ${fails.length} / exit 1`,
  );
  process.exit(fails.length === 0 ? 0 : 1);
}
