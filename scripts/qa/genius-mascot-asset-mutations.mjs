#!/usr/bin/env node
/**
 * 마스코트 **자산 게이트**의 검출력 증명 — 실제 결함 주입 (삼순 2026-08-17).
 *
 * 🔴 왜 필요한가: `--selftest` 는 임계값을 반전시키거나 강제로 false 를 넣는 방식이라
 *    "이 assertion 이 RED 를 낼 수 있다"만 보여줄 뿐, **진짜 결함이 들어왔을 때 잡히는지**는
 *    증명하지 못한다. 임계값 반전은 측정 코드가 통째로 틀려 있어도 통과한다.
 *    여기서는 배포될 자산·manifest 를 **실제로 훼손**하고 게이트가 RED 인지 확인한 뒤
 *    반드시 원복한다.
 *
 * 실행: node scripts/qa/genius-mascot-asset-mutations.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const DIR = "public/mascot/motion";
const MANIFEST = `${DIR}/DERIVED.json`;
const LEDGER = "scripts/assets/mascot-motion-SOURCES.sha256";

// 원복 대상 — 훼손 전 바이트를 통째로 들고 있는다.
const BACKUP = new Map();
// 실행 전 원본 바이트 — 마지막에 "훼손이 남았나"를 판정하는 기준점.
const PRISTINE = new Map();
function stash(file) {
  if (!PRISTINE.has(file)) PRISTINE.set(file, fs.readFileSync(file));
  if (!BACKUP.has(file)) BACKUP.set(file, fs.readFileSync(file));
}
function restore() {
  for (const [file, buf] of BACKUP) fs.writeFileSync(file, buf);
  BACKUP.clear();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { restore(); process.exit(130); });
}
process.on("uncaughtException", (err) => { restore(); throw err; });

/** 게이트를 돌리고 RED 인지 + 기대한 assertion 이 실패했는지 본다. */
function runGate(cmd, args, expect) {
  const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const red = res.status !== 0;
  // "그냥 실패"가 아니라 **의도한 축**이 실패해야 한다. 다른 이유로 죽으면 검출력 증명이 아니다.
  const hit = expect ? out.includes(expect) : true;
  return { red, hit, out };
}
const visual = () => runGate("npx", ["tsx", "scripts/qa/genius-mascot-visual-qa.mjs"]);
const visualExpect = (needle) =>
  runGate("npx", ["tsx", "scripts/qa/genius-mascot-visual-qa.mjs"], needle);
const buildCheck = (needle) =>
  runGate("python3", ["scripts/assets/build-mascot-motion.py", "--check"], needle);

/** WebP 애니메이션의 한 프레임에 실제로 구멍을 뚫는다(알파 0). */
async function punchHole(clip, frameIdx, box) {
  stash(clip);
  const buf = fs.readFileSync(clip);
  const meta = await sharp(buf, { pages: 1 }).metadata();
  const { width: w, height: h } = meta;
  const raw = await sharp(buf, { animated: true }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const pages = Math.round(raw.info.height / h);
  const data = Buffer.from(raw.data);
  const idx = Math.min(frameIdx, pages - 1);
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      data[((idx * h + y) * w + x) * 4 + 3] = 0;   // 알파 0 = 속이 뚫림
    }
  }
  await writeAnimated(clip, data, w, h, pages);
}

/** raw RGBA 페이지 스택 → 애니메이션 WebP. sharp 버전별 옵션차이를 흡수한다. */
async function writeAnimated(clip, data, w, h, pages) {
  // ⚠️ `pages` 를 입력 옵션으로 넘기면 sharp 0.34 에서 `n-pages not found` 로 죽는다.
  //    **raw 안에 `pageHeight` 만** 넣어야 애니메이션으로 써진다(실측으로 확인).
  const tmp = `${clip}.mut.webp`;
  await sharp(data, { raw: { width: w, height: h * pages, channels: 4, pageHeight: h } })
    .webp({ quality: 62, effort: 4, loop: 0, delay: new Array(pages).fill(83) })
    .toFile(tmp);
  fs.renameSync(tmp, clip);
}

