#!/usr/bin/env node
/**
 * 브랜드 아이콘(앱 아이콘 PNG) 원형 클립 정적 게이트 — 브라우저·계정·env 무의존.
 *
 * 왜 필요한가 (2026-08-15 유저 제보 "크보팬 로고에 흰색 테두리 킹받아요"):
 * 쪽지 목록의 `크보팬 운영팀` 아바타가 원형 슬롯 안에서 **흰 사각형 테두리**로 보였다.
 * 원인은 두 사실의 곱이다.
 *   ① `public/apple-touch-icon.png` 등 앱 아이콘 자산은 **알파가 없고 모서리가 흰색**이다.
 *      (iOS 홈화면 아이콘은 OS 가 마스킹하므로 자산이 꽉 찬 정사각형인 게 정상이다.
 *       즉 자산은 잘못되지 않았다 — 웹에서 원형으로 쓸 때 **우리가** 잘라야 한다.)
 *   ② 아바타 컨테이너가 `rounded-full` 이지만 #1039 에서 야잘알봇 캐릭터를 슬롯 밖으로
 *      넘치게 그리려고 `overflow-hidden` → `overflow-visible` 로 바꿨다. 그 순간
 *      컨테이너의 둥근 모서리는 **자식을 더 이상 잘라주지 않는다.**
 * 따라서 자식 `<img>` 스스로 `rounded-full` 을 갖지 않으면 흰 모서리가 그대로 드러난다.
 *
 * 이 게이트가 잠그는 계약:
 *   A. 자산 사실 검증 — 브랜드 아이콘 PNG 는 실제로 모서리가 흰색이다(= 클립이 필수인 이유).
 *      자산이 언젠가 투명 모서리로 바뀌면 이 검사가 알려주고, 그때 계약을 재검토하면 된다.
 *   B. 사용처 검증 — src 하위 전체 .tsx 안의 모든 브랜드 아이콘 `<img>` 는
 *      자기 className 에 `rounded-full` 을 갖는다. 조상 `overflow-hidden` 에 의존하지 않는다.
 *      (의존하면 조상 한 줄 바뀔 때 조용히 회귀한다 — 실제로 그렇게 회귀했다.)
 *
 * 검증력 증명: `--selftest` 는 (1) rounded-full 없는 사용처 (2) 흰 모서리 아닌 자산
 * 두 결함을 주입해 각각 RED 가 되는지 확인한다.
 */
import path from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "../..");
const SRC = path.join(ROOT, "src");

/** 웹 UI 에서 원형으로 노출되는 브랜드 아이콘 자산(알파 없는 꽉 찬 정사각형). */
export const BRAND_ICON_ASSETS = ["/apple-touch-icon.png", "/icon-192.png", "/app-icon.png"];

/** 모서리가 "흰색"으로 간주되는 임계. 254 는 실측 자산값(254,254,254). */
const WHITE_MIN = 245;
/** 모서리 판정 시 안티에일리어싱을 피해 안쪽으로 들어가지 않는다 — 모서리 픽셀 그 자체를 본다. */
const CORNER_INSET = 0;

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

function listTsx(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsx(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * 브랜드 아이콘 `<img ...>` 태그를 원문에서 뽑는다.
 * 정규식 파싱이지만 대상이 닫힌 집합(자산 3개)이고, 못 찾으면 fail-close(사용처 0 = RED)라
 * 조용히 통과하는 경로가 없다.
 */
export function findBrandIconImgTags(source) {
  const tags = [];
  const re = /<img\b[^>]*?>/gs;
  for (const m of source.matchAll(re)) {
    const tag = m[0];
    const asset = BRAND_ICON_ASSETS.find((a) => tag.includes(`src="${a}"`));
    if (asset) tags.push({ tag, asset });
  }
  return tags;
}

/** 태그 자체가 원형 클립을 갖는지. 조상 overflow 에 의존하지 않는다. */
export function isSelfClipped(tag) {
  return /\brounded-full\b/.test(tag);
}

function checkUsages(files) {
  const found = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const { tag, asset } of findBrandIconImgTags(source)) {
      found.push({ file: path.relative(ROOT, file), asset, clipped: isSelfClipped(tag), tag });
    }
  }
  ok("브랜드 아이콘 사용처를 1건 이상 찾았다(파서 fail-close)", found.length > 0, `found=${found.length}`);
  for (const u of found) {
    ok(
      `${u.file} — ${u.asset} 가 self-clip(rounded-full)`,
      u.clipped,
      u.clipped ? "" : `조상 overflow 에 의존 중: ${u.tag.replace(/\s+/g, " ").slice(0, 140)}`,
    );
  }
  return found;
}

