/**
 * 히어로샷 매핑검증 핵심 유틸 — 두 이미지가 같은 선수인지 Gemini Vision으로 대조.
 *
 * 사용:
 *   import { verifyIdentity } from "./verify-identity.mjs";
 *   const r = await verifyIdentity(anchorSrc, candidateSrc);
 *   // r = { same: boolean, confidence: number(0~1), reason: string }
 *
 * 셀프테스트(실 API 호출):
 *   node scripts/hero-batch/verify-identity.mjs --selftest
 *
 * anchorSrc / candidateSrc 는 http(s) URL 또는 로컬 파일 경로.
 *
 * 매핑 오류(가나쿠보 osen 사고) 방지의 1차 게이트. ground-truth 앵커(KBO 공식 헤드샷)와
 * 후보 이미지를 동일인 대조해, 다른 사람이면 same=false 로 거부한다.
 */

import fs from "fs";

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  (() => {
    // 로컬 실행 fallback: ~/.zshrc 에서 export GEMINI_API_KEY 추출 (CI 에선 env 로 주입)
    try {
      const rc = fs.readFileSync(`${process.env.HOME}/.zshrc`, "utf8");
      const m = rc.match(/^export GEMINI_API_KEY="?([^"\n]+)"?/m);
      return m ? m[1] : "";
    } catch {
      return "";
    }
  })();

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const DEFAULT_THRESHOLD = 0.75;

/** 이미지 소스(URL 또는 로컬 경로)를 { mimeType, data(base64) } 로 로드. */
async function loadImage(src) {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, {
      headers: { "User-Agent": "Mozilla/5.0 (kbo-hero-batch)" },
    });
    if (!res.ok) throw new Error(`fetch ${src} → HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get("content-type")?.split(";")[0] || guessMime(src);
    return { mimeType, data: buf.toString("base64") };
  }
  const buf = fs.readFileSync(src);
  return { mimeType: guessMime(src), data: buf.toString("base64") };
}

function guessMime(p) {
  if (/\.png$/i.test(p)) return "image/png";
  if (/\.webp$/i.test(p)) return "image/webp";
  return "image/jpeg";
}

/**
 * 두 이미지가 같은 야구선수인지 대조.
 * @param {string} anchorSrc   진실 기준(KBO 공식 헤드샷 등)
 * @param {string} candidateSrc 검증 대상(네이버 후보 / 생성 cutout 등)
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.75] same 판정 임계값
 * @returns {Promise<{same:boolean, confidence:number, reason:string}>}
 */
export async function verifyIdentity(anchorSrc, candidateSrc, opts = {}) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

  const [anchor, candidate] = await Promise.all([
    loadImage(anchorSrc),
    loadImage(candidateSrc),
  ]);

  const prompt =
    "두 이미지는 KBO 프로야구 선수 사진입니다. " +
    "첫 번째(기준)와 두 번째(후보)가 동일 인물인지 얼굴 특징 위주로 판정하세요. " +
    "유니폼/배경/화질 차이는 무시하고 인물 동일성만 봅니다. " +
    "확신이 없으면 보수적으로 낮은 confidence 를 주세요. " +
    'JSON 만 출력: {"same": boolean, "confidence": 0~1 사이 숫자, "reason": "짧은 근거"}';

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { text: "기준 이미지:" },
          { inline_data: { mime_type: anchor.mimeType, data: anchor.data } },
          { text: "후보 이미지:" },
          { inline_data: { mime_type: candidate.mimeType, data: candidate.data } },
        ],
      },
    ],
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  };

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const raw = parts.filter((p) => p.text).map((p) => p.text).join("").trim();
  if (!raw) throw new Error("Gemini empty response");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 혹시 코드펜스 등이 섞이면 첫 { ... } 블록 추출
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`unparseable Gemini output: ${raw.slice(0, 120)}`);
    parsed = JSON.parse(m[0]);
  }

  const confidence = Number(parsed.confidence) || 0;
  // 모델 same 과 임계값을 AND: 둘 다 만족해야 통과 (보수적)
  const same = Boolean(parsed.same) && confidence >= threshold;
  return { same, confidence, reason: String(parsed.reason || "") };
}

// ===== 셀프테스트 (실 API 호출) =====
async function selftest() {
  const KBO = (id) =>
    `https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/person/middle/2026/${id}.jpg`;

  // 케이스: same(같은 선수 ↔ 자기 자신) / diff(다른 두 선수) → 매핑 오류 거부 검증
  const cases = [
    { name: "동일인(가나쿠보 56348 ↔ 자기 자신)", a: KBO(56348), b: KBO(56348), expect: true },
    { name: "타인(가나쿠보 56348 ↔ 시라카와 54843)", a: KBO(56348), b: KBO(54843), expect: false },
  ];

  let pass = 0;
  for (const c of cases) {
    try {
      const r = await verifyIdentity(c.a, c.b);
      const ok = r.same === c.expect;
      console.log(
        `${ok ? "✅" : "❌"} ${c.name} → same=${r.same} conf=${r.confidence.toFixed(2)} (expect same=${c.expect}) :: ${r.reason}`
      );
      if (ok) pass++;
    } catch (e) {
      console.log(`❌ ${c.name} → ERROR ${e.message}`);
    }
  }
  console.log(`\n${pass}/${cases.length} PASS`);
  process.exit(pass === cases.length ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  selftest();
}
