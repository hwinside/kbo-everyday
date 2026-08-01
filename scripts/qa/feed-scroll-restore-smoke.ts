/**
 * 커뮤니티 피드 뒤로가기 복원 회귀.
 *
 * 사고: 피드를 깊게 스크롤한 뒤 글 상세로 들어갔다가 뒤로 나오면 피드가 맨 위로 초기화.
 * production 실측(390x844): scrollY 12849 → 1243, 카드 31 → 11.
 *
 * 핵심 계약(이 스위트가 고정):
 *  ① 스크롤만 저장해서는 못 고친다 — 페이지 수(pageCount)를 함께 복원해야 문서가 충분히 길어진다.
 *  ② 복원은 **뒤로가기(popstate)** 에서만. 탭바 등 push 진입에서는 발동하지 않는다.
 *  ③ 복원 상태는 1회용. TTL 경과·손상된 값은 무시(fail-safe).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  decideFeedPersist,
  matchesPoppedFeed,
  parseRestoreState,
  resolveFeedRestoreIntent,
  RESTORE_TTL_MS,
  type FeedRestoreIntent,
  type FeedRestoreState,
} from "../../src/lib/community/feed-restore";

let pass = 0;
let fail = 0;
function t(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}

const NOW = 1_700_000_000_000;
const ok: FeedRestoreState = { pageCount: 4, scrollY: 12849, savedAt: NOW };

console.log("\n[1] 저장 상태 파싱 — fail-safe");
t("정상 값은 그대로 파싱", () => {
  assert.deepEqual(parseRestoreState(JSON.stringify(ok), NOW), ok);
});
t("null/빈 값은 null", () => {
  assert.equal(parseRestoreState(null, NOW), null);
  assert.equal(parseRestoreState("", NOW), null);
});
t("JSON 파싱 실패는 null(throw 금지)", () => {
  assert.equal(parseRestoreState("{not json", NOW), null);
});
t("TTL 경과분은 무시", () => {
  const stale = JSON.stringify({ ...ok, savedAt: NOW - RESTORE_TTL_MS - 1 });
  assert.equal(parseRestoreState(stale, NOW), null);
});
t("TTL 경계 이내는 유효", () => {
  const edge = JSON.stringify({ ...ok, savedAt: NOW - RESTORE_TTL_MS + 1 });
  assert.notEqual(parseRestoreState(edge, NOW), null);
});
t("음수 scrollY / pageCount<1 / 비수치는 거부", () => {
  assert.equal(parseRestoreState(JSON.stringify({ ...ok, scrollY: -5 }), NOW), null);
  assert.equal(parseRestoreState(JSON.stringify({ ...ok, pageCount: 0 }), NOW), null);
  assert.equal(parseRestoreState(JSON.stringify({ ...ok, pageCount: "4" }), NOW), null);
  assert.equal(parseRestoreState(JSON.stringify({ ...ok, savedAt: NaN }), NOW), null);
});

/**
 * [2] 복원 시뮬레이션 — useUnifiedFeed 초기 로드 루프의 계약을 순수 재현한다.
 * 실제 훅과 같은 규칙: saved.pageCount 까지 순차 loadPage, 빈 응답이면 중단, dedupe 유지.
 */
function simulateInitialLoad(opts: {
  totalRows: number;
  pageSize: number;
  saved: FeedRestoreState | null;
}): { loadedRows: number; pages: number; calls: number } {
  const { totalRows, pageSize, saved } = opts;
  let calls = 0;
  const loadPage = (cursor: number | null): number[] => {
    calls++;
    const start = cursor === null ? 0 : cursor;
    return Array.from({ length: Math.max(0, Math.min(pageSize, totalRows - start)) }, (_, i) => start + i + 1);
  };

  const rows = loadPage(null);
  const acc: number[] = [...rows];
  let cursor = rows.length ? rows[rows.length - 1] : null;
  let more = rows.length === pageSize;
  let pages = 1;

  while (saved && more && pages < saved.pageCount) {
    const next = loadPage(cursor);
    if (!next.length) {
      more = false;
      break;
    }
    const seen = new Set(acc);
    next.filter((r) => !seen.has(r)).forEach((r) => acc.push(r));
    cursor = next[next.length - 1];
    more = next.length === pageSize;
    pages += 1;
  }
  return { loadedRows: acc.length, pages, calls };
}

