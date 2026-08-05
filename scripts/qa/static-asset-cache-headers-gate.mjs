#!/usr/bin/env node
/**
 * /public 정적자산 Cache-Control 계약 게이트 (브라우저·계정·env 무의존).
 *
 * 배경 (2026-08-05 production 실측):
 * `/public` 하위 자산이 전부 Vercel 기본값 `public, max-age=0, must-revalidate` 로 나갔다.
 * `_next/static` 은 `max-age=31536000, immutable` 인데 `/public` 만 빠져 있어서,
 * 재방문마다 878개 hero webp / 920개 선수 jpg / 브랜드 이미지가 매번 revalidate 요청을
 * 보낸다. 304 라 바이트는 작지만 **요청 1건 = Edge Request 1건**은 그대로 과금된다.
 *
 * 이 게이트가 잠그는 계약:
 *   ① `/sw.js` 는 반드시 no-store 유지 — 여기에 장수명 캐시가 걸리면 SW 업데이트가 막혀
 *      구버전 SW 가 영구히 살아남는다(치명적 회귀). 어떤 신규 rule 도 sw.js 를 잡으면 안 된다.
 *   ② 선수 사진(`/players-hero`,`/players`)은 개별 파일이 교체되므로(3개월간 835/1802 파일
 *      수정) immutable 금지. max-age 상한을 둔다.
 *   ③ 사실상 불변 자산(로고·국기·마스코트 등)은 장수명 캐시 + SWR.
 *   ④ 커버리지: production 홈 1회 로드에서 실제로 요청되는 /public 경로가 전부 rule 에
 *      매칭돼야 한다(rule 을 넣었는데 경로가 안 잡히는 false-green 차단).
 *
 * 매칭은 Vercel/Next 가 실제로 쓰는 path-to-regexp 로 판정한다(정규식 추론 금지).
 *
 * `--selftest` 는 결함 주입으로 RED 를 증명한다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ptr from "next/dist/compiled/path-to-regexp/index.js";
const { pathToRegexp } = ptr;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERCEL_JSON = path.join(HERE, "../../vercel.json");

const SW_PATH = "/sw.js";
// 선수 사진 max-age 상한(초). 사진 교체가 하루 넘게 안 보이면 회귀로 본다.
const PHOTO_MAX_AGE_CEIL = 21600; // 6h
// 장수명 자산 최소 max-age(초). 이보다 짧으면 재방문 revalidate 가 계속 나간다.
const LONG_MIN_MAX_AGE = 3600;

/** production 홈 1회 로드에서 실제 관측된 /public 요청 경로(2026-08-05 Playwright 실측). */
const OBSERVED_PUBLIC_PATHS = [
  "/players-hero/78122.webp",
  "/players/78122.jpg",
  "/logo-mark.png",
  "/logo-mark-light.png",
  "/logo.png",
  "/og-image.png",
  "/icon-512.png",
  "/team-logos/lg.svg",
  "/flags/us.svg",
  "/mascot/yajalal-avatar.png",
  "/avatars/cap.svg",
  "/broadcast-logos/S-T.svg",
  "/icons/icon-192x192.png",
];

function matchers(config) {
  return (config.headers || []).map((rule) => {
    const re = pathToRegexp(rule.source);
    const cc = (rule.headers || []).find((h) => h.key.toLowerCase() === "cache-control");
    return { source: rule.source, re, cc: cc ? cc.value : null };
  });
}

/** Vercel 은 매칭되는 모든 rule 의 헤더를 적용하고, 같은 key 는 뒤쪽 rule 이 이긴다. */
function resolveCacheControl(rules, p) {
  let hit = null;
  for (const r of rules) {
    if (r.re.test(p) && r.cc !== null) hit = r;
  }
  return hit;
}

function maxAgeOf(cc) {
  const m = /max-age=(\d+)/.exec(cc || "");
  return m ? Number(m[1]) : null;
}

