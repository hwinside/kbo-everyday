#!/usr/bin/env node
/**
 * End-User QA: 글 공개범위 라벨 (#1121)
 *
 * 하린아빠 P0: 개인/공유 계정 사용 금지 → 전용 테스트 계정을 새로 만들고 끝나면 지운다.
 *
 * 왜 이 스크립트인가:
 *   서버/DB PASS 만으로는 마감할 수 없다(AGENTS.md End-User Level QA 원칙).
 *   실제 로그인 세션으로 진짜 화면을 띄워, 유저가 보는 배지 텍스트를 읽는다.
 *
 * 검증:
 *   1. 10팀 전부      → "전체구단 공개"
 *   2. 1팀            → 그 팀 배지
 *   3. 3팀            → 각 팀 배지 3개 (외 n팀 없음)
 *   4. 4팀            → 앞 3팀 + "외 1팀"   ← 사용자 선택 순서 보존
 *   5. 태그 0개(레거시) → "전체구단 공개" 폴백
 *   6. 홈 최신글 compact 라벨도 동일 스코프
 *   7. 320px 폭에서 라벨이 잘리거나 줄바꿈으로 깨지지 않음
 *   8. DB 경계: 무태그 INSERT 는 실제 로그인 유저 권한으로도 거절(23514)
 *
 * 이 게이트의 위치: **수동 Production E2E**. required/prebuild 에 올리지 않는다 —
 *   실제 계정과 글을 생성하므로 빌드마다 돌릴 성격이 아니다. 배포 후 회귀 확인용.
 *
 * 사용법 (Production 은 --allow-production 명시 필수):
 *   npm run qa:ui:post-scope-label
 *   node scripts/qa/ui-smoke-post-scope-label.mjs --base-url=https://keubo.fan --allow-production
 *   node scripts/qa/ui-smoke-post-scope-label.mjs --base-url=http://localhost:3003
 *   … --headed   # 브라우저 창 열기
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPABASE_URL, ANON, SERVICE_ROLE, BASE } from "./_env.mjs";

const { chromium } = playwright;
const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(__dirname, "../../tmp/qa-screenshots");
mkdirSync(SHOT_DIR, { recursive: true });

const HEADED = process.argv.includes("--headed");
const BASE_URL = process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] || BASE;

// ── Production 안전장치 (fail-closed) ──────────────────────────────────
// `_env.mjs` 는 기본값으로 Production URL + service_role 을 준다. 이 스크립트는 계정과
// 글을 **생성하고 지우므로**, 인자 없이 돌리면 아무 경고 없이 운영 DB 를 건드린다.
//
// ⚠️ 자체결함 이력(삼순 NO-GO 2026-08-07 ①): 첫 판본은 **웹 주소(BASE_URL)만** 보고 판정했다.
//   그러나 계정·글이 생기는 곳은 웹이 아니라 **DB** 이고, DB 는 `SUPABASE_URL` 이라 항상 운영이다.
//   즉 `--base-url=http://localhost:3003` 을 주면 가드는 통과하는데 데이터는 그대로 운영에
//   쌓인다 — 가드가 막아야 할 바로 그 일을 못 막았다.
//   → **쓰기가 일어나는 대상(DB)을 주 판정축**으로 삼고, 웹은 보조로 둔다.
//     둘 중 하나라도 운영이면 명시적 동의를 요구한다.
const PROD_WEB_HOSTS = ["keubo.fan", "www.keubo.fan", "kbo-everyday.vercel.app"];
const PROD_DB_REF = "lbmbdjgsnenqjwjotoei"; // 크보팬 운영 Supabase 프로젝트 ref
const targetHost = (() => { try { return new URL(BASE_URL).host; } catch { return String(BASE_URL); } })();
const dbRef = SUPABASE_URL?.match(/https:\/\/([a-z0-9]+)/)?.[1] ?? "";
const webIsProd = PROD_WEB_HOSTS.includes(targetHost);
const dbIsProd = dbRef === PROD_DB_REF;
if ((webIsProd || dbIsProd) && !process.argv.includes("--allow-production")) {
  console.error(
    `\n❌ 거부: Production 을 대상으로 합니다.\n` +
    `   · 웹  : ${targetHost} ${webIsProd ? "(운영)" : "(비운영)"}\n` +
    `   · DB  : ${dbRef} ${dbIsProd ? "(운영)" : "(비운영)"}   ← 계정·글이 실제로 쌓이는 곳\n` +
    `   이 스크립트는 전용 테스트 계정과 글을 실제로 생성하고 지웁니다.\n` +
    `   의도한 것이 맞다면 --allow-production 을 붙이세요.\n` +
    `   비운영으로 돌리려면 웹뿐 아니라 **DB 자격증명까지** 바꿔야 합니다\n` +
    `   (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).\n`,
  );
  process.exit(2);
}

// ── 수동 게이트 계약: prebuild/required 에 들어가 있으면 안 된다 ──────────────
// ⚠️ 삼순 NO-GO 2026-08-07 ④ — 직전 보고에 "미포함을 스크립트가 assert" 라고 썼지만
//   실제로는 커밋 때 사람이 한 번 확인한 게 전부였다. **없는 안전장치를 있다고 보고했다.**
//   이 스크립트는 실계정·실글을 만드므로 prebuild 에 섮이면 배포마다 운영 DB 에
//   계정이 생긴다. 런타임에서 실제로 막는다.
{
  const pkgPath = resolve(__dirname, "../../package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const inPrebuild = (pkg.scripts?.prebuild ?? "").includes("qa:ui:post-scope-label");
  if (inPrebuild) {
    console.error(
      `\n❌ 거부: 이 게이트가 prebuild 에 등록돼 있습니다.\n` +
      `   실계정·실글을 생성하므로 빌드마다 돌릴 수 없습니다. 수동 게이트로 유지하세요.\n`,
    );
    process.exit(2);
  }
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
let passCount = 0;
let failCount = 0;
const check = (name, cond, msg) => {
  if (cond) { console.log(`  ✅  ${name}`); passCount++; }
  else { console.log(`  ❌  ${name}  ${msg ?? ""}`); failCount++; }
};

const STAMP = Date.now().toString(36);
const email = `qa-scope-${STAMP}@keubo.fan`;
const pw = "QaScope!" + STAMP;

// 앱과 같은 SSOT 를 쓴다 — 여기서 팀 목록을 다시 적으면 앱이 바뀌어도 QA 가 안 따라간다.
const TEAM_ORDER = ["lg", "doosan", "kt", "ssg", "nc", "kia", "lotte", "samsung", "hanwha", "kiwoom"];
const SHORT = {
  lg: "LG", doosan: "두산", kt: "KT", ssg: "SSG", nc: "NC",
  kia: "KIA", lotte: "롯데", samsung: "삼성", hanwha: "한화", kiwoom: "키움",
};

let userId = null;
const postIds = [];

/**
 * 전용 테스트 계정·글 정리.
 *
 * ⚠️ 삼순 NO-GO 2026-08-07 ② — 종전 판본은 삭제 오류를 통째로 삼켰다.
 *   정리가 실패해도 "정리 완료" 를 찍고 전체 PASS 로 끝난다 — 운영 DB 에 QA 계정과
 *   글이 쌓이는데도 모르게 된다. 이건 보고가 아니라 **검사 항목**이어야 한다.
 *   → 각 삭제의 error 를 판정하고, 마지막에 **잔여물을 재조회**해 0건을 확인한다.
 */