console.log("\n[2] 복원 로드 — 페이지 분량까지 채움");
t("사고 재현: 복원 없으면 1페이지(20건)만 → 문서가 짧아 스크롤 복원 불가", () => {
  const r = simulateInitialLoad({ totalRows: 500, pageSize: 20, saved: null });
  assert.equal(r.pages, 1);
  assert.equal(r.loadedRows, 20);
});
t("복원 시 저장된 페이지 수(4)만큼 채움 = 80건", () => {
  const r = simulateInitialLoad({ totalRows: 500, pageSize: 20, saved: ok });
  assert.equal(r.pages, 4);
  assert.equal(r.loadedRows, 80);
});
t("데이터가 저장 시점보다 적어도 안전하게 멈춤(무한루프 없음)", () => {
  const r = simulateInitialLoad({ totalRows: 25, pageSize: 20, saved: { ...ok, pageCount: 9 } });
  assert.equal(r.loadedRows, 25);
  assert.ok(r.pages <= 9);
  assert.ok(r.calls <= 9, `calls=${r.calls}`);
});
t("복원 페이지 수만큼만 부르고 그 이상 안 부름(과다 요청 방지)", () => {
  const r = simulateInitialLoad({ totalRows: 500, pageSize: 20, saved: ok });
  assert.equal(r.calls, 4);
});

console.log("\n[3] 뒤로가기에서만 복원 (push 진입 격리)");
/** consumeBackNavigation + readFeedRestore 조합 계약을 재현. */
function shouldRestore(cameBack: boolean, savedRaw: string | null, now = NOW) {
  return cameBack ? parseRestoreState(savedRaw, now) : null;
}
t("popstate(뒤로가기) + 저장분 있음 → 복원", () => {
  assert.notEqual(shouldRestore(true, JSON.stringify(ok)), null);
});
t("push 진입(탭바 등)은 저장분이 있어도 복원 안 함", () => {
  assert.equal(shouldRestore(false, JSON.stringify(ok)), null);
});
t("뒤로가기여도 저장분 없으면 복원 안 함", () => {
  assert.equal(shouldRestore(true, null), null);
});

console.log("\n[4] 저장 규칙");
t("1페이지 + 최상단이면 저장할 게 없음(불필요한 복원 방지)", () => {
  // saveFeedRestore 의 조기 반환 조건과 동일한 판정.
  const shouldSkip = (pageCount: number, scrollY: number) => pageCount <= 1 && scrollY <= 0;
  assert.equal(shouldSkip(1, 0), true);
  assert.equal(shouldSkip(1, 500), false);
  assert.equal(shouldSkip(3, 0), false);
});

console.log("\n[5] 저장 판정 — 라우터가 만든 0 vs 유저가 만든 진짜 0");
/**
 * 사고의 진짜 원인: 상세로 이동할 때 스크롤이 먼저 0 으로 되돌아간 뒤 피드가 언마운트되므로,
 * 그 0 을 저장하면 진짜 위치가 지워진다(실측 saved 12972 → 0 → 복원해도 항상 맨 위).
 *
 * 그런데 "y<=0 이면 무조건 무시"로 막으면 반대 사고가 난다 — 유저가 직접 맨 위로 올린 진짜 0 까지
 * 무시돼 오래된 깊은 위치가 남고, 다음 복귀에 거기로 튄다(삼순 리뷰 actual: 12972 → top → 진입 →
 * back → 12972 복원). 그래서 `leaving`(링크 클릭으로 떠나는 중인가)로 두 0 을 가른다.
 */
