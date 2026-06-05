/**
 * Nano Banana Pro (Gemini 3 Pro Image) cutout 원본 생성 — repo 내장 포팅판.
 *
 * 기존 `phase2-pipeline.sh` 는 맥미니 워크스페이스 스킬
 * (`uv run ~/.openclaw/workspace/skills/nano-banana-pro/scripts/generate_image.py`)
 * 에 의존해 GH Action(ubuntu)에서 실행 불가였다. 이 스크립트는 그 호출을
 * generativelanguage REST API 직접 호출로 대체해 **맥미니 의존을 제거**한다.
 * (verify-identity.mjs 와 동일한 fetch 패턴 — 외부 의존성 0)
 *
 * 사용:
 *   import { generateCutout } from "./generate-cutout.mjs";
 *   await generateCutout({ srcJpg, outPng, name, team, position });
 *
 *   node scripts/hero-batch/generate-cutout.mjs --src public/players/56305.jpg \
 *        --out /tmp/raw.png --name 히우라 --team 키움 --pos 내야수
 *
 * env: GEMINI_API_KEY_HERO (gemini-key.mjs 참조)
 */

import fs from "fs";
import path from "path";
import { getGeminiKey } from "./gemini-key.mjs";

const MODEL = "gemini-3-pro-image-preview";
const MAX_ATTEMPTS = 2;

function guessMime(p) {
  if (/\.png$/i.test(p)) return "image/png";
  if (/\.webp$/i.test(p)) return "image/webp";
  return "image/jpeg";
}

function buildPrompt({ name, team, position }) {
  // phase2-pipeline.sh v5 프롬프트와 동일 — 화각/스타일 일관성 유지.
  return (
    "Official KBO baseball player portrait photograph. Upper body shot from head to chest, " +
    "standing pose facing camera, wearing authentic KBO " +
    `${team} 2025 home uniform with team logo clearly visible. ` +
    "Studio portrait style, soft professional lighting, neutral medium-gray background (#8a8a8a), " +
    "sharp focus, high detail photography. " +
    `The player is ${name}, a ${position} for ${team}. ` +
    "Preserve facial features and likeness from the reference photo exactly."
  );
}

/**
 * 증명사진(srcJpg)을 입력으로 v5 스튜디오 포트레이트 PNG(outPng)를 생성.
 * @param {object} args
 * @param {string} args.srcJpg   KBO 증명사진 경로
 * @param {string} args.outPng   출력 PNG 경로
 * @param {string} args.name
 * @param {string} args.team
 * @param {string} args.position
 * @param {string} [args.resolution="2K"]
 * @returns {Promise<{ok:boolean, attempts:number}>}
 */
export async function generateCutout({ srcJpg, outPng, name, team, position, resolution = "2K" }) {
  const key = getGeminiKey();
  if (!key) throw new Error("GEMINI_API_KEY_HERO missing");
  if (!fs.existsSync(srcJpg)) throw new Error(`source not found: ${srcJpg}`);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
  const srcB64 = fs.readFileSync(srcJpg).toString("base64");
  const prompt = buildPrompt({ name, team, position });

  const body = {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: guessMime(srcJpg), data: srcB64 } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { imageSize: resolution },
    },
  };

  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
        // 429/5xx 는 잠깐 대기 후 재시도
        if (attempt < MAX_ATTEMPTS) await sleep(10_000);
        continue;
      }
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const imgPart = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
      const b64 = imgPart?.inlineData?.data || imgPart?.inline_data?.data;
      if (!b64) {
        lastErr = "no image part in response";
        if (attempt < MAX_ATTEMPTS) await sleep(10_000);
        continue;
      }
      fs.mkdirSync(path.dirname(outPng), { recursive: true });
      fs.writeFileSync(outPng, Buffer.from(b64, "base64"));
      return { ok: true, attempts: attempt };
    } catch (e) {
      lastErr = e.message;
      if (attempt < MAX_ATTEMPTS) await sleep(10_000);
    }
  }
  throw new Error(`generateCutout failed (${MAX_ATTEMPTS} attempts): ${lastErr}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ===== CLI =====
function parseArgs() {
  const a = process.argv.slice(2);
  const get = (f) => {
    const i = a.indexOf(f);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    srcJpg: get("--src"),
    outPng: get("--out"),
    name: get("--name"),
    team: get("--team"),
    position: get("--pos") || "선수",
    resolution: get("--res") || "2K",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs();
  if (!args.srcJpg || !args.outPng || !args.name || !args.team) {
    console.error("usage: --src <jpg> --out <png> --name <name> --team <team> [--pos <pos>] [--res 2K]");
    process.exit(2);
  }
  generateCutout(args)
    .then((r) => {
      console.log(`OK cutout → ${args.outPng} (${r.attempts} attempt)`);
      process.exit(0);
    })
    .catch((e) => {
      console.error("FAIL:", e.message);
      process.exit(1);
    });
}
