#!/usr/bin/env node
/**
 * 신규 외국인 자동 온보딩 분류/리포트 순수 로직 스모크 (A안 슬라이스 1).
 * Usage: node scripts/qa/foreign-onboard-smoke.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildNewlyOnboardedPhotoManifest,
  classifyForeign,
  mergePendingReport,
  checkNewlyOnboardedPhotos,
} from "../lib/foreign-onboard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`✓ ${label}`); }
  else { fail++; console.log(`✗ ${label}`); }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)})`); }

// ===== classifyForeign =====
ok(classifyForeign({ draft: "26 삼성 자유선발", name: "페덱" }) === true, "자유선발 → 외인(페덱)");
ok(classifyForeign({ draft: "25 롯데 자유선발", name: "찰리반스" }) === true, "자유선발 → 외인(공백없는 외인명)");
ok(classifyForeign({ draft: "", name: "가나쿠보 유토" }) === true, "공백 풀네임 → 외인(아시아쿼터)");
ok(classifyForeign({ draft: "", name: "르윈 디아즈" }) === true, "공백 풀네임 → 외인(FP)");
ok(classifyForeign({ draft: "24 1차지명", name: "김영웅" }) === false, "국내 1차지명 → 국내");
ok(classifyForeign({ draft: "23 2차 3라운드", name: "이재현" }) === false, "국내 2차지명 → 국내");
ok(classifyForeign({ draft: "육성선수", name: "홍길동" }) === false, "육성선수 → 국내");
ok(classifyForeign({}) === false, "정보 없음 → 국내(보수적)");
ok(classifyForeign(null) === false, "null → false(방어)");

// ===== mergePendingReport =====
const now = "2026-07-19T00:00:00.000Z";

// 신규 후보 추가
eq(
  mergePendingReport({}, [{ kboId: "56459", name: "페덱", team: "삼성" }], {}, now),
  { "56459": { name: "페덱", team: "삼성", addedAt: now } },
  "빈 리포트 + 신규 1명 → 추가",
);

// 국적이 이미 붙은 항목은 병합 시 자동 소멸
eq(
  mergePendingReport(
    { "56459": { name: "페덱", team: "삼성", addedAt: "2026-07-18T00:00:00.000Z" } },
    [],
    { "56459": "US" },
    now,
  ),
  {},
  "국적 등록되면 기존 pending 제거(자동 소멸)",
);

// 기존 addedAt 보존(중복 추가 금지)
eq(
  mergePendingReport(
    { "56459": { name: "페덱", team: "삼성", addedAt: "2026-07-18T00:00:00.000Z" } },
    [{ kboId: "56459", name: "페덱", team: "삼성" }],
    {},
    now,
  ),
  { "56459": { name: "페덱", team: "삼성", addedAt: "2026-07-18T00:00:00.000Z" } },
  "이미 대기 중이면 addedAt 보존(재추가 안 함)",
);

// 국적 미상 신규 + 국적 붙은 기존 혼재
eq(
  mergePendingReport(
    { "55555": { name: "옛외인", team: "NC", addedAt: "2026-07-01T00:00:00.000Z" } },
    [{ kboId: "56459", name: "페덱", team: "삼성" }],
    { "55555": "DO" },
    now,
  ),
  { "56459": { name: "페덱", team: "삼성", addedAt: now } },
  "해결된 기존 제거 + 신규 추가 동시",
);

// 삼순 NO-GO(81149356) blocker 2 회귀: 신규 온보딩 0명(missing.length===0 경로)이어도
// 사람이 국적을 넣은 기존 pending은 이번 실행에서 그대로 정리되어야 한다(자동 소멸 계약).
eq(
  mergePendingReport(
    { "56459": { name: "페덱", team: "삼성", addedAt: "2026-07-18T00:00:00.000Z" } },
    [],
    { "56459": "US" },
    now,
  ),
  {},
  "신규 온보딩 0명이어도 국적 등록된 기존 pending은 소멸",
);

// ===== checkNewlyOnboardedPhotos (P0 사진 게이트) =====
{
  const files = new Set(["56459"]); // 페덱만 파일 있음
  const idSet = new Set(["56459"]); // 페덱만 PLAYER_PHOTO_ID_SET에 있음
  const deps = { photoFileExists: (id) => files.has(id), idSetHas: (id) => idSet.has(id) };

  eq(checkNewlyOnboardedPhotos([], deps), [], "온보딩 0명 → 누락 없음");

  eq(
    checkNewlyOnboardedPhotos([{ kboId: "56459", name: "페덱", team: "삼성" }], deps),
    [],
    "파일+idSet 둘 다 있으면 통과",
  );

  eq(
    checkNewlyOnboardedPhotos([{ kboId: "99999", name: "가상외인", team: "KT" }], deps),
    [{ kboId: "99999", name: "가상외인", team: "KT", hasFile: false, hasIdSet: false }],
    "CDN 다운로드 실패(파일·idSet 둘 다 없음) → 누락 목록에 포함",
  );

  eq(
    checkNewlyOnboardedPhotos([{ kboId: "77777", name: "부분누락", team: "LG" }], {
      photoFileExists: () => true,
      idSetHas: () => false,
    }),
    [{ kboId: "77777", name: "부분누락", team: "LG", hasFile: true, hasIdSet: false }],
    "파일은 있는데 player-photos.ts 재생성 전(idSet 미반영) → 누락 목록에 포함",
  );
}

// ===== false-negative 분류 → 숫자 id 온보딩 → 실제 사진 게이트 fail 통합 회귀 =====
{
  const detail = { draft: "", name: "페덱" }; // 허용된 휴리스틱 false-negative
  ok(classifyForeign(detail) === false, "페덱 단일명+draft 없음은 외인 휴리스틱 false-negative");

  const manifest = buildNewlyOnboardedPhotoManifest([
    { kboId: "56459", name: detail.name, team: "삼성" },
  ]);
  eq(
    manifest,
    [{ kboId: "56459", name: "페덱", team: "삼성" }],
    "분류 false-negative여도 숫자 id 온보딩은 사진 manifest에 포함",
  );

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-onboard-photo-gate-"));
  try {
    const manifestPath = path.join(fixtureRoot, "manifest.json");
    const photosDir = path.join(fixtureRoot, "players");
    const photosTsPath = path.join(fixtureRoot, "player-photos.ts");
    fs.mkdirSync(photosDir);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(
      photosTsPath,
      "// === GENERATED:PHOTO_ID_SET:BEGIN ===\nexport const PLAYER_PHOTO_ID_SET = new Set([]);\n// === GENERATED:PHOTO_ID_SET:END ===\n",
    );

    const gate = spawnSync(
      process.execPath,
      [path.join(__dirname, "foreign-onboard-photo-gate.mjs")],
      {
        env: {
          ...process.env,
          FOREIGN_ONBOARD_PHOTO_MANIFEST_PATH: manifestPath,
          FOREIGN_ONBOARD_PHOTOS_DIR: photosDir,
          FOREIGN_ONBOARD_PHOTOS_TS_PATH: photosTsPath,
        },
        encoding: "utf8",
      },
    );
    ok(
      gate.status === 1 && gate.stderr.includes("public/players/56459.jpg=MISSING") &&
        gate.stderr.includes("PLAYER_PHOTO_ID_SET=MISSING"),
      "false-negative 온보딩 후 사진/ID_SET 없음 → 실제 gate exit 1",
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