async function cleanup() {
  log("정리 중…");
  if (postIds.length) {
    const { error } = await admin.from("posts").delete().in("id", postIds);
    check("cleanup: QA 글 삭제 성공", !error, error?.message);
  }
  if (userId) {
    const { error: pErr } = await admin.from("profiles").delete().eq("id", userId);
    check("cleanup: QA 프로필 삭제 성공", !pErr, pErr?.message);
    const { error: uErr } = await admin.auth.admin.deleteUser(userId);
    check("cleanup: QA 계정 삭제 성공", !uErr, uErr?.message);
  }

  // 삭제 호출이 성공을 리턴해도 실제로 남았을 수 있다(RLS·캐스케이드 등).
  // 잔여물을 직접 조회해 0건을 확인하는 게 유일한 근거다.
  // query-guard: bounded -- 이번 실행이 만든 픽스처는 6건뿐이고 STAMP 로 이 런만 지정한다.
  //   삭제가 완전하면 0건, 실패해도 상한이 그만큼이라 limit(20) 으로 충분하며 컬렉션이 자라지 않는다.
  const { data: leftPosts } = await admin
    .from("posts").select("id").like("title", `%QA-SCOPE-${STAMP}%`).limit(20);
  check("cleanup: QA 글 잔여물 0건", (leftPosts?.length ?? 0) === 0, `${leftPosts?.length}건 잔존`);
  if (userId) {
    const { data: leftUser } = await admin.auth.admin.getUserById(userId);
    check("cleanup: QA 계정 잔여물 0건", !leftUser?.user, `계정 ${userId} 잔존`);
  }
  log("정리 완료 (전용 테스트 계정 삭제)");
}