function check(config) {
  const rules = matchers(config);
  const fails = [];
  const pass = [];

  // ① sw.js 는 no-store 여야 하고 장수명 rule 에 잡히면 안 된다
  const sw = resolveCacheControl(rules, SW_PATH);
  if (!sw) fails.push(`sw.js 에 Cache-Control rule 이 없다`);
  else if (!/no-store/.test(sw.cc)) fails.push(`sw.js Cache-Control 이 no-store 가 아니다: "${sw.cc}" (rule: ${sw.source})`);
  else pass.push(`sw.js no-store 유지 (rule ${sw.source})`);
  const swAge = maxAgeOf(sw?.cc);
  if (swAge !== null && swAge > 0) fails.push(`sw.js 에 max-age=${swAge} 가 걸렸다 — SW 업데이트가 막힌다`);

  // ②③④ 관측 경로 전수
  for (const p of OBSERVED_PUBLIC_PATHS) {
    const hit = resolveCacheControl(rules, p);
    if (!hit) { fails.push(`커버리지 결손: ${p} 가 어떤 rule 에도 안 잡힌다(기본 max-age=0 유지)`); continue; }
    const age = maxAgeOf(hit.cc);
    if (age === null || age <= 0) { fails.push(`${p} max-age 가 0/부재: "${hit.cc}"`); continue; }
    if (/immutable/.test(hit.cc)) { fails.push(`${p} 에 immutable 금지(파일이 교체된다): "${hit.cc}"`); continue; }
    const isPhoto = p.startsWith("/players-hero/") || p.startsWith("/players/");
    if (isPhoto) {
      if (age > PHOTO_MAX_AGE_CEIL) { fails.push(`${p} max-age=${age} 가 상한 ${PHOTO_MAX_AGE_CEIL} 초과 — 사진 교체 반영이 늦는다`); continue; }
    } else if (age < LONG_MIN_MAX_AGE) {
      fails.push(`${p} max-age=${age} 가 하한 ${LONG_MIN_MAX_AGE} 미만 — 재방문 revalidate 가 계속 나간다`); continue;
    }
    pass.push(`${p} → ${hit.cc}`);
  }

  return { fails, pass };
}

function run(label, config) {
  const { fails, pass } = check(config);
  for (const p of pass) console.log(`  PASS ${p}`);
  for (const f of fails) console.log(`  FAIL ${f}`);
  console.log(`${label}: PASS ${pass.length} / FAIL ${fails.length}`);
  return fails.length;
}

const config = JSON.parse(readFileSync(VERCEL_JSON, "utf8"));

if (process.argv.includes("--selftest")) {
  let bad = 0;
  const clone = () => JSON.parse(JSON.stringify(config));
  const cases = [
    ["A. sw.js 를 장수명 rule 로 덮음", () => { const c = clone();
      c.headers.push({ source: "/:file*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] }); return c; }],
    ["B. 선수사진 rule 제거(커버리지 결손)", () => { const c = clone();
      c.headers = c.headers.filter((r) => !r.source.startsWith("/players")); return c; }],
    ["C. 선수사진에 immutable", () => { const c = clone();
      for (const r of c.headers) if (r.source.startsWith("/players")) r.headers[0].value = "public, max-age=3600, immutable"; return c; }],
    ["D. 장수명 자산 max-age 를 0 으로", () => { const c = clone();
      for (const r of c.headers) if (r.source.startsWith("/team-logos")) r.headers[0].value = "public, max-age=0, must-revalidate"; return c; }],
  ];
  for (const [name, mutate] of cases) {
    console.log(`\n--- selftest ${name} ---`);
    const n = run("mutation", mutate());
    if (n === 0) { console.log(`  ❌ 이 mutation 이 RED 를 못 만들었다 — 게이트 검증력 없음`); bad++; }
    else console.log(`  ✅ RED (FAIL ${n})`);
  }
  console.log(`\nselftest 결과: 검증력 없는 mutation ${bad}건`);
  process.exit(bad === 0 ? 0 : 1);
}

console.log("=== /public 정적자산 Cache-Control 게이트 ===");
process.exit(run("baseline", config) === 0 ? 0 : 1);
