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
 * 실행:
 *   node scripts/qa/genius-mascot-asset-mutations.mjs                ← 원본 **불필요** 축만(prebuild·CI)
 *   node scripts/qa/genius-mascot-asset-mutations.mjs --with-source  ← 전체(v1 확정본 보유 환경)
 *
 * 🔴 왜 나누는가 (삼순 2026-08-17 NO-GO): `build --check` 를 호출하는 축(M6·M7·L1·L2)은
 *    repo 밖 `assets/mascot/v1` 확정본 WebP가 있어야 돌아간다. 원본이 없는 CI(Vercel)에서는
 *    의도한 assertion 에 닿기 전에 **source-missing 으로 먼저 죽어** "게이트가 결함을 통과시킨다"로
 *    오판된다. 실제로 2026-08-17 02:35Z Vercel 빌드가 정확히 이 4건으로 죽었다(로그 실측).
 *    → 기본 실행은 **자산+manifest 축만** 돌리고, 원본이 필요한 축은 `--with-source` 로 분리한다.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

const DIR = "public/mascot/motion";
const MANIFEST = `${DIR}/DERIVED.json`;
const LEDGER = "scripts/assets/mascot-motion-SOURCES.sha256";

// v1 확정본 WebP가 있어야 돌아가는 축을 포함할지. 기본은 제외(CI 안전).
const WITH_SOURCE = process.argv.includes("--with-source");
// 이 경로는 생성기의 `SSOT`(MASCOT_SSOT)와 같은 의미여야 한다 —
// `bored-black.webp` 등 v1 확정본 13종이 바로 이 폴더 아래에 있어야 한다.
const SRC_ROOT = process.env.MASCOT_SSOT
  || path.join(process.env.HOME ?? "", ".openclaw/workspace/assets/mascot/v1");
if (WITH_SOURCE && !fs.existsSync(path.join(SRC_ROOT, "bored-black.webp"))) {
  // 🔴 원본이 없는데 --with-source 를 줘으면 **조용히 건너뛰지 않고** 멈춴야 한다.
  //    "돌렸다"고 믿게 만드는 것이 가장 나쁘다.
  console.error(`❌ --with-source 인데 v1 확정본이 없다: ${SRC_ROOT}`);
  process.exit(2);
}

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
function runGate(cmd, args, expect, env) {
  const res = spawnSync(cmd, args,
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}) });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

  // 🔴 `status === null` 은 **RED 가 아니다** (삼순 2026-08-17 P0).
  //    시그널로 죽었거나(OOM·SIGKILL) spawn 자체가 실패한 것이라, "게이트가 결함을
  //    잡았다"의 증거가 될 수 없다. 판정 불능으로 따로 분류해 시끄럽게 실패시킨다.
  if (res.error || res.status === null) {
    return { red: false, hit: false, out, broken: `실행 실패: ${res.error?.message ?? `signal=${res.signal}`}` };
  }
  const red = res.status !== 0;

  // 🔴 종전엔 `out.includes("과채움")` 처럼 **문면**으로 매칭했는데, 그 문면은 ✅ 줄에도
  //    그대로 찍힌다. 그래서 의도 축이 통과하고 **다른 축 하나만 RED** 여도 hit 로 세어졌다
  //    (삼순 2026-08-17 P0 false-green). 이제 `❌ [ID]` 로만 본다 — 통과 줄과 겹칠 수 없다.
  const failedIds = new Set(
    [...out.matchAll(/^\s*❌\s*\[([A-Z0-9-]+)\]/gmu)].map((m) => m[1]));
  const hit = expect ? failedIds.has(expect) : true;
  return { red, hit, out, failedIds: [...failedIds] };
}
const visual = () => runGate("npx", ["tsx", "scripts/qa/genius-mascot-visual-qa.mjs"]);
const visualExpect = (needle) =>
  runGate("npx", ["tsx", "scripts/qa/genius-mascot-visual-qa.mjs"], needle);
const buildCheck = (needle) =>
  runGate("python3", ["scripts/assets/build-mascot-motion.py", "--check"], needle,
    { ...process.env, MASCOT_SSOT: SRC_ROOT });

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

/**
 * 재생 구간 **전체**에서 소품의 끝 조각을 지운다 — "지속하는 분리 조각이 사라졌다"의 재현.
 * 🔴 A3(클립 통째 삭제)는 소품 삭제가 아니다는 삼순 지적에 대응한다.
 * 불투명 픽셀 중 무게중심에서 가장 먼 모서리 쪽 14x14 묶음을 전 프레임에서 알파 0 으로.
 */
