#!/usr/bin/env node
/**
 * P0 사진 게이트 — 이번 크롤 실행에서 reconcile이 신규 온보딩한 숫자 id 선수마다
 * public/players/{id}.jpg + player-photos.ts PLAYER_PHOTO_ID_SET을 검증한다.
 * (삼순 코드리뷰 NO-GO `81149356`: A안 이전엔 신규 외인을 skip했으므로 사진 누락 위험이 없었으나,
 *  A안 이후 온보딩이 CDN 다운로드 성공 여부와 분리돼 있어 실패해도 PR이 green이 될 수 있었다.)
 *
 * 인계 파일(tmp/reconcile-newly-onboarded-foreign.json)이 없거나 빈 배열이면
 * 이번 실행에서 신규 온보딩된 선수가 없다는 뜻 — PASS.
 *
 * Usage: node scripts/qa/foreign-onboard-photo-gate.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkNewlyOnboardedPhotos } from "../lib/foreign-onboard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const MANIFEST_PATH = process.env.FOREIGN_ONBOARD_PHOTO_MANIFEST_PATH ||
  path.join(ROOT, "tmp/reconcile-newly-onboarded-foreign.json");
const PHOTOS_DIR = process.env.FOREIGN_ONBOARD_PHOTOS_DIR || path.join(ROOT, "public/players");
const PHOTOS_TS_PATH = process.env.FOREIGN_ONBOARD_PHOTOS_TS_PATH ||
  path.join(ROOT, "src/lib/constants/player-photos.ts");
const ID_SET_BEGIN = "// === GENERATED:PHOTO_ID_SET:BEGIN ===";
const ID_SET_END = "// === GENERATED:PHOTO_ID_SET:END ===";

let entries;
try {
  entries = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
} catch {
  console.log("✓ 사진 게이트: 인계 파일 없음(reconcile 미실행 또는 온보딩 0명) — skip");
  process.exit(0);
}

if (!Array.isArray(entries) || entries.length === 0) {
  console.log("✓ 사진 게이트: 이번 실행 신규 온보딩 선수 0명 — PASS");
  process.exit(0);
}

function loadPhotoIdSet() {
  const source = fs.readFileSync(PHOTOS_TS_PATH, "utf8");
  const beginIdx = source.indexOf(ID_SET_BEGIN);
  const endIdx = source.indexOf(ID_SET_END);
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(`[foreign-onboard-photo-gate] PLAYER_PHOTO_ID_SET sentinel 못 찾음: ${PHOTOS_TS_PATH}`);
  }
  const block = source.slice(beginIdx, endIdx);
  return new Set([...block.matchAll(/"(\d+)"/g)].map((m) => m[1]));
}

const idSet = loadPhotoIdSet();
const missing = checkNewlyOnboardedPhotos(entries, {
  photoFileExists: (kboId) => fs.existsSync(path.join(PHOTOS_DIR, `${kboId}.jpg`)),
  idSetHas: (kboId) => idSet.has(kboId),
});

if (missing.length > 0) {
  console.error(`\n✗ 신규 온보딩 선수 사진 게이트 FAILED — ${missing.length}/${entries.length}명 사진 누락/미해석\n`);
  for (const m of missing) {
    console.error(
      `  - ${m.name} (${m.kboId}, ${m.team}): public/players/${m.kboId}.jpg=${m.hasFile ? "OK" : "MISSING"}` +
        ` PLAYER_PHOTO_ID_SET=${m.hasIdSet ? "OK" : "MISSING"}`,
    );
  }
  console.error(`\nupdate-player-photos.mjs 의 CDN 다운로드가 실패했을 가능성이 높습니다.`);
  console.error(`scripts/update-player-photos.mjs 로그를 확인하고, 필요하면 MANUAL_PHOTO_URL_BY_KBO_ID에`);
  console.error(`수동 소스를 추가한 뒤 재실행하세요. (page: /Record/Player/HitterDetail·PitcherDetail)`);
  process.exit(1);
}

console.log(`✓ 사진 게이트: 신규 온보딩 선수 ${entries.length}명 전원 사진 확인 PASS`);
