#!/usr/bin/env node
/**
 * `_rsc` prefetch 예산 게이트 — Edge Request 폭증 회귀 차단.
 *
 * 배경 (2026-08-05 production 실측, Playwright 390px):
 * 홈 1회 로드에서 keubo.fan 요청 131건 중 `_rsc` prefetch 가 **56건**이었다.
 * `/api/*` 는 2건뿐이라, Edge 184M 의 주축은 API 가 아니라 RSC prefetch 다.
 *
 *   로드 직후 56건 → 스크롤 3왕복 후 72건 / 고유 경로 22개 = **중복률 69%**
 *   `/community/all-posts` 한 경로가 7번, `/standings`·`/players`·`/teams` 각 5번
 *
 * 원인: `<Link>` 가 전부 Next 기본 prefetch 라 뷰포트 진입마다 RSC payload 를 당긴다.
 * 게다가 `_rsc` 캐시키가 요청마다 달라(`1r34m`,`1pn8p`,`nn07o`...) 라우터 dedupe 도
 * 안 걸리고, 응답이 `max-age=0, must-revalidate` 라 재방문에도 그대로 다시 나간다
 * (SW 등록/차단 A/B 무관 — 둘 다 56건 실측).
 *
 * ⚠️ `experimental.staleTimes.dynamic` 은 해법이 아니다:
 * `dynamic: 0 → 30` 으로 올려 production build + start 로 A/B 했으나
 * **56건 → 56건, 중복률 69% 동일**. 효과 0 이라 채택하지 않았다.
 * 실제로 듣는 축은 `prefetch={false}` 뿐이었다(56 → 1건).
 *
 * 이 게이트가 잠그는 계약:
 *   ① 홈 초기 렌더 트리의 내비게이션 `<Link>` 는 명시적 `prefetch` 를 가진다.
 *      (기본값 복귀 = Edge Request 회귀)
 *   ② 그 값은 `{false}` 여야 한다.
 *   ③ 커버리지: 아래 파일 목록이 실재하고, 각 파일의 `<Link>` 개수가 기대치와 같다.
 *      (파일이 리팩터링돼 Link 가 늘어났는데 게이트가 못 보는 false-green 차단)
 *
 * 판정은 소스 문자열이 아니라 **빌드된 파일의 JSX 여는 태그**를 파싱해서 한다.
 *
 * `--selftest` 는 결함 주입으로 RED 를 증명한다.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "../..");

/**
 * 홈 초기 렌더 트리에서 `_rsc` prefetch 를 유발하던 파일과 그 `<Link>` 개수.
 * 개수는 2026-08-05 실측 기준. 늘어나면 게이트가 FAIL 하고, 새 Link 도 명시적으로
 * 판단하게 만든다(자동 통과 금지).
 */
const TARGETS = [
  { file: "src/app/(main)/layout.tsx", links: 2, why: "푸터 약관·개인정보 — 클릭률 극저" },
  { file: "src/components/ui/TabBar.tsx", links: 1, why: "하단 5탭 — 전 페이지에 상주" },
  { file: "src/components/ui/HeaderProfileLink.tsx", links: 2, why: "헤더 쪽지·마이 — 전 페이지 상주" },
  { file: "src/components/home/CommunityLatestPosts.tsx", links: 3, why: "홈 최신글 목록 + 더보기 2개" },
  { file: "src/components/home/HomeClientShell.tsx", links: 4, why: "홈 티켓·구장 등 진입 카드" },
  { file: "src/components/home/MyTeamHero.tsx", links: 1, why: "내 팀 경기 카드" },
  { file: "src/components/home/TodayGamesSection.tsx", links: 1, why: "오늘 경기 카드(경기 수만큼 반복)" },
  { file: "src/components/home/AllStarGameCard.tsx", links: 1, why: "올스타 카드" },
  { file: "src/components/game/CompactGameCard.tsx", links: 1, why: "경기 카드(홈·팀탭 반복 렌더)" },
];