async function erasePropTip(clip) {
  stash(clip);
  const buf = fs.readFileSync(clip);
  const { width: w, height: h } = await sharp(buf, { pages: 1 }).metadata();
  const raw = await sharp(buf, { animated: true }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const pages = Math.round(raw.info.height / h);
  const data = Buffer.from(raw.data);
  for (let p = 0; p < pages; p += 1) {
    const base = p * h * w * 4;
    let sx = 0; let sy = 0; let n = 0;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (data[base + (y * w + x) * 4 + 3] > 128) { sx += x; sy += y; n += 1; }
      }
    }
    if (n === 0) continue;
    const cx = sx / n; const cy = sy / n;
    let bx = 0; let by = 0; let best = -1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (data[base + (y * w + x) * 4 + 3] <= 128) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d > best) { best = d; bx = x; by = y; }
      }
    }
    for (let y = Math.max(0, by - 7); y < Math.min(h, by + 7); y += 1) {
      for (let x = Math.max(0, bx - 7); x < Math.min(w, bx + 7); x += 1) {
        data[base + (y * w + x) * 4 + 3] = 0;
      }
    }
  }
  await writeAnimated(clip, data, w, h, pages);
}

/**
 * 정상 음공간(전경으로 둘러싸지 않은 바깥쪽 투명 영역 중 내부 종방향 틈)을 메운다.
 * `fill_holes` 가 다리 사이까지 메우면 생기는 상태의 재현 — 과채움 축이 RED 여야 한다.
 */
async function fillNegativeSpace(clip) {
  stash(clip);
  const buf = fs.readFileSync(clip);
  const { width: w, height: h } = await sharp(buf, { pages: 1 }).metadata();
  const raw = await sharp(buf, { animated: true }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const pages = Math.round(raw.info.height / h);
  const data = Buffer.from(raw.data);
  for (let p = 0; p < pages; p += 1) {
    const base = p * h * w * 4;
    for (let y = 0; y < h; y += 1) {
      // 가로로 전경 → 투명 → 전경 이 나타나는 구간이 바로 음공간이다.
      let left = -1;
      for (let x = 0; x < w; x += 1) {
        const a = data[base + (y * w + x) * 4 + 3];
        if (a > 128) {
          if (left >= 0 && x - left > 2 && x - left < 40) {
            for (let k = left + 1; k < x; k += 1) {
              const o = base + (y * w + k) * 4;
              data[o] = data[base + (y * w + left) * 4];
              data[o + 1] = data[base + (y * w + left) * 4 + 1];
              data[o + 2] = data[base + (y * w + left) * 4 + 2];
              data[o + 3] = 255;
            }
          }
          left = x;
        }
      }
    }
  }
  await writeAnimated(clip, data, w, h, pages);
}

// ── source-level 결함주입 ─────────────────────────────────────────────
// v1 확정본 WebP를 변이시킨 **임시 트리**를 만들고, 빌더를 그 트리로 감사 모드 실행한다.
// 자산·manifest·대장은 건드리지 않으므로 원복할 것이 없다(임시 폴더만 지운다).
const MUT_SRC = "/tmp/mascot-src-mutation";
function mutateSource(clip, mode) {
  fs.rmSync(MUT_SRC, { recursive: true, force: true });
  const r = spawnSync("python3", [
    "scripts/qa/mascot-source-mutate.py",
    "--clip", clip, "--mode", mode, "--src", SRC_ROOT, "--out", MUT_SRC,
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`원본 변이 실패(${clip}/${mode}): ${r.stderr || r.stdout}`);
  }
}
function sourceAudit(clip, expect) {
  const res = runGate("python3", [
    "scripts/assets/build-mascot-motion.py", "--audit-only", "--only", clip,
  ], expect, { ...process.env, MASCOT_SSOT: MUT_SRC });
  fs.rmSync(MUT_SRC, { recursive: true, force: true });
  return res;
}

/**
 * 빌더 **코드 경로**를 변이시킨다.
 *
 * 🔴 왜 여기만 코드 변이인가 — `overfill_px` 는 **원본을 어떻게 바꿔도 안 올라간다.**
 *    빌더의 전경은 `~(바깥에 연결된 배경)` 이라, 몸 안에 갇힌 배경은 **이미 전경**이다.
 *    speck 으로 사라진 자리도 바깥쪽 배경과 이어져 있으므로 fill_holes 가 메우지 않는다.
 *    즉 `overfill > 0` 은 입력이 아니라 **알고리즘이 더 공격적으로 바뀔 때**만 발생한다
 *    (실측: closing 9→176px / 17→496px / 25→1923px). 이 게이트가 막는 위험이 정확히
 *    그것이므로, 그 회귀를 실제로 주입해 RED 를 확인한다.
 */
const BUILDER = "scripts/assets/build-mascot-motion.py";
function mutateBuilder(from, to) {
  stash(BUILDER);
  const src = fs.readFileSync(BUILDER, "utf8");
  if (!src.includes(from)) throw new Error(`빌더 변이 앵커 MISS: ${from.trim()}`);
  fs.writeFileSync(BUILDER, src.replace(from, to));
}
function builderAudit(clip, expect) {
  return runGate("python3", [BUILDER, "--audit-only", "--only", clip], expect,
    { ...process.env, MASCOT_SSOT: SRC_ROOT });
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
    const r = gate(expect);
    results.push({ name, expect, ...r });
  } finally {
    restore();
  }
}