t("떠나는 중(라우터가 만든 0)은 저장 상태를 건드리지 않음", () => {
  assert.equal(decideFeedPersist(true, 0), "ignore");
});
t("떠나는 중이면 어떤 값이 와도 확정 저장분을 덮지 않음", () => {
  assert.equal(decideFeedPersist(true, 5), "ignore");
});
t("유저가 만든 진짜 0(최상단)은 저장 상태를 제거", () => {
  // ⚠️ 이전 구현(y<=0 이면 그냥 return)은 여기서 "ignore" 였고, 그래서 오래된 12972 가 살아남았다.
  assert.equal(decideFeedPersist(false, 0), "clear");
});
t("정상 스크롤 값은 저장", () => {
  assert.equal(decideFeedPersist(false, 9200), "save");
});
t("클릭 순간의 확정 저장은 leaving=false 로 평가돼 실제 위치가 남는다", () => {
  // 링크 클릭 capture 시점에는 아직 스크롤이 0 으로 되돌려지기 전이다.
  assert.equal(decideFeedPersist(false, 7107), "save");
});

console.log("\n[5b] 뒤로가기 scope — 무관한 back 이 다음 push 를 오염시키지 않음");
/**
 * 삼순 리뷰 actual 재현: LG 피드 저장 → 경기 push → 순위 push → **경기로 back**(pop 플래그 발생)
 * → 커뮤니티 push → LG 팀 push 인데 12972 로 복원됐다. 전역 boolean 플래그가 목적지를 안 봤기 때문.
 * pop 이 실제로 도착한 경로와 마운트한 피드 경로가 같을 때만 복원으로 승격한다.
 */
t("pop 이 이 피드로 도착했을 때만 복원", () => {
  assert.equal(matchesPoppedFeed("/community/teams/lg", "/community/teams/lg"), true);
});
t("무관한 화면으로의 back 은 이 피드 복원이 아님(사고 재현 케이스)", () => {
  assert.equal(matchesPoppedFeed("/games/20260801LGHH0", "/community/teams/lg"), false);
});
t("다른 팀 피드로의 back 도 이 피드 복원이 아님", () => {
  assert.equal(matchesPoppedFeed("/community/teams/ss", "/community/teams/lg"), false);
});
t("pop 자체가 없으면 복원 아님(push 진입)", () => {
  assert.equal(matchesPoppedFeed(null, "/community/teams/lg"), false);
});

console.log("\n[5c] effect 재실행(auth hydration) — 확정된 복원 의사가 살아남아야 함");
/**
 * 삼순 재리뷰 실측 사고: 로그인 세션의 **전체문서 뒤로가기**에서 12972 → 1243, cards 31 → 12.
 *
 * 체인:
 *  1. useUnifiedFeed 초기 effect 가 back_forward 를 1회 소비하고 저장값을 읽는다
 *  2. AuthProvider 는 문서 로드마다 user=null 로 시작한 뒤 세션을 읽어 setUser 한다
 *  3. effect dep 에 user?.id 가 있어 **같은 feed 에서 즉시 재실행**된다
 *  4. 재실행은 1회용 플래그를 다시 소비할 수 없어 cameBack=false → 저장값을 clear,
 *     첫 복원 load 는 cleanup 으로 취소 → 사고 재현
 *
 * 계약: 복원 의사는 feed 당 **한 번만** 확정하고, 재실행은 확정본을 재사용한다(재소비·삭제 금지).
 */
