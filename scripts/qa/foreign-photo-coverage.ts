// @crawl-managed-read: structural  (크롤 관리 데이터 파일을 구조·불변식 검증에만 사용 — 값 하드코딩 금지, 축② 순환참조 메타게이트)
/**
 * Foreign player photo coverage gate.
 *
 * 외국인 선수 사진이 _재발하지 않도록_ 잠그는 CI 가드.
 *
 * 검증 대상: roster에 등록된 모든 외국인 선수 (kboId가 FP/AQ/TR로 시작).
 *
 * 각 선수에 대해 5가지 입력 변형을 모두 통과해야 한다:
 *   1. canonical alpha kboId  (예: "FP008")
 *   2. KBO 공식 숫자 kboId    (예: "53827", FOREIGN_ALPHA_TO_NUMERIC에 존재하는 경우만)
 *   3. 풀네임 + 팀ID          (예: { name: "기예르모 에레디아", teamId: 4 })
 *   4. 축약 last-token + 팀ID  (예: { name: "에레디아", teamId: 4 })
 *   5. 축약 last-token 단독    (homonym 없을 때만; 동명이인 있으면 skip로 카운트)
 *
 * 각 입력은 다음을 만족해야 한다:
 *   a. resolvePlayer가 정확히 canonical alpha kboId를 반환
 *   b. getPlayerPhotoUrl이 non-null 반환
 *
 * 하나라도 실패하면 process.exit(1) — CI/prebuild 단계에서 차단.
 *
 * 배경:
 *   - 4/23 693ceadf에서 resolvePlayer SSOT를 만들었지만 컴포넌트 Phase 3가 미완.
 *   - 5/15 1루 주자 에레디아 사진 누락 — 이전과 동일한 _재발_ 패턴.
 *   - 본 가드 없이는 "이번엔 다르다" 주장이 자동 enforceable 하지 않다.
 */

import fs from "node:fs";
import path from "node:path";
import playersRoster from "../../src/lib/constants/players-roster.json";
import heroApproved from "../../src/lib/constants/hero-approved-kboids.json";
import {
  FOREIGN_ALPHA_TO_NUMERIC,
} from "../../src/lib/constants/foreign-id-map";
import { resolvePlayer } from "../../src/lib/utils/resolve-player";
import { getPlayerPhotoUrl } from "../../src/lib/constants/player-photos";

const PUBLIC_DIR = path.resolve(__dirname, "../../public");

function publicFileExists(urlPath: string): boolean {
  // urlPath = "/players/FP008.jpg" → public/players/FP008.jpg
  const rel = urlPath.startsWith("/") ? urlPath.slice(1) : urlPath;
  return fs.existsSync(path.join(PUBLIC_DIR, rel));
}

interface RosterEntry {
  name: string;
  kboId: string;
  teamId: number;
  team: string;
  position: string;
  backNo: string;
}

const roster = playersRoster as RosterEntry[];
const foreigners = roster.filter((p) => /^(FP|AQ|TR)/.test(p.kboId));

if (foreigners.length === 0) {
  console.error("✗ roster에서 외국인 선수가 0명 검출되었습니다 — roster JSON 손상 가능성.");
  process.exit(2);
}

interface CaseResult {
  player: string;       // 풀네임
  expectedId: string;   // canonical alpha
  variant: string;      // 변형 라벨
  pass: boolean;
  reason?: string;
}

const results: CaseResult[] = [];

function check(variant: string, expected: RosterEntry, query: unknown, photoNameInput: string): void {
  const resolved = resolvePlayer(query as never);
  if (!resolved) {
    results.push({
      player: expected.name,
      expectedId: expected.kboId,
      variant,
      pass: false,
      reason: "resolvePlayer → null",
    });
    return;
  }
  if (resolved.kboId !== expected.kboId) {
    results.push({
      player: expected.name,
      expectedId: expected.kboId,
      variant,
      pass: false,
      reason: `resolved.kboId=${resolved.kboId} (expected ${expected.kboId})`,
    });
    return;
  }
  const photoUrl = getPlayerPhotoUrl(photoNameInput, resolved.kboId, expected.teamId);
  if (!photoUrl) {
    results.push({
      player: expected.name,
      expectedId: expected.kboId,
      variant,
      pass: false,
      reason: `getPlayerPhotoUrl(name=${JSON.stringify(photoNameInput)}, kboId=${resolved.kboId}) → null`,
    });
    return;
  }
  if (!publicFileExists(photoUrl)) {
    results.push({
      player: expected.name,
      expectedId: expected.kboId,
      variant,
      pass: false,
      reason: `photo URL ${photoUrl} → 파일이 public/ 에 없음`,
    });
    return;
  }
  results.push({
    player: expected.name,
    expectedId: expected.kboId,
    variant,
    pass: true,
  });
}