// ── 자산 자체를 훼손한다 ────────────────────────────────────────────────
await mutation(
  "A1 cheerC f17 몸통에 20x20 구멍 (키잉이 몸을 파먹은 상태 재현)",
  () => punchHole(`${DIR}/cheerC.webp`, 17, { x: 60, y: 95, w: 20, h: 20 }),
  visualExpect,
  "V-MANIFEST-SYNC",
);
await mutation(
  "A2 pitching 전 프레임 고정 (호흡 idle 재현)",
  () => freezeClip(`${DIR}/pitching.webp`),
  visualExpect,
  "V-MOTION",
);
await mutation(
  "A3 클립 1종 삭제 (파서가 헛돌면 fail-close)",
  () => { stash(`${DIR}/swing.webp`); fs.unlinkSync(`${DIR}/swing.webp`); },
  visualExpect,
  // 🔴 종전엔 `expect=null` 이라 **아무 이유로 죽어도 통과**했다(삼순 지적).
  //    13종 전수 검사 축이 정확히 죽는지 지목한다.
  "V-COVERAGE",
);
// 🔴 A4·A5 는 **원본(빌더 입력)** 을 변이한다 — 최종 WebP 가 아니다 (삼순 2026-08-17 P0).
//    `overfill_px`·`dropped_persist_frames` 는 빌더가 **원본 픽셀과 대조**해 재는 값이라,
//    WebP 를 아무리 훼손해도 그 축은 안 움직인다. 종전 구현은 다른 축(V-POSTER)을 죽이고
//    문면 매칭 덕에 "통과"하던 **정확히 false-green** 이었고, ID 매칭으로 바꾸자마자 드러났다.
//    이젠 `mascot-source-mutate.py` 로 v1 확정본 WebP 프레임을 고치고 빌더를 감사 모드로 돌려
//    `[B-DROP]`·`[B-OVERFILL]` 이 **실제로** 뜨는지 본다. 원본이 필요하므로 --with-source 전용.
if (WITH_SOURCE) {
  await mutation(
    "A4 원본에 **떨어진 작은 소품** 추가 → speck 제거가 지우는가 (source-level)",
    () => mutateSource("cheerstick", "add-prop"),
    () => sourceAudit("cheerstick", "B-DROP"),
    "B-DROP",
  );
  await mutation(
    "A5 마스크 정리를 공격적으로 바꿈(closing 주입) → 정상 음공간을 메우는가 (code-path)",
    () => mutateBuilder(
      "    fg = ndimage.binary_fill_holes(kept)",
      "    fg = ndimage.binary_fill_holes(ndimage.binary_closing(kept, np.ones((17, 17))))"),
    () => builderAudit("excited", "B-OVERFILL"),
    "B-OVERFILL",
  );
}