async function cornerColors(assetPath) {
  const img = sharp(assetPath);
  const meta = await img.metadata();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2], info.channels === 4 ? data[i + 3] : 255];
  };
  const c = CORNER_INSET;
  return {
    meta,
    corners: [
      px(c, c),
      px(info.width - 1 - c, c),
      px(c, info.height - 1 - c),
      px(info.width - 1 - c, info.height - 1 - c),
    ],
  };
}

async function checkAssets(assets = BRAND_ICON_ASSETS) {
  for (const asset of assets) {
    const assetPath = path.join(ROOT, "public", asset.replace(/^\//, ""));
    const { corners } = await cornerColors(assetPath);
    const allWhite = corners.every(([r, g, b, a]) => a > 8 && r >= WHITE_MIN && g >= WHITE_MIN && b >= WHITE_MIN);
    ok(
      `${asset} 모서리가 불투명 흰색(= 원형 클립이 필수인 근거)`,
      allWhite,
      `corners=${JSON.stringify(corners)}`,
    );
  }
}

async function main() {
  const selftest = process.argv.includes("--selftest");
  console.log("🎯 브랜드 아이콘 원형 클립 게이트\n");

  console.log("① 자산 사실(모서리 흰색)");
  await checkAssets();

  console.log("\n② 사용처 self-clip");
  checkUsages(listTsx(SRC));

  if (selftest) {
    console.log("\n③ selftest — 결함 주입 시 RED 인지");
    const brokenTag = `<img src="/apple-touch-icon.png" alt="크보팬" className="w-full h-full object-cover" />`;
    const goodTag = `<img src="/apple-touch-icon.png" alt="크보팬" className="w-full h-full rounded-full object-cover" />`;
    ok("주입1: rounded-full 없는 사용처를 미클립으로 판정", isSelfClipped(brokenTag) === false);
    ok("주입1 대조: rounded-full 있으면 클립으로 판정", isSelfClipped(goodTag) === true);

    const transparentCorner = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const { corners } = await (async () => {
      const img = sharp(transparentCorner);
      const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
      const px = (x, y) => {
        const i = (y * info.width + x) * info.channels;
        return [data[i], data[i + 1], data[i + 2], data[i + 3]];
      };
      return { corners: [px(0, 0), px(7, 0), px(0, 7), px(7, 7)] };
    })();
    const wouldPass = corners.every(([r, g, b, a]) => a > 8 && r >= WHITE_MIN && g >= WHITE_MIN && b >= WHITE_MIN);
    ok("주입2: 투명 모서리 자산은 '흰 모서리' 판정에서 RED", wouldPass === false, JSON.stringify(corners));

    const parsed = findBrandIconImgTags(`<div><img src="/nope.png" /></div>`);
    ok("주입3: 브랜드 자산이 아니면 수집하지 않는다", parsed.length === 0);
  }

  console.log(`\n${fails.length === 0 ? "✅" : "❌"} PASS ${pass} / FAIL ${fails.length}`);
  if (fails.length) {
    for (const f of fails) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("게이트 실행 실패(판정 불능 = RED):", err);
  process.exit(1);
});