/** 전 프레임을 첫 프레임으로 덮어 **정지 애니메이션**을 만든다(idle 결함). */
async function freezeClip(clip) {
  stash(clip);
  const buf = fs.readFileSync(clip);
  const meta = await sharp(buf, { pages: 1 }).metadata();
  const { width: w, height: h } = meta;
  const raw = await sharp(buf, { animated: true }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const pages = Math.round(raw.info.height / h);
  const first = raw.data.subarray(0, w * h * 4);
  const data = Buffer.alloc(w * h * 4 * pages);
  for (let p = 0; p < pages; p += 1) first.copy(data, p * w * h * 4);
  await writeAnimated(clip, data, w, h, pages);
}

function patchManifest(mutate) {
  stash(MANIFEST);
  const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  mutate(m);
  fs.writeFileSync(MANIFEST, `${JSON.stringify(m, null, 1)}\n`);
}

const results = [];
async function mutation(name, apply, gate, expect) {
  process.stdout.write(`  … ${name}\n`);
  try {
    await apply();
    const { red, hit, out } = gate(expect);
    results.push({ name, red, hit, out });
  } finally {
    restore();
  }
}

// ── 자산 자체를 훼손한다 ────────────────────────────────────────────────
await mutation(
  "A1 cheerC f17 몸통에 20x20 구멍 (키잉이 몸을 파먹은 상태 재현)",
  () => punchHole(`${DIR}/cheerC.webp`, 17, { x: 60, y: 95, w: 20, h: 20 }),
  visualExpect,
  "구멍 측정치 = manifest 기록",
);
await mutation(
  "A2 pitching 전 프레임 고정 (호흡 idle 재현)",
  () => freezeClip(`${DIR}/pitching.webp`),
  visualExpect,
  "실루에 변화량",
);
await mutation(
  "A3 클립 1종 삭제 (파서가 헛돌면 fail-close)",
  () => { stash(`${DIR}/swing.webp`); fs.unlinkSync(`${DIR}/swing.webp`); },
  visual,
  null,
);

// ── manifest 를 훼손한다 (게이트가 여기서 임계값·측정치를 읽는다) ─────────
await mutation(
  "M1 defect_px 를 300 으로 위조 (키잉 결함 은폐 시도)",
  () => patchManifest((m) => { m.clips.cheerC.defect_px = 300; }),
  visualExpect,
  "키잉 구멍",
);
await mutation(
  "M2 overfill_px 를 500 으로 위조 (정상 음공간 메움)",
  () => patchManifest((m) => { m.clips.excited.overfill_px = 500; }),
  visualExpect,
  "과채움",
);
await mutation(
  "M3 dropped_persist_frames 를 20 으로 위조 (소품 삭제)",
  () => patchManifest((m) => { m.clips.bored.dropped_persist_frames = 20; }),
  visualExpect,
  "삭제된 조각의 연속 지속",
);
await mutation(
  "M4 hole_px 를 0 이 아닌 값으로 위조 (자산↔manifest 불일치)",
  () => patchManifest((m) => { m.clips.thinking.hole_px = 77; }),
  visualExpect,
  "구멍 측정치 = manifest 기록",
);
await mutation(
  "M5 edge_run 을 잘림 있음으로 위조",
  () => patchManifest((m) => { m.clips.cheer.edge_run.top = 40; }),
  visualExpect,
  "edge-run 0",
);
await mutation(
  "M6 임계값 자체를 풀어버림 (hole_px_max 9999) — build --check 가 잡아야 한다",
  () => patchManifest((m) => { m.params.hole_px_max = 9999; }),
  buildCheck,
  "DERIVED.json",
);
await mutation(
  "M7 manifest 에서 클립 1종 삭제 — build --check 가 잡아야 한다",
  () => patchManifest((m) => { delete m.clips.headspin; }),
  buildCheck,
  "DERIVED.json",
);

// ── 원본 해시 대장을 훼손한다 ──────────────────────────────────────────
await mutation(
  "L1 대장 삭제 (원본 증명 불가 → 통과시키면 안 된다)",
  () => { stash(LEDGER); fs.unlinkSync(LEDGER); },
  buildCheck,
  "대장이 없다",
);
await mutation(
  "L2 대장 해시 위조 (다른 원본으로 바꿔치기)",
  () => {
    stash(LEDGER);
    const lines = fs.readFileSync(LEDGER, "utf8").split("\n").map((ln) =>
      ln.startsWith("#") || !ln.includes("  ") ? ln : `${"0".repeat(64)}${ln.slice(64)}`);
    fs.writeFileSync(LEDGER, lines.join("\n"));
  },
  buildCheck,
  "해시가 대장과 다르다",
);

restore();

// ── 결과 ────────────────────────────────────────────────────────────────
console.log("");
let failed = 0;
for (const r of results) {
  const ok = r.red && r.hit;
  if (!ok) failed += 1;
  console.log(`  ${ok ? "✅" : "❌"} ${r.name}` +
    (ok ? "" : ` — ${r.red ? "다른 이유로 실패(의도한 축이 아님)" : "게이트가 통과시켰다"}`));
  if (!ok) console.log(r.out.split("\n").filter((l) => l.includes("❌")).slice(0, 3).join("\n"));
}

// 원복 검증 — 훼손이 남아 있으면 그 자체가 사고다.
// ⚠️ `git status` 로 보면 **아직 커밋 안 한 정상 변경**까지 훼손으로 오판한다.
//    만지고 간 파일의 **실행 전 바이트**와 직접 비교해야 정확하다.
const tampered = [...PRISTINE].filter(([file, before]) =>
  !fs.existsSync(file) || !fs.readFileSync(file).equals(before)).map(([file]) => file);
if (tampered.length > 0) {
  console.error(`\n❌ 원복 실패 — 훼손이 남았다:\n${tampered.join("\n")}`);
  process.exit(1);
}

console.log(failed === 0
  ? `\n✅ 자산 결함주입 ${results.length}/${results.length} RED — 게이트 검출력 확인 (워킹트리 clean)`
  : `\n❌ 자산 결함주입 ${failed}건이 RED 를 못 냈다 — 게이트가 결함을 통과시킨다`);
process.exit(failed === 0 ? 0 : 1);