// ── manifest 를 훼손한다 (게이트가 여기서 임계값·측정치를 읽는다) ─────────
await mutation(
  "M1 defect_px 를 300 으로 위조 (키잉 결함 은폐 시도)",
  () => patchManifest((m) => { m.clips.cheerC.defect_px = 300; }),
  visualExpect,
  "V-HOLE",
);
await mutation(
  "M2 overfill_px 를 500 으로 위조 (정상 음공간 메움)",
  () => patchManifest((m) => { m.clips.excited.overfill_px = 500; }),
  visualExpect,
  "V-OVERFILL",
);
await mutation(
  "M3 dropped_persist_frames 를 20 으로 위조 (소품 삭제)",
  () => patchManifest((m) => { m.clips.bored.dropped_persist_frames = 20; }),
  visualExpect,
  "V-DROP-PERSIST",
);
await mutation(
  "M4 hole_px 를 0 이 아닌 값으로 위조 (자산↔manifest 불일치)",
  () => patchManifest((m) => { m.clips.thinking.hole_px = 77; }),
  visualExpect,
  "V-MANIFEST-SYNC",
);
await mutation(
  "M5 원본 비접촉 변 edge_run 을 잘림 있음으로 위조",
  () => patchManifest((m) => { m.clips.cheerG.edge_run.top = 40; }),
  visualExpect,
  "V-EDGE-RUN",
);
// ── v1 확정본 WebP가 있어야 돌아가는 축 (`build --check`) ───────────────
if (WITH_SOURCE) {
  await mutation(
    "M6 임계값 자체를 풀어버림 (hole_px_max 9999) — build --check 가 잡아야 한다",
    () => patchManifest((m) => { m.params.hole_px_max = 9999; }),
    buildCheck,
    "B-REPRO",
  );
  await mutation(
    "M7 manifest 에서 클립 1종 삭제 — build --check 가 잡아야 한다",
    () => patchManifest((m) => { delete m.clips.headspin; }),
    buildCheck,
    "B-REPRO",
  );

  // ── 원본 해시 대장을 훼손한다 ──────────────────────────────────────────
  await mutation(
    "L1 대장 삭제 (원본 증명 불가 → 통과시키면 안 된다)",
    () => { stash(LEDGER); fs.unlinkSync(LEDGER); },
    buildCheck,
    "B-LEDGER-MISSING",
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
    "B-LEDGER-DRIFT",
  );

  // ── 🔴 삼순 2026-08-17 P0: "자산 교체 + manifest 동시 갱신" 과 "모드 강등" ──────────
  //    직전 구조는 툴체인이 다르면(=CI 는 항상) shipped WebP 를 **존재만** 확인했다.
  //    그래서 아래 S1 이 정확히 GREEN 이었다 — 원본에서 생성되지 않은 자산이 통과했다.
  //    선택자를 없애고 `semantic_diff`(디코딩 실루엣 IoU)를 넣었으니, 이 두 축을
  //    **영구 회귀 테스트로 고정**한다. 다시 느슨해지면 여기서 죽는다.
  await mutation(
    "S1 자산 교체 + manifest 해시 동시 갱신 (가장 정교한 위조 — 해시 정합성까지 맞춘다)",
    () => {
      // swing 자리에 thinking 을 넣는다. 둘 다 **정상 자산**이라 픽셀 결함 축은 안 걸린다.
      stash(`${DIR}/swing.webp`);
      stash(`${DIR}/swing-poster.webp`);
      fs.copyFileSync(`${DIR}/thinking.webp`, `${DIR}/swing.webp`);
      fs.copyFileSync(`${DIR}/thinking-poster.webp`, `${DIR}/swing-poster.webp`);
      // manifest 해시도 새 파일 기준으로 맞춰준다 — 해시 대조로는 절대 못 잡게.
      patchManifest((m) => {
        m.clips.swing.clip_sha256 = sha256(`${DIR}/swing.webp`);
        m.clips.swing.poster_sha256 = sha256(`${DIR}/swing-poster.webp`);
        m.clips.swing.clip_kb = Math.round(fs.statSync(`${DIR}/swing.webp`).size / 1024);
      });
    },
    buildCheck,
    "B-REPRO",
  );
  await mutation(
    "S2 manifest 에 `toolchain` 키 주입 (검사 강도를 데이터가 고르게 만들려는 시도)",
    () => patchManifest((m) => { m.toolchain = "webp=9.9.9 / os=Nowhere"; }),
    buildCheck,
    "B-REPRO",
  );
} else {
  console.log("  ⏭ M6·M7·L1·L2·S1·S2 생략 — `build --check` 는 repo 밖 v1 확정본 WebP가 필요하다.");
  console.log("     원본 보유 환경에서 `npm run qa:genius-mascot-assets:mutations:full` 로 검증한다.");
}

restore();

// ── 결과 ────────────────────────────────────────────────────────────────
console.log("");
let failed = 0;
for (const r of results) {
  const ok = r.red && r.hit;
  if (!ok) failed += 1;
  let why = "";
  if (!ok) {
    if (r.broken) why = `판정 불능 — ${r.broken}`;
    else if (!r.red) why = "게이트가 통과시켰다";
    else why = `의도 축[${r.expect}] 이 아닌 다른 축이 죽었다 (실패 ID: ${(r.failedIds ?? []).join(",") || "없음"})`;
  }
  console.log(`  ${ok ? "✅" : "❌"} ${r.name}${ok ? "" : ` — ${why}`}`);
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

const scope = WITH_SOURCE ? "전체" : "원본불필요 축";
console.log(failed === 0
  ? `\n✅ 자산 결함주입 ${results.length}/${results.length} RED (${scope}) — 검출력 확인, 원본 무손`
  : `\n❌ 자산 결함주입 ${failed}건이 RED 를 못 냈다 — 게이트가 결함을 통과시킨다`);
process.exit(failed === 0 ? 0 : 1);