/** JSX `<Link ...>` 여는 태그를 잘라낸다(자식/닫는 태그 무시). */
function openTags(src) {
  const out = [];
  let i = 0;
  for (;;) {
    const j = src.indexOf("<Link", i);
    if (j < 0) break;
    // `<Linkage` 같은 오탐 방지: 다음 문자가 공백/개행/`>` 여야 한다
    const next = src[j + 5];
    if (next && !/[\s>]/.test(next)) { i = j + 5; continue; }
    const k = src.indexOf(">", j);
    if (k < 0) break;
    out.push(src.slice(j, k + 1));
    i = k + 1;
  }
  return out;
}

function check(readFile) {
  const fails = [];
  const pass = [];
  for (const t of TARGETS) {
    const abs = path.join(ROOT, t.file);
    let src;
    try { src = readFile(abs, t.file); } catch {
      fails.push(`파일 없음: ${t.file} (리팩터링됐다면 게이트 TARGETS 를 갱신해야 한다)`);
      continue;
    }
    const tags = openTags(src);
    if (tags.length !== t.links) {
      fails.push(`${t.file}: <Link> ${tags.length}개 (기대 ${t.links}개) — 새 Link 는 prefetch 정책을 명시적으로 정해야 한다`);
      continue;
    }
    let bad = 0;
    for (const tag of tags) {
      if (!/prefetch\s*=/.test(tag)) { bad++; continue; }
      if (!/prefetch=\{false\}/.test(tag)) bad++;
    }
    if (bad > 0) fails.push(`${t.file}: prefetch={false} 아닌 <Link> ${bad}개 — ${t.why}`);
    else pass.push(`${t.file} (${tags.length}개) — ${t.why}`);
  }
  return { fails, pass };
}

function run(label, readFile) {
  const { fails, pass } = check(readFile);
  for (const p of pass) console.log(`  PASS ${p}`);
  for (const f of fails) console.log(`  FAIL ${f}`);
  console.log(`${label}: PASS ${pass.length} / FAIL ${fails.length}`);
  return fails.length;
}

const realRead = (abs) => {
  if (!existsSync(abs)) throw new Error("missing");
  return readFileSync(abs, "utf8");
};

if (process.argv.includes("--selftest")) {
  let bad = 0;
  const cases = [
    ["A. TabBar prefetch 제거(기본값 복귀)", (abs, rel) => {
      const s = realRead(abs);
      return rel.endsWith("TabBar.tsx") ? s.replace(/prefetch=\{false\}\s*/g, "") : s;
    }],
    ["B. prefetch={true} 로 뒤집음", (abs, rel) => {
      const s = realRead(abs);
      return rel.endsWith("CommunityLatestPosts.tsx") ? s.replace(/prefetch=\{false\}/g, "prefetch={true}") : s;
    }],
    ["C. Link 신규 추가(커버리지 결손)", (abs, rel) => {
      const s = realRead(abs);
      return rel.endsWith("HeaderProfileLink.tsx") ? s + '\n// <Link href="/x">신규</Link>\n' : s;
    }],
    ["D. 대상 파일 삭제", (abs, rel) => {
      if (rel.endsWith("MyTeamHero.tsx")) throw new Error("missing");
      return realRead(abs);
    }],
  ];
  for (const [name, reader] of cases) {
    console.log(`\n--- selftest ${name} ---`);
    const n = run("mutation", reader);
    if (n === 0) { console.log("  ❌ 이 mutation 이 RED 를 못 만들었다 — 게이트 검증력 없음"); bad++; }
    else console.log(`  ✅ RED (FAIL ${n})`);
  }
  console.log(`\nselftest 결과: 검증력 없는 mutation ${bad}건`);
  process.exit(bad === 0 ? 0 : 1);
}

console.log("=== _rsc prefetch 예산 게이트 ===");
process.exit(run("baseline", realRead) === 0 ? 0 : 1);
