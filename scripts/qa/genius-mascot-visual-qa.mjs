/**
 * 마스코트 영상 자산 **시각 품질** 게이트 (삼순 #1228 4축-④).
 *
 * 소스·컨테이너 계약(qa:genius-mascot-motion)은 "loop=0·alpha·12fps"까지만 본다.
 * 실제 화면에서 보이는 결함 — poster 전환 깜빡임 · 여백으로 캐릭터가 작아 보임 ·
 * 키잉 실패로 남은 dark halo — 은 **픽셀을 직접 읽어야** 잡힌다.
 *
 * ⚠️ 임계값은 "통과시키려고" 고른 값이 아니라 **의미**에서 나온다.
 *    1차 작성 때 임의 임계값(diff>12 · 첫프레임 padding · 경계 반투명 전부)을 써서
 *    13종 전부를 이상으로 표시했는데, 진단해 보니 셋 다 측정 자체가 틀렸다:
 *      · padding 은 **첫 프레임**이 아니라 **전 프레임 union bbox** 로 봐야 한다
 *        (동작 중 캐릭터가 움직이므로 첫 프레임만 보면 여백이 있는 게 정상이다).
 *      · 경계의 어두운 반투명 픽셀은 **안티에일리어싱 그 자체**다. 유니폼이 남색이라
 *        경계가 어두운 건 정상이고, halo 는 "경계가 **내부보다** 유의하게 어두울 때"다.
 *      · poster 차이는 lossy 재인코딩 노이즈라 픽셀 수가 아니라 **평균 강도**로 본다.
 *    측정이 틀린 채 임계값을 풀면 그게 바로 false-green 이다.
 *
 * 실행: npx tsx scripts/qa/genius-mascot-visual-qa.mjs [--selftest]
 */
import { readFileSync, readdirSync } from "node:fs";
import sharp from "sharp";

const DIR = "public/mascot/motion";
const SELFTEST = process.argv.includes("--selftest");
const DERIVED = JSON.parse(readFileSync(`${DIR}/DERIVED.json`, "utf8"));