function runFeedEffects(opts: {
  /** effect 가 실행되는 순서대로의 feedKey (auth hydration 은 같은 키가 두 번). */
  runs: string[];
  /** 최초 확정 때 back_forward 소비 결과. 1회용이라 두 번째 호출부터는 false. */
  backAvailable: boolean;
  saved: FeedRestoreState | null;
}) {
  let intentRef: FeedRestoreIntent | null = null;
  let backLeft = opts.backAvailable;
  let storage: FeedRestoreState | null = opts.saved;
  let consumeCalls = 0;
  const results: (FeedRestoreState | null)[] = [];

  for (const feedKey of opts.runs) {
    const { intent, fresh } = resolveFeedRestoreIntent({
      prev: intentRef,
      feedKey,
      consumeBack: () => {
        consumeCalls++;
        const v = backLeft;
        backLeft = false; // 1회용
        return v;
      },
      readSaved: () => storage,
    });
    intentRef = intent;
    // 구현과 동일: 최초 확정에서 복원 대상이 아닐 때만 저장 상태를 버린다.
    if (fresh && !intent.state) storage = null;
    results.push(intent.state);
  }
  return { results, consumeCalls, storage };
}

const DEEP: FeedRestoreState = { pageCount: 2, scrollY: 12972, savedAt: NOW };

t("사고 재현 방지: auth hydration 재실행에도 같은 복원값 유지", () => {
  const r = runFeedEffects({ runs: ["team:lg", "team:lg"], backAvailable: true, saved: DEEP });
  assert.deepEqual(r.results[0], DEEP);
  // ⚠️ 이전 구현은 여기서 null 이 되고 저장값까지 지워 12972 → 1243 이 됐다.
  assert.deepEqual(r.results[1], DEEP);
});
t("재실행은 1회용 뒤로가기 플래그를 다시 소비하지 않음", () => {
  const r = runFeedEffects({ runs: ["team:lg", "team:lg", "team:lg"], backAvailable: true, saved: DEEP });
  assert.equal(r.consumeCalls, 1);
});
t("재실행은 저장 상태를 지우지 않음(첫 복원이 끊기지 않도록)", () => {
  const r = runFeedEffects({ runs: ["team:lg", "team:lg"], backAvailable: true, saved: DEEP });
  assert.notEqual(r.storage, null);
});
t("push 진입은 최초 확정에서 상태를 버리고, 재실행해도 복원되지 않음", () => {
  const r = runFeedEffects({ runs: ["team:lg", "team:lg"], backAvailable: false, saved: DEEP });
  assert.equal(r.results[0], null);
  assert.equal(r.results[1], null);
  assert.equal(r.storage, null);
});
t("다른 피드로 이동하면 새로 확정한다(intent 가 고착되지 않음)", () => {
  const r = runFeedEffects({ runs: ["team:lg", "team:ss"], backAvailable: true, saved: DEEP });
  assert.deepEqual(r.results[0], DEEP);
  assert.equal(r.consumeCalls, 2, "새 feedKey 에서는 다시 판정해야 한다");
});

console.log("\n[6] 뒤로가기 판별 — 전체 문서 로드(back_forward)도 인정, 단 1회·경로 일치");
/**
 * 모바일 웹뷰/전체 로드 복귀에서는 popstate 리스너가 없다(JS 컨텍스트 초기화) → Navigation Timing 사용.
 * ⚠️ navigation type 은 **문서 전체**의 속성이라 그 뒤 SPA 로 어디를 눌러도 계속 back_forward 로 남는다.
 * 그래서 (a) 문서 진입 경로가 이 피드인지 (b) 아직 소비 안 됐는지를 함께 봐야 한다.
 * (consumeBackForwardLoad 의 계약을 순수 재현)
 */