// Build short-name homonym index up front (last token by space).
const shortTokenCounts = new Map<string, number>();
for (const p of foreigners) {
  const short = p.name.split(/\s+/).pop() ?? p.name;
  shortTokenCounts.set(short, (shortTokenCounts.get(short) ?? 0) + 1);
}

let skipped = 0;

for (const p of foreigners) {
  const shortName = p.name.split(/\s+/).pop() ?? p.name;

  // 1. canonical alpha kboId
  check("alpha-kboId", p, p.kboId, p.name);

  // 2. numeric kboId (외국인은 FOREIGN_ALPHA_TO_NUMERIC에 있는 경우만)
  const numeric = FOREIGN_ALPHA_TO_NUMERIC[p.kboId];
  if (numeric) {
    check("numeric-kboId", p, numeric, p.name);
  } else {
    skipped++; // map에 없는 신규 외국인은 numeric 검증 skip — 정상 (KBO 공식 사이트에 ID 없음)
  }

  // 3. 풀네임 + 팀ID
  check("fullname+teamId", p, { name: p.name, teamId: p.teamId }, p.name);

  // 4. 축약 last-token + 팀ID
  if (shortName !== p.name) {
    check("shortname+teamId", p, { name: shortName, teamId: p.teamId }, shortName);
  }

  // 5. 축약 last-token 단독 — homonym이 없는 경우만
  if (shortName !== p.name && (shortTokenCounts.get(shortName) ?? 0) === 1) {
    check("shortname-only", p, { name: shortName }, shortName);
  }
}

// Hero cutout coverage — hero-approved 목록에 들어간 외국인은 hero webp 파일이 존재해야 한다.
const heroApprovedSet = new Set(heroApproved as string[]);
for (const p of foreigners) {
  if (!heroApprovedSet.has(p.kboId)) continue;
  const heroPath = `/players-hero/${p.kboId}.webp`;
  if (!publicFileExists(heroPath)) {
    results.push({
      player: p.name,
      expectedId: p.kboId,
      variant: "hero-webp",
      pass: false,
      reason: `hero approved지만 ${heroPath} 파일 누락`,
    });
  } else {
    results.push({
      player: p.name,
      expectedId: p.kboId,
      variant: "hero-webp",
      pass: true,
    });
  }
}

const fails = results.filter((r) => !r.pass);
const passes = results.length - fails.length;

if (fails.length > 0) {
  console.error("\n✗ Foreign player photo coverage FAILED\n");
  for (const f of fails) {
    console.error(`  - ${f.player} (${f.expectedId}) [${f.variant}]: ${f.reason}`);
  }
  console.error(`\n${passes} pass, ${fails.length} fail, ${skipped} skip (no numeric ID in FOREIGN_ALPHA_TO_NUMERIC)`);
  console.error(`\n외국인 ${foreigners.length}명 × 5 input forms 검증 중 일부가 통과하지 못했습니다.`);
  console.error(`이대로 머지하면 사진 누락이 재발합니다. 위 변형에 대해:`);
  console.error(`  - resolvePlayer 매칭 규칙을 보완하거나`);
  console.error(`  - roster JSON / FOREIGN_ALPHA_TO_NUMERIC / PLAYER_PHOTO_ID_SET을 보강하세요.`);
  process.exit(1);
}

console.log(`✓ Foreign player photo coverage PASSED`);
console.log(`  외국인 ${foreigners.length}명 × 5 input forms (총 ${results.length} 케이스)`);
console.log(`  ${passes} pass, 0 fail, ${skipped} skip`);