let pass = 0;
const failures = [];
// 🔴 assertion 마다 **안정적인 ID** 를 붙인다 (삼순 2026-08-17 P0).
//    mutation runner 가 종전엔 `out.includes("과채움")` 처럼 문면으로 매칭했는데,
//    그 문면은 ✅ 줄에도 그대로 찍히므로 **다른 축이 RED 여도 hit 로 세어졌다**.
//    이제 runner 는 `❌ [ID]` 만 본다 — 통과 줄과 절대 겹치지 않는다.
const seenIds = new Set();
function check(id, name, ok, detail) {
  if (seenIds.has(id)) { console.error(`  ❌ [GATE] assertion id 중복: ${id}`); process.exit(1); }
  seenIds.add(id);
  if (ok) { pass += 1; console.log(`  ✅ [${id}] ${name}`); }
  else { failures.push(id); console.error(`  ❌ [${id}] ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** 전 프레임을 (프레임, 폭, 높이) 로 펼쳐 읽는다. */
async function readFrames(buf) {
  const meta = await sharp(buf, { animated: true }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const one = await sharp(buf, { pages: 1 }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const w = one.info.width, h = one.info.height;
  const n = Math.max(1, Math.round(meta.info.height / h));
  return { data: meta.data, w, h, n, first: one.data };
}

const clips = readdirSync(DIR)
  .filter((f) => f.endsWith(".webp") && !f.includes("-poster"))
  .map((f) => f.replace(".webp", ""))
  .sort();

const rows = [];
for (const clip of clips) {
  const { data, w, h, n, first } = await readFrames(readFileSync(`${DIR}/${clip}.webp`));
  const poster = await sharp(readFileSync(`${DIR}/${clip}-poster.webp`)).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });

  // ① poster ↔ 첫 프레임: reduced-motion 전환 시 눈에 띄는 변화가 없어야 한다.
  //    lossy 재인코딩 노이즈는 불가피하므로 **보이는 영역의 평균 차이**로 본다.
  //    사람 눈의 식별 한계(JND)는 8bit 채널에서 대략 2~3 — 평균 2 미만이면 안 보인다.
  let visN = 0, visSum = 0, sizeSame = poster.info.width === w && poster.info.height === h;
  if (sizeSame) {
    for (let i = 0; i < first.length; i += 4) {
      const a = first[i + 3];
      if (a < 24) continue;                       // 투명 영역은 화면에 안 보인다
      visSum += Math.max(
        Math.abs(first[i] - poster.data[i]),
        Math.abs(first[i + 1] - poster.data[i + 1]),
        Math.abs(first[i + 2] - poster.data[i + 2]),
        Math.abs(a - poster.data[i + 3]),
      );
      visN += 1;
    }
  }
  const posterAvg = visN ? visSum / visN : Infinity;

  // ② 여백: **전 프레임 union bbox** 가 캔버스에 닿아야 한다.
  //    여백이 있으면 96px 렌더에서 캐릭터가 그만큼 작게 보인다.
  let mnX = w, mxX = -1, mnY = h, mxY = -1;
  for (let p = 0; p < n; p += 1) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (data[((p * h + y) * w + x) * 4 + 3] > 24) {
          if (x < mnX) mnX = x; if (x > mxX) mxX = x;
          if (y < mnY) mnY = y; if (y > mxY) mxY = y;
        }
      }
    }
  }
  const padMax = Math.max(mnY, h - 1 - mxY, mnX, w - 1 - mxX);
  // 최소 여백도 함께 잰다 — **잘림 여부**는 여백의 최댓값이 아니라 최솟값이 말한다.
  // 🔴 2026-08-18 v1 복귀: 변별로 따로 들고 간다 — v1 확정본은 원본 자체가 일부 변에
  //    닿아 있고(하린아빠가 그 모습 그대로를 컨펌), 그 변은 상속이지 결함이 아니다.
  //    면제 근거는 생성기가 원본을 재서 기록한 `src_edge_contact`(DERIVED.json)다.
  const pads = { top: mnY, bottom: h - 1 - mxY, left: mnX, right: w - 1 - mxX };
  const contact = DERIVED.clips?.[clip]?.src_edge_contact ?? {};
  const freeSides = Object.keys(pads).filter((k) => !contact[k]);
  // 원본이 안 닿은 변만으로 재는 최소 여백. 사방 전부 닿은 종(cheerpom)은 비교할
  // 비접촉 변이 없으므로 Infinity — 면제 근거는 대장에 결속된 원본 해시+contact 기록이다.
  const padMin = freeSides.length
    ? Math.min(...freeSides.map((k) => pads[k]))
    : Number.POSITIVE_INFINITY;

  // ③ dark halo — **흰 배경에 합성했을 때 캐릭터 바깥 링이 얼마나 어두워지는가**.
  //
  //    🔴 1차 시도는 "경계 픽셀이 내부보다 60 이상 어두우면 halo" 였는데, 그게
  //       실제로 잡은 것은 **아트워크의 검은 외곽선**이었다(방망이·응원봉·폼폼).
  //       cheerstick 41.8% / swing 10.4% 로 뜬 클립이 정확히 "검게 외곽선 그린 소품을
  //       든 클립"이었고, 96px 실렌더 3배경 합성에서는 테두리가 보이지 않았다.
  //       즉 그 지표는 halo 가 아니라 **그림체**를 재고 있었다.
  //
  //    un-premultiply 실패는 그림체와 무관하게 **전 클립에 고르게** 나타나는 대신
  //    특정 클립만 유독 어둡게 만든다. 그래서 절대 임계가 아니라 **코호트 대비
  //    이상치**로 판정한다. 실측(수정 후): 13종 바깥링 평균 lum 181~189 로 균일 —
  //    이 균일함 자체가 "키잉은 정상이고 남은 건 안티에일리어싱"이라는 증거다.
  let ring = 0, ringSum = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = (y * w + x) * 4, a = first[i + 3];
      if (a <= 4 || a >= 200) continue;
      const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
      const idx = ([nx, ny]) => (ny * w + nx) * 4;
      // 캐릭터 **바깥** 링: 인접에 완전투명이 있고, 몸통(불투명)에도 닿아 있는 픽셀
      if (!nb.some((q) => first[idx(q) + 3] <= 4)) continue;
      if (!nb.some((q) => first[idx(q) + 3] >= 200)) continue;
      const al = a / 255;
      const r = first[i] * al + 255 * (1 - al);
      const g = first[i + 1] * al + 255 * (1 - al);
      const b = first[i + 2] * al + 255 * (1 - al);
      ringSum += r * 0.299 + g * 0.587 + b * 0.114;
      ring += 1;
    }
  }
  const ringLum = ring ? ringSum / ring : 255;   // 255 = 흰색(테두리 없음)

  // ④ 투명 영역 RGB 잔재 (삼순 2026-08-16 P0-②).
  //
  //    un-premultiply 는 alpha 로 나누므로 alpha=0 인 곳의 RGB 에 **원본 배경색이
  //    그대로 남는다**. 화면(알파 합성)에는 안 보이지만, 알파를 무시하고 RGB 만 읽는
  //    도구(raw 뷰어·썸네일러·이미지 파이프라인)에서는 "큰 남색 직사각형"으로 보인다 —
  //    삼순이 실제로 그렇게 관측했다. 안 보인다고 두면 다른 소비 경로에서 그대로 터진다.
  //
  //    ⚠️ **poster 만 검사한다.** 클립은 lossy WebP 라 인코더가 투명 픽셀의 RGB 를
  //       압축이 잘 되는 값으로 바꿔버리며, `exact=True` 로도 lossy 모드에서는 보존되지
  //       않는다(실측). 무손실로 바꾸면 4.5MB → 수십 MB 가 된다. poster 는 무손실
  //       + `exact=True` 라 원리적으로 보존 가능하고, **정지 상태로 오래 노출되는 쪽**이
  //       바로 poster 다(reduced-motion). 클립은 알파 합성으로만 소비된다.
  let transN = 0, transDirty = 0;
  for (let i = 0; i < poster.data.length; i += 4) {
    if (poster.data[i + 3] !== 0) continue;
    transN += 1;
    if (poster.data[i] || poster.data[i + 1] || poster.data[i + 2]) transDirty += 1;
  }
  const posterTransDirtyPct = transN ? (transDirty / transN) * 100 : 0;

  // ⑤ 내부 alpha 무결성 — **몸 안이 뚫렸는가** (삼순 2026-08-17 P0-①).
  //
  //    🔴 종전 게이트가 이걸 못 봤다. edge-run 은 **캔버스 변**만 보고, 채움률은
  //       전체 면적의 비율이라 몸통 한가운데가 뚫려도 15% 문턱을 여유롭게 넘는다.
  //       실측: `cheerC` f17 내부 구멍 509px · `cheertowel` f54 127px · `cheerpom` f48 55px
  //       인데 세 숫자(edge-run·채움률·bbox)가 **전부 GREEN** 이었다.
  //
  //    구멍의 정의는 **바깥과 연결되지 않은 투명 영역**이다. 다리 사이·들어올린 팔과
  //    몸통 사이의 정상적인 틈은 바깥과 이어져 있으므로 여기 걸리지 않는다
  //    (그 구분이 안 되면 정상 자산을 RED 로 만든다 — 실측으로 확인했다).
  //    2-pass flood fill: 변에서 시작해 투명 영역을 채우고, 남은 투명 픽셀이 구멍이다.
  //    ⚠️ 임계값 **하나로는 흔든다.** 경계가 반투명이라 alpha>128 만 보면 진한
  //    안티에일리싱 띄가 버팔처럼 작용해 정상 틈을 구멍으로 오보하고, alpha>24 만
  //    보면 엷은 구멍을 놓친다. **생성기와 똑같은** 2중 임계값 교집합을 쓴다.
  const stack = new Int32Array(w * h);
  const enclosed = (base, thr) => {
    const seen = new Uint8Array(w * h);
    let sp = 0;
    const push = (idx) => {
      if (seen[idx]) return;
      if (data[base + idx * 4 + 3] > thr) return;   // 불투명 = 몸, 배경 전파 안 됨
      seen[idx] = 1; stack[sp++] = idx;
    };
    for (let x = 0; x < w; x += 1) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y += 1) { push(y * w); push(y * w + w - 1); }
    while (sp > 0) {
      const idx = stack[--sp], x = idx % w, y = (idx - x) / w;
      if (x > 0) push(idx - 1);
      if (x < w - 1) push(idx + 1);
      if (y > 0) push(idx - w);
      if (y < h - 1) push(idx + w);
    }
    const out = new Uint8Array(w * h);
    for (let idx = 0; idx < w * h; idx += 1) {
      if (data[base + idx * 4 + 3] <= thr && !seen[idx]) out[idx] = 1;
    }
    return out;
  };
  let holeMax = 0, holeFrame = -1;
  for (let p = 0; p < n; p += 1) {
    const base = p * h * w * 4;
    const hi = enclosed(base, 128), lo = enclosed(base, 24);
    let holes = 0;
    for (let idx = 0; idx < w * h; idx += 1) if (hi[idx] && lo[idx]) holes += 1;
    if (holes > holeMax) { holeMax = holes; holeFrame = p; }
  }

  // ⑥ 실루엣 변화량 — **정말 움직이는가** (삼순 2026-08-17 P0-①, `pitching`).
  //
  //    "활발하게 움직이는 버전"이 요구사항인데, 종전 게이트에는 움직임을 재는 축이
  //    아예 없었다. `pitching` 은 잘림을 피하려 동작을 축소한 결과 실루엣 변화
  //    0.48%(13종 중 최저)의 호흡 idle 이 됐고, 게이트는 전부 GREEN 이었다.
  //    프레임 간 실루엣 IoU 거리의 평균으로 잰다 — 위치 이동·팔 각도 변화가 모두 잡힌다.
  let motionSum = 0;
  for (let p = 1; p < n; p += 1) {
    const a0 = (p - 1) * h * w * 4, a1 = p * h * w * 4;
    let inter = 0, uni = 0;
    for (let idx = 0; idx < w * h; idx += 1) {
      const s0 = data[a0 + idx * 4 + 3] > 128, s1 = data[a1 + idx * 4 + 3] > 128;
      if (s0 && s1) inter += 1;
      if (s0 || s1) uni += 1;
    }
    motionSum += uni ? 1 - inter / uni : 0;
  }
  const motionPct = n > 1 ? (motionSum / (n - 1)) * 100 : 0;

  rows.push({ clip, size: `${w}x${h}`, frames: n, posterAvg: +posterAvg.toFixed(2),
              padMax, padMin, ringPx: ring, ringLum: +ringLum.toFixed(0),
              posterDirty: +posterTransDirtyPct.toFixed(2),
              holeMax, holeFrame, motionPct: +motionPct.toFixed(2) });
}

console.table(rows);

// selftest: 임계값이 실제로 결함을 잡는지 — 값을 반전시켜 RED 를 확인한다.
// ⚠️ 여백 계약은 **양쪽 방향**이다 (2026-08-17, 재생성 트랙).
//    · 여백이 **너무 크면** 96px 렌더에서 캐릭터가 그만큼 작게 보인다 → padMax 상한
//    · 여백이 **0 이면** 캐릭터가 캔버스 모서리에 닿아 잘려 보인다 → padMin 하한
//    종전에는 상한만 있었고 하한이 `<= 0` 이라 "잘린 자산"이 오히려 통과했다.
//    빌드가 사방에 `safe_pad` 를 남기므로, 그 값을 **생성기 manifest 에서 읽어**
//    기대값으로 쓴다(게이트가 상수를 재구현하면 생성기와 조용히 어긋난다 — 8/15 교훈).
const SAFE_PAD = DERIVED?.params?.safe_pad;
if (!(SAFE_PAD > 0)) {
  console.log(`  ❌ DERIVED.json 에 safe_pad 가 없다 — 생성기 계약을 읽을 수 없다`);
  process.exit(1);
}
// 구멍·움직임 임계값은 **생성기 manifest 에서 읽는다**. 게이트가 상수를 재구현하면
// 생성기와 조용히 어긋난다(8/15 교훈, 이미 safe_pad 에 적용한 계약).
const HOLE_MAX = DERIVED?.params?.hole_px_max;
const MOTION_MIN = DERIVED?.params?.motion_pct_min;
const OVERFILL_MAX = DERIVED?.params?.overfill_px_max;
// 소품 삭제 판정은 **크기가 아니라 지속 프레임 수**다(삼순 2026-08-17: `<=500px` 는 임의 통과선).
// 노이즈는 한→두 프레임 반짝이고 진짜 소품은 연속해서 남는다.
const DROPPED_PERSIST_MAX = DERIVED?.params?.dropped_persist_max;
if (!(HOLE_MAX >= 0) || !(MOTION_MIN > 0) || !(OVERFILL_MAX >= 0)
    || !(DROPPED_PERSIST_MAX >= 0)) {
  console.log("  ❌ DERIVED.json 에 hole_px_max/motion_pct_min/overfill_px_max/dropped_persist_max 가"
    + " 없다 — 생성기 계약을 읽을 수 없다");
  process.exit(1);
}
const T = SELFTEST
  ? { poster: -1, padMax: -1, padMin: 9999, haloDelta: -1, hole: -1, motion: 9999 }
  : { poster: 2, padMax: SAFE_PAD, padMin: 1, haloDelta: 40, hole: HOLE_MAX, motion: MOTION_MIN };
const TR = SELFTEST
  ? { overfill: -1, persist: -1 }
  : { overfill: OVERFILL_MAX, persist: DROPPED_PERSIST_MAX };

check("V-POSTER", `poster ↔ 첫 프레임 평균 차이 < ${T.poster} (reduced-motion 전환 깜빡임 없음)`,
  rows.every((r) => r.posterAvg < T.poster),
  rows.filter((r) => !(r.posterAvg < T.poster)).map((r) => `${r.clip}=${r.posterAvg}`).join(", "));
check("V-PAD-MAX", `전 프레임 union bbox 여백 <= ${T.padMax}px (96px 렌더에서 캐릭터가 안 작아짐)`,
  rows.every((r) => r.padMax <= T.padMax),
  rows.filter((r) => !(r.padMax <= T.padMax)).map((r) => `${r.clip}=${r.padMax}px`).join(", "));
// 🔴 잘림 계약 — **원본이 닿지 않은 변**은 여백이 최소 1px 이상이어야 한다.
//    v1 확정본 자체가 닿은 변은 `src_edge_contact`로 기록해 상속으로 분리하고,
//    비접촉 변의 여백 0만 "파생 과정에서 새로 평평하게 잘림"으로 판정한다.
check("V-PAD-MIN", `전 프레임 사방 여백 >= ${T.padMin}px (원본 비접촉 변 기준 — src_edge_contact 면제)`,
  rows.every((r) => r.padMin >= T.padMin),
  rows.filter((r) => !(r.padMin >= T.padMin)).map((r) => `${r.clip}=${r.padMin}px`).join(", "));
// 생성기가 기록한 edge-run(전 프레임+poster 연속 불투명 런)도 대조한다.
// 🔴 2026-08-18 v1 복귀: 원본 자체가 닿은 변(`src_edge_contact`)은 상속으로 면제하고,
// 원본이 닿지 않은 변의 edge-run만 파생 신규 잘림(결함)으로 본다.
// contact 자체의 위조는 build --check의 DERIVED 대조(CONTRACT 축)가 잡는다.
{
  const bad = Object.entries(DERIVED.clips ?? {})
    .flatMap(([n, m]) => Object.entries(m.edge_run ?? { x: 1 })
      .filter(([side, v]) => v > 0 && !(m.src_edge_contact ?? {})[side])
      .map(([side, v]) => `${n}.${side}=${v}px`));
  check("V-EDGE-RUN", "DERIVED.json: 원본 비접촉 변 edge-run 0 (파생 신규 잘림 계약)",
    SELFTEST ? false : bad.length === 0, bad.join(", "));
}
// 🔴 원본 접촉 변도 무제한 면제하지 않는다. 원본·파생 edge-run을 각 변 길이로
// 정규화해 같은 단위로 비교하고, 출력 픽셀 환산 1px 초과 증가면 더 잘린 것이다.
{
  const max = DERIVED.params?.edge_growth_px_max;
  const bad = [];
  for (const [n, m] of Object.entries(DERIVED.clips ?? {})) {
    for (const side of ["top", "bottom", "left", "right"]) {
      if (!(m.src_edge_contact ?? {})[side]) continue;
      const len = side === "top" || side === "bottom" ? m.w : m.h;
      const src = m.src_edge_run_ratio?.[side];
      const run = m.edge_run?.[side];
      if (!(Number.isFinite(len) && len > 0 && Number.isFinite(src) && Number.isFinite(run))) {
        bad.push(`${n}.${side}=측정치 누락`);
        continue;
      }
      const growthPx = (run / len - src) * len;
      if (!(growthPx <= max + 1e-6)) bad.push(`${n}.${side}=+${growthPx.toFixed(2)}px`);
    }
  }
  check("V-EDGE-GROWTH", `DERIVED.json: 원본 접촉 변 edge-run 증가 <= ${max}px (정규화 비교)`,
    SELFTEST ? false : Number.isFinite(max) && bad.length === 0, bad.join(", "));
}
// 코호트 중앙값보다 유의하게 어두운 클립이 있으면 그 클립만 키잉이 실패한 것이다.
const lums = rows.map((r) => r.ringLum).sort((a, b) => a - b);
const median = lums[Math.floor(lums.length / 2)];
check("V-HALO-DARK", `dark halo: 어느 클립도 코호트 중앙값(${median})보다 ${T.haloDelta} 이상 어둡지 않다`,
  rows.every((r) => median - r.ringLum < T.haloDelta),
  rows.filter((r) => !(median - r.ringLum < T.haloDelta))
    .map((r) => `${r.clip}=${r.ringLum}(-${median - r.ringLum})`).join(", "));
// 균일함 자체도 계약이다 — 편차가 크면 일부 클립만 다른 키잉을 탄 것이다.
const spread = Math.max(...lums) - Math.min(...lums);
check("V-HALO-SPREAD", `dark halo: 13종 바깥링 밝기 편차 <= 40 (전 클립이 같은 키잉을 탔다) — 실측 ${spread}`,
  SELFTEST ? false : spread <= 40, `min=${Math.min(...lums)} max=${Math.max(...lums)}`);
check("V-POSTER-DIRTY", `poster 투명 영역에 배경색 잔재 0% (RGB 만 읽는 도구에서 사각형으로 보이지 않는다)`,
  SELFTEST ? false : rows.every((r) => r.posterDirty === 0),
  rows.filter((r) => r.posterDirty !== 0).map((r) => `${r.clip}=${r.posterDirty}%`).join(", "));
// 🔴 키잉 구멍 — 모서리가 아니라 **몸 안**이 뚫렸는가 (삼순 2026-08-17 P0-①).
//
//    ⚠️ "닫힌 투명 영역"과 "키잉 결함"은 다르다. 두 다리 사이처럼 발끝이 붙으면
//    정상 음공간도 닫힌다(실측: `excited` 117px). 숫자 크기로는 둘을 가를 수 없고
//    (37~509px 가 섞인다), 임의 임계값을 고르면 그게 바로 "통과시키려고 고른 값"이 된다.
//    → **생성기만 원본 mp4 를 볼 수 있으므로**, 거기서 원본 픽셀과 대조해 잰 `defect_px`
//      (= 닫힌 영역 중 원본에서 배경이 아니었던 픽셀)를 계약값으로 쓴다.
{
  const bad = Object.entries(DERIVED.clips ?? {})
    .filter(([, m]) => !(m.defect_px <= T.hole))
    .map(([n, m]) => `${n}=${m.defect_px}px@f${m.defect_frame}`);
  check("V-HOLE", `DERIVED.json: 키잉 구멍 <= ${T.hole}px (원본 대조 — 몸을 배경으로 오인해 파먹지 않았다)`,
    SELFTEST ? false : bad.length === 0, bad.join(", "));
}
// 🔴 **역방향** — 결함을 지우는 보정(fill_holes·speck 제거)이 정상 요소까지 지우지 않았는가
//    (삼순 2026-08-17). 위 키잉구멍 축만 보면 "다 메워버리면 항상 통과"하는 서로 반대 방향의
//    false-green 이 생긴다. 둘 다 생성기가 **원본 픽셀과 대조**해 재고 manifest 에 썼다.
{
  const bad = Object.entries(DERIVED.clips ?? {})
    .filter(([, m]) => !(m.overfill_px <= TR.overfill))
    .map(([n, m]) => `${n}=${m.overfill_px}px`);
  check("V-OVERFILL", `DERIVED.json: 과채움 <= ${TR.overfill}px (정상 음공간—다리 사이 등—을 메우지 않았다)`,
    bad.length === 0, bad.join(", "));
}
{
  const bad = Object.entries(DERIVED.clips ?? {})
    .filter(([, m]) => !(m.dropped_persist_frames <= TR.persist))
    .map(([n, m]) => `${n}=${m.dropped_persist_frames}f`);
  check("V-DROP-PERSIST", `DERIVED.json: 삭제된 조각의 연속 지속 <= ${TR.persist}프레임`
    + " (공·응원도구 같은 소품은 연속해서 남는다 — 노이즈는 반짝하고 사라진다)",
    bad.length === 0, bad.join(", "));
}
// 파생 자산을 직접 재측정한 값과 생성기 기록이 일치하는가 — **빌드 후 자산이 교체됐다**를 잡는다.
// (edge_run ↔ padMin 을 둘 다 보는 것과 같은 구조. 한쪽만 보면 조용히 어긋난다.)
{
  const bad = rows.filter((r) => (DERIVED.clips?.[r.clip]?.hole_px ?? -1) !== r.holeMax)
    .map((r) => `${r.clip}: 재측정=${r.holeMax} manifest=${DERIVED.clips?.[r.clip]?.hole_px}`);
  check("V-MANIFEST-SYNC", "파생 자산 구멍 측정치 = manifest 기록 (빌드 후 자산 교체 없음)",
    SELFTEST ? false : bad.length === 0, bad.join(", "));
}
// 🔴 움직임 — "활발하게 움직이는 버전"이 요구사항이므로 숫자로 고정한다.
//    `pitching` 은 잘림을 피하려고 동작을 줄인 결과 0.48% 의 호흡 idle 이 됐는데
//    종전 게이트에는 움직임을 재는 축이 아예 없어 전부 GREEN 이었다.
check("V-MOTION", `실루에 변화량 >= ${T.motion}% (호흡 idle 이 아니라 실제 동작이다)`,
  rows.every((r) => r.motionPct >= T.motion),
  rows.filter((r) => !(r.motionPct >= T.motion))
    .map((r) => `${r.clip}=${r.motionPct}%`).join(", "));
check("V-FRAMES", "모든 클립이 실제 애니메이션이다(프레임 2 이상)", rows.every((r) => r.frames >= 2),
  rows.filter((r) => r.frames < 2).map((r) => r.clip).join(", "));
check("V-COVERAGE", "13종 전부 검사됐다(파서가 헛돌면 fail-close)", rows.length === 13, `${rows.length}종`);

if (SELFTEST) {
  const detected = failures.length >= 3;
  console.log(detected
    ? `\n✅ selftest: 임계값 반전으로 ${failures.length}축 RED — 검출력 확인`
    : `\n❌ selftest: RED ${failures.length}축뿐 — 게이트가 결함을 못 잡는다`);
  process.exit(detected ? 0 : 1);
}

console.log(failures.length === 0
  ? `\n✅ genius mascot visual: ${pass} PASS (poster 정합 + 파생 신규잘림 0 + halo 0)`
  : `\n❌ genius mascot visual FAIL: ${failures.length}건`);
process.exit(failures.length === 0 ? 0 : 1);
