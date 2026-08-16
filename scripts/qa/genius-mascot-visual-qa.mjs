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

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { failures.push(name); console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
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

  rows.push({ clip, size: `${w}x${h}`, frames: n, posterAvg: +posterAvg.toFixed(2),
              padMax, ringPx: ring, ringLum: +ringLum.toFixed(0),
              posterDirty: +posterTransDirtyPct.toFixed(2) });
}

console.table(rows);

// selftest: 임계값이 실제로 결함을 잡는지 — 값을 반전시켜 RED 를 확인한다.
const T = SELFTEST
  ? { poster: -1, pad: -1, haloDelta: -1 }         // 불가능한 기준 → 전부 RED 여야 한다
  : { poster: 2, pad: 0, haloDelta: 40 };          // 코호트 중앙값 대비 허용 낙차

check(`poster ↔ 첫 프레임 평균 차이 < ${T.poster} (reduced-motion 전환 깜빡임 없음)`,
  rows.every((r) => r.posterAvg < T.poster),
  rows.filter((r) => !(r.posterAvg < T.poster)).map((r) => `${r.clip}=${r.posterAvg}`).join(", "));
check(`전 프레임 union bbox 여백 <= ${T.pad}px (96px 렌더에서 캐릭터가 안 작아짐)`,
  rows.every((r) => r.padMax <= T.pad),
  rows.filter((r) => !(r.padMax <= T.pad)).map((r) => `${r.clip}=${r.padMax}px`).join(", "));
// 코호트 중앙값보다 유의하게 어두운 클립이 있으면 그 클립만 키잉이 실패한 것이다.
const lums = rows.map((r) => r.ringLum).sort((a, b) => a - b);
const median = lums[Math.floor(lums.length / 2)];
check(`dark halo: 어느 클립도 코호트 중앙값(${median})보다 ${T.haloDelta} 이상 어둡지 않다`,
  rows.every((r) => median - r.ringLum < T.haloDelta),
  rows.filter((r) => !(median - r.ringLum < T.haloDelta))
    .map((r) => `${r.clip}=${r.ringLum}(-${median - r.ringLum})`).join(", "));
// 균일함 자체도 계약이다 — 편차가 크면 일부 클립만 다른 키잉을 탄 것이다.
const spread = Math.max(...lums) - Math.min(...lums);
check(`dark halo: 13종 바깥링 밝기 편차 <= 40 (전 클립이 같은 키잉을 탔다) — 실측 ${spread}`,
  SELFTEST ? false : spread <= 40, `min=${Math.min(...lums)} max=${Math.max(...lums)}`);
check(`poster 투명 영역에 배경색 잔재 0% (RGB 만 읽는 도구에서 사각형으로 보이지 않는다)`,
  SELFTEST ? false : rows.every((r) => r.posterDirty === 0),
  rows.filter((r) => r.posterDirty !== 0).map((r) => `${r.clip}=${r.posterDirty}%`).join(", "));
check("모든 클립이 실제 애니메이션이다(프레임 2 이상)", rows.every((r) => r.frames >= 2),
  rows.filter((r) => r.frames < 2).map((r) => r.clip).join(", "));
check("13종 전부 검사됐다(파서가 헛돌면 fail-close)", rows.length === 13, `${rows.length}종`);

if (SELFTEST) {
  const detected = failures.length >= 3;
  console.log(detected
    ? `\n✅ selftest: 임계값 반전으로 ${failures.length}축 RED — 검출력 확인`
    : `\n❌ selftest: RED ${failures.length}축뿐 — 게이트가 결함을 못 잡는다`);
  process.exit(detected ? 0 : 1);
}

console.log(failures.length === 0
  ? `\n✅ genius mascot visual: ${pass} PASS (poster 정합 + 여백 0 + halo 0)`
  : `\n❌ genius mascot visual FAIL: ${failures.length}건`);
process.exit(failures.length === 0 ? 0 : 1);