function makeBfConsumer(entryPath: string | null) {
  let consumed = false;
  return (feedPath: string) => {
    if (consumed) return false;
    if (entryPath !== feedPath) return false;
    consumed = true;
    return true;
  };
}
t("SPA popstate 로 복귀(경로 일치)", () => {
  assert.equal(matchesPoppedFeed("/community/teams/lg", "/community/teams/lg"), true);
});
t("전체 로드 뒤로가기(back_forward)가 이 피드로 진입하면 복원 대상", () => {
  const bf = makeBfConsumer("/community/teams/lg");
  assert.equal(bf("/community/teams/lg"), true);
});
t("bf 로드가 다른 화면으로 진입했으면 그 뒤 push 로 온 피드는 복원 안 함", () => {
  const bf = makeBfConsumer("/games/20260801LGHH0");
  assert.equal(bf("/community/teams/lg"), false);
});
t("bf 는 1회만 인정 — 소비 후 같은 문서에서 재진입해도 복원 안 함", () => {
  const bf = makeBfConsumer("/community/teams/lg");
  assert.equal(bf("/community/teams/lg"), true);
  assert.equal(bf("/community/teams/lg"), false);
});
t("일반 진입(navigate)은 복원 안 함", () => {
  const bf = makeBfConsumer(null);
  assert.equal(bf("/community/teams/lg"), false);
});

// ── 전용 QA 계정 정리 fail-close (삼순 3차 NO-GO) ──────────────────────────
// 로그인 스모크의 cleanup 이 실패해도 PASS 로 끝나면 계정이 운영에 남는다(AGENTS P0).
// 실제 정리 로직을 소스에서 계약으로 고정하고, 실패 주입으로 구·신 구현을 대조한다.
{
  const authSmoke = readFileSync(
    path.join(process.cwd(), "scripts/qa/ui-smoke-feed-scroll-restore-auth.mjs"),
    "utf8",
  );
  const cleanup = authSmoke.slice(authSmoke.indexOf("if (userId) {"));

  t("정리: profile·auth 삭제의 반환 error 를 각각 검사한다", () => {
    assert.match(cleanup, /const \{ error \} = await admin\.from\("profiles"\)\.delete\(\)/);
    assert.match(cleanup, /const \{ error \} = await admin\.auth\.admin\.deleteUser\(userId\)/);
  });
  t("정리: 두 삭제를 서로 독립적으로 끝까지 시도한다", () => {
    // 한 try 안에 두 삭제가 같이 있으면 앞이 throw 할 때 뒤를 건너뛴다.
    const profileIdx = cleanup.indexOf('admin.from("profiles").delete()');
    const authIdx = cleanup.indexOf("admin.auth.admin.deleteUser(userId)");
    assert.ok(profileIdx >= 0 && authIdx >= 0);
    const between = cleanup.slice(profileIdx, authIdx);
    assert.match(between, /\}\s*catch[\s\S]*?\}\s*try\s*\{/, "두 삭제가 독립 try 로 분리돼야 한다");
  });
  t("정리: 삭제 후 postcondition(profile 0 · auth not-found)을 확인한다", () => {
    assert.match(cleanup, /count:\s*"exact"/, "profile 잔존 count 확인 없음");
    assert.match(cleanup, /getUserById\(userId\)/, "auth 잔존 확인 없음");
  });
  t("정리: 실패·잔존이면 failures 를 올려 exit 1 로 끝난다", () => {
    assert.match(cleanup, /failures \+= 1;/, "정리 실패가 종료코드에 반영되지 않는다");
  });
  t("정리: 무조건 '완료' 를 출력하지 않는다(거짓 초록 금지)", () => {
    const successLog = cleanup.indexOf("전용 테스트 계정 정리 완료");
    assert.ok(successLog >= 0, "성공 로그를 찾지 못함");
    // 성공 로그는 "문제 0건" 분기 안에서만 나와야 한다.
    // 구현은 `if (problems.length > 0) { 실패 } else { 성공 }` 형태이므로,
    // 성공 로그 직전에 그 분기가 있고 실패 경로가 failures 를 올리는지 함께 본다.
    const before = cleanup.slice(0, successLog);
    assert.match(before, /cleanupProblems\.length\s*>\s*0[\s\S]*failures \+= 1;[\s\S]*\}\s*else\s*\{/,
      "성공 로그가 '문제 0건' 분기 밖에 있다(항상 완료로 보고될 수 있음)");
  });

}

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