async function main() {
  console.log(`\n글 공개범위 라벨 End-User QA — ${BASE_URL}\n`);

  // ── 전용 테스트 계정 생성 ────────────────────────────────────────────────
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password: pw, email_confirm: true,
  });
  if (cErr) throw cErr;
  userId = created.user.id;
  await admin.from("profiles").insert({
    id: userId, nickname: `QA스코프${STAMP.slice(-4)}`, team_id: 1, grade: "member", points: 0,
  });
  log(`전용 테스트 계정 생성: ${email}`);

  // ── 픽스처: 각 경계마다 글 1개 ───────────────────────────────────────────
  // 4팀 케이스는 구단 기본 순서와 **다른 순서**로 넣는다. 기본 순서로 재정렬하는
  // 잘못된 구현이면 여기서 드러난다.
  const rev4 = ["ssg", "kt", "doosan", "lg"];
  const cases = [
    { key: "all10", tags: TEAM_ORDER, expect: "전체구단 공개" },
    { key: "one", tags: ["lg"], expect: "LG" },
    { key: "three", tags: ["lg", "doosan", "kt"], expect: "LG 두산 KT" },
    { key: "four-rev", tags: rev4, expect: `${rev4.slice(0, 3).map((s) => SHORT[s]).join(" ")} 외 1팀` },
  ];

  for (const c of cases) {
    const { data, error } = await admin.from("posts").insert({
      author_id: userId, board_type: "free", board_id: "general", content_type: "general",
      title: `[QA-SCOPE-${STAMP}] ${c.key}`,
      content: `공개범위 라벨 QA 픽스처 (${c.key})`,
      team_tags: c.tags,
    }).select("id").single();
    if (error) throw new Error(`${c.key} seed 실패: ${error.message}`);
    c.id = data.id;
    postIds.push(data.id);
  }

  // 무태그 INSERT 는 트리거가 막아야 정상이다 — service_role 은 BYPASSRLS 지만 트리거는 못 뚫는다.
  // 그것 자체가 경계 검증이므로 여기서 바로 판정한다.
  const blocked = await admin.from("posts").insert({
    author_id: userId, board_type: "free", board_id: "general", content_type: "general",
    title: `[QA-SCOPE-${STAMP}] blocked`, content: "무태그 INSERT 시도", team_tags: [],
  }).select("id").single();
  check("DB 경계: 무태그 INSERT 거절(23514)", blocked.error?.code === "23514",
    blocked.error ? `code=${blocked.error.code}` : "무태그가 저장됨 — 트리거 미작동");
  if (blocked.data) postIds.push(blocked.data.id);

  // ── 레거시 무태그 행 → "전체구단 공개" 폴백 (삼순 지적 2026-08-07) ────────
  //   운영에는 태그 없는 옛 글이 2,000건대로 남아있다(migration 은 backfill 하지 않는다).
  //   그 글들이 화면에서 어떻게 보이는지가 실제 유저 경험인데, 종전 판본은 주석에만
  //   적어두고 **UI 검증이 없었다**.
  //   트리거는 INSERT-only 이므로: 정상 태그로 INSERT → team_tags=[] 로 UPDATE 하면
  //   운영의 레거시 행과 같은 형상을 만들 수 있다(트리거 우회가 아니라 설계된 경로).
  const legacyIns = await admin.from("posts").insert({
    author_id: userId, board_type: "free", board_id: "general", content_type: "general",
    title: `[QA-SCOPE-${STAMP}] legacy`, content: "태그 없는 레거시 글", team_tags: ["lg"],
  }).select("id").single();
  if (legacyIns.error) throw new Error(`legacy seed 실패: ${legacyIns.error.message}`);
  postIds.push(legacyIns.data.id);
  const legacyUpd = await admin.from("posts")
    .update({ team_tags: [] }).eq("id", legacyIns.data.id).select("team_tags").single();
  check("레거시 형상 준비: 태그 비우는 UPDATE 가 23514 로 죽지 않는다(트리거 INSERT-only)",
    !legacyUpd.error && Array.isArray(legacyUpd.data?.team_tags) && legacyUpd.data.team_tags.length === 0,
    legacyUpd.error ? `code=${legacyUpd.error.code}` : `team_tags=${JSON.stringify(legacyUpd.data?.team_tags)}`);
  cases.push({ key: "legacy", tags: [], expect: "전체구단 공개", id: legacyIns.data.id });

  log(`픽스처 ${postIds.length}건 생성`);

  // ── 실브라우저 ───────────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  // 실제 로그인 세션 주입 (service_role 우회 아님 — 진짜 유저 토큰)
  const anonClient = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } });
  const { data: signIn, error: sErr } = await anonClient.auth.signInWithPassword({ email, password: pw });
  if (sErr) throw sErr;
  const projectRef = SUPABASE_URL.match(/https:\/\/([a-z0-9]+)/)[1];
  await page.addInitScript(([ref, session]) => {
    localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(session));
  }, [projectRef, signIn.session]);

  // ── 자유게시판 피드 ──────────────────────────────────────────────────────
  await page.goto(`${BASE_URL}/community/free`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2500);

  /**
   * 특정 QA 글 카드의 공개범위 배지 칩 텍스트를 공백으로 이어 읽는다.
   *
   * ⚠️ 자체결함 2연속 — 둘 다 "어느 카드를 읽고 있는가"를 특정 못한 유형이다:
   *   1차: `closest("...div[class*='rounded']")` — 실제 카드는 `div.glass-card` 라 전부 null.
   *   2차: 배지에서 8단계 위로 올라가며 제목 포함 조상을 찾음 — 피드 컴테이너까지
   *        닿아서 **4개 글을 전부 포함**하는 공통 조상이 잡혔고, 그래서 세 케이스가
   *        전부 같은 값(첫 배지)을 돌려줌. 위로 올라가는 방향은 범위가 점점 넓어져
   *        제목 포함 여부로는 카드를 특정할 수 없다.
   *   → 방향을 뒤집는다. **제목 엘리먼트에서 출발**해 배지를 포함하는 **가장 가까운**
   *     조상을 찾으면, 그게 곳 그 글의 카드다(다른 글의 배지를 집을 수 없다).
   */
  const scopeOf = async (title) =>
    page.evaluate((t) => {
      const leaf = Array.from(document.querySelectorAll("h1, h2, h3, h4, p, span, div"))
        .find((e) => e.children.length === 0 && (e.textContent ?? "").includes(t));
      if (!leaf) return "제목 엘리먼트 없음";
      let node = leaf.parentElement;
      for (let i = 0; i < 10 && node; i += 1) {
        const blocks = node.querySelectorAll("[data-community-source-label]");
        if (blocks.length === 1) {
          const block = blocks[0];
          const badge = block.querySelector("span.inline-flex.items-center.gap-1.min-w-0") ?? block;
          const chips = Array.from(badge.children)
            .map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim())
            .filter(Boolean);
          return chips.length ? chips.join(" ") : (badge.textContent ?? "").replace(/\s+/g, " ").trim();
        }
        // 2개 이상 잡히면 이미 카드 경계를 넘은 것 — 더 올라가도 정확해지지 않는다.
        if (blocks.length > 1) return `카드 경계 초과(배지 ${blocks.length}개)`;
        node = node.parentElement;
      }
      return "배지 없음";
    }, title);

  for (const c of cases) {
    const title = `[QA-SCOPE-${STAMP}] ${c.key}`;
    const actual = await scopeOf(title);
    check(`피드 ${c.key} → "${c.expect}"`, actual === c.expect, `실제 "${actual}"`);
  }

  await page.screenshot({ path: `${SHOT_DIR}/scope-feed-390.png`, fullPage: false });

  // ── 320px 최소 폭 — 잘림/깨짐 ────────────────────────────────────────────
  await page.setViewportSize({ width: 320, height: 720 });
  await page.waitForTimeout(1200);

  const narrow = await page.evaluate(() => {
    const out = [];
    for (const block of document.querySelectorAll("[data-community-source-label]")) {
      const badge = block.querySelector("span.inline-flex.items-center.gap-1.min-w-0") ?? block;
      const r = badge.getBoundingClientRect();
      out.push({
        text: (badge.textContent ?? "").replace(/\s+/g, " ").trim(),
        overflowRight: Math.round(r.right - document.documentElement.clientWidth),
        height: Math.round(r.height),
      });
    }
    return out;
  });
  check("320px: 배지가 화면 밖으로 안 넘침", narrow.every((n) => n.overflowRight <= 0),
    JSON.stringify(narrow.filter((n) => n.overflowRight > 0).slice(0, 3)));
  check("320px: 배지 줄바꿈으로 안 깨짐(높이 40px 이하)", narrow.every((n) => n.height <= 40),
    JSON.stringify(narrow.filter((n) => n.height > 40).slice(0, 3)));
  await page.screenshot({ path: `${SHOT_DIR}/scope-feed-320.png`, fullPage: false });

  // ── 홈 최신글 compact 라벨 ───────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3000);

  const homeScopes = await page.evaluate(() => {
    const out = [];
    for (const link of document.querySelectorAll("a[href^='/community/']")) {
      const badge = link.querySelector("span.inline-flex.items-center.gap-1.min-w-0");
      if (!badge) continue;
      const aria = badge.getAttribute("aria-label");
      out.push({
        title: (link.textContent ?? "").slice(0, 40),
        scope: aria ? aria.replace(/,\s*/g, " ").replace(/\s+/g, " ").trim()
                    : (badge.textContent ?? "").replace(/\s+/g, " ").trim(),
      });
    }
    return out;
  });
  check("홈 최신글이 공개범위 배지를 렌더한다", homeScopes.length > 0, `배지 0개`);

  // ⚠️ 삼순 NO-GO 2026-08-07 ③ — 종전 판본은 QA 글을 못 찾으면 `log` 만 찍고 넘어갔다.
  //   그러면 홈 검증이 **0건인데 전체 PASS** 가 나온다(vacuous). 홈 배선이 통째로 끊겨도
  //   이 게이트는 초록불이다. QA 글은 방금 만든 최신글이라 홈 최신글에 나오는 게 정상이다.
  //   → 못 찾으면 FAIL. 각 case 도 "매칭되면 비교"가 아니라 **반드시 존재 + 값 일치**를 요구한다.
  const homeQa = homeScopes.filter((h) => h.title.includes(`QA-SCOPE-${STAMP}`));
  check("홈 최신글에 QA 글이 노출된다(검증 0건 방지)", homeQa.length > 0,
    `QA 글 0건 — 홈 배선이 끊겼거나 최신글 목록에서 밀렸다`);
  for (const c of cases) {
    const hit = homeQa.find((h) => h.title.includes(c.key));
    check(`홈 ${c.key} → "${c.expect}"`, !!hit && hit.scope === c.expect,
      hit ? `실제 "${hit.scope}"` : "홈에서 해당 글을 못 찾음");
  }
  check("홈이 옛 '크보팬' 라벨을 안 쓴다", !homeScopes.some((h) => h.scope === "크보팬"),
    JSON.stringify(homeScopes.filter((h) => h.scope === "크보팬").slice(0, 2)));
  await page.screenshot({ path: `${SHOT_DIR}/scope-home-390.png`, fullPage: false });

  // ── 실제 로그인 유저 권한으로 DB 경계 재확인 (service_role 우회 아님) ────
  const userClient = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } });
  await userClient.auth.signInWithPassword({ email, password: pw });
  const bypass = await userClient.from("posts").insert({
    author_id: userId, board_type: "stadium", board_id: "jamsil-seats",
    content_type: "general", title: "우회 시도", content: "무태그", team_tags: [],
  }).select("id").single();
  check("실제 로그인 유저의 무태그 우회 INSERT 거절", bypass.error?.code === "23514",
    bypass.error ? `code=${bypass.error.code}` : "저장됨 — 경계 뚫림");
  if (bypass.data) postIds.push(bypass.data.id);

  await browser.close();
  console.log(`\n  ${passCount} passed, ${failCount} failed`);
  console.log(`  스크린샷: ${SHOT_DIR}`);
}

main()
  .then(cleanup)
  .then(() => process.exit(failCount > 0 ? 1 : 0))
  .catch(async (e) => {
    console.error("\n❌ QA 실패:", e.message);
    await cleanup().catch(() => {});
    process.exit(1);
  });
